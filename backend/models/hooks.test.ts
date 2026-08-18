import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  hooks as hooksTable,
  jobHistory as jobHistoryTable,
  sites as sitesTable
} from '../db/schema.ts'

/**
 * `getDeliveryHistory()` is a filtered, paginated read against the shared `jobHistory` table (a
 * `task = 'dispatchWebhook'` + `payload->>'hookId'` match, backed by a partial expression index) —
 * squarely the kind of SQL orchestration CLAUDE.md says to verify against a real database rather than
 * a mock of the query builder.
 */
describe('hooks getDeliveryHistory (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let hooksModel: typeof import('./hooks.ts').hooks

  before(async () => {
    fixtures = await setupTestDb()
    ;({ hooks: hooksModel } = await import('./hooks.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Inserts one `jobHistory` row shaped like a `dispatchWebhook` execution (or another task/hook). */
  async function insertDelivery(
    hookId: string,
    overrides: Partial<{
      task: string
      event: string
      state: 'active' | 'completed' | 'failed' | 'interrupted'
      attempt: number
      maxRetries: number
      lastErrorMessage: string | null
      startedAt: Date
      completedAt: Date | null
    }> = {}
  ) {
    const {
      task = 'dispatchWebhook',
      event = 'page:create',
      state = 'completed',
      attempt = 1,
      maxRetries = 3,
      lastErrorMessage = null,
      startedAt = new Date(),
      completedAt = new Date()
    } = overrides
    await fixtures.db.insert(jobHistoryTable).values({
      task,
      state,
      payload: { hookId, event, data: {}, instance: 'test' },
      attempt,
      maxRetries,
      lastErrorMessage,
      createdAt: startedAt,
      startedAt,
      completedAt
    })
  }

  test('returns only dispatchWebhook deliveries for the requested hook', async () => {
    const hookId = randomUUID()
    const otherHookId = randomUUID()

    await insertDelivery(hookId, { event: 'page:create' })
    // -> Same task, different hook: must not leak in
    await insertDelivery(otherHookId, { event: 'page:edit' })
    // -> Same hookId, different task: must not leak in either — the payload shape is coincidental
    await insertDelivery(hookId, { task: 'cleanJobHistory', event: 'page:delete' })

    const page = await hooksModel.getDeliveryHistory(hookId)

    assert.equal(page.total, 1)
    assert.equal(page.deliveries.length, 1)
    assert.equal(page.deliveries[0]!.event, 'page:create')
  })

  test('orders by startedAt desc and reports fields per row', async () => {
    const hookId = randomUUID()
    const older = new Date(Date.now() - 60_000)
    const newer = new Date()

    await insertDelivery(hookId, {
      event: 'page:edit',
      state: 'failed',
      attempt: 2,
      maxRetries: 3,
      lastErrorMessage: 'The endpoint answered with HTTP 500.',
      startedAt: older,
      completedAt: older
    })
    await insertDelivery(hookId, {
      event: 'page:create',
      state: 'completed',
      attempt: 1,
      maxRetries: 3,
      lastErrorMessage: null,
      startedAt: newer,
      completedAt: newer
    })

    const page = await hooksModel.getDeliveryHistory(hookId)

    assert.equal(page.total, 2)
    assert.equal(page.deliveries.length, 2)
    assert.equal(page.deliveries[0]!.event, 'page:create')
    assert.equal(page.deliveries[0]!.state, 'completed')
    assert.equal(page.deliveries[0]!.lastErrorMessage, null)
    assert.equal(page.deliveries[1]!.event, 'page:edit')
    assert.equal(page.deliveries[1]!.state, 'failed')
    assert.equal(page.deliveries[1]!.attempt, 2)
    assert.equal(page.deliveries[1]!.lastErrorMessage, 'The endpoint answered with HTTP 500.')
  })

  test('total counts every match while deliveries is capped at limit', async () => {
    const hookId = randomUUID()
    for (let i = 0; i < 5; i++) {
      await insertDelivery(hookId, { event: 'page:create', startedAt: new Date(Date.now() - i) })
    }

    const page = await hooksModel.getDeliveryHistory(hookId, { limit: 2 })

    assert.equal(page.total, 5)
    assert.equal(page.deliveries.length, 2)
  })
})

/**
 * `emit()`'s per-hook rate limit (mocked `WIKI`, no database)
 *
 * `models/rateLimits.ts#consume()`'s own fixed-window algorithm is a separate, already-existing unit
 * with its own concerns (DB-backed, concurrency-safe upsert). What this covers is whether
 * `emit()` actually consults it before queuing each delivery, honors a refusal by skipping
 * `WIKI.scheduler.addJob` and logging a warn line rather than silently dropping the delivery, and
 * queues again once the window has rolled over — the behavior this task adds. A small in-memory
 * fixed-window stand-in for `consume()`, driven by a controllable clock, makes the "resets after the
 * window" half of that verifiable without a real wait or a live Postgres connection (none is reachable
 * in this environment).
 */
describe('hooks emit rate limiting (mocked)', () => {
  let previousWiki: any
  let nowMs: number
  let addJobCalls: any[]
  let warnCalls: string[]
  let hooksModel: typeof import('./hooks.ts').hooks

  /** Mirrors `models/rateLimits.ts#consume()`'s window semantics, minus the ban/DB plumbing. */
  function createFakeRateLimits() {
    const store = new Map<string, { windowStart: number; hits: number }>()
    return {
      consume: async (key: string, policy: { max: number; windowSeconds: number }) => {
        let entry = store.get(key)
        if (!entry || nowMs - entry.windowStart >= policy.windowSeconds * 1000) {
          entry = { windowStart: nowMs, hits: 0 }
        }
        entry.hits++
        store.set(key, entry)
        const allowed = entry.hits <= policy.max
        return { allowed, hits: entry.hits, retryAfter: allowed ? 0 : policy.windowSeconds }
      }
    }
  }

  beforeEach(async () => {
    previousWiki = (globalThis as any).WIKI
    nowMs = 0
    addJobCalls = []
    warnCalls = []
    ;(globalThis as any).WIKI = {
      INSTANCE_ID: 'test-instance',
      config: {
        scheduler: {
          webhookRateLimitMax: 3,
          webhookRateLimitWindow: '1m',
          webhookRateLimitBan: '1m'
        }
      },
      logger: { info: () => {}, warn: (msg: string) => warnCalls.push(msg), debug: () => {} },
      models: { rateLimits: createFakeRateLimits() },
      scheduler: {
        // -> No `update`/`insert` stub exists on the fake `WIKI.db` below: if a throttled delivery
        //    ever touched the persisted hook row, that branch would throw "is not a function" and
        //    fail these tests, which is the enforcement that it must not.
        addJob: mock.fn(async (job: any) => {
          addJobCalls.push(job)
          return { id: `job-${addJobCalls.length}` }
        })
      },
      db: {
        select: () => ({
          from: () => ({
            where: async () => [{ id: 'hook-1', includeMetadata: false, includeContent: false }]
          })
        })
      }
    }
    ;({ hooks: hooksModel } = await import('./hooks.ts'))
  })

  afterEach(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('queues only up to the configured cap, then skips and warns without throwing', async () => {
    for (let i = 0; i < 5; i++) {
      await hooksModel.emit('page:create', null, {})
    }

    assert.equal(addJobCalls.length, 3)
    assert.equal(warnCalls.length, 2)
    assert.match(warnCalls[0]!, /hook-1/)
    assert.match(warnCalls[0]!, /rate limit/i)
  })

  test('resets the count once the configured window has elapsed', async () => {
    for (let i = 0; i < 3; i++) {
      await hooksModel.emit('page:create', null, {})
    }
    assert.equal(addJobCalls.length, 3)

    // -> Still inside the window: refused, not queued
    await hooksModel.emit('page:create', null, {})
    assert.equal(addJobCalls.length, 3)

    // -> Past the configured 1-minute window: the count starts again
    nowMs += 60_000
    await hooksModel.emit('page:create', null, {})
    assert.equal(addJobCalls.length, 4)
  })
})

/**
 * `emit()`'s site-scoping filter (DB-backed)
 *
 * The filter itself is a `WHERE` clause (`siteId IS NULL OR siteId = :siteId`, or just `siteId IS
 * NULL` for a site-less event) — exactly the kind of SQL a mocked query builder can't actually
 * verify, since a mock's `where()` never evaluates what it was given. Real rows, a real query,
 * against the DB-backed fixture the same way `getDeliveryHistory` above is verified.
 */
describe('hooks emit site scoping (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let otherSiteId: string
  let hooksModel: typeof import('./hooks.ts').hooks
  let addJobCalls: any[]

  before(async () => {
    fixtures = await setupTestDb()
    ;({ hooks: hooksModel } = await import('./hooks.ts'))

    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'other.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    otherSiteId = otherSite!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  beforeEach(() => {
    addJobCalls = []
    ;(globalThis as any).WIKI.scheduler = {
      addJob: mock.fn(async (job: any) => {
        addJobCalls.push(job)
        return { id: `job-${addJobCalls.length}` }
      })
    }
  })

  /**
   * Creates a hook subscribed to `page:create` and `user:login`, scoped to `siteId` (null means
   * every site).
   */
  async function createHook(siteId: string | null) {
    const [row] = await fixtures.db
      .insert(hooksTable)
      .values({
        name: `hook-${randomUUID()}`,
        url: 'https://example.com/hook',
        events: ['page:create', 'user:login'],
        siteId
      })
      .returning({ id: hooksTable.id })
    return row!.id
  }

  /** The `hookId`s that were queued a delivery, in no particular order. */
  function queuedHookIds(): string[] {
    return addJobCalls.map((job) => job.payload.hookId)
  }

  test("an event scoped to a site reaches an unscoped hook and that site's hook, not another site's", async () => {
    const unscoped = await createHook(null)
    const thisSite = await createHook(fixtures.siteId)
    const otherSite = await createHook(otherSiteId)

    await hooksModel.emit('page:create', fixtures.siteId, {})

    const queued = queuedHookIds()
    assert.ok(queued.includes(unscoped), 'unscoped hook should fire')
    assert.ok(queued.includes(thisSite), "the event's own site hook should fire")
    assert.ok(!queued.includes(otherSite), "a different site's hook must not fire")
  })

  test('a site-less event (siteId null) reaches only unscoped hooks, never a site-scoped one', async () => {
    const unscoped = await createHook(null)
    const scoped = await createHook(fixtures.siteId)

    // -> The deliberate behavior task 651 documents: no site context is not a wildcard match against
    //    a specific site, so a site-scoped hook must not fire on e.g. `user:login` instance-wide.
    await hooksModel.emit('user:login', null, {})

    const queued = queuedHookIds()
    assert.ok(queued.includes(unscoped), 'unscoped hook should still fire')
    assert.ok(!queued.includes(scoped), 'a site-scoped hook must not fire on a site-less event')
  })
})
