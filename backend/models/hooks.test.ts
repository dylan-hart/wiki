import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  hooks as hooksTable,
  jobHistory as jobHistoryTable,
  sites as sitesTable
} from '../db/schema.ts'
import { EMITTED_EVENTS, HOOK_EVENTS } from './hooks.ts'

test('HOOK_EVENTS and EMITTED_EVENTS stay in parity', () => {
  assert.deepEqual(EMITTED_EVENTS as unknown as string[], HOOK_EVENTS as unknown as string[])
})

/**
 * `CARDINAL.db` is stubbed rather than backed by a real database: `emit()`'s only SQL is a plain
 * `select ... where event = ANY(events)`, and what this suite covers is the JS layered on top of
 * that result — the metadata/content strip, the job payload shape, the queued count.
 *
 * `emit()` treats every event identically, so `comment:new` stands in for all of them.
 */
describe('Hooks.emit (unit)', () => {
  let hooksModule: typeof import('./hooks.ts')
  let subscribed: { id: string; includeMetadata: boolean; includeContent: boolean }[]
  let queuedJobs: any[]
  let emailSubscribers: { id: string }[]

  before(async () => {
    ;(globalThis as any).CARDINAL = {
      logger: { warn: mock.fn(), debug: mock.fn(), info: mock.fn() },
      INSTANCE_ID: 'test-instance',
      config: { scheduler: {} },
      models: {
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        },
        // -> `emit()`'s email fan-out queries this; empty so these webhook-only tests see no extra
        //    job queued.
        users: {
          listEmailSubscribers: async () => emailSubscribers
        }
      },
      db: {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(subscribed)
          })
        })
      },
      scheduler: {
        addJob: mock.fn(async (job: any) => {
          queuedJobs.push(job)
          return { id: `job-${queuedJobs.length}` }
        })
      }
    }
    hooksModule = await import('./hooks.ts')
  })

  beforeEach(() => {
    subscribed = []
    queuedJobs = []
    emailSubscribers = []
  })

  test('queues a dispatchWebhook job for a webhook subscribed to comment:new', async () => {
    subscribed = [{ id: 'hook-1', includeMetadata: true, includeContent: true }]

    const queued = await hooksModule.hooks.emit('comment:new', 'site-1', {
      id: 'comment-1',
      pageId: 'page-1',
      siteId: 'site-1',
      authorId: 'user-1',
      isGuest: false,
      metadata: { authorName: 'Alice', replyTo: null },
      content: 'Hello world'
    })

    assert.equal(queued, 1)
    assert.equal(queuedJobs.length, 1)
    assert.equal(queuedJobs[0].task, 'dispatchWebhook')
    assert.equal(queuedJobs[0].payload.hookId, 'hook-1')
    assert.equal(queuedJobs[0].payload.event, 'comment:new')
    assert.equal(queuedJobs[0].payload.instance, 'test-instance')
    assert.equal(queuedJobs[0].payload.data.id, 'comment-1')
    assert.equal(queuedJobs[0].payload.data.pageId, 'page-1')
    assert.equal(queuedJobs[0].payload.data.content, 'Hello world')
    assert.deepEqual(queuedJobs[0].payload.data.metadata, { authorName: 'Alice', replyTo: null })
  })

  test('strips content from the payload when the webhook has includeContent off', async () => {
    subscribed = [{ id: 'hook-2', includeMetadata: true, includeContent: false }]

    await hooksModule.hooks.emit('comment:new', 'site-1', {
      id: 'comment-2',
      pageId: 'page-1',
      siteId: 'site-1',
      authorId: null,
      isGuest: true,
      metadata: { authorName: 'Guest' },
      content: 'Should not be sent'
    })

    assert.equal(queuedJobs.length, 1)
    assert.equal('content' in queuedJobs[0].payload.data, false)
    assert.deepEqual(queuedJobs[0].payload.data.metadata, { authorName: 'Guest' })
  })

  test('strips metadata from the payload when the webhook has includeMetadata off', async () => {
    subscribed = [{ id: 'hook-3', includeMetadata: false, includeContent: true }]

    await hooksModule.hooks.emit('comment:new', 'site-1', {
      id: 'comment-3',
      pageId: 'page-1',
      siteId: 'site-1',
      authorId: 'user-1',
      isGuest: false,
      metadata: { authorName: 'Alice' },
      content: 'Hi'
    })

    assert.equal(queuedJobs.length, 1)
    assert.equal('metadata' in queuedJobs[0].payload.data, false)
    assert.equal(queuedJobs[0].payload.data.content, 'Hi')
  })

  test('queues one job per subscribed webhook', async () => {
    subscribed = [
      { id: 'hook-a', includeMetadata: true, includeContent: true },
      { id: 'hook-b', includeMetadata: false, includeContent: false }
    ]

    const queued = await hooksModule.hooks.emit('comment:delete', 'site-1', {
      id: 'comment-4',
      pageId: 'page-1',
      siteId: 'site-1',
      authorId: 'user-1',
      isGuest: false
    })

    assert.equal(queued, 2)
    assert.deepEqual(queuedJobs.map((job) => job.payload.hookId).sort(), ['hook-a', 'hook-b'])
  })

  test('queues nothing when no webhook is subscribed to the event', async () => {
    subscribed = []

    const queued = await hooksModule.hooks.emit('comment:new', 'site-1', { id: 'comment-5' })

    assert.equal(queued, 0)
    assert.equal(queuedJobs.length, 0)
  })
})

describe('Hooks.emit email fan-out (unit)', () => {
  let hooksModule: typeof import('./hooks.ts')
  let subscribed: { id: string; includeMetadata: boolean; includeContent: boolean }[]
  let emailSubscribers: { id: string }[]
  let queuedJobs: any[]
  let listEmailSubscribers: ReturnType<typeof mock.fn>

  before(async () => {
    listEmailSubscribers = mock.fn(async () => emailSubscribers)
    ;(globalThis as any).CARDINAL = {
      logger: { warn: mock.fn(), debug: mock.fn(), info: mock.fn() },
      INSTANCE_ID: 'test-instance',
      config: { scheduler: {} },
      models: {
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        },
        users: { listEmailSubscribers }
      },
      db: {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(subscribed)
          })
        })
      },
      scheduler: {
        addJob: mock.fn(async (job: any) => {
          queuedJobs.push(job)
          return { id: `job-${queuedJobs.length}` }
        })
      }
    }
    hooksModule = await import('./hooks.ts')
  })

  beforeEach(() => {
    subscribed = []
    emailSubscribers = []
    queuedJobs = []
    listEmailSubscribers.mock.resetCalls()
  })

  test('queues a notifyEventSubscribers job carrying every subscribed user id, siteId and event', async () => {
    emailSubscribers = [{ id: 'user-1' }, { id: 'user-2' }]

    await hooksModule.hooks.emit('page:create', 'site-1', {
      id: 'page-1',
      path: 'docs/getting-started',
      metadata: { title: 'Getting Started' }
    })

    assert.equal(listEmailSubscribers.mock.calls[0]!.arguments[0], 'page:create')
    const emailJobs = queuedJobs.filter((job) => job.task === 'notifyEventSubscribers')
    assert.equal(emailJobs.length, 1)
    assert.equal(emailJobs[0].payload.event, 'page:create')
    assert.equal(emailJobs[0].payload.siteId, 'site-1')
    assert.deepEqual(emailJobs[0].payload.subscribers, [{ userId: 'user-1' }, { userId: 'user-2' }])
    assert.equal(emailJobs[0].payload.data.metadata.title, 'Getting Started')
  })

  test('queues no notifyEventSubscribers job when nobody is subscribed to the event', async () => {
    emailSubscribers = []

    await hooksModule.hooks.emit('page:create', 'site-1', { id: 'page-1' })

    assert.equal(queuedJobs.filter((job) => job.task === 'notifyEventSubscribers').length, 0)
  })

  test("does not count the email job in emit()'s returned webhook queued count", async () => {
    subscribed = [{ id: 'hook-1', includeMetadata: true, includeContent: true }]
    emailSubscribers = [{ id: 'user-1' }]

    const queued = await hooksModule.hooks.emit('page:create', 'site-1', { id: 'page-1' })

    assert.equal(queued, 1)
    assert.equal(queuedJobs.length, 2)
  })

  test('a broken email-subscriber lookup does not stop the webhook queueing (and does not throw)', async () => {
    subscribed = [{ id: 'hook-1', includeMetadata: true, includeContent: true }]
    listEmailSubscribers.mock.mockImplementationOnce(async () => {
      throw new Error('db unavailable')
    })

    const queued = await hooksModule.hooks.emit('page:create', 'site-1', { id: 'page-1' })

    assert.equal(queued, 1)
    assert.equal(queuedJobs.filter((job) => job.task === 'dispatchWebhook').length, 1)
    assert.equal(queuedJobs.filter((job) => job.task === 'notifyEventSubscribers').length, 0)
  })

  test('a broken webhook lookup does not stop the email queueing', async () => {
    ;(globalThis as any).CARDINAL.db.select = () => ({
      from: () => ({
        where: () => Promise.reject(new Error('db unavailable'))
      })
    })
    emailSubscribers = [{ id: 'user-1' }]

    const queued = await hooksModule.hooks.emit('page:create', 'site-1', { id: 'page-1' })

    assert.equal(queued, 0)
    assert.equal(queuedJobs.filter((job) => job.task === 'notifyEventSubscribers').length, 1)

    // -> `CARDINAL` is installed once in `before()`: put the working stub back for later tests
    ;(globalThis as any).CARDINAL.db.select = () => ({
      from: () => ({
        where: () => Promise.resolve(subscribed)
      })
    })
  })
})

/**
 * A null `hooks.siteId` means "all sites". Against a real migrated database because the behavior
 * under test is the SQL filter itself (`siteId IS NULL OR siteId = event's siteId`).
 */
describe('hooks per-site scoping (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let hooksModel: typeof import('./hooks.ts').hooks
  let otherSiteId: string
  let addJob: ReturnType<typeof mock.fn>

  before(async () => {
    fixtures = await setupTestDb()
    ;({ hooks: hooksModel } = await import('./hooks.ts'))

    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'other-site.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    otherSiteId = otherSite!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  before(() => {
    addJob = mock.fn(async () => ({ id: 'job-id' }))
    ;(globalThis as any).CARDINAL.scheduler = { addJob }
  })

  test('a hook scoped to site A does not fire for an event on site B; the unscoped hook does', async () => {
    const scopedHookId = await hooksModel.createHook({
      name: 'Site A only',
      events: ['page:create'],
      url: 'https://example.com/site-a',
      siteId: fixtures.siteId
    })
    const unscopedHookId = await hooksModel.createHook({
      name: 'All sites',
      events: ['page:create'],
      url: 'https://example.com/all-sites'
    })

    addJob.mock.resetCalls()
    const queued = await hooksModel.emit('page:create', otherSiteId, { id: 'page-1' })

    assert.equal(queued, 1)
    const queuedHookIds = addJob.mock.calls.map(
      (call) => (call.arguments[0] as { payload: { hookId: string } }).payload.hookId
    )
    assert.deepEqual(queuedHookIds, [unscopedHookId])
    assert.ok(!queuedHookIds.includes(scopedHookId))
  })

  test("an event on the scoped hook's own site reaches both the scoped and the unscoped hook", async () => {
    const scopedHookId = await hooksModel.createHook({
      name: 'Site A only (2)',
      events: ['page:edit'],
      url: 'https://example.com/site-a-2',
      siteId: fixtures.siteId
    })
    const unscopedHookId = await hooksModel.createHook({
      name: 'All sites (2)',
      events: ['page:edit'],
      url: 'https://example.com/all-sites-2'
    })

    addJob.mock.resetCalls()
    const queued = await hooksModel.emit('page:edit', fixtures.siteId, { id: 'page-2' })

    assert.equal(queued, 2)
    const queuedHookIds = addJob.mock.calls
      .map((call) => (call.arguments[0] as { payload: { hookId: string } }).payload.hookId)
      .sort()
    assert.deepEqual(queuedHookIds, [scopedHookId, unscopedHookId].sort())
  })

  test('a site-less event (e.g. user:join) only reaches unscoped hooks', async () => {
    const scopedHookId = await hooksModel.createHook({
      name: 'Site A only (3)',
      events: ['user:join'],
      url: 'https://example.com/site-a-3',
      siteId: fixtures.siteId
    })
    const unscopedHookId = await hooksModel.createHook({
      name: 'All sites (3)',
      events: ['user:join'],
      url: 'https://example.com/all-sites-3'
    })

    addJob.mock.resetCalls()
    const queued = await hooksModel.emit('user:join', null, { userId: 'user-1' })

    assert.equal(queued, 1)
    const queuedHookIds = addJob.mock.calls.map(
      (call) => (call.arguments[0] as { payload: { hookId: string } }).payload.hookId
    )
    assert.deepEqual(queuedHookIds, [unscopedHookId])
    assert.ok(!queuedHookIds.includes(scopedHookId))
  })

  test('createHook defaults siteId to null, and updateHook can change it', async () => {
    const hookId = await hooksModel.createHook({
      name: 'Default scope',
      events: ['page:create'],
      url: 'https://example.com/default-scope'
    })
    const created = await hooksModel.getHookById(hookId)
    assert.equal(created?.siteId, null)

    await hooksModel.updateHook(hookId, { siteId: fixtures.siteId })
    const scoped = await hooksModel.getHookById(hookId)
    assert.equal(scoped?.siteId, fixtures.siteId)

    await hooksModel.updateHook(hookId, { siteId: null })
    const unscoped = await hooksModel.getHookById(hookId)
    assert.equal(unscoped?.siteId, null)
  })
})

/**
 * `getDeliveryHistory()` is a filtered read of the shared `jobHistory` table (a
 * `task = 'dispatchWebhook'` + `payload->>'hookId'` match), which a mocked query builder cannot
 * verify.
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

describe('hooks emit rate limiting (mocked)', () => {
  let previousWiki: any
  let nowMs: number
  let addJobCalls: any[]
  let warnCalls: { scope: string; message: string; fields?: Record<string, any> }[]
  let hooksModel: typeof import('./hooks.ts').hooks

  /**
   * Mirrors `models/rateLimits.ts#consume()`'s window semantics, minus the ban/DB plumbing, on a
   * controllable clock (`nowMs`) so the window reset is verifiable without a real wait.
   */
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
    previousWiki = (globalThis as any).CARDINAL
    nowMs = 0
    addJobCalls = []
    warnCalls = []
    ;(globalThis as any).CARDINAL = {
      INSTANCE_ID: 'test-instance',
      config: {
        scheduler: {
          webhookRateLimitMax: 3,
          webhookRateLimitWindow: '1m',
          webhookRateLimitBan: '1m'
        }
      },
      logger: {
        info: () => {},
        warn: (scope: string, message: string, fields?: Record<string, any>) =>
          warnCalls.push({ scope, message, fields }),
        debug: () => {}
      },
      models: {
        rateLimits: createFakeRateLimits(),
        // -> `emit()`'s email fan-out queries this too; empty so `warnCalls` only ever captures
        //    rate-limit warnings.
        users: { listEmailSubscribers: async () => [] }
      },
      scheduler: {
        // -> The fake `CARDINAL.db` below has no `update`/`insert` on purpose: a throttled delivery
        //    that touched the persisted hook row would throw, which is what enforces that it must
        //    not.
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
    ;(globalThis as any).CARDINAL = previousWiki
  })

  test('queues only up to the configured cap, then skips and warns without throwing', async () => {
    for (let i = 0; i < 5; i++) {
      await hooksModel.emit('page:create', null, {})
    }

    assert.equal(addJobCalls.length, 3)
    assert.equal(warnCalls.length, 2)
    assert.equal(warnCalls[0]!.scope, 'hooks')
    assert.equal(warnCalls[0]!.fields?.hook, 'hook-1')
    assert.match(warnCalls[0]!.message, /rate limit/i)
  })

  test('resets the count once the configured window has elapsed', async () => {
    for (let i = 0; i < 3; i++) {
      await hooksModel.emit('page:create', null, {})
    }
    assert.equal(addJobCalls.length, 3)

    await hooksModel.emit('page:create', null, {})
    assert.equal(addJobCalls.length, 3)

    nowMs += 60_000
    await hooksModel.emit('page:create', null, {})
    assert.equal(addJobCalls.length, 4)
  })
})

/**
 * The filter is a `WHERE` clause (`siteId IS NULL OR siteId = :siteId`, or just `siteId IS NULL`
 * for a site-less event), which a mocked query builder cannot verify: a mock's `where()` never
 * evaluates what it was given.
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
    ;(globalThis as any).CARDINAL.scheduler = {
      addJob: mock.fn(async (job: any) => {
        addJobCalls.push(job)
        return { id: `job-${addJobCalls.length}` }
      })
    }
  })

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

    // -> Deliberate: no site context is not a wildcard match against a specific site, so a
    //    site-scoped hook must not fire on an instance-wide event such as `user:login`.
    await hooksModel.emit('user:login', null, {})

    const queued = queuedHookIds()
    assert.ok(queued.includes(unscoped), 'unscoped hook should still fire')
    assert.ok(!queued.includes(scoped), 'a site-scoped hook must not fire on a site-less event')
  })
})

describe('HOOK_EVENTS / EMITTED_EVENTS declared/emitted parity', () => {
  test('page:classification-changed is both declared and emitted', async () => {
    const { HOOK_EVENTS, EMITTED_EVENTS } = await import('./hooks.ts')
    assert.ok(
      (HOOK_EVENTS as readonly string[]).includes('page:classification-changed'),
      'page:classification-changed should be declared in HOOK_EVENTS'
    )
    assert.ok(
      (EMITTED_EVENTS as string[]).includes('page:classification-changed'),
      'page:classification-changed should be listed in EMITTED_EVENTS'
    )
  })
})
