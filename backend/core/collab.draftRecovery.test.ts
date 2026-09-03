/**
 * `core/collab.ts`'s recovery-draft persistence (OpenProject #2455): a room that closes with a real,
 * unsaved edit still in it gets that content snapshotted into `WIKI.models.pageDrafts` rather than
 * simply discarded, and an actual save clears whatever was persisted. Exercised against
 * `test/collabHarness.ts#installCollabHarness`'s `WIKI.models.pageDrafts` mocks, so this asserts on
 * what was CALLED rather than a real database round trip -- the SQL itself is `models/pageDrafts.ts`'s
 * own DB-backed coverage.
 *
 * Split out of `core/collab.test.ts` (TEST-F14 precedent); see that file's header for the sibling map.
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import * as Y from 'yjs'
import collab, { extractSnapshot } from './collab.ts'
import { installCollabHarness, makeInstance, STORED_PAGE, wire } from '../test/collabHarness.ts'

const harness = installCollabHarness()

// -> Every describe below either opens a room on the real singleton or on its own `makeInstance()`
//    clones -- either way, known-empty rather than left at its module-load default (`checkedAt: 0`,
//    which reads as stale and would otherwise send `ensureRoom()` on a real `hasPeers()` query this
//    test's `WIKI.db` stub cannot answer).
beforeEach(() => {
  collab.peerPresence = { known: false, checkedAt: Date.now() }
})

describe('extractSnapshot: the inverse of buildSeed', () => {
  test('reads content and props back out as plain strings', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      doc.getText('content').insert(0, 'Hello world')
      const props = doc.getMap('props')
      props.set('title', 'A Title')
      props.set('description', 'A description')
      props.set('icon', 'mdi:file')
    })
    try {
      assert.deepEqual(extractSnapshot(doc), {
        content: 'Hello world',
        title: 'A Title',
        description: 'A description',
        icon: 'mdi:file'
      })
    } finally {
      doc.destroy()
    }
  })

  test('defaults every field to an empty string when the doc never got one', () => {
    const doc = new Y.Doc()
    try {
      assert.deepEqual(extractSnapshot(doc), {
        content: '',
        title: '',
        description: '',
        icon: ''
      })
    } finally {
      doc.destroy()
    }
  })
})

describe('closeRoomIfEmpty: persisting a recovery draft', () => {
  test('a room nobody ever typed into is closed with no draft persisted', async () => {
    const page = { id: 'page-clean', siteId: 'site-1' }
    const room = await harness.openRoom(collab, page)

    collab.closeRoomIfEmpty(room)

    assert.equal(harness.getPageDraftsSave().mock.calls.length, 0)
    assert.equal(collab.rooms.has(page.id), false)
  })

  test('a room with a genuine edit is snapshotted and persisted before being torn down', async () => {
    const page = { id: 'page-dirty', siteId: 'site-1' }
    const room = await harness.openRoom(collab, page)

    room.doc.transact(() => {
      room.doc.getText('content').insert(0, 'UNSAVED: ')
    })
    assert.equal(room.dirty, true)

    collab.closeRoomIfEmpty(room, 'Ada Lovelace')

    const calls = harness.getPageDraftsSave().mock.calls
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].arguments[0], {
      pageId: page.id,
      authorId: null,
      authorName: 'Ada Lovelace',
      content: `UNSAVED: ${STORED_PAGE.content}`,
      title: STORED_PAGE.title,
      description: STORED_PAGE.description,
      icon: STORED_PAGE.icon
    })
    assert.equal(collab.rooms.has(page.id), false)
  })

  test('with no closing identity, the draft is still persisted, with no author name attached', async () => {
    const page = { id: 'page-dirty-anon', siteId: 'site-1' }
    const room = await harness.openRoom(collab, page)

    room.doc.transact(() => {
      room.doc.getText('content').insert(0, 'X')
    })

    collab.closeRoomIfEmpty(room)

    const calls = harness.getPageDraftsSave().mock.calls
    assert.equal(calls.length, 1)
    assert.equal(calls[0].arguments[0].authorName, null)
  })

  test('an edit relayed in from a peer instance counts as dirty exactly like a local one', async () => {
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)
    const page = { id: 'page-cross-instance', siteId: 'site-1' }

    a.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const roomA = await harness.openRoom(a, page)

    b.peerPresence = { known: true, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'B'
    const roomB = await harness.openRoom(b, page)
    // -> B seeded from A's (clean, unedited) state during its own setup -- not dirty yet.
    assert.equal(roomB.dirty, false)

    // -> Somebody edits on A, after both rooms are already past their own setup. The edit reaches B
    //    only over the relay (`origin === RELAYED` on B's side), never through B's own local typing.
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    roomA.doc.transact(() => {
      roomA.doc.getText('content').insert(0, 'EDITED ON A: ')
    })
    const expectedContent = roomA.doc.getText('content').toString()

    assert.equal(roomB.doc.getText('content').toString(), expectedContent)
    assert.equal(roomB.dirty, true)

    // -> B's local participant disconnects (A's is still around, but that is a separate replica --
    //    see closeRoomIfEmpty's own doc comment). B's own copy of the edit must not be lost.
    b.closeRoomIfEmpty(roomB)

    const calls = harness.getPageDraftsSave().mock.calls
    assert.equal(calls.length, 1)
    assert.equal(calls[0].arguments[0].content, expectedContent)
  })
})

describe('pageSaved: clearing a recovery draft on an actual save', () => {
  test('resets the local room to not-dirty and clears any persisted draft', async () => {
    const page = { id: 'page-saved', siteId: 'site-1' }
    const room = await harness.openRoom(collab, page)
    room.doc.transact(() => {
      room.doc.getText('content').insert(0, 'about to be saved')
    })
    assert.equal(room.dirty, true)

    collab.pageSaved(page.id, {
      versionDate: '2026-01-01T00:00:00.000Z',
      authorId: 'user-1',
      authorName: 'Ada Lovelace'
    })

    assert.equal(room.dirty, false)
    assert.equal(harness.getPageDraftsClear().mock.calls.length, 1)
    assert.equal(harness.getPageDraftsClear().mock.calls[0].arguments[0], page.id)

    // -> Closing the now-clean room afterwards persists nothing more: the save already covers it.
    collab.closeRoomIfEmpty(room)
    assert.equal(harness.getPageDraftsSave().mock.calls.length, 0)
  })

  test('a save for a page with no locally-held room still clears the persisted draft', () => {
    collab.pageSaved('page-elsewhere', {
      versionDate: '2026-01-01T00:00:00.000Z',
      authorId: 'user-1',
      authorName: 'Ada Lovelace'
    })

    assert.equal(harness.getPageDraftsClear().mock.calls.length, 1)
    assert.equal(harness.getPageDraftsClear().mock.calls[0].arguments[0], 'page-elsewhere')
  })
})
