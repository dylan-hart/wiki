import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type Mail from 'nodemailer/lib/mailer/index.js'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'
import type { HookEvent } from './hooks.ts'
import { localizedPagePath, type LocaleRoutingConfig } from '../helpers/localeRouting.ts'

/** A rendered email, ready to hand to the transporter. */
export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * Verb form of each notifiable action, for the summary phrasing (e.g. `edited: title, content`),
 * resolved from `mail.watchAction.*` for the recipient's locale (`en` fallback) via
 * `WIKI.models.locales.resolveString`.
 */
async function watchActionLabel(
  action: PageWatchNotifiableAction,
  locale?: string | null
): Promise<string> {
  return WIKI.models.locales.resolveString(locale, `mail.watchAction.${action}`)
}

/**
 * Whether this action tells the recipient about the outcome of THEIR OWN edit suggestion, rather than
 * about a page they are watching — see `models/approvals.ts#notifySubmissionAuthor`. The two kinds of
 * mail need different footers: the ordinary "you are receiving this because you are watching this
 * page" line would be false for a submission author who may never have watched the page at all.
 */
function isSuggestionDecision(action: PageWatchNotifiableAction): boolean {
  return action === 'suggestApproved' || action === 'suggestDeclined'
}

/**
 * Escape the four HTML metacharacters, for values that land in a template's HTML body but did not
 * come from this file — a page title or a display name is content a wiki editor chose, not a
 * constant this module wrote, so it is escaped the same way `models/search.ts`'s own `escapeHtml`
 * treats a search highlight.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** One page-watch change, described the same way whether it stands alone or sits inside a digest. */
export interface WatchEventItem {
  page: { title: string; path: string; locale: string }
  action: PageWatchNotifiableAction
  changedFields: string[]
  actorName: string
}

/**
 * Classify a failed send by nodemailer's `err.code` so logs — and the test-send endpoint's
 * response — distinguish a plain network-level problem (unreachable host, wrong port, timeout)
 * from a TLS certificate that failed validation, from bad credentials, from a rejected message,
 * instead of one generic "failed to send" line for all four. Codes come from
 * `nodemailer/lib/smtp-connection`, the only transport this model uses.
 *
 * `'tls'` is split out from `'connection'` on purpose: `smtp-connection` reports both a
 * self-signed/expired/hostname-mismatched certificate (via `ETLS`, whether hit during the initial
 * implicit-TLS handshake or during `STARTTLS`) and a plain socket-level failure (refused
 * connection, DNS lookup failure, timeout, protocol desync) as connection-stage errors — but they
 * call for different admin action. A `'connection'` failure says "check the host and port"; a
 * `'tls'` failure says "check the certificate, or enable Verify SSL Certificate" (see
 * `buildTransportOptions`'s `tls.rejectUnauthorized` — this is the failure that setting exists to
 * work around for a self-hosted mail relay with a self-signed cert).
 */
export function classifyMailError(err: any): 'connection' | 'tls' | 'auth' | 'send' | 'unknown' {
  switch (err?.code) {
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'ETIMEDOUT':
    case 'EDNS':
    case 'EPROTOCOL':
      return 'connection'
    case 'ETLS':
      return 'tls'
    case 'EAUTH':
      return 'auth'
    case 'EENVELOPE':
    case 'EMESSAGE':
      return 'send'
    default:
      return 'unknown'
  }
}

/**
 * Mail model
 *
 * Builds a single `nodemailer` SMTP transporter from `WIKI.config.mail` (CRUD'd by `api/mail.ts`)
 * and exposes a generic `send()` plus the transactional templates this feature needs: verify-email,
 * registration-collision (the non-enumerating notice `register()` sends the real owner instead of
 * throwing `ERR_EMAIL_ALREADY_EXISTS`), forgot-password (the reset-*request* email, with the actual
 * reset link), password-reset-confirmed (the after-the-fact notice once a reset completes — a
 * distinct email from the request one above), test-email (the admin "Send Test Email" action), and
 * the page-watch notification. Every subject and body is a `mail.*` key in `backend/locales/en.json`,
 * resolved through `WIKI.models.locales.resolveString`/`resolvePluralString` against a `locale` each
 * send method accepts (typically the recipient's `users.prefs.locale`, `en` as the fallback —
 * OpenProject #1611/#1623) — building a DB-backed, admin-editable template system is a separate,
 * larger scope this deliberately stays out of: there is no `db/schema.ts` table to back one, and
 * none is added by this change.
 *
 * `getTransporter()` re-reads `WIKI.config.mail` on every call (it is called once per `send()`) and
 * rebuilds the transporter whenever the resulting options differ from the last build, compared by a
 * cheap JSON snapshot. The net effect is the same as constructing a fresh transporter per send — a
 * runtime config edit through the admin area takes effect on the very next email — without the
 * connection-pool churn of literally discarding and recreating the nodemailer object when nothing
 * changed.
 */
class MailModel {
  private transporter: Mail<SMTPTransport.SentMessageInfo> | null = null
  private transporterSnapshot: string | null = null

  /**
   * Whether enough of `WIKI.config.mail` is filled in to attempt a connection. Only `host` is
   * required for a transporter to be buildable at all — everything else nodemailer accepts as
   * empty/absent.
   */
  isConfigured(): boolean {
    return Boolean(WIKI.config.mail?.host)
  }

  /**
   * Map the stored mail settings onto nodemailer's SMTP transport options.
   *
   * `verifySSL` -> `tls.rejectUnauthorized`, `user`/`pass` -> `auth`, and the `useDKIM` group ->
   * nodemailer's native `dkim` option (only passed once every field it needs is actually set).
   */
  buildTransportOptions(): SMTPTransport.Options {
    const cfg = WIKI.config.mail ?? {}
    const options: SMTPTransport.Options = {
      host: cfg.host,
      port: cfg.port || (cfg.secure ? 465 : 587),
      secure: cfg.secure ?? true,
      tls: {
        rejectUnauthorized: cfg.verifySSL ?? true
      }
    }
    if (cfg.name) {
      options.name = cfg.name
    }
    if (cfg.user) {
      options.auth = {
        user: cfg.user,
        pass: cfg.pass ?? ''
      }
    }
    if (cfg.useDKIM && cfg.dkimDomainName && cfg.dkimKeySelector && cfg.dkimPrivateKey) {
      options.dkim = {
        domainName: cfg.dkimDomainName,
        keySelector: cfg.dkimKeySelector,
        privateKey: cfg.dkimPrivateKey
      }
    }
    return options
  }

  /**
   * The transporter for the current config, rebuilding it only when the config actually changed.
   *
   * @throws `ERR_MAIL_NOT_CONFIGURED` when no SMTP host is set, logging why the send was refused.
   */
  getTransporter(): Mail<SMTPTransport.SentMessageInfo> {
    if (!this.isConfigured()) {
      WIKI.logger.warn('mail', 'cannot send, no SMTP host is configured')
      throw new Error('ERR_MAIL_NOT_CONFIGURED')
    }
    const options = this.buildTransportOptions()
    const snapshot = JSON.stringify(options)
    if (!this.transporter || this.transporterSnapshot !== snapshot) {
      this.transporter = nodemailer.createTransport(options)
      this.transporterSnapshot = snapshot
    }
    return this.transporter
  }

  /**
   * Send a single email through the configured SMTP transport.
   *
   * @throws `ERR_MAIL_NOT_CONFIGURED` when there is no transport to send with. Any other failure
   *   (auth rejected, connection refused, certificate rejected, message rejected, ...) is logged
   *   with its {@link classifyMailError} category — so a log search can tell "the SMTP host is
   *   unreachable" apart from "the TLS certificate didn't validate" apart from "the credentials
   *   are wrong" apart from "the message itself was rejected" — and rethrown as-is.
   */
  async send({ to, subject, html, text }: MailMessage): Promise<void> {
    const transporter = this.getTransporter()
    const cfg = WIKI.config.mail ?? {}
    const senderEmail = cfg.senderEmail || cfg.user
    try {
      await transporter.sendMail({
        from: cfg.senderName ? { name: cfg.senderName, address: senderEmail } : senderEmail,
        to,
        subject,
        html,
        text
      })
    } catch (err: any) {
      const kind = classifyMailError(err)
      // -> The recipient is deliberately absent: an address is an identity, and the send site's own
      //    context is what says whose mail this was.
      WIKI.logger.warn('mail', 'sending failed', { kind, error: err })
      throw err
    }
  }

  /**
   * Build `<base><path>`, without a doubled-up slash. Every template link goes through this so a
   * missing base produces an obviously-relative (and obviously wrong) link rather than a silently
   * broken one.
   *
   * @param baseURL Overrides `WIKI.config.mail.defaultBaseURL` — used by the page-watch templates to
   *   link at the originating site's own hostname instead of the instance-wide default. See
   *   {@link resolveMailBaseURL}.
   */
  buildLink(path: string, baseURL?: string): string {
    const base = (baseURL ?? WIKI.config.mail?.defaultBaseURL ?? '').replace(/\/+$/, '')
    return `${base}${path}`
  }

  /**
   * The base URL a page-watch email should link at: `https://<site hostname>` for a real site, or
   * `WIKI.config.mail.defaultBaseURL` when there is no site to ask (no `siteId`, an unresolvable
   * one) or the site is the `*` catch-all, which has no hostname of its own to link at. No per-site
   * override setting exists for scheme/port (v1 scope decision, OpenProject #1023) — `https://` is
   * assumed, matching how every other Cardinal.js 3.x site link is built.
   */
  resolveMailBaseURL(siteId?: string): string {
    const hostname = siteId ? WIKI.sites[siteId]?.hostname : null
    if (hostname && hostname !== '*') {
      return `https://${hostname}`
    }
    return WIKI.config.mail?.defaultBaseURL ?? ''
  }

  /**
   * Resolve one `mail.<key>.{subject,text,html}` trio for a locale and send it.
   *
   * Every transactional template is the same three `resolveString` calls plus a `send()`; what
   * differs between them is the key, the params, and — for the two that append a sender signature —
   * a suffix on each body. Written out five times before this, which is five places for a template
   * to acquire a subject in the recipient's locale and a body in `en`.
   *
   * The suffixes are passed already resolved rather than as another key, because
   * `sendForgotPassword` only resolves them when `mail.senderName` is set at all.
   */
  private async sendTemplate(
    to: string,
    locale: string | null | undefined,
    key: string,
    params: Record<string, string>,
    { textSuffix = '', htmlSuffix = '' }: { textSuffix?: string; htmlSuffix?: string } = {}
  ): Promise<void> {
    await this.send({
      to,
      subject: await WIKI.models.locales.resolveString(locale, `mail.${key}.subject`),
      text:
        (await WIKI.models.locales.resolveString(locale, `mail.${key}.text`, params)) + textSuffix,
      html:
        (await WIKI.models.locales.resolveString(locale, `mail.${key}.html`, params)) + htmlSuffix
    })
  }

  /**
   * Email verification link, sent on self-registration when the local strategy's `emailValidation`
   * setting is on. Links at `/auth/verify/:token`, consumed by the public verify route.
   *
   * @param locale The recipient's `users.prefs.locale`, if known — falls back to `en` when unset or
   *   not installed (see `models/locales.ts#resolveString`). A brand-new self-registering user has
   *   no saved preference yet, so callers on that path pass nothing.
   */
  async sendVerifyEmail({
    to,
    name,
    token,
    locale
  }: {
    to: string
    name: string
    token: string
    locale?: string | null
  }): Promise<void> {
    const link = this.buildLink(`/auth/verify/${token}`)
    await this.sendTemplate(to, locale, 'verifyEmail', { name, link })
  }

  /**
   * Password reset link, sent by a forgot-password request. Links at `/login/reset-password/:token`,
   * the frontend screen that collects a new password and submits it against the reset token. This is
   * the request-side email — distinct from {@link sendPasswordResetConfirmed}, which is the
   * after-the-fact notice sent once the reset actually completes.
   *
   * The "24 hours" in the copy below must be kept in sync with the token TTL set by
   * `models/users.ts#generateToken` — there is no shared constant, since that TTL is a single flat
   * value applied to every token kind, not something specific to `resetPwd` alone.
   *
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}.
   */
  async sendForgotPassword({
    to,
    name,
    token,
    locale
  }: {
    to: string
    name: string
    token: string
    locale?: string | null
  }): Promise<void> {
    const link = this.buildLink(`/login/reset-password/${token}`)
    const cfg = WIKI.config.mail ?? {}
    const signatureText = cfg.senderName
      ? await WIKI.models.locales.resolveString(locale, 'mail.signature.text', {
          name: cfg.senderName
        })
      : ''
    const signatureHtml = cfg.senderName
      ? await WIKI.models.locales.resolveString(locale, 'mail.signature.html', {
          name: cfg.senderName
        })
      : ''
    await this.sendTemplate(
      to,
      locale,
      'forgotPassword',
      { name, link },
      { textSuffix: signatureText, htmlSuffix: signatureHtml }
    )
  }

  /**
   * Welcome email sent when an administrator creates a local-strategy user with `sendWelcomeEmail`
   * set (`POST /_api/users`). Links at the same `/login/reset-password/:token` screen
   * {@link sendForgotPassword} uses, built from a fresh `resetPwd` token rather than emailing the
   * password the admin chose in plaintext — the new user sets their own password on first login.
   * The "24 hours" copy is kept in sync with `models/users.ts#generateToken`'s token TTL, the same
   * caveat {@link sendForgotPassword} documents.
   *
   * @param siteId The site to link at (`sendWelcomeEmailFromSiteId` on the create-user request) —
   *   see {@link resolveMailBaseURL}. Falls back to `WIKI.config.mail.defaultBaseURL` when omitted
   *   or unresolvable, same as every other siteId-scoped send.
   * @param locale A brand-new user has no `users.prefs.locale` of their own yet (they have never
   *   logged in) — unlike every other template here, there is no recipient preference to thread, so
   *   this always resolves in `en` unless a future caller has some other locale to suggest.
   */
  async sendWelcomeEmail({
    to,
    name,
    token,
    siteId,
    locale
  }: {
    to: string
    name: string
    token: string
    siteId?: string
    locale?: string | null
  }): Promise<void> {
    const link = this.buildLink(`/login/reset-password/${token}`, this.resolveMailBaseURL(siteId))
    await this.sendTemplate(to, locale, 'welcomeEmail', { name, link })
  }

  /**
   * Notice sent after a password reset completes, so the account owner has a record of it even if
   * they weren't the one who did it.
   *
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}.
   */
  async sendPasswordResetConfirmed({
    to,
    name,
    locale
  }: {
    to: string
    name: string
    locale?: string | null
  }): Promise<void> {
    const link = this.buildLink('/login')
    await this.sendTemplate(to, locale, 'passwordChanged', { name, link })
  }

  /**
   * Notice sent to an address's real, already-verified owner when someone else attempts to register
   * a new account with it. `models/users.ts#register()` sends this -- and answers the attempt itself
   * with the same generic `{ nextAction: 'verify' }` a genuinely new registration gets -- instead of
   * throwing `ERR_EMAIL_ALREADY_EXISTS`, which is what would otherwise let an unauthenticated caller
   * confirm whether a given address already has an account here.
   *
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}.
   */
  async sendRegistrationAttemptNotice({
    to,
    name,
    locale
  }: {
    to: string
    name: string
    locale?: string | null
  }): Promise<void> {
    const link = this.buildLink('/login')
    await this.sendTemplate(to, locale, 'registrationAttempt', { name, link })
  }

  /**
   * Sent by the admin area's "Send Test Email" action to confirm the current `WIKI.config.mail`
   * settings can actually reach an inbox. Includes the instance's `defaultBaseURL` so the recipient
   * can also confirm that setting is correct — the same value {@link buildLink} stitches onto every
   * other template's links — rather than just proving SMTP connectivity in isolation.
   *
   * @param locale The requesting admin's own `users.prefs.locale`, if known — there is no separate
   *   "recipient" here (the `to` address is whatever the admin typed into the send-test-email
   *   dialog), so the sender's own preference is what's threaded through.
   */
  async sendTestEmail({ to, locale }: { to: string; locale?: string | null }): Promise<void> {
    const baseURL = WIKI.config.mail?.defaultBaseURL
    const baseURLText = baseURL
      ? await WIKI.models.locales.resolveString(locale, 'mail.testEmail.baseURLConfigured.text', {
          url: baseURL
        })
      : await WIKI.models.locales.resolveString(locale, 'mail.testEmail.baseURLMissing')
    const baseURLHtml = baseURL
      ? await WIKI.models.locales.resolveString(locale, 'mail.testEmail.baseURLConfigured.html', {
          url: baseURL
        })
      : await WIKI.models.locales.resolveString(locale, 'mail.testEmail.baseURLMissing')
    await this.send({
      to,
      subject: await WIKI.models.locales.resolveString(locale, 'mail.testEmail.subject'),
      text: await WIKI.models.locales.resolveString(locale, 'mail.testEmail.text', { baseURLText }),
      html: await WIKI.models.locales.resolveString(locale, 'mail.testEmail.html', { baseURLHtml })
    })
  }

  /**
   * Minimal, generic notification sent by `tasks/simple/notify-event-subscription-subscribers.ts`
   * for one user subscribed to an event (`models/eventSubscriptions.ts`), whenever
   * `models/hooks.ts#emit()` fires it — the per-user counterpart to the site-configured webhook
   * `hooks` deliver instead. Deliberately
   * a single generic template rather than one per event: richer, per-event-type copy is separately-
   * tracked follow-on work (Feature #2425's "email transport/templating" child), and this exists to
   * prove the subscribe → trigger → send path end to end, not to be the final reader-facing copy.
   *
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}.
   */
  async sendEventSubscriptionNotification({
    to,
    event,
    locale
  }: {
    to: string
    event: string
    locale?: string | null
  }): Promise<void> {
    await this.sendTemplate(to, locale, 'eventSubscription', { event })
  }

  /**
   * The content one page-watch change contributes to an email — a single line describing who did
   * what to which page, with the summary and a link back to it. The shared building block behind
   * both `sendPageWatchNotification` (one change, sent alone) and `sendPageWatchDigest` (several
   * changes, one per line): the digest job composes its email out of exactly this per-event content
   * rather than re-deriving the phrasing, so the two templates can never drift apart on how a change
   * is described.
   *
   * Every value here — page title/path, `changedFields`, `actorName` — is expected to be exactly
   * what was captured on the `pageWatchEvents` row when the change was recorded, not looked up now:
   * by the time either template actually sends, a `deleted` page (and the `pageWatching` row a
   * watcher's preference came from) can already be gone, same reasoning as
   * `db/schema.ts#pageWatchEvents`'s own comment.
   *
   * @param page.path Composed into a locale-aware link the same way `models/pageWatching.ts#WatchedPage`'s
   *   own link does (`InboxWatching.vue`'s `openPage`/`openNotification`, via `localizedPagePath`) —
   *   the wiki's page route DOES carry a locale segment for a non-primary locale, so `page.locale` and
   *   the site's `locales` config (resolved by the caller) are both required here.
   * @param locales The originating site's locale routing config, resolved by the caller
   *   (`sendPageWatchNotification` / `sendPageWatchDigest`) from `WIKI.sites[siteId]`, since a
   *   `pageWatchEvents` row outlives the page but the site config does not need re-resolving per row.
   * @param baseURL The link's host, resolved by the caller via {@link resolveMailBaseURL} for the
   *   same reason as `locales` — once per send, from the one `siteId` every item in a send shares.
   */
  private async renderWatchEventLine(
    { page, action, changedFields, actorName }: WatchEventItem,
    locales: LocaleRoutingConfig | null | undefined,
    baseURL: string,
    locale?: string | null
  ): Promise<{
    text: string
    html: string
  }> {
    const label = await watchActionLabel(action, locale)
    const summary = changedFields.length > 0 ? `${label}: ${changedFields.join(', ')}` : label
    const link = this.buildLink(localizedPagePath(page.path, page.locale, locales), baseURL)
    const safeTitle = escapeHtml(page.title)
    const safeActor = escapeHtml(actorName)
    const safeSummary = escapeHtml(summary)
    return {
      text: await WIKI.models.locales.resolveString(locale, 'mail.watchEventLine.text', {
        actor: actorName,
        label,
        title: page.title,
        summary,
        link
      }),
      html: await WIKI.models.locales.resolveString(locale, 'mail.watchEventLine.html', {
        actor: safeActor,
        label,
        title: safeTitle,
        summary: safeSummary,
        link
      })
    }
  }

  /**
   * Immediate page-watch notification, sent by `tasks/simple/notify-page-watchers.ts` for one
   * watcher whose preference is `immediate` (see `models/pageWatching.ts#WatchNotifyMode`). One email
   * per change per watcher — `sendPageWatchDigest` is what batches several changes into one message
   * for a `digest`-mode watcher instead, built from the same `renderWatchEventLine` content.
   *
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}.
   */
  async sendPageWatchNotification({
    to,
    siteId,
    page,
    action,
    changedFields,
    actorName,
    locale
  }: {
    to: string
    siteId: string
    page: { title: string; path: string; locale: string }
    action: PageWatchNotifiableAction
    changedFields: string[]
    actorName: string
    locale?: string | null
  }): Promise<void> {
    const locales = WIKI.sites[siteId]?.config?.locales
    const baseURL = this.resolveMailBaseURL(siteId)
    const label = await watchActionLabel(action, locale)
    const line = await this.renderWatchEventLine(
      { page, action, changedFields, actorName },
      locales,
      baseURL,
      locale
    )
    // -> A submission-decision notice (see `isSuggestionDecision`) is addressed directly at the
    //    author, not resolved from `pageWatching.listWatchers()` -- the ordinary "you are watching
    //    this page" footer would be false for them, so it gets its own locale string instead.
    const footer = await WIKI.models.locales.resolveString(
      locale,
      isSuggestionDecision(action)
        ? 'mail.watchNotification.footerSuggestion'
        : 'mail.watchNotification.footer'
    )
    await this.send({
      to,
      subject: await WIKI.models.locales.resolveString(locale, 'mail.watchNotification.subject', {
        label,
        title: page.title
      }),
      text: `${line.text}\n\n${footer}`,
      html: `<p>${line.html}</p><p>${footer}</p>`
    })
  }

  /**
   * Digest notification, sent by `tasks/simple/send-watch-digests.ts` for a `digest`-mode watcher's
   * accumulated pending changes, batched across every page they watch into a single email — one line
   * per change, built from the same `renderWatchEventLine` content `sendPageWatchNotification` sends
   * alone, so the two templates read consistently without duplicating how a change is phrased.
   *
   * @param siteId Every item in one digest send is scoped to a single site — `send-watch-digests.ts`
   *   groups pending events by `(userId, siteId)`, not `userId` alone, precisely so this always holds;
   *   resolving `locales` once per send rather than once per item is what that grouping buys.
   * @param items At least one — the caller (the digest job) is what turns "no pending events this
   *   cycle" into skipping the send entirely, not this method turning an empty list into an empty
   *   email. Order is preserved as given (the caller's own chronological order).
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}. The
   *   digest subject is a plural message (`models/locales.ts#resolvePluralString`) rather than the
   *   `${count === 1 ? '' : 's'}` concatenation this replaced, which cannot be correct in every
   *   language `backend/locales/metadata.js` ships (`ar`, `pl`, `ru`, ...).
   */
  async sendPageWatchDigest({
    to,
    siteId,
    items,
    locale
  }: {
    to: string
    siteId: string
    items: WatchEventItem[]
    locale?: string | null
  }): Promise<void> {
    const locales = WIKI.sites[siteId]?.config?.locales
    const baseURL = this.resolveMailBaseURL(siteId)
    const lines = await Promise.all(
      items.map((item) => this.renderWatchEventLine(item, locales, baseURL, locale))
    )
    const count = items.length
    const subject = await WIKI.models.locales.resolvePluralString(
      locale,
      'mail.watchDigest.subject',
      count
    )
    const footer = await WIKI.models.locales.resolveString(locale, 'mail.watchDigest.footer')
    const text = lines.map((line) => `- ${line.text}`).join('\n')
    const html = `<ul>${lines.map((line) => `<li>${line.html}</li>`).join('')}</ul>`
    await this.send({
      to,
      subject,
      text: `${text}\n\n${footer}`,
      html: `${html}<p>${footer}</p>`
    })
  }

  /**
   * Sent to a user subscribed (`prefs.notifications.events`, see
   * `models/users.ts#listEmailSubscribers`) to an event type, when `models/hooks.ts#Hooks.emit()`
   * fires it — the email half of the same fan-out `dispatchWebhook` already gets, queued by
   * `tasks/simple/notify-event-subscribers.ts`.
   *
   * Deliberately generic across every `HookEvent`: the events this fires for carry different `data`
   * shapes (a page/asset event has `path`; a comment event has `pageId` but no `path`; a user or
   * approval event varies again), so this reads only what's universally safe to assume —
   * `data.metadata?.title` (present on the events that pass one) or `data.path` for what the event
   * was about, never a shape specific to one event family. A richer, per-event-family template is
   * OpenProject #2483's scope, not this method's.
   *
   * @param siteId The site the event happened on, or null for a site-less event (`user:*`) — see
   *   `Hooks.emit()`'s own doc comment for what that distinction means there. Resolves the link and
   *   the "site" label the same way {@link resolveMailBaseURL} resolves every other siteId-scoped
   *   send.
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}.
   */
  async sendEventNotification({
    to,
    event,
    siteId,
    data,
    locale
  }: {
    to: string
    event: HookEvent
    siteId: string | null
    data: Record<string, unknown>
    locale?: string | null
  }): Promise<void> {
    const label = await WIKI.models.locales.resolveString(
      locale,
      `mail.notificationEventLabel.${event}`
    )
    const metadata = (data.metadata ?? {}) as Record<string, unknown>
    const subjectMatter =
      typeof metadata.title === 'string'
        ? metadata.title
        : typeof data.path === 'string'
          ? data.path
          : null
    const siteName = (siteId ? WIKI.sites[siteId]?.config?.title : null) || 'Wiki'
    const baseURL = this.resolveMailBaseURL(siteId ?? undefined)
    const link = typeof data.path === 'string' ? this.buildLink(`/${data.path}`, baseURL) : baseURL
    const detailText = subjectMatter ? ` (${subjectMatter})` : ''
    const detailHtml = subjectMatter ? ` (${escapeHtml(subjectMatter)})` : ''

    await this.send({
      to,
      subject: await WIKI.models.locales.resolveString(locale, 'mail.notificationEvent.subject', {
        label,
        site: siteName
      }),
      text:
        (await WIKI.models.locales.resolveString(locale, 'mail.notificationEvent.text', {
          label,
          site: siteName,
          detail: detailText,
          link
        })) +
        '\n\n' +
        (await WIKI.models.locales.resolveString(locale, 'mail.notificationEvent.footer', {
          label
        })),
      html:
        (await WIKI.models.locales.resolveString(locale, 'mail.notificationEvent.html', {
          label,
          site: escapeHtml(siteName),
          detail: detailHtml,
          link
        })) +
        `<p>${await WIKI.models.locales.resolveString(locale, 'mail.notificationEvent.footer', { label })}</p>`
    })
  }

  /**
   * Notification-event email — the templating half of Feature #2425's per-user, per-event-type
   * subscriptions (OpenProject #2483). `event` is one of `models/hooks.ts#HOOK_EVENTS`, the same
   * vocabulary webhooks already dispatch on: the Feature's own scope is to extend that existing
   * trigger infrastructure to also emit email rather than invent a parallel one, so this template
   * reuses it too instead of declaring its own event names. Nothing calls this yet — resolving which
   * users are subscribed to which event (per-user storage) and firing this from the trigger points
   * themselves is #2481/#2482's job, not this template's. #2481/#2482 landed their own, simpler
   * {@link sendEventNotification} (wired from `tasks/simple/notify-event-subscribers.ts`) before this
   * method's branch merged, rather than waiting on this richer templating — so this method has no
   * caller yet, and its own `mail.notificationEvent.templateFooter` locale key is deliberately
   * distinct from {@link sendEventNotification}'s `mail.notificationEvent.footer` (different call
   * signature, different wording) to avoid colliding with it in `en.json`.
   *
   * Deliberately takes structured fields (`title`/`path`/`pageLocale`/`actorName`) rather than the
   * raw webhook payload `models/hooks.ts#emit()` receives: what identifies "the thing this happened
   * to" differs per event (a page carries `path`, an asset carries `folderPath`+`fileName`, a comment
   * carries a `pageId`, a user event carries neither), so the caller — which already knows which
   * event it's resolving — picks the human-facing title/link path, keeping this template decoupled
   * from every event's own payload shape.
   *
   * `title`/`path` are coupled in practice (both come from "is there a page/thing to point at"), so
   * there are only two body variants: with a target (title + link) or without one (`user:join`/
   * `user:login`/`user:logout`, which have neither) — not a combinatorial set per optional field.
   *
   * @param path A page-relative path (e.g. a page's `path`) to link at, when there is one. Routed
   *   through `localizedPagePath` exactly like {@link sendPageWatchNotification}'s link, so a
   *   non-primary-locale page still links with its locale prefix.
   * @param pageLocale The linked page's own locale, required to build a correct link when `locales`
   *   has more than one active locale — see `pageLocale` on {@link WatchEventItem.page}.
   * @param actorName Who did it, if the caller resolved one (e.g. from `data.authorId`). Falls back
   *   to `mail.notificationEvent.unknownActor` ("Someone") rather than an empty subject/body — every
   *   event this covers has an actor in principle, but a caller may not always have resolved a name
   *   for one (a deleted account, a guest with no display name captured).
   * @param locale The recipient's `users.prefs.locale`, if known — see {@link sendVerifyEmail}.
   */
  async sendNotificationEvent({
    to,
    event,
    siteId,
    title,
    path,
    pageLocale,
    actorName,
    locale
  }: {
    to: string
    event: HookEvent
    siteId?: string | null
    title?: string | null
    path?: string | null
    pageLocale?: string | null
    actorName?: string | null
    locale?: string | null
  }): Promise<void> {
    const label = await WIKI.models.locales.resolveString(
      locale,
      `mail.notificationEvent.${event}.label`
    )
    const actor =
      actorName ||
      (await WIKI.models.locales.resolveString(locale, 'mail.notificationEvent.unknownActor'))
    const target = title ?? path ?? null

    let link: string | null = null
    if (path) {
      const locales = siteId ? WIKI.sites[siteId]?.config?.locales : null
      const baseURL = this.resolveMailBaseURL(siteId ?? undefined)
      link = this.buildLink(
        pageLocale ? localizedPagePath(path, pageLocale, locales) : path,
        baseURL
      )
    }

    const subject = target
      ? await WIKI.models.locales.resolveString(
          locale,
          'mail.notificationEvent.subjectWithTarget',
          {
            label,
            target
          }
        )
      : await WIKI.models.locales.resolveString(locale, 'mail.notificationEvent.subjectPlain', {
          label
        })

    const footer = await WIKI.models.locales.resolveString(
      locale,
      'mail.notificationEvent.templateFooter'
    )
    let text: string
    let html: string
    if (target && link) {
      text = await WIKI.models.locales.resolveString(
        locale,
        'mail.notificationEvent.bodyWithTarget.text',
        {
          actor,
          label,
          target,
          link
        }
      )
      html = await WIKI.models.locales.resolveString(
        locale,
        'mail.notificationEvent.bodyWithTarget.html',
        {
          actor: escapeHtml(actor),
          label,
          target: escapeHtml(target),
          link
        }
      )
    } else {
      text = await WIKI.models.locales.resolveString(
        locale,
        'mail.notificationEvent.bodyPlain.text',
        {
          actor,
          label
        }
      )
      html = await WIKI.models.locales.resolveString(
        locale,
        'mail.notificationEvent.bodyPlain.html',
        {
          actor: escapeHtml(actor),
          label
        }
      )
    }

    await this.send({
      to,
      subject,
      text: `${text}\n\n${footer}`,
      html: `<p>${html}</p><p>${footer}</p>`
    })
  }
}

export const mail = new MailModel()
