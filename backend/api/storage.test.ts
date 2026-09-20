import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import storageRoutes from './storage.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

let app: FastifyInstance
let executeAction: ReturnType<typeof mock.fn>
let getSiteTargetById: ReturnType<typeof mock.fn>
let getSiteTargets: ReturnType<typeof mock.fn>
let validateTarget: ReturnType<typeof mock.fn>
let updateTarget: ReturnType<typeof mock.fn>

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

  getSiteTargets = mock.fn(async () => [ENABLED_TARGET])
  validateTarget = mock.fn(async () => null)
  updateTarget = mock.fn(async () => true)

  app = await buildTestApp({
    routes: storageRoutes,
    ajv: true,
    wiki: {
      models: {
        storage: {
          getSiteTargetById,
          getSiteTargets,
          validateTarget,
          updateTarget,
          executeAction
        },
        auditLog: { record: async () => {} }
      }
    }
  })
})

beforeEach(() => {
  updateTarget.mock.resetCalls()
  executeAction.mock.resetCalls()
  getSiteTargetById.mock.resetCalls()
  ;(CARDINAL.scheduler.addJob as any).mock.resetCalls()
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

test('a synchronous action’s return value reaches the reply message, not the fixed string', async () => {
  executeAction.mock.mockImplementationOnce(async () => ({ purged: 3, skipped: 1 }))

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${ENABLED_TARGET.id}/actions/exportAll`
  })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.match(body.message, /purged: 3/)
  assert.match(body.message, /skipped: 1/)
})

test('a synchronous action returning nothing keeps the fixed completion message', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${ENABLED_TARGET.id}/actions/exportAll`
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().message, 'Action completed successfully.')
})

test('a target must be enabled before an action can run', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/storage/targets/${DISABLED_TARGET.id}/actions/exportAll`
  })

  assert.equal(res.statusCode, 409)
  assert.equal(executeAction.mock.calls.length, 0)
})

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

// -> The git module's mass-delete safety guard reads `data.confirmMassDelete` out of the queued job
//    payload, and this route is the one place that payload is built.
describe('confirmMassDelete threads through the queued job for a sync-shaped action', () => {
  test('omitted body queues the job with confirmMassDelete: false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/storage/targets/${GIT_TARGET.id}/actions/sync`
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    assert.equal((CARDINAL.scheduler.addJob as any).mock.calls.length, 1)
    const [job] = (CARDINAL.scheduler.addJob as any).mock.calls[0]!.arguments
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
    const [job] = (CARDINAL.scheduler.addJob as any).mock.calls[0]!.arguments
    assert.equal(job.payload.data.confirmMassDelete, true)
  })
})

describe('PUT /sites/:siteId/storage/targets carries assetDelivery.readThrough', () => {
  test('a readThrough flag passes schema validation and reaches updateTarget untouched', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/storage/targets`,
      payload: {
        targets: [{ id: ENABLED_TARGET.id, assetDelivery: { readThrough: true } }]
      }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().updated, 1)
    const [siteId, target, patch] = updateTarget.mock.calls[0]!.arguments as any[]
    assert.equal(siteId, SITE_ID)
    assert.equal(target.id, ENABLED_TARGET.id)
    assert.deepEqual(patch.assetDelivery, { readThrough: true })
  })

  test('a non-boolean readThrough is refused before anything is written', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/storage/targets`,
      payload: {
        targets: [{ id: ENABLED_TARGET.id, assetDelivery: { readThrough: { on: true } } }]
      }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(updateTarget.mock.calls.length, 0)
  })
})
