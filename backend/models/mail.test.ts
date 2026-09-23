import { readFileSync } from 'node:fs'
import { describe, test, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { MailKind } from './mail.ts'
import {
  mail,
  classifyMailError,
  mailFailureLevel,
  recipientRef,
  MAIL_UNCONFIGURED_LOG_WINDOW_MS
} from './mail.ts'
import { resetCoalesce } from '../helpers/logCoalesce.ts'
import { interpolate } from './locales.ts'

/**
 * `mail` builds its transport from `CARDINAL.config.mail` and never touches the database, so these
 * tests need only a stand-in `CARDINAL` global rather than the `test/db.ts` fixture.
 */

let previousWiki: any
const originalGetTransporter = mail.getTransporter.bind(mail)
const originalSend = mail.send.bind(mail)

/**
 * The real resolver reads the `locales` DB table, so this stub re-implements the same
 * lookup/fallback/plural-form contract over the real `en.json` on disk plus whatever `catalogues` a
 * test supplies, letting template tests exercise the production `mail.*` keys rather than a
 * hand-rolled duplicate of them.
 */
const enStrings = JSON.parse(
  readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')
) as Record<string, string>

function makeLocalesStub(catalogues: Record<string, Record<string, string>> = {}) {
  function lookup(locale: string | null | undefined, key: string): string {
    if (locale && locale !== 'en') {
      const value = catalogues[locale]?.[key]
      if (typeof value === 'string' && value.length > 0) {
        return value
      }
    }
    const enValue = (catalogues.en ?? enStrings)[key]
    return typeof enValue === 'string' && enValue.length > 0 ? enValue : key
  }
  return {
    resolveString: async (
      locale: string | null | undefined,
      key: string,
      params: Record<string, string> = {}
    ) => interpolate(lookup(locale, key), params),
    resolvePluralString: async (
      locale: string | null | undefined,
      key: string,
      count: number,
      params: Record<string, string> = {}
    ) => {
      const raw = lookup(locale, key)
      const forms = raw.split('|').map((form) => form.trim())
      const form =
        count === 0 ? (forms[0] ?? raw) : count === 1 ? (forms[1] ?? forms.at(-1)!) : forms.at(-1)!
      return interpolate(form, { ...params, count: String(count) })
    }
  }
}

/** One non-primary locale (`fr`) active alongside the primary, so the page-watch sends have a real
 *  `locales` config to resolve against. The hostname is deliberately distinct from
 *  `defaultBaseURL`'s, so an assertion on the per-site host cannot pass on the global fallback. */
const DEFAULT_SITE_ID = 'site-1'
const DEFAULT_SITES = {
  [DEFAULT_SITE_ID]: {
    hostname: 'de.wiki.example.com',
    config: { locales: { primary: 'en', active: ['en', 'fr'] } }
  }
}

function setMailConfig(
  cfg: Record<string, any> = {},
  sites: Record<string, any> = DEFAULT_SITES,
  localeCatalogues: Record<string, Record<string, string>> = {}
) {
  ;(globalThis as any).CARDINAL = {
    config: { mail: cfg },
    sites,
    models: { locales: makeLocalesStub(localeCatalogues) },
    logger: {
      warn: mock.fn(),
      error: mock.fn(),
      info: mock.fn(),
      debug: mock.fn()
    }
  }
}

before(() => {
  previousWiki = (globalThis as any).CARDINAL
})

after(() => {
  ;(globalThis as any).CARDINAL = previousWiki
})

beforeEach(() => {
  // -> A transport or method stub installed by one test must not leak into the next.
  ;(mail as any).transporter = null
  ;(mail as any).transporterSnapshot = null
  mail.getTransporter = originalGetTransporter
  mail.send = originalSend
  // -> The coalescing window map and the per-window kind set are shared module/instance state, so a
  //    refused send in one test would otherwise be counted into the next test's summary.
  resetCoalesce()
  ;(mail as any).unconfiguredKinds.clear()
})

afterEach(() => {
  // -> `mock.timers.reset()` is a no-op when a test never enabled them, so it is safe file-wide.
  mock.timers.reset()
  resetCoalesce()
  ;(mail as any).unconfiguredKinds.clear()
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
  test('throws ERR_MAIL_NOT_CONFIGURED when no host is set', () => {
    setMailConfig({ host: '' })
    assert.throws(() => mail.getTransporter(), /ERR_MAIL_NOT_CONFIGURED/)
  })

  test('logs nothing at the moment of the refusal, only when the window closes', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    setMailConfig({ host: '' })
    assert.throws(() => mail.getTransporter('digest'), /ERR_MAIL_NOT_CONFIGURED/)
    assert.equal((CARDINAL.logger.warn as any).mock.calls.length, 0)
  })

  test('does not throw once a host is set', () => {
    setMailConfig({ host: 'smtp.example.com' })
    assert.doesNotThrow(() => mail.getTransporter())
  })

  test('logs the settings actually in force when it builds a transport', () => {
    setMailConfig({ host: 'smtp.example.com', port: 2525, secure: false })
    mail.getTransporter('test')
    const debugCalls = (CARDINAL.logger.debug as any).mock.calls
    assert.equal(debugCalls.length, 1)
    const [scope, , fields] = debugCalls[0].arguments
    assert.equal(scope, 'mail')
    assert.deepEqual(fields, { host: 'smtp.example.com', port: 2525, secure: false })
  })

  test('does not re-log when the config is unchanged, and does when it changes', () => {
    setMailConfig({ host: 'smtp.example.com', port: 2525, secure: false })
    mail.getTransporter('test')
    mail.getTransporter('test')
    assert.equal((CARDINAL.logger.debug as any).mock.calls.length, 1)

    CARDINAL.config.mail.port = 587
    mail.getTransporter('test')
    const debugCalls = (CARDINAL.logger.debug as any).mock.calls
    assert.equal(debugCalls.length, 2)
    assert.equal(debugCalls[1].arguments[2].port, 587)
  })
})

describe('mail unconfigured coalescing', () => {
  test('folds a burst of refused sends into one summary carrying the total', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    setMailConfig({ host: '' })

    for (let i = 0; i < 5; i++) {
      assert.throws(() => mail.getTransporter('digest'), /ERR_MAIL_NOT_CONFIGURED/)
    }
    assert.equal((CARDINAL.logger.warn as any).mock.calls.length, 0)

    mock.timers.tick(MAIL_UNCONFIGURED_LOG_WINDOW_MS)

    const warnCalls = (CARDINAL.logger.warn as any).mock.calls
    assert.equal(warnCalls.length, 1)
    const [scope, , fields] = warnCalls[0].arguments
    assert.equal(scope, 'mail')
    assert.equal(fields.dropped, 5)
  })

  test('names every kind dropped in the window, deduplicated', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    setMailConfig({ host: '' })

    for (const kind of ['digest', 'digest', 'watch', 'verify'] as const) {
      assert.throws(() => mail.getTransporter(kind))
    }
    mock.timers.tick(MAIL_UNCONFIGURED_LOG_WINDOW_MS)

    const [, , fields] = (CARDINAL.logger.warn as any).mock.calls[0].arguments
    assert.equal(fields.kinds, 'digest,watch,verify')
    assert.equal(fields.dropped, 4)
  })

  test('a single refusal still reports itself once the window closes', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    setMailConfig({ host: '' })
    assert.throws(() => mail.getTransporter('test'))
    mock.timers.tick(MAIL_UNCONFIGURED_LOG_WINDOW_MS)

    const [, , fields] = (CARDINAL.logger.warn as any).mock.calls[0].arguments
    assert.equal(fields.dropped, 1)
    assert.equal(fields.kinds, 'test')
  })

  test("a second window starts fresh rather than carrying the first window's kinds", () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    setMailConfig({ host: '' })

    assert.throws(() => mail.getTransporter('digest'))
    mock.timers.tick(MAIL_UNCONFIGURED_LOG_WINDOW_MS)
    assert.throws(() => mail.getTransporter('verify'))
    mock.timers.tick(MAIL_UNCONFIGURED_LOG_WINDOW_MS)

    const warnCalls = (CARDINAL.logger.warn as any).mock.calls
    assert.equal(warnCalls.length, 2)
    assert.equal(warnCalls[0].arguments[2].kinds, 'digest')
    assert.equal(warnCalls[1].arguments[2].kinds, 'verify')
    assert.equal(warnCalls[1].arguments[2].dropped, 1)
  })
})

describe('mail.send', () => {
  test('throws ERR_MAIL_NOT_CONFIGURED without calling sendMail when unconfigured', async () => {
    setMailConfig({ host: '' })
    await assert.rejects(
      () =>
        mail.send({
          to: 'ada@example.com',
          subject: 'x',
          html: '<p>x</p>',
          text: 'x',
          kind: 'test'
        }),
      /ERR_MAIL_NOT_CONFIGURED/
    )
  })

  test('calls sendMail on the transporter with a plain-string from when no senderName is set', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const sendMail = mock.fn(async (_mailOptions: any) => ({ messageId: '1' }))
    mail.getTransporter = () => ({ sendMail }) as any

    await mail.send({
      to: 'ada@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      kind: 'test'
    })

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

    await mail.send({
      to: 'ada@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      kind: 'test'
    })

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
      () =>
        mail.send({
          to: 'ada@example.com',
          subject: 'Hi',
          html: '<p>Hi</p>',
          text: 'Hi',
          kind: 'test'
        }),
      /connection refused/
    )
    // -> An uncoded error classifies as `unknown`, which a retry cannot help, so it is an `error`.
    assert.equal((CARDINAL.logger.error as any).mock.calls.length, 1)
    assert.equal((CARDINAL.logger.info as any).mock.calls.length, 0)
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
      mail.send({
        to: 'ada@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        kind: 'test'
      })
    )
    const [scope, , fields] = (CARDINAL.logger.warn as any).mock.calls[0].arguments
    assert.equal(scope, 'mail')
    assert.equal(fields.failure, 'connection')
    // -> `warn`, not `error`: a refused socket may well answer on the scheduler's next attempt.
    assert.equal((CARDINAL.logger.error as any).mock.calls.length, 0)
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
      mail.send({
        to: 'ada@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        kind: 'test'
      })
    )
    const [scope, , fields] = (CARDINAL.logger.error as any).mock.calls[0].arguments
    assert.equal(scope, 'mail')
    assert.equal(fields.failure, 'auth')
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
      mail.send({
        to: 'ada@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        kind: 'test'
      })
    )
    const [scope, , fields] = (CARDINAL.logger.error as any).mock.calls[0].arguments
    assert.equal(scope, 'mail')
    assert.equal(fields.failure, 'send')
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
      mail.send({
        to: 'ada@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        kind: 'test'
      })
    )
    const [scope, , fields] = (CARDINAL.logger.error as any).mock.calls[0].arguments
    assert.equal(scope, 'mail')
    assert.equal(fields.failure, 'tls')
  })

  test('passes the Error itself, not a formatted message', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const err: any = new Error('Invalid login')
    err.code = 'EAUTH'
    mail.getTransporter = () =>
      ({
        sendMail: async () => {
          throw err
        }
      }) as any

    await assert.rejects(() =>
      mail.send({
        to: 'ada@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        kind: 'test'
      })
    )
    // -> `core/logger.ts` renders the message inline and the stack after it; a string throws away both.
    const [, , fields] = (CARDINAL.logger.error as any).mock.calls[0].arguments
    assert.equal(fields.error, err)
  })

  test('logs one info line naming the kind and the recipient user id on success', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    mail.getTransporter = () => ({ sendMail: async () => ({ messageId: '1' }) }) as any

    await mail.send({
      to: 'ada@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      kind: 'digest',
      userId: 'user-42'
    })

    const infoCalls = (CARDINAL.logger.info as any).mock.calls
    assert.equal(infoCalls.length, 1)
    const [scope, , fields] = infoCalls[0].arguments
    assert.equal(scope, 'mail')
    assert.deepEqual(fields, { kind: 'digest', to: 'user-42' })
  })

  test('falls back to an address hash, never the address, when there is no user id', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    mail.getTransporter = () => ({ sendMail: async () => ({ messageId: '1' }) }) as any

    await mail.send({
      to: 'ada@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      kind: 'test'
    })

    const [, , fields] = (CARDINAL.logger.info as any).mock.calls[0].arguments
    assert.equal(fields.to, recipientRef('ada@example.com'))
    assert.doesNotMatch(JSON.stringify(fields), /ada@example\.com/)
  })

  test('a failed send names the same recipient reference the success line would have', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    const err: any = new Error('Invalid login')
    err.code = 'EAUTH'
    mail.getTransporter = () =>
      ({
        sendMail: async () => {
          throw err
        }
      }) as any

    await assert.rejects(() =>
      mail.send({
        to: 'ada@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        kind: 'welcome',
        userId: 'user-7'
      })
    )
    const [, , fields] = (CARDINAL.logger.error as any).mock.calls[0].arguments
    assert.equal(fields.kind, 'welcome')
    assert.equal(fields.to, 'user-7')
  })
})

describe('recipientRef', () => {
  test('prefers the user id when one was threaded', () => {
    assert.equal(recipientRef('ada@example.com', 'user-42'), 'user-42')
  })

  test('is stable across case and surrounding whitespace', () => {
    assert.equal(recipientRef('  Ada@Example.COM '), recipientRef('ada@example.com'))
  })

  test('never contains the address it stands for', () => {
    const ref = recipientRef('ada@example.com')
    assert.doesNotMatch(ref, /ada|example|@/)
    assert.match(ref, /^[0-9a-f]{12}$/)
  })

  test('distinguishes two different addresses', () => {
    assert.notEqual(recipientRef('ada@example.com'), recipientRef('grace@example.com'))
  })
})

describe('mailFailureLevel', () => {
  test('warns for a connection failure the scheduler will retry into', () => {
    assert.equal(mailFailureLevel('connection'), 'warn')
  })

  test('errors for every standing fault a retry cannot clear', () => {
    for (const failure of ['tls', 'auth', 'send', 'unknown'] as const) {
      assert.equal(mailFailureLevel(failure), 'error', failure)
    }
  })
})

describe('classifyMailError', () => {
  test('classifies every nodemailer socket/protocol-stage code as connection', () => {
    for (const code of ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'EPROTOCOL']) {
      assert.equal(classifyMailError({ code }), 'connection', code)
    }
  })

  test('classifies ETLS as tls, distinct from a plain connection failure', () => {
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

describe('mail.hasResolvableBaseURL (OpenProject #3386)', () => {
  test('true when defaultBaseURL is set, even with no sites at all', () => {
    setMailConfig({ host: 'smtp.example.com', defaultBaseURL: 'https://wiki.example.com' }, {})
    assert.equal(mail.hasResolvableBaseURL(), true)
  })

  test('false when defaultBaseURL is blank and no site has a real hostname', () => {
    setMailConfig(
      { host: 'smtp.example.com', defaultBaseURL: '' },
      {
        'catch-all-site': { hostname: '*', config: {} }
      }
    )
    assert.equal(mail.hasResolvableBaseURL(), false)
  })

  test('false when defaultBaseURL is blank and there are no sites at all', () => {
    setMailConfig({ host: 'smtp.example.com', defaultBaseURL: '' }, {})
    assert.equal(mail.hasResolvableBaseURL(), false)
  })

  test('true when defaultBaseURL is blank but a site has a real hostname', () => {
    setMailConfig({ host: 'smtp.example.com', defaultBaseURL: '' })
    assert.equal(mail.hasResolvableBaseURL(), true)
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

  test('sendVerifyEmail links at the given siteId hostname instead of the instance default (OpenProject #3386)', async () => {
    await mail.sendVerifyEmail({
      to: 'ada@example.com',
      name: 'Ada',
      token: 'tok123',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/auth\/verify\/tok123/)
    assert.match(msg.text, /https:\/\/de\.wiki\.example\.com\/auth\/verify\/tok123/)
  })

  test('sendRegistrationAttemptNotice notifies the existing owner without leaking a token', async () => {
    await mail.sendRegistrationAttemptNotice({ to: 'fixture@example.com', name: 'Fixture User' })
    assert.equal(sendCalls.length, 1)
    const msg = sendCalls[0]
    assert.equal(msg.to, 'fixture@example.com')
    assert.match(msg.subject, /register/i)
    assert.match(msg.text, /Fixture User/)
    assert.match(msg.text, /already has an account/i)
  })

  test('sendForgotPassword includes the reset link', async () => {
    await mail.sendForgotPassword({ to: 'ada@example.com', name: 'Ada', token: 'tok456' })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/wiki\.example\.com\/login\/reset-password\/tok456/)
    assert.match(msg.text, /https:\/\/wiki\.example\.com\/login\/reset-password\/tok456/)
  })

  test('sendForgotPassword links at the given siteId hostname instead of the instance default (OpenProject #3386)', async () => {
    await mail.sendForgotPassword({
      to: 'ada@example.com',
      name: 'Ada',
      token: 'tok456',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login\/reset-password\/tok456/)
    assert.match(msg.text, /https:\/\/de\.wiki\.example\.com\/login\/reset-password\/tok456/)
  })

  test('sendPasswordResetConfirmed sends a notice with no token', async () => {
    await mail.sendPasswordResetConfirmed({ to: 'ada@example.com', name: 'Ada' })
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.subject, /password/i)
    assert.match(msg.text, /Ada/)
  })

  test('sendPasswordResetConfirmed links at the given siteId hostname (OpenProject #3386)', async () => {
    await mail.sendPasswordResetConfirmed({
      to: 'ada@example.com',
      name: 'Ada',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login/)
  })

  test('sendTfaRecoveryCodesGenerated sends a notice with no token', async () => {
    await mail.sendTfaRecoveryCodesGenerated({ to: 'ada@example.com', name: 'Ada' })
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.subject, /recovery codes/i)
    assert.match(msg.text, /Ada/)
  })

  test('sendTfaRecoveryCodesGenerated links at the given siteId hostname (OpenProject #3386)', async () => {
    await mail.sendTfaRecoveryCodesGenerated({
      to: 'ada@example.com',
      name: 'Ada',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login/)
  })

  test('sendTfaEnabled links at the given siteId hostname (OpenProject #3386)', async () => {
    await mail.sendTfaEnabled({ to: 'ada@example.com', name: 'Ada', siteId: DEFAULT_SITE_ID })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login/)
  })

  test('sendTfaDisabled links at the given siteId hostname (OpenProject #3386)', async () => {
    await mail.sendTfaDisabled({ to: 'ada@example.com', name: 'Ada', siteId: DEFAULT_SITE_ID })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login/)
  })

  test('sendTfaNewDeviceLogin links at the given siteId hostname (OpenProject #3386)', async () => {
    await mail.sendTfaNewDeviceLogin({
      to: 'ada@example.com',
      name: 'Ada',
      ip: '1.2.3.4',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login/)
  })

  test('sendSignInMethodAdded names the method, escaping it in the HTML part only', async () => {
    await mail.sendSignInMethodAdded({
      to: 'ada@example.com',
      name: 'Ada',
      methodName: 'Acme <SSO>',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.equal(msg.kind, 'signInMethodAdded')
    assert.match(msg.subject, /sign-in method/i)
    assert.match(msg.text, /Ada/)
    assert.match(msg.text, /Acme <SSO>/)
    assert.match(msg.html, /Acme &lt;SSO&gt;/)
    assert.doesNotMatch(msg.html, /<SSO>/)
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login/)
  })

  test('sendRegistrationAttemptNotice links at the given siteId hostname (OpenProject #3386)', async () => {
    await mail.sendRegistrationAttemptNotice({
      to: 'fixture@example.com',
      name: 'Fixture User',
      siteId: DEFAULT_SITE_ID
    })
    const msg = sendCalls[0]
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/login/)
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
    // -> Matches the 24-hour validUntil set by `models/userCredentials.ts#generateToken`.
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

  describe('a site whose non-primary locale has a URL alias', () => {
    const ALIAS_SITES = {
      'alias-site': {
        hostname: 'de.wiki.example.com',
        config: {
          locales: { primary: 'en', active: ['en', 'zh-CN'], aliases: { 'zh-CN': 'zh' } }
        }
      }
    }

    beforeEach(() => {
      setMailConfig(
        {
          host: 'smtp.example.com',
          senderEmail: 'wiki@example.com',
          defaultBaseURL: 'https://wiki.example.com'
        },
        ALIAS_SITES
      )
      mail.send = (async (msg: any) => {
        sendCalls.push(msg)
      }) as any
    })

    test('sendPageWatchNotification links the aliased locale through its alias, not the canonical code', async () => {
      await mail.sendPageWatchNotification({
        to: 'ada@example.com',
        siteId: 'alias-site',
        page: { title: 'Guide', path: 'docs/guide', locale: 'zh-CN' },
        action: 'updated',
        changedFields: ['title'],
        actorName: 'Bob'
      })
      const msg = sendCalls[0]
      assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/zh\/docs\/guide/)
      assert.match(msg.text, /https:\/\/de\.wiki\.example\.com\/zh\/docs\/guide/)
      assert.doesNotMatch(msg.html, /zh-CN\/docs\/guide/)
    })

    test('sendPageWatchDigest links each item by its own locale spelling', async () => {
      await mail.sendPageWatchDigest({
        to: 'ada@example.com',
        siteId: 'alias-site',
        items: [
          {
            page: { title: 'Guide', path: 'docs/guide', locale: 'en' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          },
          {
            page: { title: 'Guide', path: 'docs/guide', locale: 'zh-CN' },
            action: 'updated',
            changedFields: ['title'],
            actorName: 'Bob'
          }
        ]
      })
      const msg = sendCalls[0]
      assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/docs\/guide/)
      assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/zh\/docs\/guide/)
      assert.doesNotMatch(msg.html, /zh-CN\/docs\/guide/)
    })
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
    assert.doesNotMatch(msg.text, /deleted:/)
    assert.match(msg.text, /\(deleted\)/)
  })

  test('sendPageWatchNotification for a suggestion decision tells the recipient why, without the "watching this page" line', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'suggestApproved',
      changedFields: [],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.match(msg.subject, /approved/)
    assert.match(msg.text, /submitted this suggested edit/)
    assert.doesNotMatch(msg.text, /watching this page/)
  })

  test('sendPageWatchNotification for a declined suggestion uses the declined label', async () => {
    await mail.sendPageWatchNotification({
      to: 'ada@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'suggestDeclined',
      changedFields: [],
      actorName: 'Bob'
    })
    const msg = sendCalls[0]
    assert.match(msg.subject, /declined/)
    assert.match(msg.text, /submitted this suggested edit/)
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
    // -> The plain-text alternative needs no escaping: it is never parsed as markup.
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
      const [i1, i2, i3] = ['Page One', 'Page Two', 'Page Three'].map((needle) =>
        msg.text.indexOf(needle)
      )
      assert.ok(i1 < i2 && i2 < i3)
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

describe('mail.sendEventNotification', () => {
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

  test('links at the site hostname, not the instance defaultBaseURL, and includes the page path', async () => {
    await mail.sendEventNotification({
      to: 'ada@example.com',
      event: 'page:create',
      siteId: DEFAULT_SITE_ID,
      data: { id: 'page-1', path: 'docs/getting-started', metadata: { title: 'Getting Started' } }
    })
    assert.equal(sendCalls.length, 1)
    const msg = sendCalls[0]
    assert.equal(msg.to, 'ada@example.com')
    assert.match(msg.subject, /A page was created/)
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com\/docs\/getting-started/)
    assert.match(msg.text, /Getting Started/)
  })

  test('falls back to defaultBaseURL for a site-less event (e.g. user:join)', async () => {
    await mail.sendEventNotification({
      to: 'ada@example.com',
      event: 'user:join',
      siteId: null,
      data: { userId: 'user-2', metadata: { name: 'Bob', email: 'bob@example.com' } }
    })
    const msg = sendCalls[0]
    assert.match(msg.subject, /A new user joined/)
    assert.match(msg.html, /https:\/\/wiki\.example\.com/)
  })

  test('falls back to the bare site link when the event carries no path', async () => {
    await mail.sendEventNotification({
      to: 'ada@example.com',
      event: 'approval:submitted',
      siteId: DEFAULT_SITE_ID,
      data: { id: 'submission-1', pageId: 'page-1', authorId: 'user-1' }
    })
    const msg = sendCalls[0]
    assert.match(msg.subject, /submitted for approval/)
    assert.match(msg.html, /https:\/\/de\.wiki\.example\.com/)
  })

  test('prefers metadata.title over the bare path for the body detail', async () => {
    await mail.sendEventNotification({
      to: 'ada@example.com',
      event: 'page:edit',
      siteId: DEFAULT_SITE_ID,
      data: {
        id: 'page-1',
        path: 'docs/getting-started',
        metadata: { title: 'Getting Started (v2)' }
      }
    })
    const msg = sendCalls[0]
    assert.match(msg.text, /Getting Started \(v2\)/)
  })

  test('escapes an untrusted metadata title in the HTML body', async () => {
    await mail.sendEventNotification({
      to: 'ada@example.com',
      event: 'page:edit',
      siteId: DEFAULT_SITE_ID,
      data: {
        id: 'page-1',
        path: 'evil-page',
        metadata: { title: '<script>alert(1)</script>' }
      }
    })
    const msg = sendCalls[0]
    assert.doesNotMatch(msg.html, /<script>/)
    assert.match(msg.html, /&lt;script&gt;/)
  })

  test('body includes the mail.notificationEvent.footer line naming the event label', async () => {
    await mail.sendEventNotification({
      to: 'ada@example.com',
      event: 'comment:new',
      siteId: DEFAULT_SITE_ID,
      data: { id: 'comment-1', pageId: 'page-1' }
    })
    const msg = sendCalls[0]
    assert.match(msg.text, /subscribed to email notifications/i)
    assert.match(msg.html, /subscribed to email notifications/i)
  })
})

describe('mail templates resolve through the locale catalogue', () => {
  let sendCalls: any[]

  beforeEach(() => {
    sendCalls = []
  })

  function captureSends() {
    mail.send = (async (msg: any) => {
      sendCalls.push(msg)
    }) as any
  }

  test('sendVerifyEmail subject resolves from a recipient locale that has the key', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' }, DEFAULT_SITES, {
      fr: { 'mail.verifyEmail.subject': 'Vérifiez votre adresse e-mail' }
    })
    captureSends()
    await mail.sendVerifyEmail({ to: 'ada@example.com', name: 'Ada', token: 'tok', locale: 'fr' })
    assert.equal(sendCalls[0].subject, 'Vérifiez votre adresse e-mail')
  })

  test('sendTfaRecoveryCodesGenerated subject resolves from a recipient locale that has the key', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' }, DEFAULT_SITES, {
      fr: {
        'mail.tfaRecoveryCodesGenerated.subject': 'Vos codes de récupération ont été régénérés'
      }
    })
    captureSends()
    await mail.sendTfaRecoveryCodesGenerated({ to: 'ada@example.com', name: 'Ada', locale: 'fr' })
    assert.equal(sendCalls[0].subject, 'Vos codes de récupération ont été régénérés')
  })

  test('falls back to en for a locale that is not installed', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' })
    captureSends()
    await mail.sendVerifyEmail({
      to: 'ada@example.com',
      name: 'Ada',
      token: 'tok',
      locale: 'xx-not-installed'
    })
    assert.equal(sendCalls[0].subject, enStrings['mail.verifyEmail.subject'])
  })

  test('falls back to en for a key missing (blank) from an otherwise-installed locale', async () => {
    setMailConfig({ host: 'smtp.example.com', senderEmail: 'wiki@example.com' }, DEFAULT_SITES, {
      fr: { 'mail.verifyEmail.subject': '' }
    })
    captureSends()
    await mail.sendVerifyEmail({ to: 'ada@example.com', name: 'Ada', token: 'tok', locale: 'fr' })
    assert.equal(sendCalls[0].subject, enStrings['mail.verifyEmail.subject'])
  })

  test('every one of the six templates resolves its subject from the real en.json mail.* keys', async () => {
    setMailConfig({
      host: 'smtp.example.com',
      senderEmail: 'wiki@example.com',
      defaultBaseURL: 'https://wiki.example.com'
    })
    captureSends()

    await mail.sendVerifyEmail({ to: 'a@example.com', name: 'Ada', token: 't' })
    await mail.sendForgotPassword({ to: 'a@example.com', name: 'Ada', token: 't' })
    await mail.sendPasswordResetConfirmed({ to: 'a@example.com', name: 'Ada' })
    await mail.sendWelcomeEmail({ to: 'a@example.com', name: 'Ada', token: 't' })
    await mail.sendTestEmail({ to: 'a@example.com' })
    await mail.sendPageWatchNotification({
      to: 'a@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'updated',
      changedFields: [],
      actorName: 'Bob'
    })

    assert.equal(sendCalls[0].subject, enStrings['mail.verifyEmail.subject'])
    assert.equal(sendCalls[1].subject, enStrings['mail.forgotPassword.subject'])
    assert.equal(sendCalls[2].subject, enStrings['mail.passwordChanged.subject'])
    assert.equal(sendCalls[3].subject, enStrings['mail.welcomeEmail.subject'])
    assert.equal(sendCalls[4].subject, enStrings['mail.testEmail.subject'])
    const expectedWatchSubject = enStrings['mail.watchNotification.subject']
      .replace('{label}', enStrings['mail.watchAction.updated'])
      .replace('{title}', 'Getting Started')
    assert.equal(sendCalls[5].subject, expectedWatchSubject)
  })

  test('sendPageWatchNotification body includes the mail.watchNotification.footer line', async () => {
    setMailConfig({
      host: 'smtp.example.com',
      senderEmail: 'wiki@example.com',
      defaultBaseURL: 'https://wiki.example.com'
    })
    captureSends()
    await mail.sendPageWatchNotification({
      to: 'a@example.com',
      siteId: DEFAULT_SITE_ID,
      page: { title: 'Getting Started', path: 'docs/getting-started', locale: 'en' },
      action: 'updated',
      changedFields: [],
      actorName: 'Bob'
    })
    assert.match(sendCalls[0].text, /Manage your watched pages from your profile's Inbox/)
    assert.match(sendCalls[0].html, /Manage your watched pages from your profile's Inbox/)
  })

  test('watch-digest subject uses a plural message for counts of 0, 1 and 2', async () => {
    setMailConfig({
      host: 'smtp.example.com',
      senderEmail: 'wiki@example.com',
      defaultBaseURL: 'https://wiki.example.com'
    })
    captureSends()

    await mail.sendPageWatchDigest({ to: 'a@example.com', siteId: DEFAULT_SITE_ID, items: [] })
    await mail.sendPageWatchDigest({
      to: 'a@example.com',
      siteId: DEFAULT_SITE_ID,
      items: [
        {
          page: { title: 'Solo', path: 'solo', locale: 'en' },
          action: 'updated',
          changedFields: [],
          actorName: 'Bob'
        }
      ]
    })
    await mail.sendPageWatchDigest({
      to: 'a@example.com',
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

    const [zeroForm, oneForm, otherForm] = enStrings['mail.watchDigest.subject'].split(' | ')
    assert.equal(sendCalls[0].subject, zeroForm)
    assert.equal(sendCalls[1].subject, oneForm)
    assert.equal(sendCalls[2].subject, otherForm.replace('{count}', '2'))
  })
})

/**
 * A wrapper that forgets its `MailKind` logs `kind=undefined` rather than failing anywhere, so
 * nothing but this table catches it — and a new template left out of the table fails the coverage
 * test at the end rather than passing unnoticed.
 */
describe('mail send wrappers set their own kind', () => {
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

  const cases: [string, MailKind, () => Promise<void>][] = [
    [
      'sendVerifyEmail',
      'verify',
      () => mail.sendVerifyEmail({ to: 'a@example.com', name: 'A', token: 't', userId: 'u1' })
    ],
    [
      'sendForgotPassword',
      'forgotPassword',
      () => mail.sendForgotPassword({ to: 'a@example.com', name: 'A', token: 't', userId: 'u1' })
    ],
    [
      'sendWelcomeEmail',
      'welcome',
      () => mail.sendWelcomeEmail({ to: 'a@example.com', name: 'A', token: 't', userId: 'u1' })
    ],
    [
      'sendPasswordResetConfirmed',
      'passwordChanged',
      () => mail.sendPasswordResetConfirmed({ to: 'a@example.com', name: 'A', userId: 'u1' })
    ],
    [
      'sendRegistrationAttemptNotice',
      'registrationAttempt',
      () => mail.sendRegistrationAttemptNotice({ to: 'a@example.com', name: 'A', userId: 'u1' })
    ],
    [
      'sendTfaRecoveryCodesGenerated',
      'tfaRecoveryCodesGenerated',
      () => mail.sendTfaRecoveryCodesGenerated({ to: 'a@example.com', name: 'A', userId: 'u1' })
    ],
    ['sendTestEmail', 'test', () => mail.sendTestEmail({ to: 'a@example.com' })],
    [
      'sendPageWatchNotification',
      'watch',
      () =>
        mail.sendPageWatchNotification({
          to: 'a@example.com',
          siteId: DEFAULT_SITE_ID,
          page: { title: 'T', path: 'a/b', locale: 'en' },
          action: 'updated',
          changedFields: ['content'],
          actorName: 'Ada',
          userId: 'u1'
        })
    ],
    [
      'sendPageWatchDigest',
      'digest',
      () =>
        mail.sendPageWatchDigest({
          to: 'a@example.com',
          siteId: DEFAULT_SITE_ID,
          items: [
            {
              page: { title: 'T', path: 'a/b', locale: 'en' },
              action: 'updated',
              changedFields: ['content'],
              actorName: 'Ada'
            }
          ],
          userId: 'u1'
        })
    ],
    [
      'sendEventNotification',
      'notificationEvent',
      () =>
        mail.sendEventNotification({
          to: 'a@example.com',
          event: 'page:edit',
          siteId: DEFAULT_SITE_ID,
          data: {},
          userId: 'u1'
        })
    ],
    [
      'sendTfaEnabled',
      'tfaEnabled',
      () => mail.sendTfaEnabled({ to: 'a@example.com', name: 'A', userId: 'u1' })
    ],
    [
      'sendTfaDisabled',
      'tfaDisabled',
      () => mail.sendTfaDisabled({ to: 'a@example.com', name: 'A', userId: 'u1' })
    ],
    [
      'sendTfaNewDeviceLogin',
      'tfaNewDeviceLogin',
      () => mail.sendTfaNewDeviceLogin({ to: 'a@example.com', name: 'A', userId: 'u1' })
    ],
    [
      'sendSignInMethodAdded',
      'signInMethodAdded',
      () =>
        mail.sendSignInMethodAdded({
          to: 'a@example.com',
          name: 'A',
          methodName: 'GitHub',
          userId: 'u1'
        })
    ]
  ]

  for (const [name, kind, run] of cases) {
    test(`${name} sends kind=${kind}`, async () => {
      await run()
      assert.equal(sendCalls.length, 1)
      assert.equal(sendCalls[0].kind, kind)
    })
  }

  test('every MailKind but approval is covered by a wrapper above', () => {
    // -> `approval` and `commentMention` are composed outside this model
    //    (`models/approvalNotifications.ts`, `models/commentNotifications.ts` build their own body
    //    and call `mail.send` directly), so they have no wrapper to table here.
    const covered = new Set(cases.map(([, kind]) => kind))
    const allKinds: Record<Exclude<MailKind, 'approval' | 'commentMention'>, true> = {
      verify: true,
      forgotPassword: true,
      welcome: true,
      passwordChanged: true,
      registrationAttempt: true,
      test: true,
      watch: true,
      digest: true,
      notificationEvent: true,
      tfaEnabled: true,
      tfaDisabled: true,
      tfaRecoveryCodesGenerated: true,
      tfaNewDeviceLogin: true,
      signInMethodAdded: true
    }
    const all = Object.keys(allKinds) as MailKind[]
    for (const kind of all) {
      assert.ok(covered.has(kind), `MailKind "${kind}" has no wrapper case above`)
    }
  })

  test('a wrapper forwards the userId it was given', async () => {
    await mail.sendVerifyEmail({ to: 'a@example.com', name: 'A', token: 't', userId: 'u-99' })
    assert.equal(sendCalls[0].userId, 'u-99')
  })

  test('a wrapper called without a userId leaves it absent rather than inventing one', async () => {
    await mail.sendTestEmail({ to: 'a@example.com' })
    assert.equal(sendCalls[0].userId, undefined)
  })
})
