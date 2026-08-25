import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mail, classifyMailError, pickLocalizedString } from './mail.ts'

/**
 * `mail` builds its nodemailer transport straight from `WIKI.config.mail` and never touches the
 * database, so this is a pure unit test: no `test/db.ts` fixture needed, just a stand-in `WIKI`
 * global (same convention as `core/config.test.ts` / `api/sites.test.ts`).
 */

let previousWiki: any
const originalGetTransporter = mail.getTransporter.bind(mail)
const originalSend = mail.send.bind(mail)

/** The default site a `siteId` in these tests resolves to — one non-primary locale (`fr`) active
 *  alongside the primary (`en`), so `sendPageWatchNotification`/`sendPageWatchDigest` have a real
 *  `locales` config to resolve `WIKI.sites[siteId]?.config?.locales` against. Its `hostname` is
 *  deliberately distinct from `defaultBaseURL`'s host, so a test asserting on the per-site host
 *  cannot pass by accident from the global fallback leaking through unnoticed. */
const DEFAULT_SITE_ID = 'site-1'
const DEFAULT_SITES = {
  [DEFAULT_SITE_ID]: {
    hostname: 'de.wiki.example.com',
    config: { locales: { primary: 'en', active: ['en', 'fr'] } }
  }
}

/**
 * Stubbed `WIKI.models.locales.getStrings`, matching the real model's return shape: an empty array
 * (never an object) for a locale with no matching row — see `models/locales.ts#getStrings`.
 * `catalogs` is keyed by locale code; a code with no entry here resolves to `[]`, same as an
 * uninstalled/unknown locale would against the real table.
 */
function setMailConfig(
  cfg: Record<string, any> = {},
  sites: Record<string, any> = DEFAULT_SITES,
  catalogs: Record<string, Record<string, string>> = {}
) {
  ;(globalThis as any).WIKI = {
    config: { mail: cfg },
    sites,
    models: {
      locales: {
        getStrings: mock.fn(async (locale: string) => catalogs[locale] ?? [])
      }
    },
    logger: {
      warn: mock.fn(),
      error: mock.fn(),
      info: mock.fn(),
      debug: mock.fn()
    }
  }
}

before(() => {
  previousWiki = (globalThis as any).WIKI
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

beforeEach(() => {
  // -> Each test starts from an unconfigured transport and the real (un-mocked) methods, so a
  //    stub installed by one test can't leak into the next.
  ;(mail as any).transporter = null
  ;(mail as any).transporterSnapshot = null
  mail.getTransporter = originalGetTransporter
  mail.send = originalSend
})

describe('mail.isConfigured', () => {
  test('false when no host is set', () => {
    setMailConfig({ host: '' })
    assert.equal(mail.isConfigured(), false)
  })

  test('true once a host is set', () => {
    setMailConfig({ host: 'smtp.example.com' })
    assert.equal(mail.isConfigured(), true)
  })
})

describe('mail.buildTransportOptions', () => {
  test('maps verifySSL onto tls.rejectUnauthorized', () => {
    setMailConfig({ host: 'smtp.example.com', verifySSL: false })
    const options = mail.buildTransportOptions()
    assert.equal(options.tls?.rejectUnauthorized, false)
  })

  test('defaults verifySSL to true when unset', () => {
    setMailConfig({ host: 'smtp.example.com' })
    const options = mail.buildTransportOptions()
    assert.equal(options.tls?.rejectUnauthorized, true)
  })

  test('maps user/pass onto auth', () => {
    setMailConfig({ host: 'smtp.example.com', user: 'wiki', pass: 'secret' })
    const options = mail.buildTransportOptions()
    assert.deepEqual(options.auth, { user: 'wiki', pass: 'secret' })
  })

  test('omits auth entirely when no user is set', () => {
    setMailConfig({ host: 'smtp.example.com' })
    const options = mail.buildTransportOptions()
    assert.equal(options.auth, undefined)
  })

  test('passes host/port/secure through', () => {
    setMailConfig({ host: 'smtp.example.com', port: 587, secure: false })
    const options = mail.buildTransportOptions()
    assert.equal(options.host, 'smtp.example.com')
    assert.equal(options.port, 587)
    assert.equal(options.secure, false)
  })

  test('builds nodemailer dkim option when useDKIM and every field is set', () => {
    setMailConfig({
      host: 'smtp.example.com',
      useDKIM: true,
      dkimDomainName: 'example.com',
      dkimKeySelector: 'wiki',
      dkimPrivateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
    })
    const options = mail.buildTransportOptions()
    assert.deepEqual(options.dkim, {
      domainName: 'example.com',
      keySelector: 'wiki',
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
    })
  })

  test('omits dkim when useDKIM is off', () => {
    setMailConfig({
      host: 'smtp.example.com',
      useDKIM: false,
      dkimDomainName: 'example.com',
      dkimKeySelector: 'wiki',
      dkimPrivateKey: 'key'
    })
    const options = mail.buildTransportOptions()
    assert.equal(options.dkim, undefined)
  })

  test('omits dkim when useDKIM is on but a required field is missing', () => {
    setMailConfig({
      host: 'smtp.example.com',
      useDKIM: true,
      dkimDomainName: 'example.com',
      dkimKeySelector: '',
      dkimPrivateKey: 'key'
    })
    const options = mail.buildTransportOptions()
    assert.equal(options.dkim, undefined)
  })
})

describe('mail.getTransporter', () => {
  test('throws ERR_MAIL_NOT_CONFIGURED and logs when no host is set', () => {
    setMailConfig({ host: '' })
    assert.throws(() => mail.getTransporter(), /ERR_MAIL_NOT_CONFIGURED/)
    assert.equal((WIKI.logger.warn as any).mock.calls.length, 1)
  })

  test('does not throw once a host is set', () => {
    setMailConfig({ host: 'smtp.example.com' })
    assert.doesNotThrow(() => mail.getTransporter())
  })
})

describe('mail.send', () => {
  test('throws ERR_MAIL_NOT_CONFIGURED without calling sendMail when unconfigured', async () => {
    setMailConfig({ host: '' })
    await assert.rejects(
      () => mail.send({ to: 'ada@example.com', subject: 'x', html: '<p>x</p>', text: 'x' }),
      /ERR_MAIL_NOT_CONFIGURED/
    )
  })

  test('calls sendMail on the transporter with a plain-string from when no senderName is set', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const sendMail = mock.fn(async (_mailOptions: any) => ({ messageId: '1' }))
    mail.getTransporter = () => ({ sendMail }) as any

    await mail.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })

    assert.equal(sendMail.mock.calls.length, 1)
    const arg = sendMail.mock.calls[0].arguments[0]
    assert.equal(arg.to, 'ada@example.com')
    assert.equal(arg.subject, 'Hi')
    assert.equal(arg.from, 'wiki@example.com')
  })

  test('builds a name/address from when senderName is set', async () => {
    setMailConfig({
      host: 'smtp.example.com',
      senderName: 'My Wiki',
      senderEmail: 'wiki@example.com'
    })
    const sendMail = mock.fn(async (_mailOptions: any) => ({ messageId: '1' }))
    mail.getTransporter = () => ({ sendMail }) as any

    await mail.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })

    const arg = sendMail.mock.calls[0].arguments[0]
    assert.deepEqual(arg.from, { name: 'My Wiki', address: 'wiki@example.com' })
  })

  test('logs and rethrows when sendMail itself fails', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const sendMail = mock.fn(async (_mailOptions: any) => {
      throw new Error('connection refused')
    })
    mail.getTransporter = () => ({ sendMail }) as any

    await assert.rejects(
      () => mail.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' }),
      /connection refused/
    )
    assert.equal((WIKI.logger.warn as any).mock.calls.length, 1)
  })

  test('logs a connection-classified message when sendMail fails with a transport-level code', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const err: any = new Error('connect ECONNREFUSED 127.0.0.1:25')
    err.code = 'ECONNECTION'
    const sendMail = mock.fn(async () => {
      throw err
    })
    mail.getTransporter = () => ({ sendMail }) as any

    await assert.rejects(() =>
      mail.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    )
    const [message] = (WIKI.logger.warn as any).mock.calls[0].arguments
    assert.match(message, /\(connection failure\)/)
  })

  test('logs an auth-classified message when sendMail fails with EAUTH', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const err: any = new Error('Invalid login')
    err.code = 'EAUTH'
    const sendMail = mock.fn(async () => {
      throw err
    })
    mail.getTransporter = () => ({ sendMail }) as any

    await assert.rejects(() =>
      mail.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    )
    const [message] = (WIKI.logger.warn as any).mock.calls[0].arguments
    assert.match(message, /\(auth failure\)/)
  })

  test('logs a send-classified message when sendMail fails with an envelope/message code', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const err: any = new Error('Message failed')
    err.code = 'EMESSAGE'
    const sendMail = mock.fn(async () => {
      throw err
    })
    mail.getTransporter = () => ({ sendMail }) as any

    await assert.rejects(() =>
      mail.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    )
    const [message] = (WIKI.logger.warn as any).mock.calls[0].arguments
    assert.match(message, /\(send failure\)/)
  })

  test('logs a tls-classified message when sendMail fails with a certificate error', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const err: any = new Error('Error initiating TLS - self signed certificate')
    err.code = 'ETLS'
    const sendMail = mock.fn(async () => {
      throw err
    })
    mail.getTransporter = () => ({ sendMail }) as any

    await assert.rejects(() =>
      mail.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    )
    const [message] = (WIKI.logger.warn as any).mock.calls[0].arguments
    assert.match(message, /\(tls failure\)/)
  })
})

describe('classifyMailError', () => {
  test('classifies every nodemailer socket/protocol-stage code as connection', () => {
    for (const code of ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'EPROTOCOL']) {
      assert.equal(classifyMailError({ code }), 'connection', code)
    }
  })

  test('classifies ETLS as tls, distinct from a plain connection failure', () => {
    // -> nodemailer reports a rejected (e.g. self-signed) certificate as ETLS whether it happens
    //    during the initial implicit-TLS handshake or during STARTTLS — either way it calls for
    //    "check the certificate / Verify SSL Certificate setting", not "check the host and port".
    assert.equal(classifyMailError({ code: 'ETLS' }), 'tls')
  })

  test('classifies EAUTH as auth', () => {
    assert.equal(classifyMailError({ code: 'EAUTH' }), 'auth')
  })

  test('classifies EENVELOPE and EMESSAGE as send', () => {
    assert.equal(classifyMailError({ code: 'EENVELOPE' }), 'send')
    assert.equal(classifyMailError({ code: 'EMESSAGE' }), 'send')
  })

  test('falls back to unknown for an uncoded or unrecognized error', () => {
    assert.equal(classifyMailError(new Error('boom')), 'unknown')
    assert.equal(classifyMailError({ code: 'SOMETHING_ELSE' }), 'unknown')
  })
})

describe('mail.buildLink', () => {
  test('joins defaultBaseURL and path without a doubled slash', () => {
    setMailConfig({ host: 'smtp.example.com', defaultBaseURL: 'https://wiki.example.com/' })
    assert.equal(
      mail.buildLink('/auth/verify/tok123'),
      'https://wiki.example.com/auth/verify/tok123'
    )
  })

  test('is relative when defaultBaseURL is unset', () => {
    setMailConfig({ host: 'smtp.example.com' })
    assert.equal(mail.buildLink('/auth/verify/tok123'), '/auth/verify/tok123')
  })
})

describe('pickLocalizedString', () => {
  test('prefers the requested locale catalogue over en', () => {
    const result = pickLocalizedString(
      { 'mail.verifyEmail.subject': 'Vérifiez votre adresse e-mail' },
      { 'mail.verifyEmail.subject': 'Verify your email address' },
      'mail.verifyEmail.subject',
      'fallback'
    )
    assert.equal(result, 'Vérifiez votre adresse e-mail')
  })

  test('falls back to en when the requested catalogue lacks the key', () => {
    const result = pickLocalizedString(
      {},
      { 'mail.verifyEmail.subject': 'Verify your email address' },
      'mail.verifyEmail.subject',
      'fallback'
    )
    assert.equal(result, 'Verify your email address')
  })

  test('falls back to en when the requested catalogue has the key but blank', () => {
    const result = pickLocalizedString(
      { 'mail.verifyEmail.subject': '' },
      { 'mail.verifyEmail.subject': 'Verify your email address' },
      'mail.verifyEmail.subject',
      'fallback'
    )
    assert.equal(result, 'Verify your email address')
  })

  test('falls back to the given literal when en lacks the key too', () => {
    const result = pickLocalizedString({}, {}, 'mail.verifyEmail.subject', 'fallback')
    assert.equal(result, 'fallback')
  })
})

describe('mail.resolveMailString', () => {
  test('resolves a key from the requested locale catalogue for a user whose prefs.locale is set', async () => {
    setMailConfig({ host: 'smtp.example.com' }, DEFAULT_SITES, {
      fr: { 'mail.verifyEmail.subject': 'Vérifiez votre adresse e-mail' }
    })
    const result = await mail.resolveMailString(
      'fr',
      'mail.verifyEmail.subject',
      'Verify your email address'
    )
    assert.equal(result, 'Vérifiez votre adresse e-mail')
  })

  test('falls back to en for an unknown locale code', async () => {
    setMailConfig({ host: 'smtp.example.com' }, DEFAULT_SITES, {
      en: { 'mail.verifyEmail.subject': 'Verify your email address (en)' }
    })
    const result = await mail.resolveMailString(
      'xx-not-a-locale',
      'mail.verifyEmail.subject',
      'fallback'
    )
    assert.equal(result, 'Verify your email address (en)')
    // -> Queried en too, not just the unknown code -- this is the fallback path, not a lucky miss.
    assert.deepEqual(
      (WIKI.models.locales.getStrings as any).mock.calls.map((c: any) => c.arguments[0]),
      ['xx-not-a-locale', 'en']
    )
  })

  test('falls back to en for a key missing from the requested locale', async () => {
    setMailConfig({ host: 'smtp.example.com' }, DEFAULT_SITES, {
      fr: { 'mail.other.subject': 'Autre chose' },
      en: { 'mail.verifyEmail.subject': 'Verify your email address (en)' }
    })
    const result = await mail.resolveMailString('fr', 'mail.verifyEmail.subject', 'fallback')
    assert.equal(result, 'Verify your email address (en)')
  })

  test('a falsy locale resolves straight against en', async () => {
    setMailConfig({ host: 'smtp.example.com' }, DEFAULT_SITES, {
      en: { 'mail.verifyEmail.subject': 'Verify your email address (en)' }
    })
    const result = await mail.resolveMailString(undefined, 'mail.verifyEmail.subject', 'fallback')
    assert.equal(result, 'Verify your email address (en)')
    assert.equal((WIKI.models.locales.getStrings as any).mock.calls.length, 1)
  })

  test('falls back to the given literal when neither the locale nor en has the key', async () => {
    setMailConfig({ host: 'smtp.example.com' })
    const result = await mail.resolveMailString('fr', 'mail.verifyEmail.subject', 'fallback')
    assert.equal(result, 'fallback')
  })
})

describe('mail template senders', () => {
  let sendCalls: any[]

  beforeEach(() => {
    setMailConfig({
      host: 'smtp.example.com',
      senderEmail: 'wiki@example.com',
      defaultBaseURL: 'https://wiki.example.com'
    })
    sendCalls = []
    mail.send = (async (msg: any) => {
      sendCalls.push(msg)
    }) as any
  })

  test('sendVerifyEmail includes the verify link and greets the user by name', async () => {
    await mail.sendVerifyEmail({ to: 'ada@example.com', name: 'Ada', token: 'tok123' })
    assert.equal(sendCalls.length, 1)
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.html, /https:\/\/wiki\.example\.com\/auth\/verify\/tok123/)
    assert.match(msg.text, /https:\/\/wiki\.example\.com\/auth\/verify\/tok123/)
    assert.match(msg.text, /Ada/)
  })

  test('sendVerifyEmail resolves its subject through the locale catalogue when a locale is given', async () => {
    setMailConfig(
      {
        host: 'smtp.example.com',
        senderEmail: 'wiki@example.com',
        defaultBaseURL: 'https://wiki.example.com'
      },
      DEFAULT_SITES,
      { fr: { 'mail.verifyEmail.subject': 'Vérifiez votre adresse e-mail' } }
    )
    mail.send = (async (msg: any) => {
      sendCalls.push(msg)
    }) as any
    await mail.sendVerifyEmail({
      to: 'ada@example.com',
      name: 'Ada',
      token: 'tok123',
      locale: 'fr'
    })
    assert.equal(sendCalls[0].subject, 'Vérifiez votre adresse e-mail')
  })

  test('sendVerifyEmail falls back to the English subject for a locale nobody has installed', async () => {
    mail.send = (async (msg: any) => {
      sendCalls.push(msg)
    }) as any
    await mail.sendVerifyEmail({
      to: 'ada@example.com',
      name: 'Ada',
      token: 'tok123',
      locale: 'xx-not-a-locale'
    })
    assert.equal(sendCalls[0].subject, 'Verify your email address')
  })

  test('sendForgotPassword includes the reset link', async () => {
    await mail.sendForgotPassword({ to: 'ada@example.com', name: 'Ada', token: 'tok456' })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/wiki\.example\.com\/login\/reset-password\/tok456/)
    assert.match(msg.text, /https:\/\/wiki\.example\.com\/login\/reset-password\/tok456/)
  })

  test('sendPasswordResetConfirmed sends a notice with no token', async () => {
    await mail.sendPasswordResetConfirmed({ to: 'ada@example.com', name: 'Ada' })
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.subject, /password/i)
    assert.match(msg.text, /Ada/)
  })

  test('sendWelcomeEmail links at the reset-password screen with the given token, on the instance default base URL when no siteId is given', async () => {
    await mail.sendWelcomeEmail({ to: 'ada@example.com', name: 'Ada', token: 'tok789' })
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.html, /https:\/\/wiki\.example\.com\/login\/reset-password\/tok789/)
    assert.match(msg.text, /https:\/\/wiki\.example\.com\/login\/reset-password\/tok789/)
    assert.match(msg.text, /Ada/)
  })

  test('sendWelcomeEmail links at the given siteId hostname instead of the instance default', async () => {
    await mail.sendWelcomeEmail({
      to: 'ada@example.com',
      name: 'Ada',
      token: 'tok789',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login\/reset-password\/tok789/)
  })

  test('sendWelcomeEmail includes an expiry notice matching the resetPwd token TTL', async () => {
    await mail.sendWelcomeEmail({ to: 'ada@example.com', name: 'Ada', token: 'tok789' })
    const msg = sendCalls[0]
    assert.match(msg.text, /24 hours/i)
    assert.match(msg.html, /24 hours/i)
  })

  test('sendForgotPassword includes an expiry notice matching the token TTL', async () => {
    await mail.sendForgotPassword({ to: 'ada@example.com', name: 'Ada', token: 'tok456' })
    const msg = sendCalls[0]
    // -> Matches the 24-hour validUntil set by models/users.ts#generateToken for kind: 'resetPwd'.
    assert.match(msg.text, /24 hours/i)
    assert.match(msg.html, /24 hours/i)
  })

  test('sendForgotPassword signs with the sender name when one is set', async () => {
    setMailConfig({
      host: 'smtp.example.com',
      senderEmail: 'wiki@example.com',
      senderName: 'My Wiki',
      defaultBaseURL: 'https://wiki.example.com'
    })
    await mail.sendForgotPassword({ to: 'ada@example.com', name: 'Ada', token: 'tok456' })
    const msg = sendCalls[0]
    assert.match(msg.text, /My Wiki/)
    assert.match(msg.html, /My Wiki/)
  })

  test('sendForgotPassword omits a signature when no sender name is set', async () => {
    await mail.sendForgotPassword({ to: 'ada@example.com', name: 'Ada', token: 'tok456' })
    const msg = sendCalls[0]
    assert.doesNotMatch(msg.text, /—\s*$/)
  })

  test('sendTestEmail confirms SMTP works and includes the instance defaultBaseURL', async () => {
    await mail.sendTestEmail({ to: 'ada@example.com' })
    assert.equal(sendCalls.length, 1)
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.subject, /test/i)
    assert.match(msg.text, /https:\/\/wiki\.example\.com/)
    assert.match(msg.html, /https:\/\/wiki\.example\.com/)
  })

  test('sendTestEmail still sends when defaultBaseURL is unset', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    await mail.sendTestEmail({ to: 'ada@example.com' })
    assert.equal(sendCalls.length, 1)
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
  })

  test('sendPageWatchNotification links at the site hostname, not the instance defaultBaseURL', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'updated',
      changedFields: ['title'],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/docs\/getting-started/)
    assert.match(msg.text, /https:\/\/de\.wiki\.example\.com\/docs\/getting-started/)
  })

  test('sendPageWatchNotification for a non-primary-locale page links with the locale prefix', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Bien Démarrer', path: 'docs/getting-started', locale: 'fr' },
      action: 'updated',
      changedFields: ['title'],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/fr\/docs\/getting-started/)
    assert.match(msg.text, /https:\/\/de\.wiki\.example\.com\/fr\/docs\/getting-started/)
  })

  test('sendPageWatchNotification falls back to defaultBaseURL when the site has no hostname on record', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: 'site-unresolvable',
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'updated',
      changedFields: ['title'],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/wiki\.example\.com\/docs\/getting-started/)
    assert.match(msg.text, /https:\/\/wiki\.example\.com\/docs\/getting-started/)
  })

  test('sendPageWatchNotification falls back to defaultBaseURL for the * catch-all site', async () => {
    setMailConfig(
      {
        host: 'smtp.example.com',
        senderEmail: 'wiki@example.com',
        defaultBaseURL: 'https://wiki.example.com'
      },
      {
        'catch-all-site': { hostname: '*', config: { locales: { primary: 'en', active: ['en'] } } }
      }
    )
    mail.send = (async (msg: any) => {
      sendCalls.push(msg)
    }) as any
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: 'catch-all-site',
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'updated',
      changedFields: ['title'],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/wiki\.example\.com\/docs\/getting-started/)
    assert.doesNotMatch(msg.html, /https:\/\/\*\//)
  })

  test('sendPageWatchNotification summarises an edit as "edited: <fields>"', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'updated',
      changedFields: ['title', 'content'],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.match(msg.text, /Bob/)
    assert.match(msg.text, /edited: title, content/)
    assert.match(msg.html, /edited: title, content/)
  })

  test('sendPageWatchNotification for a delete has no changed fields to list', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Old Page', path: 'old-page', locale: 'en' },
      action: 'deleted',
      changedFields: [],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.match(msg.subject, /deleted/)
    // -> No field summary to append when nothing changed about the page's content
    assert.doesNotMatch(msg.text, /deleted:/)
    assert.match(msg.text, /\(deleted\)/)
  })

  test('sendPageWatchNotification escapes an untrusted page title and actor name in the HTML body', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: '<script>alert(1)</script>', path: 'evil-page', locale: 'en' },
      action: 'updated',
      changedFields: [],
      actorName: '<img src=x>'
    })
    const msg = sendCalls[0]
    assert.doesNotMatch(msg.html, /<script>/)
    assert.doesNotMatch(msg.html, /<img/)
    assert.match(msg.html, /&lt;script&gt;/)
    // -> The plain-text alternative needs no escaping: it is never parsed as markup
    assert.match(msg.text, /<script>alert\(1\)<\/script>/)
  })

  describe('sendPageWatchDigest', () => {
    test('one item reads as one line, reusing the same per-event content as a single notification', async () => {
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: DEFAULT_SITE_ID,
        items: [
          {
            page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          }
        ]
      })
      const msg = sendCalls[0]
      assert.equal(msg.to, 'ada@example.com')
      assert.match(msg.text, /Bob/)
      assert.match(msg.text, /edited: title/)
      assert.match(msg.html, /edited: title/)
      assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/docs\/getting-started/)
    })

    test('a non-primary-locale item links with the locale prefix, alongside a primary-locale item with none', async () => {
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: DEFAULT_SITE_ID,
        items: [
          {
            page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          },
          {
            page: { title: 'Bien Démarrer', path: 'docs/getting-started', locale: 'fr' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          }
        ]
      })
      const msg = sendCalls[0]
      assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/docs\/getting-started/)
      assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/fr\/docs\/getting-started/)
      assert.match(msg.text, /https:\/\/de\.wiki\.example\.com\/fr\/docs\/getting-started/)
    })

    test('falls back to defaultBaseURL for the * catch-all site', async () => {
      setMailConfig(
        {
          host: 'smtp.example.com',
          senderEmail: 'wiki@example.com',
          defaultBaseURL: 'https://wiki.example.com'
        },
        {
          'catch-all-site': {
            hostname: '*',
            config: { locales: { primary: 'en', active: ['en'] } }
          }
        }
      )
      mail.send = (async (msg: any) => {
        sendCalls.push(msg)
      }) as any
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: 'catch-all-site',
        items: [
          {
            page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          }
        ]
      })
      const msg = sendCalls[0]
      assert.match(msg.html, /https:\/\/wiki\.example\.com\/docs\/getting-started/)
      assert.doesNotMatch(msg.html, /https:\/\/\*\//)
    })

    test('falls back to defaultBaseURL when the site has no hostname on record', async () => {
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: 'site-unresolvable',
        items: [
          {
            page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          }
        ]
      })
      const msg = sendCalls[0]
      assert.match(msg.html, /https:\/\/wiki\.example\.com\/docs\/getting-started/)
    })

    test('several items each contribute their own line, in the given order', async () => {
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: DEFAULT_SITE_ID,
        items: [
          {
            page: { title: 'Page One', path: 'page-one', locale: 'en' },
            action: 'updated',
            changedFields: ['content'],
            actorName: 'Bob'
          },
          {
            page: { title: 'Page Two', path: 'page-two', locale: 'en' },
            action: 'moved',
            changedFields: [],
            actorName: 'Carol'
          },
          {
            page: { title: 'Page Three', path: 'page-three', locale: 'en' },
            action: 'deleted',
            changedFields: [],
            actorName: 'Dave'
          }
        ]
      })
      const msg = sendCalls[0]
      assert.match(msg.text, /Page One/)
      assert.match(msg.text, /Page Two/)
      assert.match(msg.text, /Page Three/)
      // -> Order preserved: "Page One" precedes "Page Two" precedes "Page Three" in the rendered text
      const [i1, i2, i3] = ['Page One', 'Page Two', 'Page Three'].map((needle) =>
        msg.text.indexOf(needle)
      )
      assert.ok(i1 < i2 && i2 < i3)
      // -> Three distinct <li> lines in the HTML body, one per item
      assert.equal((msg.html.match(/<li>/g) ?? []).length, 3)
    })

    test('subject counts the items and pluralizes correctly', async () => {
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: DEFAULT_SITE_ID,
        items: [
          {
            page: { title: 'Solo Page', path: 'solo-page', locale: 'en' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          }
        ]
      })
      assert.match(sendCalls[0].subject, /^1 update on pages/)

      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: DEFAULT_SITE_ID,
        items: [
          {
            page: { title: 'A', path: 'a', locale: 'en' },
            action: 'updated',
            changedFields: [],
            actorName: 'Bob'
          },
          {
            page: { title: 'B', path: 'b', locale: 'en' },
            action: 'updated',
            changedFields: [],
            actorName: 'Bob'
          }
        ]
      })
      assert.match(sendCalls[1].subject, /^2 updates on pages/)
    })

    test('escapes an untrusted page title in the HTML body but not the plain-text alternative', async () => {
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: DEFAULT_SITE_ID,
        items: [
          {
            page: { title: '<script>alert(1)</script>', path: 'evil-page', locale: 'en' },
            action: 'updated',
            changedFields: [],
            actorName: 'Bob'
          }
        ]
      })
      const msg = sendCalls[0]
      assert.doesNotMatch(msg.html, /<script>/)
      assert.match(msg.html, /&lt;script&gt;/)
      assert.match(msg.text, /<script>alert\(1\)<\/script>/)
    })
  })
})
