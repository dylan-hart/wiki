import assert from 'node:assert/strict'
import { before, beforeEach, describe, mock, test } from 'node:test'

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
  let queuedJobs: any[]

  before(async () => {
    ;(globalThis as any).WIKI = {
      logger: { warn: mock.fn(), debug: mock.fn(), info: mock.fn() },
      INSTANCE_ID: 'test-instance',
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
  })

  test('queues a dispatchWebhook job for a webhook subscribed to comment:new', async () => {
    subscribed = [{ id: 'hook-1', includeMetadata: true, includeContent: true }]

    const queued = await hooksModule.hooks.emit('comment:new', {
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

    await hooksModule.hooks.emit('comment:new', {
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

    await hooksModule.hooks.emit('comment:new', {
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

    const queued = await hooksModule.hooks.emit('comment:delete', {
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

    const queued = await hooksModule.hooks.emit('comment:new', { id: 'comment-5' })

    assert.equal(queued, 0)
    assert.equal(queuedJobs.length, 0)
  })
})
