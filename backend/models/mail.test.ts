import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mail } from './mail.ts'

/**
 * `mail` builds its nodemailer transport straight from `WIKI.config.mail` and never touches the
 * database, so this is a pure unit test: no `test/db.ts` fixture needed, just a stand-in `WIKI`
 * global (same convention as `core/config.test.ts` / `api/sites.test.ts`).
 */

let previousWiki: any
const originalGetTransporter = mail.getTransporter.bind(mail)
const originalSend = mail.send.bind(mail)

function setMailConfig(cfg: Record<string, any> = {}) {
  ;(globalThis as any).WIKI = {
    config: { mail: cfg },
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

  test('sendPageWatchNotification links to the page path with no locale segment', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      page: { title: 'Getting Started', path: 'docs/getting-started' },
      action: 'updated',
      changedFields: ['title'],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.html, /https:\/\/wiki\.example\.com\/docs\/getting-started/)
    assert.match(msg.text, /https:\/\/wiki\.example\.com\/docs\/getting-started/)
  })

  test('sendPageWatchNotification summarises an edit as "edited: <fields>"', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      page: { title: 'Getting Started', path: 'docs/getting-started' },
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
      page: { title: 'Old Page', path: 'old-page' },
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
      page: { title: '<script>alert(1)</script>', path: 'evil-page' },
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
})
