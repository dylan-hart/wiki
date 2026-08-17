import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type Mail from 'nodemailer/lib/mailer/index.js'

/** A rendered email, ready to hand to the transporter. */
export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * Classify a failed send by nodemailer's `err.code` so logs distinguish a network-level problem
 * from bad credentials from a rejected message, instead of one generic "failed to send" line for
 * all three. Codes come from `nodemailer/lib/smtp-connection`, the only transport this model uses.
 */
export function classifyMailError(err: any): 'connection' | 'auth' | 'send' | 'unknown' {
  switch (err?.code) {
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'ETIMEDOUT':
    case 'EDNS':
    case 'ETLS':
    case 'EPROTOCOL':
      return 'connection'
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
 * forgot-password (the reset-*request* email, with the actual reset link), password-reset-confirmed
 * (the after-the-fact notice once a reset completes — a distinct email from the request one above),
 * and test-email (the admin "Send Test Email" action). Templates are plain inline HTML/text pairs —
 * building a DB-backed, admin-editable template system is explicitly out of scope here.
 * `MailTemplateEditorOverlay.vue` and the `admin.mail.templates` admin-area section are unwired UI
 * for that unbuilt system, gated behind `flagStore.experimental` on the frontend; there is no
 * `db/schema.ts` table to back them, and none is added by this change.
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
   *   (auth rejected, connection refused, message rejected, ...) is logged with its
   *   {@link classifyMailError} category — so a log search can tell "the SMTP host is unreachable"
   *   apart from "the credentials are wrong" apart from "the message itself was rejected" — and
   *   rethrown as-is.
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
      WIKI.logger.warn(`Failed to send mail to ${to} (${kind} failure): ${err.message}`)
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
   * the frontend screen that collects a new password and submits it against the reset token. This is
   * the request-side email — distinct from {@link sendPasswordResetConfirmed}, which is the
   * after-the-fact notice sent once the reset actually completes.
   *
   * The "24 hours" in the copy below must be kept in sync with the token TTL set by
   * `models/users.ts#generateToken` — there is no shared constant, since that TTL is a single flat
   * value applied to every token kind, not something specific to `resetPwd` alone.
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
    const cfg = WIKI.config.mail ?? {}
    const signatureText = cfg.senderName ? `\n\n— ${cfg.senderName}` : ''
    const signatureHtml = cfg.senderName ? `<p>— ${cfg.senderName}</p>` : ''
    await this.send({
      to,
      subject: 'Reset your password',
      text: `Hi ${name},\n\nA password reset was requested for your account. Use the link below to choose a new password. This link will expire in 24 hours.\n${link}\n\nIf you did not request this, you can safely ignore this email — your password will not change.${signatureText}`,
      html: `<p>Hi ${name},</p><p>A password reset was requested for your account. Use the link below to choose a new password. This link will expire in 24 hours.</p><p><a href="${link}">${link}</a></p><p>If you did not request this, you can safely ignore this email — your password will not change.</p>${signatureHtml}`
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
   * Sent by the admin area's "Send Test Email" action to confirm the current `WIKI.config.mail`
   * settings can actually reach an inbox. Includes the instance's `defaultBaseURL` so the recipient
   * can also confirm that setting is correct — the same value {@link buildLink} stitches onto every
   * other template's links — rather than just proving SMTP connectivity in isolation.
   */
  async sendTestEmail({ to }: { to: string }): Promise<void> {
    const baseURL = WIKI.config.mail?.defaultBaseURL
    const baseURLText = baseURL
      ? `It is currently configured with the base URL: ${baseURL}`
      : 'No default base URL is set yet — links in other emails (password reset, email verification) will be relative until one is configured under Mail Configuration.'
    const baseURLHtml = baseURL
      ? `It is currently configured with the base URL: <a href="${baseURL}">${baseURL}</a>`
      : 'No default base URL is set yet — links in other emails (password reset, email verification) will be relative until one is configured under Mail Configuration.'
    await this.send({
      to,
      subject: 'Wiki.js Test Email',
      text: `This is a test email sent from your Wiki.js instance to confirm your SMTP configuration is working.\n\n${baseURLText}`,
      html: `<p>This is a test email sent from your Wiki.js instance to confirm your SMTP configuration is working.</p><p>${baseURLHtml}</p>`
    })
  }
}

export const mail = new MailModel()
