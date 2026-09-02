import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import schedulerRoutes from './scheduler.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Task 1983: `backend/api/` had 30 of its 34 route sources with a co-located test; `scheduler.ts`
 * was the largest of the four gaps (314 lines, six routes), two of which mutate state
 * destructively (`DELETE /upcoming/:jobId`, `POST /jobs/:jobId/retry`) and were, until now, covered
 * only indirectly via `e2e/tests/scheduler.spec.js` driving the admin UI. This suite builds a real
 * Fastify instance and drives every route through `app.inject()`, following `api/system.test.ts`
 * and `api/hooks.test.ts` as structural templates: `WIKI.models.jobs` is stubbed with `mock.fn()`
 * per method (no database), and `setErrorHandler` mirrors `index.ts`'s real one so a thrown
 * `reply.notFound()`/`conflict()`/`internalServerError()` comes back shaped as the `ApiError` the
 * schemas declare, exactly as it would in the running app.
 */

const SCHEDULE_ENTRY = {
  id: randomUUID(),
  task: 'cleanJobHistory',
  cron: '0 0 * * *',
  type: 'system',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
}

const KNOWN_UPCOMING_ID = randomUUID()
const ALREADY_PICKED_UP_ID = randomUUID()

const HISTORY_ENTRY_RETRYABLE = {
  id: randomUUID(),
  task: 'cleanJobHistory',
  state: 'failed',
  maxRetries: 3,
  payload: {}
}

const HISTORY_ENTRY_RUNNING = {
  id: randomUUID(),
  task: 'cleanJobHistory',
  state: 'active',
  maxRetries: 3,
  payload: {}
}

let app: FastifyInstance
let getSchedule: ReturnType<typeof mock.fn>
let getScheduleEntry: ReturnType<typeof mock.fn>
let runScheduledTask: ReturnType<typeof mock.fn>
let getUpcoming: ReturnType<typeof mock.fn>
let cancelUpcoming: ReturnType<typeof mock.fn>
let getHistory: ReturnType<typeof mock.fn>
let getHistoryEntry: ReturnType<typeof mock.fn>
let retryJob: ReturnType<typeof mock.fn>
const routeConfigs: Record<string, any> = {}

before(async () => {
  getSchedule = mock.fn(async () => [SCHEDULE_ENTRY])
  getScheduleEntry = mock.fn(async (id: string) =>
    id === SCHEDULE_ENTRY.id ? SCHEDULE_ENTRY : null
  )
  runScheduledTask = mock.fn(async () => 'new-job-id')
  getUpcoming = mock.fn(async () => [])
  cancelUpcoming = mock.fn(async (id: string) => id === KNOWN_UPCOMING_ID)
  getHistory = mock.fn(async () => ({ total: 0, jobs: [] }))
  getHistoryEntry = mock.fn(async (id: string) => {
    if (id === HISTORY_ENTRY_RETRYABLE.id) return HISTORY_ENTRY_RETRYABLE
    if (id === HISTORY_ENTRY_RUNNING.id) return HISTORY_ENTRY_RUNNING
    return null
  })
  retryJob = mock.fn(async () => 'new-retry-job-id')

  // -> Captures each route's `config.permissions` as it is registered, since Fastify does not
  //    expose a public, stable API to read it back afterwards — same technique as
  //    `api/analytics.test.ts`. Wrapped around the route plugin, since an `onRoute` hook only fires
  //    for routes registered into the same encapsulation or below it.
  const capturingRoutes: FastifyPluginAsync = async (instance) => {
    instance.addHook('onRoute', (routeOptions: any) => {
      routeConfigs[`${routeOptions.method}:${routeOptions.url}`] = routeOptions.config
    })
    await instance.register(schedulerRoutes)
  }

  app = await buildTestApp({
    routes: capturingRoutes,
    ajv: true,
    wiki: {
      models: {
        jobs: {
          getSchedule,
          getScheduleEntry,
          runScheduledTask,
          getUpcoming,
          cancelUpcoming,
          getHistory,
          getHistoryEntry,
          retryJob
        }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  getSchedule.mock.resetCalls()
  getScheduleEntry.mock.resetCalls()
  runScheduledTask.mock.resetCalls()
  getUpcoming.mock.resetCalls()
  cancelUpcoming.mock.resetCalls()
  getHistory.mock.resetCalls()
  getHistoryEntry.mock.resetCalls()
  retryJob.mock.resetCalls()
})

describe('every route declares manage:system', () => {
  test('all six routes are gated on manage:system, and nothing else', () => {
    const routes = [
      'GET:/schedule',
      'POST:/schedule/:scheduleId/run',
      'GET:/upcoming',
      'DELETE:/upcoming/:jobId',
      'GET:/jobs',
      'POST:/jobs/:jobId/retry'
    ]
    for (const key of routes) {
      assert.deepEqual(
        routeConfigs[key]?.permissions,
        ['manage:system'],
        `${key} should require manage:system`
      )
    }
  })
})

describe('GET /schedule', () => {
  test('returns the cron schedule from the model, unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/schedule' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [SCHEDULE_ENTRY])
    assert.equal(getSchedule.mock.callCount(), 1)
  })
})

describe('POST /schedule/:scheduleId/run', () => {
  test('queues the task and returns its new job id', async () => {
    const res = await app.inject({ method: 'POST', url: `/schedule/${SCHEDULE_ENTRY.id}/run` })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.id, 'new-job-id')
    assert.equal(runScheduledTask.mock.callCount(), 1)
  })

  test('404s when the schedule entry does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: `/schedule/${randomUUID()}/run` })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().ok, false)
    assert.equal(runScheduledTask.mock.callCount(), 0)
  })

  test('500s when the scheduler refuses to queue the job', async () => {
    runScheduledTask.mock.mockImplementationOnce(async () => null)
    const res = await app.inject({ method: 'POST', url: `/schedule/${SCHEDULE_ENTRY.id}/run` })
    assert.equal(res.statusCode, 500)
    assert.equal(res.json().message, 'The scheduler could not queue the job.')
  })

  test('rejects a non-uuid scheduleId at the schema, before the model is asked', async () => {
    const res = await app.inject({ method: 'POST', url: '/schedule/not-a-uuid/run' })
    assert.equal(res.statusCode, 400)
    assert.equal(getScheduleEntry.mock.callCount(), 0)
  })
})

describe('GET /upcoming', () => {
  test('returns the pending queue from the model, unchanged', async () => {
    const upcoming = [{ id: randomUUID(), task: 'cleanJobHistory' }]
    getUpcoming.mock.mockImplementationOnce(async () => upcoming)
    const res = await app.inject({ method: 'GET', url: '/upcoming' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), upcoming)
  })
})

describe('DELETE /upcoming/:jobId', () => {
  test('204s when the job was cancelled', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/upcoming/${KNOWN_UPCOMING_ID}` })
    assert.equal(res.statusCode, 204)
    assert.equal(cancelUpcoming.mock.callCount(), 1)
  })

  /**
   * The "already picked up by another instance" race: an instance can grab a pending job between
   * the admin UI listing it and the operator clicking cancel, at which point `cancelUpcoming()`
   * deletes zero rows. `e2e/helpers/db.js` plants this by hand for the UI-level spec; here it is
   * just `cancelUpcoming` resolving false, no database involved.
   */
  test('404s when the job is no longer pending (already picked up)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/upcoming/${ALREADY_PICKED_UP_ID}` })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().ok, false)
  })
})

describe('GET /jobs', () => {
  test('returns total, limit and jobs from the model', async () => {
    const jobs = [{ id: randomUUID(), task: 'cleanJobHistory', state: 'completed' }]
    getHistory.mock.mockImplementationOnce(async () => ({ total: 5, jobs }))
    const res = await app.inject({ method: 'GET', url: '/jobs' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.total, 5)
    assert.equal(body.limit, 100)
    assert.deepEqual(body.jobs, jobs)
  })

  test('forwards an explicit limit and states filter to the model', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/jobs?limit=10&states=failed&states=active'
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().limit, 10)
    assert.deepEqual(getHistory.mock.calls[0].arguments[0], {
      states: ['failed', 'active'],
      limit: 10
    })
  })

  test('clamps limit above the schema maximum (500) to a 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs?limit=501' })
    assert.equal(res.statusCode, 400)
    assert.equal(getHistory.mock.callCount(), 0)
  })

  test('clamps limit below the schema minimum (1) to a 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs?limit=0' })
    assert.equal(res.statusCode, 400)
    assert.equal(getHistory.mock.callCount(), 0)
  })

  test('rejects an unknown states value at the schema', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs?states=not-a-real-state' })
    assert.equal(res.statusCode, 400)
    assert.equal(getHistory.mock.callCount(), 0)
  })
})

describe('POST /jobs/:jobId/retry', () => {
  test('queues a fresh run and returns the new job id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/jobs/${HISTORY_ENTRY_RETRYABLE.id}/retry`
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.id, 'new-retry-job-id')
    assert.equal(retryJob.mock.callCount(), 1)
  })

  test('404s when the job does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: `/jobs/${randomUUID()}/retry` })
    assert.equal(res.statusCode, 404)
    assert.equal(retryJob.mock.callCount(), 0)
  })

  test('409s when the job is still running (UI-unreachable branch)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/jobs/${HISTORY_ENTRY_RUNNING.id}/retry`
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().message, 'This job is still running.')
    assert.equal(retryJob.mock.callCount(), 0)
  })

  test('500s when the scheduler refuses to queue the retry (UI-unreachable branch)', async () => {
    retryJob.mock.mockImplementationOnce(async () => null)
    const res = await app.inject({
      method: 'POST',
      url: `/jobs/${HISTORY_ENTRY_RETRYABLE.id}/retry`
    })
    assert.equal(res.statusCode, 500)
    assert.equal(res.json().message, 'The scheduler could not queue the job.')
  })
})
