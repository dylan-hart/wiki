import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import storageRoutes from './storage.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Task 545: prove `POST /sites/:siteId/storage/targets/:targetId/actions/exportAll` actually calls
 * `WIKI.models.storage.executeAction()` with the resolved target and action name, and that the
 * route's existing `try { await executeAction(...) } catch (err) { reply.badRequest(err.message) }`
 * contract (`api/storage.ts`) turns a thrown module error — the shape a broken cloud config (wrong
 * bucket, revoked credentials) produces — into a 400 with a readable message rather than an unhandled
 * 500. `WIKI.models.storage` is stubbed here rather than exercising a real cloud SDK: that proof lives
 * in `modules/storage/s3/storage.emulated.test.ts`, which runs the real s3 module against a real
 * S3-compatible server. This file is only about the HTTP-layer contract on top of it.
 */

let app: FastifyInstance
let executeAction: ReturnType<typeof mock.fn>
let getSiteTargetById: ReturnType<typeof mock.fn>

const SITE_ID = randomUUID()

const ENABLED_TARGET = {
  id: randomUUID(),
  siteId: SITE_ID,
  module: 's3',
  isEnabled: true,
  title: 'Test S3',
  actions: [{ handler: 'exportAll', label: 'Export All', hint: '', icon: 'this-way-up' }]
}

const DISABLED_TARGET = { ...ENABLED_TARGET, id: randomUUID(), isEnabled: false }

const GIT_TARGET = {
  id: randomUUID(),
  siteId: SITE_ID,
  module: 'git',
  isEnabled: true,
  title: 'Test Git',
  actions: [{ handler: 'sync', label: 'Force Sync', hint: '', icon: 'synchronize' }]
}

before(async () => {
  executeAction = mock.fn(async () => {})
  getSiteTargetById = mock.fn(async (_siteId: string, targetId: string) => {
    if (targetId === ENABLED_TARGET.id) return ENABLED_TARGET
    if (targetId === DISABLED_TARGET.id) return DISABLED_TARGET
    if (targetId === GIT_TARGET.id) return GIT_TARGET
    return null
  })

  app = await buildTestApp({
    routes: storageRoutes,
    ajv: true,
    wiki: {
      models: {
        storage: {
          getSiteTargetById,
          executeAction
        }
      }
    }
  })
})

beforeEach(() => {
  executeAction.mock.resetCalls()
  getSiteTargetById.mock.resetCalls()
  ;(WIKI.scheduler.addJob as any).mock.resetCalls()
})

after(() => closeTestApp(app))

test('exportAll invokes executeAction() with the resolved target and the "exportAll" handler', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${ENABLED_TARGET.id}/actions/exportAll`
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(executeAction.mock.calls.length, 1)
  const [target, handler] = executeAction.mock.calls[0]!.arguments
  assert.equal((target as typeof ENABLED_TARGET).id, ENABLED_TARGET.id)
  assert.equal(handler, 'exportAll')
})

test('a module error (broken cloud config — wrong bucket, revoked credentials, ...) surfaces as 400 with a readable message, not a 500', async () => {
  executeAction.mock.mockImplementationOnce(async () => {
    throw new Error(
      'Could not reach the "wrong-bucket" bucket: The specified bucket does not exist.'
    )
  })

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${ENABLED_TARGET.id}/actions/exportAll`
  })

  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.match(body.message, /Could not reach the "wrong-bucket" bucket/)
})

test('a target must be enabled before an action can run', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${DISABLED_TARGET.id}/actions/exportAll`
  })

  assert.equal(res.statusCode, 409)
  assert.equal(executeAction.mock.calls.length, 0)
})

// -> #1616: this used to be a hardcoded `<target> has no "<action>" action.` English sentence,
//    which surfaced verbatim in the UI instead of translating like the rest of a
//    `t(key, fallback)` screen. Assert the coded `ERR_*` shape, not any particular wording.
test('an action the target does not declare is refused before executeAction is ever called', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${ENABLED_TARGET.id}/actions/notARealAction`
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_UNKNOWN_STORAGE_ACTION')
  assert.equal(executeAction.mock.calls.length, 0)
})

test('a nonexistent target 404s', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${randomUUID()}/actions/exportAll`
  })

  assert.equal(res.statusCode, 404)
})

// -> OpenProject #2429: the git module's mass-delete safety guard reads `data.confirmMassDelete`
//    out of the queued job payload `sync.ts#sync()` is eventually called with — this is the one place
//    that payload is built, so this is where the request body has to actually reach it.
describe('confirmMassDelete threads through the queued job for a sync-shaped action', () => {
  test('omitted body queues the job with confirmMassDelete: false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/storage/targets/${GIT_TARGET.id}/actions/sync`
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    assert.equal((WIKI.scheduler.addJob as any).mock.calls.length, 1)
    const [job] = (WIKI.scheduler.addJob as any).mock.calls[0]!.arguments
    assert.equal(job.task, 'dispatchStorage')
    assert.equal(job.payload.handler, 'sync')
    assert.equal(job.payload.data.confirmMassDelete, false)
  })

  test('confirmMassDelete: true in the body reaches the queued job data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/storage/targets/${GIT_TARGET.id}/actions/sync`,
      payload: { confirmMassDelete: true }
    })

    assert.equal(res.statusCode, 200)
    const [job] = (WIKI.scheduler.addJob as any).mock.calls[0]!.arguments
    assert.equal(job.payload.data.confirmMassDelete, true)
  })
})
