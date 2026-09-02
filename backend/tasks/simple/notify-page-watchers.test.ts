import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as notifyPageWatchers } from './notify-page-watchers.ts'
import type { NotifyPageWatchersPayload, QueuedWatcher } from './notify-page-watchers.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * Unit coverage for this task's own branching (recording, the immediate-send loop, per-recipient
 * failure isolation) against a stubbed model layer — `models/pageWatching.ts#listWatchers` and
 * `models/pages.ts#notifyWatchers`'s own SQL orchestration are covered DB-backed in
 * `models/pages.test.ts`'s "pages watch-notification trigger" suite, which also exercises this task's
 * real implementation end to end (including the OpenProject #2173 re-check added below, against a real
 * `read:pages` grant). This file exists specifically to pin the re-check's OWN branching in isolation,
 * the same way `send-watch-digests.test.ts` does for its sibling task.
 */

let wikiHandle: { restore(): void }
let recordMany: ReturnType<typeof mock.fn>
let markDelivered: ReturnType<typeof mock.fn>
let filterReadable: ReturnType<typeof mock.fn>
let getById: ReturnType<typeof mock.fn>
let sendPageWatchNotification: ReturnType<typeof mock.fn>
let loggerError: ReturnType<typeof mock.fn>

function watcher(overrides: Partial<QueuedWatcher> = {}): QueuedWatcher {
  return { userId: 'watcher-1', notifyMode: 'immediate', ...overrides }
}

function payload(overrides: Partial<NotifyPageWatchersPayload> = {}): NotifyPageWatchersPayload {
  return {
    siteId: 'site-1',
    pageId: 'page-1',
    pageTitle: 'Getting Started',
    pagePath: 'docs/getting-started',
    pageLocale: 'en',
    action: 'updated',
    changedFields: ['title'],
    actorId: 'actor-1',
    watchers: [watcher()],
    ...overrides
  }
}

before(() => {})

after(() => {
  wikiHandle.restore()
})

beforeEach(() => {
  recordMany = mock.fn(async (events: { userId: string }[]) =>
    events.map((event, i) => ({ id: `event-${i}`, userId: event.userId }))
  )
  markDelivered = mock.fn(async () => {})
  // -> Pass-through by default (OpenProject #2173): every watcher may read the page unless a test
  //    below says otherwise.
  filterReadable = mock.fn(async (_userId: string, events: unknown[]) => events)
  getById = mock.fn(async (id: string) => ({ id, name: 'Someone', email: `${id}@example.com` }))
  sendPageWatchNotification = mock.fn(async () => {})
  loggerError = mock.fn()
  wikiHandle = installTestWiki({
    logger: { info: mock.fn(), warn: mock.fn(), error: loggerError, debug: mock.fn() },
    models: {
      pageWatchEvents: { recordMany, markDelivered, filterReadable },
      users: { getById },
      mail: { sendPageWatchNotification }
    }
  })
})

describe('notify-page-watchers task', () => {
  test('no payload is a no-op', async () => {
    await notifyPageWatchers()
    assert.equal(recordMany.mock.calls.length, 0)
  })

  test('an empty watcher list is a no-op', async () => {
    await notifyPageWatchers(payload({ watchers: [] }))
    assert.equal(recordMany.mock.calls.length, 0)
  })

  test('records every watcher, then sends only to the immediate one', async () => {
    await notifyPageWatchers(
      payload({
        watchers: [
          watcher({ userId: 'immediate-1', notifyMode: 'immediate' }),
          watcher({ userId: 'digest-1', notifyMode: 'digest' })
        ]
      })
    )

    assert.equal(recordMany.mock.calls.length, 1)
    assert.equal((recordMany.mock.calls[0]!.arguments[0] as any[]).length, 2)
    assert.equal(sendPageWatchNotification.mock.calls.length, 1)
    assert.equal(
      (sendPageWatchNotification.mock.calls[0]!.arguments[0] as any).to,
      'immediate-1@example.com'
    )
  })
})

/**
 * OpenProject #2173: `filterReadable` is re-checked once per immediate watcher, right before the send
 * — a scheduler backlog can put real time between the synchronous `read:pages` check that built this
 * payload and this job actually running.
 */
describe('notify-page-watchers task — read:pages re-check (OpenProject #2173)', () => {
  test('an immediate watcher who fails the re-check gets no mail, and their event is left unmarked', async () => {
    filterReadable.mock.mockImplementation(async () => [])

    await notifyPageWatchers(payload())

    assert.equal(sendPageWatchNotification.mock.calls.length, 0)
    assert.equal(markDelivered.mock.calls.length, 0)
    // -> Still recorded -- recording happens before the per-watcher re-check, unconditionally
    assert.equal(recordMany.mock.calls.length, 1)
  })

  test('a digest-mode watcher is never re-checked at all: only the immediate loop calls filterReadable', async () => {
    await notifyPageWatchers(payload({ watchers: [watcher({ notifyMode: 'digest' })] }))

    assert.equal(filterReadable.mock.calls.length, 0)
    assert.equal(sendPageWatchNotification.mock.calls.length, 0)
  })

  test('filterReadable is called with this watcher’s own userId and the page from the payload', async () => {
    await notifyPageWatchers(payload({ watchers: [watcher({ userId: 'watcher-42' })] }))

    assert.equal(filterReadable.mock.calls.length, 1)
    const [userId, events] = filterReadable.mock.calls[0]!.arguments as [string, any[]]
    assert.equal(userId, 'watcher-42')
    assert.equal(events.length, 1)
    assert.equal(events[0].pageId, 'page-1')
    assert.equal(events[0].pagePath, 'docs/getting-started')
    assert.equal(events[0].pageLocale, 'en')
    assert.equal(events[0].siteId, 'site-1')
  })

  test('one watcher failing the re-check does not stop a second, readable watcher from being sent to', async () => {
    filterReadable.mock.mockImplementation(async (userId: string, events: unknown[]) =>
      userId === 'blocked' ? [] : events
    )

    await notifyPageWatchers(
      payload({
        watchers: [
          watcher({ userId: 'blocked', notifyMode: 'immediate' }),
          watcher({ userId: 'allowed', notifyMode: 'immediate' })
        ]
      })
    )

    assert.equal(sendPageWatchNotification.mock.calls.length, 1)
    assert.equal(
      (sendPageWatchNotification.mock.calls[0]!.arguments[0] as any).to,
      'allowed@example.com'
    )
  })
})
