import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type Mail from 'nodemailer/lib/mailer/index.js'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'
import type { HookEvent } from './hooks.ts'
import { localizedPagePath, type LocaleRoutingConfig } from '../helpers/localeRouting.ts'
import { generateHash } from '../helpers/common.ts'
import { coalesce } from '../helpers/logCoalesce.ts'

/**
 * Which transactional message a send is: one member per `send*` wrapper below, plus `approval` and
 * `commentMention` for the templates composed outside this file (`models/approvalNotifications.ts`,
 * `models/commentNotifications.ts`). It is what `kind=` says on every mail log line, and a closed union is what keeps that field countable.
 *
 * Not the failure category — `classifyMailError`'s verdict is a different question, on its own
 * `failure=` field.
 */
export type MailKind =
  | 'verify'
  | 'forgotPassword'
  | 'welcome'
  | 'passwordChanged'
  | 'registrationAttempt'
  | 'test'
  | 'watch'
  | 'digest'
  | 'notificationEvent'
  | 'approval'
  | 'commentMention'
  | 'tfaEnabled'
  | 'tfaDisabled'
  | 'tfaRecoveryCodesGenerated'
  | 'tfaNewDeviceLogin'
  | 'signInMethodRemoved'

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  kind: MailKind
  /**
   * Optional because not every send has a user behind it — the admin's "Send Test Email" goes to
   * whatever address was typed into the dialog. Absent, the log falls back to
   * {@link recipientRef}'s hash of the address, never to the address itself.
   */
  userId?: string
}

/**
 * How long one `mail:unconfigured` coalescing window stays open. There is no "the calling job just
 * finished" hook to flush against, so it is a fixed window: long enough that a digest fan-out on an
 * unconfigured instance collapses into one or two lines rather than hundreds, short enough that an
 * operator who has just typed in an SMTP host is not left waiting on a stale count.
 */
export const MAIL_UNCONFIGURED_LOG_WINDOW_MS = 60_000

const MAIL_UNCONFIGURED_LOG_KEY = 'mail:unconfigured'

/**
 * Enough of the address hash to correlate two lines about the same recipient, not enough to be
 * worth attacking back into the address — the point is correlation, not identification.
 */
const ADDRESS_REF_LENGTH = 12

/**
 * What `to=` says on a mail log line. An e-mail address is an identity and never reaches the log; a
 * stable hash still lets an operator follow one recipient across two lines.
 */
export function recipientRef(address: string, userId?: string): string {
  if (userId) {
    return userId
  }
  return generateHash(address.trim().toLowerCase()).slice(0, ADDRESS_REF_LENGTH)
}

/**
 * `send()` cannot know whether its own caller will retry — the notification tasks rethrow so the
 * scheduler retries them, `models/login.ts`'s notices swallow and move on — so the level is decided
 * by whether a retry could plausibly help instead. A `connection` failure (socket refused, DNS,
 * timeout) is the transient family; everything else is a standing fault the next attempt hits in
 * exactly the same way, and an operator has to act on it rather than wait it out.
 */
export function mailFailureLevel(failure: ReturnType<typeof classifyMailError>): 'warn' | 'error' {
  return failure === 'connection' ? 'warn' : 'error'
}

/** Verb form of a notifiable action, for the summary phrasing (e.g. `edited: title, content`). */
async function watchActionLabel(
  action: PageWatchNotifiableAction,
  locale?: string | null
): Promise<string> {
  return CARDINAL.models.locales.resolveString(locale, `mail.watchAction.${action}`)
}

/**
 * Whether this action tells the recipient about the outcome of THEIR OWN edit suggestion rather than
 * about a page they watch. The two need different footers: the ordinary "you are receiving this
 * because you are watching this page" line would be false for a submission author who may never
 * have watched the page at all.
 */
function isSuggestionDecision(action: PageWatchNotifiableAction): boolean {
  return action === 'suggestApproved' || action === 'suggestDeclined'
}

/**
 * Escape the four HTML metacharacters, for values that land in a template's HTML body but did not
 * come from this file — a page title or a display name is content a wiki editor chose.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export interface WatchEventItem {
  page: { title: string; path: string; locale: string }
  action: PageWatchNotifiableAction
  changedFields: string[]
  actorName: string
}

/**
 * Classify a failed send by nodemailer's `err.code`; the codes come from
 * `nodemailer/lib/smtp-connection`, the only transport this model uses.
 *
 * `'tls'` is split out from `'connection'` on purpose: `smtp-connection` reports a rejected
 * certificate (`ETLS`, whether hit on the implicit-TLS handshake or on `STARTTLS`) as a
 * connection-stage error too, yet the two call for different admin action — "check the certificate,
 * or enable Verify SSL Certificate" rather than "check the host and port".
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
 * Builds one `nodemailer` SMTP transporter from `CARDINAL.config.mail` and exposes a generic `send()`
 * plus the transactional templates. Every subject and body is a `mail.*` key in
 * `backend/locales/en.json`, resolved for the `locale` each send method accepts (typically the
 * recipient's `users.prefs.locale`, `en` as the fallback); there is deliberately no DB-backed,
 * admin-editable template system, and no table to back one.
 *
 * `getTransporter()` re-reads the config on every call and rebuilds only when the resulting options
 * differ, compared by a cheap JSON snapshot: an admin config edit takes effect on the very next
 * email, without the connection-pool churn of recreating the nodemailer object when nothing changed.
 */
class MailModel {
  private transporter: Mail<SMTPTransport.SentMessageInfo> | null = null
  private transporterSnapshot: string | null = null

  /**
   * A `helpers/logCoalesce.ts` summary carries a count and nothing about the events themselves, so
   * the one detail the refusal line wants beyond the count is accumulated here and cleared when the
   * window closes.
   */
  private unconfiguredKinds = new Set<MailKind>()

  /** Only `host` is required to build a transporter — nodemailer accepts everything else absent. */
  isConfigured(): boolean {
    return Boolean(CARDINAL.config.mail?.host)
  }

  buildTransportOptions(): SMTPTransport.Options {
    const cfg = CARDINAL.config.mail ?? {}
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
   * Count one refused-because-unconfigured send; the summary reports the total once the window
   * closes. An unconfigured instance refuses EVERY send, so `threshold: 0` folds every call into
   * that summary rather than turning a nightly digest fan-out into one `warn` per recipient. The
   * count is the operator-facing fact, not the individual attempt.
   */
  private noteUnconfiguredDrop(kind?: MailKind): void {
    if (kind) {
      this.unconfiguredKinds.add(kind)
    }
    // -> Snapshotted per call, not read inside the callback: `coalesce` keeps the most recent
    //    call's `emit`, and the clear below is what makes the NEXT window start empty.
    const kinds = [...this.unconfiguredKinds].join(',')
    coalesce(
      MAIL_UNCONFIGURED_LOG_KEY,
      MAIL_UNCONFIGURED_LOG_WINDOW_MS,
      (summary) => {
        this.unconfiguredKinds.clear()
        CARDINAL.logger.warn('mail', `not configured, dropped ${summary.total} notifications`, {
          dropped: summary.total,
          kinds: kinds || undefined
        })
      },
      { threshold: 0 }
    )
  }

  /**
   * @param kind Which message wanted a transport, for the refusal summary's `kinds=`. Optional so a
   *   caller that only wants to know whether a transport can be built need not invent one.
   * @throws `ERR_MAIL_NOT_CONFIGURED` when no SMTP host is set — coalesced rather than logged per
   *   attempt, because on an unconfigured instance it is EVERY attempt.
   */
  getTransporter(kind?: MailKind): Mail<SMTPTransport.SentMessageInfo> {
    if (!this.isConfigured()) {
      this.noteUnconfiguredDrop(kind)
      throw new Error('ERR_MAIL_NOT_CONFIGURED')
    }
    const options = this.buildTransportOptions()
    const snapshot = JSON.stringify(options)
    if (!this.transporter || this.transporterSnapshot !== snapshot) {
      this.transporter = nodemailer.createTransport(options)
      this.transporterSnapshot = snapshot
      // -> `built`, not `connected`: nodemailer's `createTransport` opens no socket, it just holds
      //    the options until the first `sendMail`. The fields are what a misconfigured SMTP setup
      //    is diagnosed from — the settings actually in force after the config merge.
      CARDINAL.logger.debug('mail', 'transport built', {
        host: options.host,
        port: options.port,
        secure: options.secure
      })
    }
    return this.transporter
  }

  /**
   * Both outcomes reach the log, because "did the digest actually go out" is not answerable from a
   * log that only speaks up when something breaks. A failure also carries `failure=`, the
   * {@link classifyMailError} category, so a log search can tell the four apart.
   */
  async send({ to, subject, html, text, kind, userId }: MailMessage): Promise<void> {
    const transporter = this.getTransporter(kind)
    const cfg = CARDINAL.config.mail ?? {}
    const senderEmail = cfg.senderEmail || cfg.user
    const recipient = recipientRef(to, userId)
    try {
      await transporter.sendMail({
        from: cfg.senderName ? { name: cfg.senderName, address: senderEmail } : senderEmail,
        to,
        subject,
        html,
        text
      })
    } catch (err: any) {
      const failure = classifyMailError(err)
      CARDINAL.logger[mailFailureLevel(failure)]('mail', 'delivery failed', {
        kind,
        to: recipient,
        failure,
        error: err
      })
      throw err
    }
    CARDINAL.logger.info('mail', 'sent', { kind, to: recipient })
  }

  /**
   * Build `<base><path>` without a doubled-up slash. Every template link goes through this, so a
   * missing base produces an obviously-relative (and obviously wrong) link rather than a silently
   * broken one.
   *
   * @param baseURL Overrides `CARDINAL.config.mail.defaultBaseURL`, so a send scoped to one site links
   *   at that site's own hostname — see {@link resolveMailBaseURL}.
   */
  buildLink(path: string, baseURL?: string): string {
    const base = (baseURL ?? CARDINAL.config.mail?.defaultBaseURL ?? '').replace(/\/+$/, '')
    return `${base}${path}`
  }

  /**
   * `https://<site hostname>` for a real site, or `CARDINAL.config.mail.defaultBaseURL` when there is
   * no site to ask (no `siteId`, an unresolvable one) or the site is the `*` catch-all, which has no
   * hostname of its own to link at. No per-site scheme/port override exists — `https://` is assumed,
   * matching how every other site link is built.
   */
  resolveMailBaseURL(siteId?: string): string {
    const hostname = siteId ? CARDINAL.sites[siteId]?.hostname : null
    if (hostname && hostname !== '*') {
      return `https://${hostname}`
    }
    return CARDINAL.config.mail?.defaultBaseURL ?? ''
  }

  /**
   * Whether ANY link this model could build would resolve to a real host: `defaultBaseURL` is set,
   * or at least one site has a real (non-`*`) hostname. Distinct from {@link isConfigured}, which
   * only asks whether SMTP itself is reachable.
   */
  hasResolvableBaseURL(): boolean {
    if (CARDINAL.config.mail?.defaultBaseURL) {
      return true
    }
    return Object.values(CARDINAL.sites ?? {}).some(
      (site: any) => site?.hostname && site.hostname !== '*'
    )
  }

  /**
   * Resolve one `mail.<key>.{subject,text,html}` trio for a locale and send it.
   *
   * The suffixes are passed already resolved rather than as another key, because
   * `sendForgotPassword` only resolves them when `mail.senderName` is set at all.
   */
  private async sendTemplate(
    to: string,
    locale: string | null | undefined,
    key: string,
    params: Record<string, string>,
    {
      kind,
      userId,
      textSuffix = '',
      htmlSuffix = ''
    }: { kind: MailKind; userId?: string; textSuffix?: string; htmlSuffix?: string }
  ): Promise<void> {
    await this.send({
      to,
      kind,
      userId,
      subject: await CARDINAL.models.locales.resolveString(locale, `mail.${key}.subject`),
      text:
        (await CARDINAL.models.locales.resolveString(locale, `mail.${key}.text`, params)) +
        textSuffix,
      html:
        (await CARDINAL.models.locales.resolveString(locale, `mail.${key}.html`, params)) +
        htmlSuffix
    })
  }

  /**
   * Email verification link, sent on self-registration when the local strategy's `emailValidation`
   * setting is on.
   *
   * @param locale The recipient's `users.prefs.locale`, if known — a brand-new self-registering
   *   user has none yet, so callers on that path pass nothing and it resolves in `en`.
   */
  async sendVerifyEmail({
    to,
    name,
    token,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    token: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink(`/auth/verify/${token}`, this.resolveMailBaseURL(siteId))
    await this.sendTemplate(to, locale, 'verifyEmail', { name, link }, { kind: 'verify', userId })
  }

  /**
   * Password reset link, sent by a forgot-password request — the request-side email, distinct from
   * {@link sendPasswordResetConfirmed}, the after-the-fact notice once a reset completes.
   *
   * The "24 hours" in the copy must be kept in sync with the token TTL set by
   * `models/userCredentials.ts#generateToken` — there is no shared constant, since that TTL is a
   * single flat value applied to every token kind, not something specific to `resetPwd`.
   */
  async sendForgotPassword({
    to,
    name,
    token,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    token: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink(`/login/reset-password/${token}`, this.resolveMailBaseURL(siteId))
    const cfg = CARDINAL.config.mail ?? {}
    const signatureText = cfg.senderName
      ? await CARDINAL.models.locales.resolveString(locale, 'mail.signature.text', {
          name: cfg.senderName
        })
      : ''
    const signatureHtml = cfg.senderName
      ? await CARDINAL.models.locales.resolveString(locale, 'mail.signature.html', {
          name: cfg.senderName
        })
      : ''
    await this.sendTemplate(
      to,
      locale,
      'forgotPassword',
      { name, link },
      { kind: 'forgotPassword', userId, textSuffix: signatureText, htmlSuffix: signatureHtml }
    )
  }

  /**
   * Welcome email for an administrator-created local-strategy user. Links at the same
   * `/login/reset-password/:token` screen {@link sendForgotPassword} uses, built from a fresh
   * `resetPwd` token rather than emailing the password the admin chose in plaintext — the new user
   * sets their own password on first login. Its "24 hours" copy carries the same TTL-sync caveat
   * {@link sendForgotPassword} documents.
   *
   * @param locale A brand-new user has no `users.prefs.locale` of their own yet, so this resolves
   *   in `en` unless a caller has some other locale to suggest.
   */
  async sendWelcomeEmail({
    to,
    name,
    token,
    siteId,
    userId,
    locale
  }: {
    to: string
    name: string
    token: string
    siteId?: string
    userId?: string
    locale?: string | null
  }): Promise<void> {
    const link = this.buildLink(`/login/reset-password/${token}`, this.resolveMailBaseURL(siteId))
    await this.sendTemplate(to, locale, 'welcomeEmail', { name, link }, { kind: 'welcome', userId })
  }

  /**
   * Notice sent after a password reset completes, so the account owner has a record of it even if
   * they weren't the one who did it.
   */
  async sendPasswordResetConfirmed({
    to,
    name,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink('/login', this.resolveMailBaseURL(siteId))
    await this.sendTemplate(
      to,
      locale,
      'passwordChanged',
      { name, link },
      { kind: 'passwordChanged', userId }
    )
  }

  /**
   * Notice sent to the account holder once 2FA has been turned ON for one of their authentication
   * providers. A security notice, not a setup-flow email: the recovery codes are shown to the user
   * in-flow at the moment they are issued, and are never repeated here.
   */
  async sendTfaEnabled({
    to,
    name,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink('/login', this.resolveMailBaseURL(siteId))
    await this.sendTemplate(
      to,
      locale,
      'tfaEnabled',
      { name, link },
      { kind: 'tfaEnabled', userId }
    )
  }

  /**
   * Notice sent to the account holder once 2FA has been turned OFF for one of their authentication
   * providers. Their own choice (`userCredentials.ts#disableTfa()`) and an administrator's override
   * (`adminInvalidateTfa()`) send the identical notice: from the account holder's point of view 2FA
   * is off either way, and they should know whoever initiated it.
   */
  async sendTfaDisabled({
    to,
    name,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink('/login', this.resolveMailBaseURL(siteId))
    await this.sendTemplate(
      to,
      locale,
      'tfaDisabled',
      { name, link },
      { kind: 'tfaDisabled', userId }
    )
  }

  /**
   * Notice sent whenever a user's 2FA recovery codes are (re)generated, so the account holder has a
   * record of it even if the action wasn't theirs. Deliberately NOT sent by `adminInvalidateTfa()`,
   * which wipes recovery codes rather than issuing a fresh set.
   */
  async sendTfaRecoveryCodesGenerated({
    to,
    name,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink('/login', this.resolveMailBaseURL(siteId))
    await this.sendTemplate(
      to,
      locale,
      'tfaRecoveryCodesGenerated',
      { name, link },
      { kind: 'tfaRecoveryCodesGenerated', userId }
    )
  }

  async sendSignInMethodRemoved({
    to,
    name,
    methodName,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    methodName: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink('/login', this.resolveMailBaseURL(siteId))
    const key = 'signInMethodRemoved'
    await this.send({
      to,
      kind: 'signInMethodRemoved',
      userId,
      subject: await CARDINAL.models.locales.resolveString(locale, `mail.${key}.subject`),
      text: await CARDINAL.models.locales.resolveString(locale, `mail.${key}.text`, {
        name,
        method: methodName,
        link
      }),
      html: await CARDINAL.models.locales.resolveString(locale, `mail.${key}.html`, {
        name: escapeHtml(name),
        method: escapeHtml(methodName),
        link
      })
    })
  }

  /**
   * Notice sent when a 2FA-gated login completes from a device/IP `models/login.ts`'s fingerprint
   * check has not seen before for this account — never on a login from an already-known one.
   *
   * @param ip Shown so the recipient has something concrete to judge the notice against. Passed
   *   through as-is (may be absent behind a proxy that strips it) rather than blocking the notice
   *   on having one.
   */
  async sendTfaNewDeviceLogin({
    to,
    name,
    ip,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    ip?: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink('/login', this.resolveMailBaseURL(siteId))
    await this.sendTemplate(
      to,
      locale,
      'tfaNewDeviceLogin',
      { name, ip: ip || '(unknown)', link },
      { kind: 'tfaNewDeviceLogin', userId }
    )
  }

  /**
   * Notice sent to an address's real, already-verified owner when someone else attempts to register
   * a new account with it. `models/login.ts#register()` sends this -- and answers the attempt itself
   * with the same generic `{ nextAction: 'verify' }` a genuinely new registration gets -- instead of
   * throwing `ERR_EMAIL_ALREADY_EXISTS`, which is what would otherwise let an unauthenticated caller
   * confirm whether a given address already has an account here.
   */
  async sendRegistrationAttemptNotice({
    to,
    name,
    userId,
    locale,
    siteId
  }: {
    to: string
    name: string
    userId?: string
    locale?: string | null
    siteId?: string
  }): Promise<void> {
    const link = this.buildLink('/login', this.resolveMailBaseURL(siteId))
    await this.sendTemplate(
      to,
      locale,
      'registrationAttempt',
      { name, link },
      { kind: 'registrationAttempt', userId }
    )
  }

  /**
   * Sent by the admin area's "Send Test Email" action. Includes the instance's `defaultBaseURL` —
   * the value {@link buildLink} stitches onto every other template's links — so the recipient can
   * confirm that setting too, rather than just proving SMTP connectivity in isolation.
   *
   * @param locale The requesting admin's own preference: there is no separate "recipient" here, the
   *   `to` address being whatever was typed into the dialog.
   */
  async sendTestEmail({ to, locale }: { to: string; locale?: string | null }): Promise<void> {
    const baseURL = CARDINAL.config.mail?.defaultBaseURL
    const baseURLText = baseURL
      ? await CARDINAL.models.locales.resolveString(
          locale,
          'mail.testEmail.baseURLConfigured.text',
          {
            url: baseURL
          }
        )
      : await CARDINAL.models.locales.resolveString(locale, 'mail.testEmail.baseURLMissing')
    const baseURLHtml = baseURL
      ? await CARDINAL.models.locales.resolveString(
          locale,
          'mail.testEmail.baseURLConfigured.html',
          {
            url: baseURL
          }
        )
      : await CARDINAL.models.locales.resolveString(locale, 'mail.testEmail.baseURLMissing')
    await this.send({
      to,
      kind: 'test',
      subject: await CARDINAL.models.locales.resolveString(locale, 'mail.testEmail.subject'),
      text: await CARDINAL.models.locales.resolveString(locale, 'mail.testEmail.text', {
        baseURLText
      }),
      html: await CARDINAL.models.locales.resolveString(locale, 'mail.testEmail.html', {
        baseURLHtml
      })
    })
  }

  /**
   * The content one page-watch change contributes to an email, shared by
   * {@link sendPageWatchNotification} and {@link sendPageWatchDigest} so the two can never drift
   * apart on how a change is described.
   *
   * Every value here is what was captured on the `pageWatchEvents` row when the change was
   * recorded, not looked up now: by the time either template actually sends, a `deleted` page — and
   * the `pageWatching` row a watcher's preference came from — can already be gone.
   *
   * @param locales The originating site's locale routing config, resolved by the caller once per
   *   send rather than per row: a non-primary-locale page's link carries a locale segment.
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
      text: await CARDINAL.models.locales.resolveString(locale, 'mail.watchEventLine.text', {
        actor: actorName,
        label,
        title: page.title,
        summary,
        link
      }),
      html: await CARDINAL.models.locales.resolveString(locale, 'mail.watchEventLine.html', {
        actor: safeActor,
        label,
        title: safeTitle,
        summary: safeSummary,
        link
      })
    }
  }

  /**
   * Immediate page-watch notification: one email per change per watcher.
   * {@link sendPageWatchDigest} is what batches several changes into one message for a
   * `digest`-mode watcher instead.
   */
  async sendPageWatchNotification({
    to,
    siteId,
    page,
    action,
    changedFields,
    actorName,
    userId,
    locale
  }: {
    to: string
    siteId: string
    page: { title: string; path: string; locale: string }
    action: PageWatchNotifiableAction
    changedFields: string[]
    actorName: string
    userId?: string
    locale?: string | null
  }): Promise<void> {
    const locales = CARDINAL.sites[siteId]?.config?.locales
    const baseURL = this.resolveMailBaseURL(siteId)
    const label = await watchActionLabel(action, locale)
    const line = await this.renderWatchEventLine(
      { page, action, changedFields, actorName },
      locales,
      baseURL,
      locale
    )
    const footer = await CARDINAL.models.locales.resolveString(
      locale,
      isSuggestionDecision(action)
        ? 'mail.watchNotification.footerSuggestion'
        : 'mail.watchNotification.footer'
    )
    await this.send({
      to,
      kind: 'watch',
      userId,
      subject: await CARDINAL.models.locales.resolveString(
        locale,
        'mail.watchNotification.subject',
        {
          label,
          title: page.title
        }
      ),
      text: `${line.text}\n\n${footer}`,
      html: `<p>${line.html}</p><p>${footer}</p>`
    })
  }

  /**
   * Digest notification for a `digest`-mode watcher's accumulated pending changes, batched across
   * every page they watch into a single email — one line per change, built from the same
   * {@link renderWatchEventLine} content a lone notification sends.
   *
   * @param siteId Every item in one digest send is scoped to a single site — the digest job groups
   *   pending events by `(userId, siteId)`, not `userId` alone, precisely so this always holds, and
   *   that is what lets `locales` resolve once per send rather than once per item.
   * @param items At least one — turning "no pending events this cycle" into skipping the send is
   *   the caller's job, not an empty email from here. Order is preserved as given.
   */
  async sendPageWatchDigest({
    to,
    siteId,
    items,
    userId,
    locale
  }: {
    to: string
    siteId: string
    items: WatchEventItem[]
    userId?: string
    locale?: string | null
  }): Promise<void> {
    const locales = CARDINAL.sites[siteId]?.config?.locales
    const baseURL = this.resolveMailBaseURL(siteId)
    const lines = await Promise.all(
      items.map((item) => this.renderWatchEventLine(item, locales, baseURL, locale))
    )
    const count = items.length
    const subject = await CARDINAL.models.locales.resolvePluralString(
      locale,
      'mail.watchDigest.subject',
      count
    )
    const footer = await CARDINAL.models.locales.resolveString(locale, 'mail.watchDigest.footer')
    const text = lines.map((line) => `- ${line.text}`).join('\n')
    const html = `<ul>${lines.map((line) => `<li>${line.html}</li>`).join('')}</ul>`
    await this.send({
      to,
      kind: 'digest',
      userId,
      subject,
      text: `${text}\n\n${footer}`,
      html: `${html}<p>${footer}</p>`
    })
  }

  /**
   * Sent to a user subscribed (`prefs.notifications.events`) to an event type when
   * `models/hooks.ts#Hooks.emit()` fires it — the email half of the same fan-out `dispatchWebhook`
   * already gets.
   *
   * Deliberately generic across every `HookEvent`: the events carry different `data` shapes (a
   * page/asset event has `path`; a comment event has `pageId` but no `path`; a user or approval
   * event varies again), so this reads only what is universally safe — `data.metadata?.title` or
   * `data.path` — and never a shape specific to one event family.
   *
   * @param siteId Null for a site-less event (`user:*`).
   */
  async sendEventNotification({
    to,
    event,
    siteId,
    data,
    userId,
    locale
  }: {
    to: string
    event: HookEvent
    siteId: string | null
    data: Record<string, unknown>
    userId?: string
    locale?: string | null
  }): Promise<void> {
    const label = await CARDINAL.models.locales.resolveString(
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
    const siteName = (siteId ? CARDINAL.sites[siteId]?.config?.title : null) || 'Wiki'
    const baseURL = this.resolveMailBaseURL(siteId ?? undefined)
    const link = typeof data.path === 'string' ? this.buildLink(`/${data.path}`, baseURL) : baseURL
    const detailText = subjectMatter ? ` (${subjectMatter})` : ''
    const detailHtml = subjectMatter ? ` (${escapeHtml(subjectMatter)})` : ''

    await this.send({
      to,
      kind: 'notificationEvent',
      userId,
      subject: await CARDINAL.models.locales.resolveString(
        locale,
        'mail.notificationEvent.subject',
        {
          label,
          site: siteName
        }
      ),
      text:
        (await CARDINAL.models.locales.resolveString(locale, 'mail.notificationEvent.text', {
          label,
          site: siteName,
          detail: detailText,
          link
        })) +
        '\n\n' +
        (await CARDINAL.models.locales.resolveString(locale, 'mail.notificationEvent.footer', {
          label
        })),
      html:
        (await CARDINAL.models.locales.resolveString(locale, 'mail.notificationEvent.html', {
          label,
          site: escapeHtml(siteName),
          detail: detailHtml,
          link
        })) +
        `<p>${await CARDINAL.models.locales.resolveString(locale, 'mail.notificationEvent.footer', { label })}</p>`
    })
  }
}

export const mail = new MailModel()
