/**
 * `core/collab.ts`'s draft persistence (Feature #2426, "Autosave draft while editing" — OpenProject
 * #2454/#2456): a room's real edits are debounce-persisted into `pageDrafts`
 * (`schedulePersist`/`persistNow`), flushed synchronously when the room empties out
 * (`closeRoomIfEmpty`), preferred over the stored page the next time a room for that page has to
 * rebuild itself from nothing (`initRoom`), and cleared once a real save lands (`pageSaved`).
 *
 * The acceptance criterion this whole feature exists for — "crash/tab-close mid-edit does not lose
 * content; reopening recovers the draft" — is exercised directly below as the room-level equivalent
 * of that scenario: an edit lands, every participant disconnects (the room "empties out", exactly
 * what a crash or tab-close looks like from `core/collab.ts`'s side — see `closeRoomIfEmpty`'s own
 * doc comment), and a fresh room opened for the same page afterward recovers the edited content.
 *
 * Pure — `test/collabHarness.ts#makePageDraftsStub()` stands in for `WIKI.models.pageDrafts`, the
 * same way its `getPage` mock already stands in for `WIKI.models.pages`. `models/pageDrafts.db.test.ts`
 * is what proves the real model persists the same bytes this stub does.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as Y from 'yjs'
import { DRAFT_PERSIST_DEBOUNCE_MS, DRAFT_PERSIST_MAX_WAIT_MS } from './collab.ts'
import { installCollabHarness, makeInstance, STORED_PAGE, wire } from '../test/collabHarness.ts'

const harness = installCollabHarness()

/** A Yjs update encoding `text` as `content`, the same shape a real room's state takes. */
function encodeContent(text: string): Uint8Array {
  const scratch = new Y.Doc()
  scratch.getText('content').insert(0, text)
  const update = Y.encodeStateAsUpdate(scratch)
  scratch.destroy()
  return update
}

/** Decode a persisted draft's bytes back into readable text, without mutating the room's own doc. */
function decodeContent(state: Uint8Array): string {
  const check = new Y.Doc()
  Y.applyUpdate(check, state)
  const text = check.getText('content').toString()
  check.destroy()
  return text
}

describe('draft persistence: a local edit is debounced toward pageDrafts.save()', () => {
  test('a burst of edits collapses into one write after the idle window, holding the final content', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const room = await harness.openRoom(inst, { id: 'page-debounce', siteId: 'site-1' })

    for (let i = 0; i < 5; i++) {
      room.doc.transact(() => {
        room.doc.getText('content').insert(0, `${i} `)
      })
      t.mock.timers.tick(200) // well under DRAFT_PERSIST_DEBOUNCE_MS between each keystroke
    }
    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      0,
      'still inside the idle window - nothing written yet'
    )

    t.mock.timers.tick(DRAFT_PERSIST_DEBOUNCE_MS)

    assert.equal(harness.pageDrafts().save.mock.calls.length, 1, 'exactly one write for the burst')
    const [savedPageId, savedSiteId, savedState] = harness.pageDrafts().save.mock.calls[0].arguments
    assert.equal(savedPageId, 'page-debounce')
    assert.equal(savedSiteId, 'site-1')
    assert.equal(decodeContent(savedState), room.doc.getText('content').toString())
  })

  test('a continuously-edited room is still persisted at least every DRAFT_PERSIST_MAX_WAIT_MS', async (t) => {
    // -> `Date` has to be faked alongside `setTimeout`: schedulePersist()'s max-wait deadline is
    //    computed from `Date.now()`, and without it, tick()ing the fake setTimeout clock forward
    //    leaves that computation reading real (barely-moving) wall-clock time instead.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const room = await harness.openRoom(inst, { id: 'page-maxwait', siteId: 'site-1' })

    // -> Edit once a second - always well inside the idle window, so DRAFT_PERSIST_DEBOUNCE_MS alone
    //    would never fire. Only the max-wait ceiling can force a flush here.
    for (let elapsed = 0; elapsed < DRAFT_PERSIST_MAX_WAIT_MS; elapsed += 1000) {
      room.doc.transact(() => {
        room.doc.getText('content').insert(0, 'x')
      })
      t.mock.timers.tick(1000)
    }

    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      1,
      'the max-wait ceiling forced a flush despite edits never letting the idle window elapse'
    )
  })

  test('a relayed cross-instance update does not schedule a persist on the receiving instance', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)
    a.peerPresence = { known: false, checkedAt: Date.now() }
    b.peerPresence = { known: false, checkedAt: Date.now() }

    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const roomA = await harness.openRoom(a, { id: 'page-cross', siteId: 'site-1' })
    ;(globalThis as any).WIKI.INSTANCE_ID = 'B'
    const roomB = await harness.openRoom(b, { id: 'page-cross', siteId: 'site-1' })

    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    roomA.doc.transact(() => {
      roomA.doc.getText('content').insert(0, 'edit on A: ')
    })
    const expectedContent = roomA.doc.getText('content').toString()
    // -> `wire()` delivers the relay synchronously, so B already has it before any timer runs.
    assert.equal(roomB.doc.getText('content').toString(), expectedContent)

    t.mock.timers.tick(DRAFT_PERSIST_DEBOUNCE_MS)

    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      1,
      'only the originating instance (A) persists its own edit - B applying the relay is not a second one'
    )
    assert.equal(harness.pageDrafts().save.mock.calls[0].arguments[0], 'page-cross')
  })

  test('writing meta (lastSave/draftRestored) alone never schedules a persist', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const room = await harness.openRoom(inst, { id: 'page-meta-only', siteId: 'site-1' })

    room.doc.getMap('meta').set('lastSave', { versionDate: 'x', authorId: 'u1', authorName: 'Ada' })
    t.mock.timers.tick(DRAFT_PERSIST_MAX_WAIT_MS)

    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      0,
      'a lastSave/draftRestored notice is not content worth recovering'
    )
  })
})

describe('draft persistence: the acceptance criterion - crash/tab-close mid-edit does not lose content', () => {
  test('closeRoomIfEmpty() flushes a pending edit synchronously, and the next room for the page recovers it', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const room = await harness.openRoom(inst, { id: 'page-crash', siteId: 'site-1' })

    // -> The author types, then the tab crashes (or is closed) before DRAFT_PERSIST_DEBOUNCE_MS ever
    //    elapses - the exact scenario this feature exists for.
    room.doc.transact(() => {
      room.doc.getText('content').insert(0, 'unsaved edit before crash: ')
    })
    const contentAtCrash = room.doc.getText('content').toString()
    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      0,
      'not yet flushed - still debouncing'
    )

    // -> Every participant leaving is what closeRoomIfEmpty() sees, whether that is a deliberate
    //    close or a crash; room.conns is already empty here since no socket ever joined it.
    inst.closeRoomIfEmpty(room)

    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      1,
      'the pending edit was flushed the instant the room emptied out'
    )
    assert.equal(inst.rooms.has('page-crash'), false)
    // -> The room's very first open (before the crash) legitimately called getPage once, having no
    //    draft yet to prefer - what matters for this scenario is that reopening after the crash does
    //    not call it again.
    const getPageCallsBeforeReopen = harness.getPage().mock.calls.length

    // -> Reopening the page: nobody else is around, so the room falls back through the same
    //    peer -> draft -> stored-page order initRoom() always does, landing on the draft.
    const reopened = await harness.openRoom(inst, { id: 'page-crash', siteId: 'site-1' })
    assert.equal(
      reopened.doc.getText('content').toString(),
      contentAtCrash,
      'the exact content at the moment of the crash came back, unsaved edit included'
    )
    assert.ok(reopened.doc.getMap('meta').get('draftRestored'), 'the restore is announced on meta')
    assert.equal(
      harness.getPage().mock.calls.length,
      getPageCallsBeforeReopen,
      'the persisted draft was preferred - the stored page was not consulted again on reopen'
    )
  })

  test('closeRoomIfEmpty() writes nothing when there was no pending edit to lose', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const room = await harness.openRoom(inst, { id: 'page-no-edit', siteId: 'site-1' })

    inst.closeRoomIfEmpty(room)

    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      0,
      'a room nobody ever edited must not persist a byte-identical copy of the stored page'
    )
  })
})

describe('initRoom(): where a fresh room gets its starting state from', () => {
  test('a persisted draft is preferred over the stored page when there is no peer', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    harness.pageDrafts().rows.set('page-restore', encodeContent('unsaved draft content'))

    const room = await harness.openRoom(inst, { id: 'page-restore', siteId: 'site-1' })

    assert.equal(room.doc.getText('content').toString(), 'unsaved draft content')
    assert.ok(room.doc.getMap('meta').get('draftRestored'))
    assert.equal(harness.getPage().mock.calls.length, 0, 'the stored page was never consulted')
  })

  test('falls back to the stored page, with draftRestored left unset, when there is no persisted draft', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'

    const room = await harness.openRoom(inst, { id: 'page-no-draft', siteId: 'site-1' })

    assert.equal(room.doc.getText('content').toString(), STORED_PAGE.content)
    assert.equal(room.doc.getMap('meta').get('draftRestored'), undefined)
    assert.equal(harness.getPage().mock.calls.length, 1)
  })

  test('a live peer still wins over a persisted draft - the peer is the more current copy', async () => {
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)
    // -> A itself has no peer and no draft yet, so it falls back to the stored page like any
    //    ordinary first room - the persisted draft below is seeded only once A already exists, so it
    //    is B's decision being tested here, not A's.
    a.peerPresence = { known: false, checkedAt: Date.now() }
    b.peerPresence = { known: true, checkedAt: Date.now() }

    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const roomA = await harness.openRoom(a, { id: 'page-peer-wins', siteId: 'site-1' })
    roomA.doc.transact(() => {
      roomA.doc.getText('content').insert(0, 'LIVE ON A: ')
    })
    const liveContent = roomA.doc.getText('content').toString()
    // -> A stale persisted draft sitting in the table from some earlier, unrelated session - present
    //    only to prove B reaches for the live peer instead of it, never that no draft existed at all.
    harness.pageDrafts().rows.set('page-peer-wins', encodeContent('a stale persisted draft'))

    ;(globalThis as any).WIKI.INSTANCE_ID = 'B'
    const roomB = await harness.openRoom(b, { id: 'page-peer-wins', siteId: 'site-1' })

    assert.equal(roomB.doc.getText('content').toString(), liveContent)
    assert.equal(
      roomB.doc.getMap('meta').get('draftRestored'),
      undefined,
      'the peer handshake path never touches draftRestored - that is the no-peer fallback only'
    )
  })
})

describe('pageSaved(): a real save clears the persisted draft', () => {
  test('clears the row and cancels a pending debounce for the room it is writing into', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const room = await harness.openRoom(inst, { id: 'page-saved', siteId: 'site-1' })
    harness.pageDrafts().rows.set('page-saved', new Uint8Array([1, 2, 3]))

    room.doc.transact(() => {
      room.doc.getText('content').insert(0, 'still typing')
    })
    assert.ok(room.draftPersistTimer, 'a debounce is pending from the edit above')

    inst.pageSaved('page-saved', {
      versionDate: '2026-09-03T00:00:00.000Z',
      authorId: 'u1',
      authorName: 'Ada'
    })

    assert.equal(room.draftPersistTimer, null, 'the pending debounce was cancelled by the save')
    assert.equal(
      harness.pageDrafts().rows.has('page-saved'),
      false,
      'the persisted draft was cleared - the content is now committed for real'
    )

    t.mock.timers.tick(DRAFT_PERSIST_MAX_WAIT_MS)
    assert.equal(
      harness.pageDrafts().save.mock.calls.length,
      0,
      'no stale pre-save write landed after the cancel'
    )
  })

  test('clears the row even when this instance has no room open for the page (relay path)', () => {
    const inst = makeInstance('A')
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    harness.pageDrafts().rows.set('page-saved-elsewhere', new Uint8Array([9]))

    inst.pageSaved('page-saved-elsewhere', {
      versionDate: '2026-09-03T00:00:00.000Z',
      authorId: 'u1',
      authorName: 'Ada'
    })

    assert.equal(harness.pageDrafts().rows.has('page-saved-elsewhere'), false)
  })
})
