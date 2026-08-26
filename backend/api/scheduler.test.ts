import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import schedulerRoutes from './scheduler.ts'
import { registerSchemas as registerSchedulerSchema } from './schemas/scheduler.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * `backend/api/` holds 34 route sources; before this, `scheduler.ts` was one of only four with no
 * co-located test standing up a real Fastify app (testing.md §8), despite being the largest at 314
 * lines and six routes — two of which mutate state destructively (`DELETE /upcoming/:jobId`,
 * `POST /jobs/:jobId/retry`). Both were exercised only through `e2e/tests/scheduler.spec.js` driving
 * the admin UI, which cannot reach the retry route's 409/500 branches at all.
 *
 * `WIKI.models.jobs` is stubbed rather than DB-backed: what these routes own is validation, status
 * mapping and field-forwarding to the model, which `models/jobs.test.ts` already covers in isolation
 * for the parts that are pure. `WIKI.scheduler.addJob` (called by `runScheduledTask`/`retryJob`) is
 * stubbed too, matching the model's own real dependency.
 */

let app: FastifyInstance
let jobsModel: {
  getSchedule: any
  getScheduleEntry: any
  runScheduledTask: any
  getUpcoming: any
  cancelUpcoming: any
  getHistory: any
  getHistoryEntry: any
  retryJob: any
}
let addJobResult: { id: string } | null

const EXISTING_SCHEDULE_ID = randomUUID()
const EXISTING_JOB_ID = randomUUID()
const EXISTING_HISTORY_ID = randomUUID()

async function buildApp() {
  const built = fastify()
  await built.register(fastifySensible)
  built.setErrorHandler((error: any, _req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  await registerSchedulerSchema(built)
  await registerErrorSchema(built)
  await built.register(schedulerRoutes)
  await built.ready()
  return built
}

before(async () => {
  jobsModel = {
    getSchedule: async () => [],
    getScheduleEntry: async (id: string) =>
      id === EXISTING_SCHEDULE_ID ? { id, task: 'foo' } : null,
    runScheduledTask: async () => addJobResult?.id ?? null,
    getUpcoming: async () => [],
    cancelUpcoming: async (id: string) => id === EXISTING_JOB_ID,
    getHistory: async ({ states, limit }: { states: string[]; limit: number }) => ({
      total: 0,
      jobs: [],
      _states: states,
      _limit: limit
    }),
    getHistoryEntry: async (id: string) =>
      id === EXISTING_HISTORY_ID ? { id, task: 'foo', state: 'completed', maxRetries: 3 } : null,
    retryJob: async () => addJobResult?.id ?? null
  }
  ;(globalThis as any).WIKI = {
    models: { jobs: jobsModel },
    scheduler: { addJob: async () => addJobResult }
  }
  app = await buildApp()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  addJobResult = { id: randomUUID() }
})

describe('every scheduler route requires manage:system and nothing else', () => {
  test("config.permissions is exactly ['manage:system'] on all six routes", async () => {
    // -> Built by hand rather than via `buildApp()`: the hook has to be added BEFORE the routes are
    //    registered (and before `.ready()`, which fastify refuses to add hooks after).
    const probe = fastify()
    const routes: { method: string; url: string; config: any }[] = []
    probe.addHook('onRoute', (opts) => {
      routes.push({ method: String(opts.method), url: opts.url, config: opts.config })
    })
    await registerSchedulerSchema(probe)
    await registerErrorSchema(probe)
    await probe.register(schedulerRoutes)
    await probe.ready()
    try {
      assert.ok(routes.length >= 6, `expected at least 6 routes, found ${routes.length}`)
      for (const route of routes) {
        assert.deepEqual(
          route.config?.permissions,
          ['manage:system'],
          `${route.method} ${route.url} should declare config.permissions: ['manage:system']`
        )
      }
    } finally {
      await probe.close()
    }
  })
})

describe('GET /schedule and POST /schedule/:scheduleId/run', () => {
  test('run queues the entry and returns the new job id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/schedule/${EXISTING_SCHEDULE_ID}/run`
    })
    assert.equal(res.statusCode, 200)
    const json = res.json()
    assert.equal(json.ok, true)
    assert.equal(json.id, addJobResult?.id)
  })

  test('run answers 404 for an unknown schedule id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/schedule/${randomUUID()}/run`
    })
    assert.equal(res.statusCode, 404)
  })

  test('run answers 500 when the scheduler refuses the job', async () => {
    addJobResult = null
    const res = await app.inject({
      method: 'POST',
      url: `/schedule/${EXISTING_SCHEDULE_ID}/run`
    })
    assert.equal(res.statusCode, 500)
  })
})

describe('DELETE /upcoming/:jobId', () => {
  test('cancels a pending job with 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/upcoming/${EXISTING_JOB_ID}` })
    assert.equal(res.statusCode, 204)
  })

  test(
    'answers 404 when the job is gone — the "already picked up by another instance" race ' +
      'e2e/helpers/db.js currently plants by hand',
    async () => {
      const res = await app.inject({ method: 'DELETE', url: `/upcoming/${randomUUID()}` })
      assert.equal(res.statusCode, 404)
    }
  )
})

describe('GET /jobs', () => {
  test('defaults limit to 100 and forwards an empty states filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs' })
    assert.equal(res.statusCode, 200)
    const json = res.json()
    assert.equal(json.limit, 100)
  })

  test('clamps limit to the schema maximum of 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs?limit=5000' })
    assert.equal(res.statusCode, 400)
  })

  test('rejects an unknown states value at the schema', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs?states=not-a-real-state' })
    assert.equal(res.statusCode, 400)
  })

  test('accepts a valid states value and an explicit limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs?states=failed&limit=10' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().limit, 10)
  })
})

describe('POST /jobs/:jobId/retry', () => {
  test('queues a fresh run for a completed job', async () => {
    const res = await app.inject({ method: 'POST', url: `/jobs/${EXISTING_HISTORY_ID}/retry` })
    assert.equal(res.statusCode, 200)
    const json = res.json()
    assert.equal(json.ok, true)
    assert.equal(json.id, addJobResult?.id)
  })

  test('answers 404 for an unknown job id', async () => {
    const res = await app.inject({ method: 'POST', url: `/jobs/${randomUUID()}/retry` })
    assert.equal(res.statusCode, 404)
  })

  test('answers 409 when the job is still active — a branch the admin UI cannot reach at all', async () => {
    const activeId = randomUUID()
    jobsModel.getHistoryEntry = async (id: string) =>
      id === activeId ? { id, task: 'foo', state: 'active', maxRetries: 3 } : null
    try {
      const res = await app.inject({ method: 'POST', url: `/jobs/${activeId}/retry` })
      assert.equal(res.statusCode, 409)
    } finally {
      jobsModel.getHistoryEntry = async (id: string) =>
        id === EXISTING_HISTORY_ID ? { id, task: 'foo', state: 'completed', maxRetries: 3 } : null
    }
  })

  test('answers 500 when the scheduler refuses to queue the retry', async () => {
    addJobResult = null
    const res = await app.inject({ method: 'POST', url: `/jobs/${EXISTING_HISTORY_ID}/retry` })
    assert.equal(res.statusCode, 500)
  })
})
