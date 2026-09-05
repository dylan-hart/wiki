import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { after, before, describe, test } from 'node:test'
import fastify, { type FastifyInstance } from 'fastify'
import { registerSession } from './session.ts'
import { installTestWiki } from '../../test/mocks.ts'
import { SESSION_COOKIE_NAME_INSECURE } from '../../helpers/security.ts'

/**
 * OpenProject #2569: the RTL e2e failures traced to `@fastify/session`'s `onSend` hook calling
 * `session.save()` -- a full async round trip through `sessionStoreAdapter()` -- on EVERY request
 * carrying an already-established session, even a plain `GET` whose handler never touches
 * `req.session` (`GET /_api/locales/en/strings`, `publicAccess: true`). That happens because
 * `rolling` defaults to `true`, and `@fastify/session`'s own `shouldSaveSession()` is
 * `rollingSessions || request.session.isModified()` -- so an unmodified session's read-only GET
 * still forces the store write. The async write races the reply's own completion; `rolling: false`
 * (`session.ts`) is the fix, verified here through the REAL `registerSession()` (same options
 * `index.ts` boots with), not a hand-rolled re-registration.
 *
 * A `session.save()` call is observed indirectly through the store's own `set()` -- exactly the
 * call `@fastify/session#Session.prototype.save()` makes -- rather than by trying to spy on the
 * library's internals directly.
 */
describe('registerSession: session-store writes (OpenProject #2569)', () => {
  let restoreWiki: () => void
  let app: FastifyInstance
  let storeData: Map<string, any>
  let setCalls: ReturnType<typeof mock.fn>

  before(async () => {
    storeData = new Map()
    setCalls = mock.fn(async (id: string, data: any) => {
      storeData.set(id, data)
    })

    const handle = installTestWiki({
      config: {
        auth: { secret: 'a'.repeat(32) },
        // -> Plain HTTP `.inject()` -- `cookieSecure: false` is what makes `@fastify/session`
        //    actually emit the cookie at all, matching `helpers/security.test.ts`'s own reasoning.
        security: { cookieSecure: false }
      },
      models: {
        sessions: {
          get: mock.fn(async (id: string) => storeData.get(id) ?? null),
          set: setCalls,
          destroy: mock.fn(async (id: string) => {
            storeData.delete(id)
          })
        },
        security: {
          observeRequest: mock.fn()
        }
      }
    })
    restoreWiki = handle.restore

    app = fastify()
    registerSession(app)
    app.get('/public-get', { config: { publicAccess: true } }, async () => ({ ok: true }))
    app.post('/login-like', async (req: any) => {
      req.session.user = { id: 'u1' }
      return { ok: true }
    })
    app.post('/mutate-again', async (req: any) => {
      req.session.touchedAt = Date.now()
      return { ok: true }
    })
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
  })

  function cookieHeaderFrom(res: { headers: Record<string, unknown> }): string {
    const setCookie = res.headers['set-cookie']
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie
    assert.ok(cookieStr, 'expected a Set-Cookie header')
    return (cookieStr as string).split(';')[0]
  }

  test('a request that mutates req.session still writes to the store', async () => {
    const res = await app.inject({ method: 'POST', url: '/login-like' })
    assert.equal(res.statusCode, 200)
    assert.equal(setCalls.mock.callCount(), 1)
    assert.ok(cookieHeaderFrom(res).startsWith(`${SESSION_COOKIE_NAME_INSECURE}=`))
  })

  test('a later GET against the same, unmodified session does NOT write to the store', async () => {
    const loginRes = await app.inject({ method: 'POST', url: '/login-like' })
    const cookie = cookieHeaderFrom(loginRes)
    setCalls.mock.resetCalls()

    const res = await app.inject({
      method: 'GET',
      url: '/public-get',
      headers: { cookie }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
    assert.equal(
      setCalls.mock.callCount(),
      0,
      'an unmodified session must not trigger a store round trip -- that round trip is the OpenProject #2569 race'
    )
  })

  test('a request that mutates the session again, later, still writes -- the fix only skips unmodified touches', async () => {
    const loginRes = await app.inject({ method: 'POST', url: '/login-like' })
    const cookie = cookieHeaderFrom(loginRes)
    setCalls.mock.resetCalls()

    const res = await app.inject({
      method: 'POST',
      url: '/mutate-again',
      headers: { cookie }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(setCalls.mock.callCount(), 1)
  })
})
