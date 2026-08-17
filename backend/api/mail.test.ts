import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import mailRoutes from './mail.ts'
import { registerSchemas as registerMailSchema } from './schemas/mail.ts'

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
  ;(globalThis as any).WIKI = {
    models: {
      mail: {
        sendTestEmail: (...args: any[]) => sendTestEmailMock(...args)
      }
    },
    logger: {
      warn: mock.fn(),
      error: mock.fn(),
      info: mock.fn(),
      debug: mock.fn()
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await registerMailSchema(app)
  await app.register(mailRoutes, { prefix: '/mail' })
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  sendTestEmailMock = mock.fn(async () => {})
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
