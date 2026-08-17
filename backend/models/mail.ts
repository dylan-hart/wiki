import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type Mail from 'nodemailer/lib/mailer/index.js'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'

/** A rendered email, ready to hand to the transporter. */
export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
}

/** Verb form of each notifiable action, for the summary phrasing (e.g. `edited: title, content`). */
const WATCH_ACTION_LABELS: Record<PageWatchNotifiableAction, string> = {
  updated: 'edited',
  moved: 'moved',
  deleted: 'deleted'
}

/**
 * Escape the four HTML metacharacters, for values that land in a template's HTML body but did not
 * come from this file — a page title or a display name is content a wiki editor chose, not a
 * constant this module wrote, so it is escaped the same way `models/search.ts`'s own `escapeHtml`
 * treats a search highlight.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Mail model
 *
 * Builds a single `nodemailer` SMTP transporter from `WIKI.config.mail` (CRUD'd by `api/mail.ts`)
 * and exposes a generic `send()` plus the transactional templates the app needs: verify-email,
 * forgot-password, password-reset-confirmed, and the page-watch notification. Templates are plain
 * inline HTML/text pairs — there is no admin-editable template system yet
 * (`MailTemplateEditorOverlay.vue` is unwired UI that belongs to Epic 8).
 *
 * The transporter is rebuilt whenever the relevant config changes (compared by a cheap JSON snapshot)
 * rather than on every send, since `WIKI.config.mail` can be edited at runtime through the admin area.
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
      WIKI.logger.warn('Cannot send mail: no SMTP host is configured.')
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
   *   (auth rejected, connection refused, ...) is logged and rethrown as-is.
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
      WIKI.logger.warn(`Failed to send mail to ${to}: ${err.message}`)
      throw err
    }
  }

  /**
   * Build `<defaultBaseURL><path>`, without a doubled-up slash. Every template link goes through
   * this so a missing `defaultBaseURL` produces an obviously-relative (and obviously wrong) link
   * rather than a silently broken one.
   */
  buildLink(path: string): string {
    const base = (WIKI.config.mail?.defaultBaseURL ?? '').replace(/\/+$/, '')
    return `${base}${path}`
  }

  /**
   * Email verification link, sent on self-registration when the local strategy's `emailValidation`
   * setting is on. Links at `/auth/verify/:token`, consumed by the public verify route.
   */
  async sendVerifyEmail({
    to,
    name,
    token
  }: {
    to: string
    name: string
    token: string
  }): Promise<void> {
    const link = this.buildLink(`/auth/verify/${token}`)
    await this.send({
      to,
      subject: 'Verify your email address',
      text: `Hi ${name},\n\nPlease verify your email address to activate your account:\n${link}\n\nIf you did not request this, you can safely ignore this email.`,
      html: `<p>Hi ${name},</p><p>Please verify your email address to activate your account:</p><p><a href="${link}">${link}</a></p><p>If you did not request this, you can safely ignore this email.</p>`
    })
  }

  /**
   * Password reset link, sent by a forgot-password request. Links at `/login/reset-password/:token`,
   * the frontend screen that collects a new password and submits it against the reset token.
   */
  async sendForgotPassword({
    to,
    name,
    token
  }: {
    to: string
    name: string
    token: string
  }): Promise<void> {
    const link = this.buildLink(`/login/reset-password/${token}`)
    await this.send({
      to,
      subject: 'Reset your password',
      text: `Hi ${name},\n\nA password reset was requested for your account. Use the link below to choose a new password:\n${link}\n\nIf you did not request this, you can safely ignore this email — your password will not change.`,
      html: `<p>Hi ${name},</p><p>A password reset was requested for your account. Use the link below to choose a new password:</p><p><a href="${link}">${link}</a></p><p>If you did not request this, you can safely ignore this email — your password will not change.</p>`
    })
  }

  /**
   * Notice sent after a password reset completes, so the account owner has a record of it even if
   * they weren't the one who did it.
   */
  async sendPasswordResetConfirmed({ to, name }: { to: string; name: string }): Promise<void> {
    const link = this.buildLink('/login')
    await this.send({
      to,
      subject: 'Your password has been changed',
      text: `Hi ${name},\n\nThis is a confirmation that the password for your account was just changed.\n\nIf you did not make this change, contact your wiki administrator immediately.\n\n${link}`,
      html: `<p>Hi ${name},</p><p>This is a confirmation that the password for your account was just changed.</p><p>If you did not make this change, contact your wiki administrator immediately.</p><p><a href="${link}">${link}</a></p>`
    })
  }

  /**
   * Immediate page-watch notification, sent by `tasks/simple/notify-page-watchers.ts` for one
   * watcher whose preference is `immediate` (see `models/pageWatching.ts#WatchNotifyMode`). One email
   * per change per watcher — the digest job (a later task, out of this one's scope) is what batches
   * several changes into one message for a `digest`-mode watcher instead.
   *
   * Every value here — page title/path, `changedFields`, `actorName` — is exactly what was captured
   * on the `pageWatchEvents` row when the change was recorded, not looked up now: by the time an
   * immediate send actually runs, a `deleted` page (and the `pageWatching` row this watcher's
   * preference came from) can already be gone, same reasoning as `db/schema.ts#pageWatchEvents`'s own
   * comment.
   *
   * @param page.path Used verbatim as `models/pageWatching.ts#WatchedPage`'s own link does
   *   (`InboxWatching.vue`'s `router.push('/' + page.path)`) — the wiki's page route has no locale
   *   segment, so the caller passes no locale here either.
   */
  async sendPageWatchNotification({
    to,
    page,
    action,
    changedFields,
    actorName
  }: {
    to: string
    page: { title: string; path: string }
    action: PageWatchNotifiableAction
    changedFields: string[]
    actorName: string
  }): Promise<void> {
    const label = WATCH_ACTION_LABELS[action]
    const summary = changedFields.length > 0 ? `${label}: ${changedFields.join(', ')}` : label
    const link = this.buildLink(`/${page.path}`)
    const safeTitle = escapeHtml(page.title)
    const safeActor = escapeHtml(actorName)
    const safeSummary = escapeHtml(summary)
    await this.send({
      to,
      subject: `Page ${label}: ${page.title}`,
      text: `${actorName} ${label} a page you are watching: "${page.title}" (${summary}).\n\n${link}\n\nYou are receiving this because you are watching this page. Manage your watched pages from your profile's Inbox.`,
      html: `<p>${safeActor} ${label} a page you are watching: <strong>${safeTitle}</strong> (${safeSummary}).</p><p><a href="${link}">${link}</a></p><p>You are receiving this because you are watching this page. Manage your watched pages from your profile's Inbox.</p>`
    })
  }
}

export const mail = new MailModel()
