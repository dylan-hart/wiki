/**
 * `core/collab.ts`'s autosave-draft persistence (OpenProject #2454): a room's live Yjs state is
 * debounce-written to `WIKI.models.pageDrafts` as real edits happen, `initRoom()` prefers a persisted
 * draft over the plain stored page when no peer answers, and `pageSaved()` clears the draft once a
 * real save supersedes it. Pure — `test/collabHarness.ts` stubs `WIKI.models.pageDrafts`, so this
 * needs no database; `models/pageDrafts.db.test.ts` covers the storage layer itself. Split out of
 * `core/collab.test.ts` (TEST-F14) alongside its three siblings.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as Y from 'yjs'
import collab, { DRAFT_PERSIST_DEBOUNCE, DRAFT_PERSIST_MAX_DELAY } from './collab.ts'
import { installCollabHarness, STORED_PAGE } from '../test/collabHarness.ts'
import { ensureTemporal } from '../test/temporal.ts'

// -> `initRoom()`'s draft-restored marker calls `Date.prototype.toTemporalInstant()` -- see
//    `test/temporal.ts`'s own doc comment for why this sandbox needs the polyfill installed first.
await ensureTemporal()

const harness = installCollabHarness()

describe('scheduleDraftPersist / flushDraftPersist: debounce', () => {
  test('an edit schedules a timer, and DRAFT_PERSIST_DEBOUNCE of silence flushes it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const room = await harness.openRoom(collab, { id: 'page-1', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    room.doc.transact(() => {
      room.doc.getText('content').insert(0, 'hello')
    })

    assert.equal(pageDrafts.save.mock.calls.length, 0, 'not written before the debounce elapses')
    t.mock.timers.tick(DRAFT_PERSIST_DEBOUNCE)
    assert.equal(pageDrafts.save.mock.calls.length, 1)
    const [pageId, siteId, state] = pageDrafts.save.mock.calls[0].arguments
    assert.equal(pageId, 'page-1')
    assert.equal(siteId, 'site-1')
    assert.deepEqual(new Uint8Array(state), Y.encodeStateAsUpdate(room.doc))
  })

  test('further edits within the debounce window push the timer back rather than adding a second write', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const room = await harness.openRoom(collab, { id: 'page-2', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    room.doc.transact(() => room.doc.getText('content').insert(0, 'a'))
    t.mock.timers.tick(DRAFT_PERSIST_DEBOUNCE - 1)
    room.doc.transact(() => room.doc.getText('content').insert(0, 'b'))
    t.mock.timers.tick(DRAFT_PERSIST_DEBOUNCE - 1)
    assert.equal(
      pageDrafts.save.mock.calls.length,
      0,
      'still pushed back — must not have fired yet'
    )

    t.mock.timers.tick(1)
    assert.equal(pageDrafts.save.mock.calls.length, 1, 'exactly one write once it finally settles')
  })

  test('DRAFT_PERSIST_MAX_DELAY caps how long continuous edits may keep pushing the write back', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const room = await harness.openRoom(collab, { id: 'page-3', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    // -> An edit every (DEBOUNCE - 1)ms, forever — the debounce alone would never fire.
    const step = DRAFT_PERSIST_DEBOUNCE - 1
    let elapsed = 0
    while (elapsed < DRAFT_PERSIST_MAX_DELAY + step) {
      room.doc.transact(() => room.doc.getText('content').insert(0, 'x'))
      t.mock.timers.tick(step)
      elapsed += step
      if (pageDrafts.save.mock.calls.length > 0) {
        break
      }
    }
    assert.equal(
      pageDrafts.save.mock.calls.length,
      1,
      'the max-delay cap must force exactly one flush despite the debounce never going idle'
    )
  })

  test('a relayed update (RELAYED origin) never schedules a persist of its own', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const room = await harness.openRoom(collab, { id: 'page-4', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    // -> A real cross-instance edit, not an independently-seeded doc: cloned from the room's own
    //    current state first (same reasoning `buildSeed`'s doc comment gives for why two independent
    //    seeds must never both be inserted), then edited, then diffed against the room's state vector
    //    — exactly the update shape `doc.on('update', …)` itself would relay out.
    const before = Y.encodeStateVector(room.doc)
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(room.doc))
    remote.getText('content').insert(0, 'REMOTE EDIT: ')
    const diff = Y.encodeStateAsUpdate(remote, before)
    const expectedContent = remote.getText('content').toString()
    remote.destroy()

    collab.receiveRelay({
      i: 'some-other-instance',
      r: 'page-4',
      t: 'update',
      p: Buffer.from(diff).toString('base64')
    })

    assert.equal(room.doc.getText('content').toString(), expectedContent)
    t.mock.timers.tick(DRAFT_PERSIST_MAX_DELAY * 2)
    assert.equal(
      pageDrafts.save.mock.calls.length,
      0,
      'a relayed edit is already persisted wherever it actually originated'
    )
  })

  test('flushDraftPersist cancels a pending timer rather than leaving a duplicate scheduled', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const room = await harness.openRoom(collab, { id: 'page-5', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    room.doc.transact(() => room.doc.getText('content').insert(0, 'a'))
    await collab.flushDraftPersist(room)
    assert.equal(pageDrafts.save.mock.calls.length, 1)
    assert.equal(room.draftPersist.timer, null)

    // -> The debounce timer that was pending before the manual flush must not also fire later.
    t.mock.timers.tick(DRAFT_PERSIST_DEBOUNCE)
    assert.equal(
      pageDrafts.save.mock.calls.length,
      1,
      'no duplicate write from the cancelled timer'
    )
  })
})

describe('closeRoomIfEmpty: flushes a pending draft before the doc is destroyed', () => {
  // -> `ensureRoom()` directly, not `harness.openRoom()`: `closeRoomIfEmpty` below already destroys
  //    the doc/awareness itself, and the harness's own `afterEach` teardown does the same for every
  //    room `openRoom()` tracked — a real Yjs `Doc`/`Awareness` is not documented as safe to
  //    `destroy()` twice, so these two tests own their room's whole lifecycle instead of sharing it.
  test('a room with pending edits persists them one last time on close', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const room = await collab.ensureRoom({ id: 'page-6', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    // -> The room already holds `STORED_PAGE.content` from its own fallback seeding — inserting at 0
    //    prepends rather than replacing it.
    room.doc.transact(() => room.doc.getText('content').insert(0, 'not yet flushed: '))
    assert.equal(pageDrafts.save.mock.calls.length, 0)

    collab.closeRoomIfEmpty(room)

    assert.equal(pageDrafts.save.mock.calls.length, 1)
    const [, , state] = pageDrafts.save.mock.calls[0].arguments
    const check = new Y.Doc()
    Y.applyUpdate(check, new Uint8Array(state))
    assert.equal(check.getText('content').toString(), `not yet flushed: ${STORED_PAGE.content}`)
    check.destroy()
  })

  test('a room with nothing pending closes without an extra write', async () => {
    const room = await collab.ensureRoom({ id: 'page-7', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    collab.closeRoomIfEmpty(room)

    assert.equal(pageDrafts.save.mock.calls.length, 0)
  })
})

describe('initRoom: draft preference tier (peer > draft > stored page)', () => {
  test('a persisted draft is preferred over the stored page when no peer answers', async () => {
    const draftState = (() => {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, 'DRAFT CONTENT')
      const update = Y.encodeStateAsUpdate(doc)
      doc.destroy()
      return update
    })()
    const updatedAt = new Date('2026-08-01T00:00:00.000Z')
    harness.pageDrafts().get.mock.mockImplementationOnce(async () => ({
      state: Buffer.from(draftState),
      updatedAt
    }))

    const room = await harness.openRoom(collab, { id: 'page-8', siteId: 'site-1' })

    assert.equal(room.doc.getText('content').toString(), 'DRAFT CONTENT')
    assert.equal(harness.getPage().mock.calls.length, 0, 'the stored page must never be consulted')
    assert.deepEqual(room.doc.getMap('meta').get('draftRestored'), {
      at: '2026-08-01T00:00:00.000Z'
    })
  })

  test('the stored page is used, as before, when no draft exists either', async () => {
    const room = await harness.openRoom(collab, { id: 'page-9', siteId: 'site-1' })

    assert.equal(room.doc.getText('content').toString(), STORED_PAGE.content)
    assert.equal(harness.getPage().mock.calls.length, 1)
    assert.equal(room.doc.getMap('meta').get('draftRestored'), undefined)
  })

  test('restoring a draft does not itself schedule a further autosave write', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const draftState = (() => {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, 'DRAFT')
      const update = Y.encodeStateAsUpdate(doc)
      doc.destroy()
      return update
    })()
    harness.pageDrafts().get.mock.mockImplementationOnce(async () => ({
      state: Buffer.from(draftState),
      updatedAt: new Date()
    }))

    await harness.openRoom(collab, { id: 'page-10', siteId: 'site-1' })

    t.mock.timers.tick(DRAFT_PERSIST_MAX_DELAY * 2)
    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      0,
      'applying/marking the restored draft must go through RELAYED, not schedule a self-persist'
    )
  })
})

describe('pageSaved: clears the persisted draft', () => {
  test('clears the draft when this instance has the room open', async () => {
    const room = await harness.openRoom(collab, { id: 'page-11', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()

    collab.pageSaved(room.pageId, {
      versionDate: '2026-08-18T00:00:00.000Z',
      authorId: 'u1',
      authorName: 'Ada'
    })
    await Promise.resolve()

    assert.equal(pageDrafts.clear.mock.calls.length, 1)
    assert.equal(pageDrafts.clear.mock.calls[0].arguments[0], room.pageId)
  })

  test('clears the draft even when this instance has no room open for the page', async () => {
    const pageDrafts = harness.pageDrafts()

    collab.pageSaved('page-no-room', {
      versionDate: '2026-08-18T00:00:00.000Z',
      authorId: 'u1',
      authorName: 'Ada'
    })
    await Promise.resolve()

    assert.equal(pageDrafts.clear.mock.calls.length, 1)
    assert.equal(pageDrafts.clear.mock.calls[0].arguments[0], 'page-no-room')
  })
})
