import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  hooks as hooksTable,
  jobHistory as jobHistoryTable,
  sites as sitesTable,
  users as usersTable
} from '../db/schema.ts'
import { EMITTED_EVENTS, HOOK_EVENTS } from './hooks.ts'

/**
 * OpenProject #1932: `EMITTED_EVENTS`'s own doc comment says to add an entry here whenever an
 * `emit()` call is wired for it, and today every entry in `HOOK_EVENTS` also has one -- so the two
 * lists are meant to stay in lockstep. `api/hooks.test.ts` already pins the same fact indirectly (via
 * the `GET /events` response's `isEmitted` flags); this is the direct, model-level version of that
 * check, so a future `HOOK_EVENTS` addition with no matching `emit()` call fails right next to the
 * list it forgot to update, not only in a route test three files away.
 */
test('HOOK_EVENTS and EMITTED_EVENTS stay in parity', () => {
  assert.deepEqual(EMITTED_EVENTS as unknown as string[], HOOK_EVENTS as unknown as string[])
})

/**
 * Unit tests for `Hooks.emit()` (task 610's end-to-end verification): given a webhook subscribed to
 * an event, does queuing a delivery actually happen, and does the `includeMetadata`/`includeContent`
 * split behave.
 *
 * `WIKI.db` is stubbed rather than backed by a real database: `emit()`'s only SQL is a plain
 * `select ... where event = ANY(events)`, and what this suite cares about is the JS-level logic layered
 * on top of that result (the metadata/content strip, the job payload shape, the queued count) — not
 * whether Postgres's `ANY()` operator matches correctly, which the query itself does not exercise here
 * either way. `WIKI.scheduler.addJob` is stubbed to capture what gets queued instead of touching the
 * real job table.
 *
 * `comment:new` is used as the demonstrating event throughout, since that is what task 610 asks this
 * suite to confirm — but nothing here is comment-specific: `emit()` treats every event identically.
 */
describe('Hooks.emit (unit)', () => {
  let hooksModule: typeof import('./hooks.ts')
  let subscribed: { id: string; includeMetadata: boolean; includeContent: boolean }[]
  let subscribers: string[]
  let queuedJobs: any[]
  let emailSubscribers: { id: string }[]

  before(async () => {
    ;(globalThis as any).WIKI = {
      logger: { warn: mock.fn(), debug: mock.fn(), info: mock.fn() },
      INSTANCE_ID: 'test-instance',
      config: { scheduler: {} },
      models: {
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        },
        // -> `emit()`'s email fan-out (`notifyEmailSubscribers`) queries this; empty by default so
        //    the webhook-only tests above see no extra job queued.
        users: {
          listEmailSubscribers: async () => emailSubscribers
        },
        eventSubscriptions: {
          listSubscribers: async () => subscribers
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
    subscribers = []
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

/**
 * Task 2481: `emit()`'s email fan-out (`notifyEmailSubscribers`) — a second, independent job queued
 * alongside (or, per the last two tests here, entirely apart from) the webhook deliveries the suite
 * above already covers. `WIKI.models.users.listEmailSubscribers` stands in for the real query, since
 * what this suite cares about is `emit()`'s own wiring, not `models/users.ts`'s SQL (covered by its
 * own suite).
 */
describe('Hooks.emit email fan-out (unit)', () => {
  let hooksModule: typeof import('./hooks.ts')
  let subscribed: { id: string; includeMetadata: boolean; includeContent: boolean }[]
  let emailSubscribers: { id: string }[]
  let queuedJobs: any[]
  let listEmailSubscribers: ReturnType<typeof mock.fn>

  before(async () => {
    listEmailSubscribers = mock.fn(async () => emailSubscribers)
    ;(globalThis as any).WIKI = {
      logger: { warn: mock.fn(), debug: mock.fn(), info: mock.fn() },
      INSTANCE_ID: 'test-instance',
      config: { scheduler: {} },
      models: {
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        },
        users: { listEmailSubscribers },
        // -> `emit()`'s event-subscriber fan-out (`queueEventSubscriberNotifications`) also queries
        //    this on every call; empty by default so it never queues a job this suite doesn't expect.
        eventSubscriptions: { listSubscribers: async () => [] }
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
    ;(globalThis as any).WIKI.db.select = () => ({
      from: () => ({
        where: () => Promise.reject(new Error('db unavailable'))
      })
    })
    emailSubscribers = [{ id: 'user-1' }]

    const queued = await hooksModule.hooks.emit('page:create', 'site-1', { id: 'page-1' })

    assert.equal(queued, 0)
    assert.equal(queuedJobs.filter((job) => job.task === 'notifyEventSubscribers').length, 1)

    // -> Restore the working stub for any test that runs after this one in the same file.
    ;(globalThis as any).WIKI.db.select = () => ({
      from: () => ({
        where: () => Promise.resolve(subscribed)
      })
    })
  })
})

/**
 * `emit()`'s event-subscriber fan-out (OpenProject #2484), independent of the webhook fan-out above:
 * whether a subscribed user gets queued a `notifyEventSubscriptionSubscribers` job, an unsubscribed
 * one does not, several subscribers are batched into a single job rather than one job each, and the
 * webhook-queued return value stays exactly what it was before this feature existed either way.
 */
describe('Hooks.emit event-subscriber fan-out (unit)', () => {
  let hooksModule: typeof import('./hooks.ts')
  let subscribed: { id: string; includeMetadata: boolean; includeContent: boolean }[]
  let subscribers: string[]
  let queuedJobs: any[]

  before(async () => {
    ;(globalThis as any).WIKI = {
      logger: { warn: mock.fn(), debug: mock.fn(), info: mock.fn() },
      INSTANCE_ID: 'test-instance',
      config: { scheduler: {} },
      models: {
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        eventSubscriptions: { listSubscribers: async () => subscribers },
        // -> `emit()`'s email fan-out (`notifyEmailSubscribers`) also queries this on every call;
        //    empty by default so it never queues a job this suite doesn't expect.
        users: { listEmailSubscribers: async () => [] }
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
    subscribers = []
    queuedJobs = []
  })

  test('an event with a subscriber queues a batched notifyEventSubscriptionSubscribers job carrying their id', async () => {
    subscribers = ['user-subscribed']

    await hooksModule.hooks.emit('page:edit', 'site-1', { id: 'page-1' })

    const notifyJobs = queuedJobs.filter((job) => job.task === 'notifyEventSubscriptionSubscribers')
    assert.equal(notifyJobs.length, 1)
    assert.deepEqual(notifyJobs[0].payload.subscriberIds, ['user-subscribed'])
    assert.equal(notifyJobs[0].payload.event, 'page:edit')
  })

  test('an event with no subscribers queues no notifyEventSubscriptionSubscribers job', async () => {
    subscribers = []

    await hooksModule.hooks.emit('page:edit', 'site-1', { id: 'page-1' })

    assert.equal(
      queuedJobs.filter((job) => job.task === 'notifyEventSubscriptionSubscribers').length,
      0
    )
  })

  test('several subscribers are batched into one job, not one job each', async () => {
    subscribers = ['user-a', 'user-b', 'user-c']

    await hooksModule.hooks.emit('page:edit', 'site-1', { id: 'page-1' })

    const notifyJobs = queuedJobs.filter((job) => job.task === 'notifyEventSubscriptionSubscribers')
    assert.equal(notifyJobs.length, 1)
    assert.deepEqual(notifyJobs[0].payload.subscriberIds.sort(), ['user-a', 'user-b', 'user-c'])
  })

  test('the webhook-queued return value is unaffected by whether the event has subscribers', async () => {
    subscribed = [{ id: 'hook-1', includeMetadata: true, includeContent: true }]
    subscribers = ['user-subscribed']

    const queued = await hooksModule.hooks.emit('page:edit', 'site-1', { id: 'page-1' })

    assert.equal(queued, 1)
    assert.equal(queuedJobs.filter((job) => job.task === 'dispatchWebhook').length, 1)
    assert.equal(
      queuedJobs.filter((job) => job.task === 'notifyEventSubscriptionSubscribers').length,
      1
    )
  })
})

/**
 * Regression test for task 698: `Hooks.emit()` used to queue a delivery for every hook subscribed to
 * an event, with no regard for which site the event happened on. This suite covers the fix — a
 * nullable `hooks.siteId` column, null meaning "all sites" — against a real migrated database, since
 * the behavior under test is the SQL filter itself (`siteId IS NULL OR siteId = event's siteId`)
 * rather than anything worth re-describing behind a mock.
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

  // -> `emit()` never throws, but it does queue through `WIKI.scheduler.addJob` — the piece of the
  //    real scheduler this suite's minimal `WIKI` (see `test/db.ts`) does not install.
  before(() => {
    addJob = mock.fn(async () => ({ id: 'job-id' }))
    ;(globalThis as any).WIKI.scheduler = { addJob }
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
  let warnCalls: { scope: string; message: string; fields?: Record<string, any> }[]
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
      logger: {
        info: () => {},
        warn: (scope: string, message: string, fields?: Record<string, any>) =>
          warnCalls.push({ scope, message, fields }),
        debug: () => {}
      },
      models: {
        rateLimits: createFakeRateLimits(),
        // -> `emit()`'s email/event-subscriber fan-outs query these too; empty and warn-free so
        //    `warnCalls` only ever captures the rate-limit warnings this describe actually tests.
        users: { listEmailSubscribers: async () => [] },
        eventSubscriptions: { listSubscribers: async () => [] }
      },
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
    assert.equal(warnCalls[0]!.scope, 'hooks')
    assert.equal(warnCalls[0]!.fields?.hook, 'hook-1')
    assert.match(warnCalls[0]!.message, /rate limit/i)
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

/**
 * Declared/emitted parity for `page:classification-changed` (OpenProject #1935): a pure check of the
 * two plain array exports, no `WIKI` or database needed. `api/hooks.test.ts` already asserts the same
 * kind of parity generically (every `HOOK_EVENTS` entry's `isEmitted` flag against `EMITTED_EVENTS`)
 * for the `GET /hooks/events` response; this pins the specific new entry at the source-of-truth level
 * so a future edit that declares the event without wiring its `emit()` call (or vice versa) fails here
 * too, not only at the API layer.
 */
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

/**
 * OpenProject #2484: end-to-end proof, against a real database and the real `models/eventSubscriptions.ts`
 * (installed by `setupTestDb()` via the real `models/index.ts`, not a mock), that a user subscribed to
 * an event gets queued a notification when it fires and an unsubscribed user does not — the WP's own
 * literal claim, verified at the layer `emit()` actually controls (which job gets queued for whom).
 * `tasks/simple/notify-event-subscription-subscribers.test.ts` covers the next step, the queued job
 * actually resulting in a sent email, with the model layer mocked instead.
 */
describe(
  'hooks emit event-subscriber fan-out (DB-backed, OpenProject #2484)',
  {
    skip: !hasTestDatabase()
  },
  () => {
    let fixtures: TestFixtures
    let hooksModel: typeof import('./hooks.ts').hooks
    let unsubscribedUserId: string
    let addJob: ReturnType<typeof mock.fn>

    before(async () => {
      fixtures = await setupTestDb()
      ;({ hooks: hooksModel } = await import('./hooks.ts'))

      const [otherUser] = await fixtures.db
        .insert(usersTable)
        .values({ email: 'unsubscribed@example.com', name: 'Unsubscribed User', isActive: true })
        .returning({ id: usersTable.id })
      unsubscribedUserId = otherUser!.id
    })

    after(async () => {
      await teardownTestDb()
    })

    // -> `emit()` never throws, but it does queue through `WIKI.scheduler.addJob` — the piece of the
    //    real scheduler `test/db.ts`'s minimal `WIKI` does not install (same reasoning as the sibling
    //    DB-backed describes above).
    beforeEach(() => {
      addJob = mock.fn(async () => ({ id: 'job-id' }))
      ;(globalThis as any).WIKI.scheduler = { addJob }
    })

    test('a subscribed user is queued a notification; an unsubscribed user is not', async () => {
      await WIKI.models.eventSubscriptions.subscribe(fixtures.userId, 'page:edit')
      // -> `unsubscribedUserId` deliberately has no `eventSubscriptions` row at all.

      await hooksModel.emit('page:edit', fixtures.siteId, { id: 'page-1' })

      const notifyJobs = addJob.mock.calls
        .map((call) => call.arguments[0] as { task: string; payload: any })
        .filter((job) => job.task === 'notifyEventSubscriptionSubscribers')
      assert.equal(notifyJobs.length, 1)
      assert.deepEqual(notifyJobs[0]!.payload.subscriberIds, [fixtures.userId])
      assert.ok(!notifyJobs[0]!.payload.subscriberIds.includes(unsubscribedUserId))
    })

    test('unsubscribing removes the user from future fan-outs', async () => {
      await WIKI.models.eventSubscriptions.subscribe(fixtures.userId, 'page:delete')
      await WIKI.models.eventSubscriptions.unsubscribe(fixtures.userId, 'page:delete')

      await hooksModel.emit('page:delete', fixtures.siteId, { id: 'page-2' })

      const notifyJobs = addJob.mock.calls
        .map((call) => call.arguments[0] as { task: string })
        .filter((job) => job.task === 'notifyEventSubscriptionSubscribers')
      assert.equal(notifyJobs.length, 0)
    })

    test('a subscription to a different event does not fire for this one', async () => {
      await WIKI.models.eventSubscriptions.subscribe(fixtures.userId, 'page:rename')

      await hooksModel.emit('page:create', fixtures.siteId, { id: 'page-3' })

      const notifyJobs = addJob.mock.calls
        .map((call) => call.arguments[0] as { task: string })
        .filter((job) => job.task === 'notifyEventSubscriptionSubscribers')
      assert.equal(notifyJobs.length, 0)
    })
  }
)
