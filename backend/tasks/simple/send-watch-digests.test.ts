import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as sendWatchDigests } from './send-watch-digests.ts'
import type { PendingDigestEvent } from '../../models/pageWatchEvents.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * Task 534: the digest job's own grouping/branching logic (per user, per event, empty-cycle no-op,
 * per-recipient failure isolation) is entirely independent of real SQL — `listPendingForDigest` and
 * `markManyDelivered` are exactly what a DB-backed suite (`models/pageWatchEvents.test.ts`) exists to
 * verify. This suite stubs the whole model layer instead, so it can assert on what this task actually
 * does with the rows it's handed without standing up a database for it.
 */

let wikiHandle: { restore(): void }
let listPendingForDigest: ReturnType<typeof mock.fn>
let markManyDelivered: ReturnType<typeof mock.fn>
let filterReadable: ReturnType<typeof mock.fn>
let getById: ReturnType<typeof mock.fn>
let sendPageWatchDigest: ReturnType<typeof mock.fn>
let loggerError: ReturnType<typeof mock.fn>

function pendingEvent(overrides: Partial<PendingDigestEvent> = {}): PendingDigestEvent {
  return {
    id: 'event-1',
    userId: 'user-1',
    siteId: 'site-1',
    pageId: 'page-1',
    pageTitle: 'Getting Started',
    pagePath: 'docs/getting-started',
    pageLocale: 'en',
    action: 'updated',
    changedFields: ['title'],
    actorId: 'actor-1',
    ...overrides
  }
}

before(() => {})

after(() => {
  wikiHandle.restore()
})

beforeEach(() => {
  listPendingForDigest = mock.fn(async () => [] as PendingDigestEvent[])
  markManyDelivered = mock.fn(async () => {})
  // -> Pass-through by default (OpenProject #2173's read:pages re-check): every existing test in this
  //    file predates the check and expects its events to reach the digest unfiltered. The dedicated
  //    describe block below overrides this per test to exercise the filtering itself.
  filterReadable = mock.fn(async (_userId: string, events: PendingDigestEvent[]) => events)
  getById = mock.fn(async (id: string) => ({
    id,
    name: 'Someone Person',
    email: `${id}@example.com`
  }))
  sendPageWatchDigest = mock.fn(async () => {})
  loggerError = mock.fn()
  wikiHandle = installTestWiki({
    logger: { info: mock.fn(), warn: mock.fn(), error: loggerError, debug: mock.fn() },
    models: {
      pageWatchEvents: { listPendingForDigest, markManyDelivered, filterReadable },
      users: { getById },
      mail: { sendPageWatchDigest }
    }
  })
})

describe('send-watch-digests task', () => {
  test('no pending events is a no-op: no mail sent, nothing marked delivered', async () => {
    await sendWatchDigests()

    assert.equal(sendPageWatchDigest.mock.calls.length, 0)
    assert.equal(markManyDelivered.mock.calls.length, 0)
  })

  test('a single user with one pending event gets one digest covering it, then it is marked delivered', async () => {
    listPendingForDigest.mock.mockImplementation(async () => [pendingEvent()])

    await sendWatchDigests()

    assert.equal(sendPageWatchDigest.mock.calls.length, 1)
    const call = sendPageWatchDigest.mock.calls[0]!.arguments[0] as any
    assert.equal(call.to, 'user-1@example.com')
    assert.equal(call.siteId, 'site-1')
    assert.equal(call.items.length, 1)
    assert.equal(call.items[0].page.title, 'Getting Started')
    assert.equal(call.items[0].page.path, 'docs/getting-started')
    assert.equal(call.items[0].page.locale, 'en')
    assert.equal(call.items[0].actorName, 'Someone Person')

    assert.equal(markManyDelivered.mock.calls.length, 1)
    assert.deepEqual(markManyDelivered.mock.calls[0]!.arguments[0], ['event-1'])
  })

  test('a non-primary-locale event threads its locale through to the digest item', async () => {
    listPendingForDigest.mock.mockImplementation(async () => [pendingEvent({ pageLocale: 'fr' })])

    await sendWatchDigests()

    const call = sendPageWatchDigest.mock.calls[0]!.arguments[0] as any
    assert.equal(call.items[0].page.locale, 'fr')
    assert.equal(call.items[0].page.path, 'docs/getting-started')
  })

  test('several pending events for the same user are batched into one digest, one line item each', async () => {
    listPendingForDigest.mock.mockImplementation(async () => [
      pendingEvent({ id: 'ev-1', pageId: 'page-1' }),
      pendingEvent({
        id: 'ev-2',
        pageId: 'page-2',
        pageTitle: 'Second Page',
        pagePath: 'second-page'
      })
    ])

    await sendWatchDigests()

    assert.equal(sendPageWatchDigest.mock.calls.length, 1)
    const call = sendPageWatchDigest.mock.calls[0]!.arguments[0] as any
    assert.equal(call.items.length, 2)
    assert.deepEqual(markManyDelivered.mock.calls[0]!.arguments[0], ['ev-1', 'ev-2'])
  })

  test('events for the same user on different sites are grouped and sent as separate digests', async () => {
    listPendingForDigest.mock.mockImplementation(async () => [
      pendingEvent({ id: 'ev-1', siteId: 'site-1' }),
      pendingEvent({ id: 'ev-2', siteId: 'site-2' })
    ])

    await sendWatchDigests()

    // -> Same user, different sites: never batched into one email, since one email can only resolve
    //    one site's locale routing config (see this task's own doc comment).
    assert.equal(sendPageWatchDigest.mock.calls.length, 2)
    const siteIds = sendPageWatchDigest.mock.calls.map((c: any) => c.arguments[0].siteId).sort()
    assert.deepEqual(siteIds, ['site-1', 'site-2'])
    // -> `markManyDelivered` takes only an id list -- no siteId of its own -- so a group's delivered
    //   ids are tied to its site by call ORDER: the task awaits `sendPageWatchDigest` then
    //   `markManyDelivered` in the same loop iteration before moving to the next group, so call `i`
    //   of each mock belongs to the same group. Pinned here so each group is confirmed to mark only
    //   ITS OWN event delivered, not both events in one call and not the other group's id.
    assert.equal(markManyDelivered.mock.calls.length, 2)
    const deliveredIdsBySite = new Map(
      sendPageWatchDigest.mock.calls.map((c: any, i: number) => [
        c.arguments[0].siteId,
        markManyDelivered.mock.calls[i]!.arguments[0]
      ])
    )
    assert.deepEqual(deliveredIdsBySite.get('site-1'), ['ev-1'])
    assert.deepEqual(deliveredIdsBySite.get('site-2'), ['ev-2'])
  })

  test('events for different users are grouped and sent as separate digests', async () => {
    listPendingForDigest.mock.mockImplementation(async () => [
      pendingEvent({ id: 'ev-1', userId: 'user-a' }),
      pendingEvent({ id: 'ev-2', userId: 'user-b' })
    ])

    await sendWatchDigests()

    assert.equal(sendPageWatchDigest.mock.calls.length, 2)
    const recipients = sendPageWatchDigest.mock.calls.map((c: any) => c.arguments[0].to).sort()
    assert.deepEqual(recipients, ['user-a@example.com', 'user-b@example.com'])
  })

  test('an actor referenced by several events is only looked up once', async () => {
    listPendingForDigest.mock.mockImplementation(async () => [
      pendingEvent({ id: 'ev-1', pageId: 'page-1', actorId: 'shared-actor' }),
      pendingEvent({ id: 'ev-2', pageId: 'page-2', actorId: 'shared-actor' })
    ])

    await sendWatchDigests()

    const actorLookups = getById.mock.calls.filter((c: any) => c.arguments[0] === 'shared-actor')
    assert.equal(actorLookups.length, 1)
  })

  test('a recipient with no email address is skipped without attempting a send', async () => {
    getById.mock.mockImplementation(async (id: string) =>
      id === 'user-1' ? { id, name: 'No Email' } : { id, name: 'Actor', email: 'actor@example.com' }
    )
    listPendingForDigest.mock.mockImplementation(async () => [pendingEvent()])

    await assert.doesNotReject(() => sendWatchDigests())

    assert.equal(sendPageWatchDigest.mock.calls.length, 0)
    assert.equal(markManyDelivered.mock.calls.length, 0)
  })

  test("one user failing to send does not stop another user's digest, and does not throw", async () => {
    sendPageWatchDigest.mock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'user-a@example.com') {
        throw new Error('SMTP exploded')
      }
    })
    listPendingForDigest.mock.mockImplementation(async () => [
      pendingEvent({ id: 'ev-1', userId: 'user-a' }),
      pendingEvent({ id: 'ev-2', userId: 'user-b' })
    ])

    await assert.doesNotReject(() => sendWatchDigests())

    assert.equal(sendPageWatchDigest.mock.calls.length, 2)
    // -> Only the succeeding user's event was marked delivered
    assert.equal(markManyDelivered.mock.calls.length, 1)
    assert.deepEqual(markManyDelivered.mock.calls[0]!.arguments[0], ['ev-2'])
    assert.ok(loggerError.mock.calls.length > 0)
  })

  test('a failure querying pending events at all is thrown, not swallowed', async () => {
    listPendingForDigest.mock.mockImplementation(async () => {
      throw new Error('connection refused')
    })

    await assert.rejects(() => sendWatchDigests(), /connection refused/)
  })
})

/**
 * OpenProject #2173: `filterReadable` is applied per `(userId, siteId)` group, right before that
 * group's mail is composed -- the send-time re-check for the one delivery path (`digest`) where an
 * event can sit pending the longest between being recorded and being acted on.
 */
describe('send-watch-digests task — read:pages re-check (OpenProject #2173)', () => {
  test('an event that fails the re-check is excluded from the digest but still marked delivered', async () => {
    filterReadable.mock.mockImplementation(async () => [])
    listPendingForDigest.mock.mockImplementation(async () => [pendingEvent()])

    await sendWatchDigests()

    assert.equal(sendPageWatchDigest.mock.calls.length, 0)
    assert.equal(markManyDelivered.mock.calls.length, 1)
    assert.deepEqual(markManyDelivered.mock.calls[0]!.arguments[0], ['event-1'])
  })

  test('a group left with nothing readable is skipped entirely -- no digest, no recipient lookup', async () => {
    filterReadable.mock.mockImplementation(async () => [])
    listPendingForDigest.mock.mockImplementation(async () => [pendingEvent()])

    await sendWatchDigests()

    assert.equal(getById.mock.calls.length, 0)
  })

  test('a mixed group only digests the readable events, and marks both readable and unreadable delivered', async () => {
    const readable = pendingEvent({ id: 'ev-readable', pageId: 'page-readable' })
    const unreadable = pendingEvent({
      id: 'ev-unreadable',
      pageId: 'page-unreadable',
      pageTitle: 'No Longer Readable'
    })
    filterReadable.mock.mockImplementation(async () => [readable])
    listPendingForDigest.mock.mockImplementation(async () => [readable, unreadable])

    await sendWatchDigests()

    assert.equal(sendPageWatchDigest.mock.calls.length, 1)
    const call = sendPageWatchDigest.mock.calls[0]!.arguments[0] as any
    assert.equal(call.items.length, 1)
    assert.equal(call.items[0].page.title, 'Getting Started')

    // -> First call marks the readable-only batch delivered alongside the send; the unreadable one is
    //    marked delivered too (nothing further to tell that watcher), in its own call.
    const deliveredIds = markManyDelivered.mock.calls.flatMap((c: any) => c.arguments[0])
    assert.deepEqual(new Set(deliveredIds), new Set(['ev-readable', 'ev-unreadable']))
  })

  test('filterReadable is called once per (userId, siteId) group with that group’s own events', async () => {
    listPendingForDigest.mock.mockImplementation(async () => [
      pendingEvent({ id: 'ev-1', userId: 'user-a' }),
      pendingEvent({ id: 'ev-2', userId: 'user-b' })
    ])

    await sendWatchDigests()

    assert.equal(filterReadable.mock.calls.length, 2)
    const userIds = filterReadable.mock.calls.map((c: any) => c.arguments[0]).sort()
    assert.deepEqual(userIds, ['user-a', 'user-b'])
  })
})
