import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import mailRoutes from './mail.ts'
import { createSilentLogger } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * `POST /_api/mail/test` — the manual verification path for the whole mail transport feature.
 * `WIKI.models.mail.sendTestEmail` is stubbed rather than pulling in the real nodemailer transporter
 * (that mapping, and the template content itself, are covered directly in `models/mail.test.ts`),
 * keeping this a self-contained test of the route's request/response wiring: which errors from the
 * model become which HTTP statuses.
 */

let app: FastifyInstance
let sendTestEmailMock: ReturnType<typeof mock.fn>

before(async () => {
  app = await buildTestApp({
    routes: mailRoutes,
    prefix: '/mail',
    wiki: {
      models: {
        mail: {
          sendTestEmail: (...args: any[]) => sendTestEmailMock(...args)
        }
      },
      config: {
        mail: {}
      },
      configSvc: {
        saveToDb: mock.fn(async () => true)
      },
      // -> Not the silent default: tests assert on what the route logged.
      logger: {
        ...createSilentLogger(),
        warn: mock.fn(),
        error: mock.fn(),
        info: mock.fn(),
        debug: mock.fn()
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  sendTestEmailMock = mock.fn(async () => {})
  WIKI.config.mail = {}
  WIKI.configSvc.saveToDb = mock.fn(async () => true)
})

test('sends the test email and reports success', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, message: 'Test email sent successfully.' })
  assert.equal(sendTestEmailMock.mock.calls.length, 1)
  const arg = sendTestEmailMock.mock.calls[0].arguments[0] as any
  assert.equal(arg.to, 'ada@example.com')
})

test('rejects an empty recipientEmail before calling the model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: '' }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(sendTestEmailMock.mock.calls.length, 0)
})

test('answers 400 when mail is not configured', async () => {
  sendTestEmailMock = mock.fn(async () => {
    throw new Error('ERR_MAIL_NOT_CONFIGURED')
  })

  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /not configured/i)
})

test('answers 500 and logs when the send genuinely fails', async () => {
  sendTestEmailMock = mock.fn(async () => {
    throw new Error('connection refused')
  })

  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 500)
  assert.equal((WIKI.logger.warn as any).mock.calls.length, 1)
})

test('rejects a malformed recipientEmail before calling the model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'not-an-email' }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(sendTestEmailMock.mock.calls.length, 0)
})

test('answers 400 with a specific message when SMTP auth fails', async () => {
  sendTestEmailMock = mock.fn(async () => {
    const err: any = new Error('535 authentication failed')
    err.code = 'EAUTH'
    throw err
  })

  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /authentication|credentials/i)
})

test('answers 502 with a specific message when the SMTP host is unreachable', async () => {
  sendTestEmailMock = mock.fn(async () => {
    const err: any = new Error('connect ECONNREFUSED')
    err.code = 'ECONNECTION'
    throw err
  })

  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 502)
  assert.match(res.json().message, /connect/i)
})

test('answers 502 with a specific message when the SMTP TLS certificate fails validation', async () => {
  sendTestEmailMock = mock.fn(async () => {
    const err: any = new Error('Error initiating TLS - self signed certificate')
    err.code = 'ETLS'
    throw err
  })

  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 502)
  assert.match(res.json().message, /certificate/i)
  // -> Distinct wording from the plain "connect" connection-failure message below, and points the
  //    admin at the "Verify SSL Certificate" toggle that exists to work around exactly this.
  assert.match(res.json().message, /Verify SSL Certificate/)
})

test('answers 422 with a specific message when the recipient is rejected by the SMTP server', async () => {
  sendTestEmailMock = mock.fn(async () => {
    const err: any = new Error('550 no such user')
    err.code = 'EENVELOPE'
    throw err
  })

  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 422)
  assert.match(res.json().message, /recipient|rejected/i)
})

/**
 * `GET /_api/mail/config` / `PUT /_api/mail/config` — the `dkimPrivateKey` masking round trip,
 * matching the existing `pass` contract: a stored key comes back as the mask, and echoing the mask
 * back on PUT must not overwrite the stored value.
 */

test('masks a stored dkimPrivateKey on GET, like pass', async () => {
  WIKI.config.mail = {
    pass: 'super-secret-password',
    dkimPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----'
  }

  const res = await app.inject({ method: 'GET', url: '/mail/config' })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.pass, '********')
  assert.equal(body.dkimPrivateKey, '********')
})

test('returns an empty dkimPrivateKey on GET when none is stored', async () => {
  WIKI.config.mail = { pass: '' }

  const res = await app.inject({ method: 'GET', url: '/mail/config' })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().dkimPrivateKey, '')
})

test('echoing the dkimPrivateKey mask on PUT leaves the stored key byte-identical', async () => {
  const originalKey = '-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----'
  WIKI.config.mail = {
    pass: 'super-secret-password',
    dkimPrivateKey: originalKey
  }

  const res = await app.inject({
    method: 'PUT',
    url: '/mail/config',
    payload: {
      pass: '********',
      dkimPrivateKey: '********'
    }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(WIKI.config.mail.pass, 'super-secret-password')
  assert.equal(WIKI.config.mail.dkimPrivateKey, originalKey)
})

test('PUT with a new dkimPrivateKey overwrites the stored key', async () => {
  WIKI.config.mail = { dkimPrivateKey: 'old-key' }

  const res = await app.inject({
    method: 'PUT',
    url: '/mail/config',
    payload: { dkimPrivateKey: 'new-key' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(WIKI.config.mail.dkimPrivateKey, 'new-key')
})
