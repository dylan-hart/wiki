import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import mailRoutes from './mail.ts'
import { registerSchemas as registerMailSchema } from './schemas/mail.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * `POST /_api/mail/test` — the manual verification path for the whole mail transport feature.
 * `WIKI.models.mail.send` is stubbed rather than pulling in the real nodemailer transporter (that
 * mapping is covered directly in `models/mail.test.ts`), keeping this a self-contained test of the
 * route's request/response wiring: which errors from the model become which HTTP statuses.
 */

let app: FastifyInstance
let sendMock: ReturnType<typeof mock.fn>

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      mail: {
        send: (...args: any[]) => sendMock(...args)
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
  await registerErrorSchema(app)
  await registerMailSchema(app)
  await app.register(mailRoutes, { prefix: '/mail' })
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  sendMock = mock.fn(async () => {})
})

test('sends the test email and reports success', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, message: 'Test email sent successfully.' })
  assert.equal(sendMock.mock.calls.length, 1)
  const arg = sendMock.mock.calls[0].arguments[0] as any
  assert.equal(arg.to, 'ada@example.com')
  assert.ok(arg.subject)
  assert.ok(arg.html)
  assert.ok(arg.text)
})

test('rejects an empty recipientEmail before calling the model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/mail/test',
    payload: { recipientEmail: '' }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(sendMock.mock.calls.length, 0)
})

test('answers 400 when mail is not configured', async () => {
  sendMock = mock.fn(async () => {
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
  sendMock = mock.fn(async () => {
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
