import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchemas } from './schemas/page.ts'
// -> `Page#` (used by every route response here) references `PageEditSubmission#`
import { registerSchemas as registerApprovalSchemas } from './schemas/approval.ts'
import { CustomError } from '../helpers/common.ts'

/**
 * Route-wiring tests for `GET /sites/:siteId/pages/deleted` and
 * `POST /sites/:siteId/pages/deleted/:versionId/recover`.
 *
 * `WIKI.models.pageHistory` and `WIKI.models.groups` are stubbed rather than backed by a real
 * database — the model layer (listRecoverable, getDeletedVersion, recoverDeletedPage) already has
 * its own coverage from the task that added it. What this file checks is the route's own logic: that
 * the list is filtered per row by `read:history` rather than answered as a whole-list 403, that
 * recovery is checked against the TARGET path (override when given, otherwise the deleted version's
 * own path), and that a `CustomError` thrown by the model (a duplicate path, an invalid locale)
 * reaches the client as clean JSON at its own status code rather than a generic 500.
 *
 * There is no real session plugin here: a request's `session` is set directly from the
 * `x-test-session` header (JSON-encoded), which is all `actorFrom`/`mayOnPage` ever read.
 *
 * The error handler mirrors `index.ts`'s app-level one (not imported — that file also boots the
 * whole server) so a test asserting on `pageDuplicatePath` / `pageInvalidLocale` exercises the same
 * shaping the frontend actually receives.
 */

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const VERSION_ID = '22222222-2222-2222-2222-222222222222'

let app: FastifyInstance
let listRecoverableResult: any[]
let getDeletedVersionResult: any
let recoverDeletedPageImpl: (...args: any[]) => Promise<any>
let checkAccessImpl: (actor: any, permission: string, page: any) => boolean

function withSession(session: Record<string, any>) {
  return { 'x-test-session': JSON.stringify(session) }
}

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        actorForRequest: (req: any) => ({
          id: req.session?.user?.id ?? null,
          permissions: req.session?.permissions ?? [],
          groups: req.session?.groups ?? []
        }),
        checkAccess: (actor: any, permission: string, page: any) =>
          checkAccessImpl(actor, permission, page)
      },
      pageHistory: {
        listRecoverable: async (_siteId: string) => listRecoverableResult,
        getDeletedVersion: async (_siteId: string, _versionId: string) => getDeletedVersionResult,
        recoverDeletedPage: async (...args: any[]) => recoverDeletedPageImpl(...args)
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  app.setErrorHandler((error: any, _req, reply) => {
    if (error.statusCode) {
      reply.code(error.statusCode).type('application/json').send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode,
        message: error.message
      })
    } else {
      reply.code(500).type('application/json').send({
        ok: false,
        error: 'Internal Server Error',
        statusCode: 500,
        message: 'Internal Server error'
      })
    }
  })
  app.decorateRequest('session', null as any)
  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-test-session']
    ;(req as any).session = typeof raw === 'string' ? JSON.parse(raw) : {}
  })
  await registerApprovalSchemas(app)
  await registerPageSchemas(app)
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  listRecoverableResult = []
  getDeletedVersionResult = null
  checkAccessImpl = () => false
  recoverDeletedPageImpl = async () => {
    throw new Error('recoverDeletedPage should not be called in this test')
  }
})

test('GET /sites/:siteId/pages/deleted only includes rows the actor may read the history of', async () => {
  listRecoverableResult = [
    { id: 'v1', path: 'visible', locale: 'en', title: 'Visible', action: 'deleted' },
    { id: 'v2', path: 'hidden', locale: 'en', title: 'Hidden', action: 'deleted' }
  ]
  checkAccessImpl = (_actor, permission, page) =>
    permission === 'read:history' && page.path === 'visible'

  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/deleted`
  })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.length, 1)
  assert.equal(body[0].path, 'visible')
})

test('POST recover requires a logged in user', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
    headers: withSession({}),
    payload: {}
  })

  assert.equal(res.statusCode, 401)
})

test('POST recover answers 404 for an id that names no deleted version', async () => {
  getDeletedVersionResult = null

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
    headers: withSession({ authenticated: true, user: { id: 'u1' } }),
    payload: {}
  })

  assert.equal(res.statusCode, 404)
})

test('POST recover checks write:pages against the target path, not the original', async () => {
  getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
  const seenTargets: any[] = []
  checkAccessImpl = (_actor, permission, page) => {
    if (permission === 'write:pages') {
      seenTargets.push(page)
    }
    return false
  }

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
    headers: withSession({ authenticated: true, user: { id: 'u1' } }),
    payload: { path: 'overridden', locale: 'fr' }
  })

  assert.equal(res.statusCode, 403)
  assert.deepEqual(seenTargets, [{ path: 'overridden', locale: 'fr' }])
})

test('POST recover recreates the page and returns it', async () => {
  getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
  checkAccessImpl = () => true
  let calledWith: any[] = []
  recoverDeletedPageImpl = async (...args: any[]) => {
    calledWith = args
    return { id: 'p1', path: 'original', locale: 'en', title: 'T' }
  }

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
    headers: withSession({ authenticated: true, user: { id: 'u1' } }),
    payload: {}
  })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.page.path, 'original')
  assert.equal(calledWith[0], SITE_ID)
  assert.equal(calledWith[1], VERSION_ID)
  assert.equal(calledWith[2].id, 'u1')
})

test('POST recover surfaces a duplicate-path conflict as 409 JSON, not a 500', async () => {
  getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
  checkAccessImpl = () => true
  recoverDeletedPageImpl = async () => {
    throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
  }

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
    headers: withSession({ authenticated: true, user: { id: 'u1' } }),
    payload: {}
  })

  assert.equal(res.statusCode, 409)
  const body = res.json()
  assert.equal(body.error, 'pageDuplicatePath')
  assert.equal(body.statusCode, 409)
})

test('POST recover surfaces an invalid-locale rejection as 400 JSON, not a 500', async () => {
  getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
  checkAccessImpl = () => true
  recoverDeletedPageImpl = async () => {
    throw new CustomError('pageInvalidLocale', 'This locale does not exist for this site.', 400)
  }

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
    headers: withSession({ authenticated: true, user: { id: 'u1' } }),
    payload: { locale: 'zz' }
  })

  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error, 'pageInvalidLocale')
  assert.equal(body.statusCode, 400)
})
