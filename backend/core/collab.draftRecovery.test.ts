/**
 * `core/collab.ts`'s recovery-draft attribution (OpenProject #2455): `onClose` reads a departing
 * connection's awareness state for a display name and remembers it on the room
 * (`CollabRoom.lastAuthorName`), so that the draft `flushDraftPersist` writes next — whether that
 * happens right away, because the room is now empty (`closeRoomIfEmpty`), or later, from a still-open
 * room's own debounce — carries best-effort attribution of who was last known to be editing. The
 * persistence mechanism itself (debounce, which fallback tier `initRoom()` prefers, the clear-on-save)
 * is `core/collab.draftPersist.test.ts`'s job (OpenProject #2454); this file only covers the
 * attribution this WP added on top of it.
 *
 * Split out of `core/collab.test.ts` (TEST-F14 precedent); see that file's header for the sibling map.
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import collab from './collab.ts'
import { FakeSocket, installCollabHarness } from '../test/collabHarness.ts'

const harness = installCollabHarness()

beforeEach(() => {
  collab.peerPresence = { known: false, checkedAt: Date.now() }
})

/** A remote client's awareness state, merged into a room's the way a real `join()` would once the
 * client's own sync/awareness messages arrive — see `core/collab.test.ts#participantInfo`'s own
 * `mergeIn` for the same technique. Registering it with `conn` as the update's origin is what lets
 * `ensureRoom()`'s own `awareness.on('update', ...)` handler attribute the client id to that
 * connection's `CollabConn.clients`, exactly as it would for a real socket's own awareness frame. */
function attachIdentifiedClient(
  room: any,
  conn: FakeSocket,
  name: string
): { doc: Y.Doc; awareness: awarenessProtocol.Awareness } {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalStateField('user', { name })
  awarenessProtocol.applyAwarenessUpdate(
    room.awareness,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
    conn
  )
  return { doc, awareness }
}

describe('onClose: attributing the next persisted draft to whoever just left', () => {
  test('a departing connection with a named awareness state is remembered on the room', async () => {
    const room = await harness.openRoom(collab, { id: 'page-onclose-1', siteId: 'site-1' })
    const conn = new FakeSocket() as any
    const identity = { userId: 'u1', address: '127.0.0.1' }
    collab.reserveSlot(identity)
    room.conns.set(conn, { clients: new Set(), alive: true, identity })
    const remote = attachIdentifiedClient(room, conn, 'Ada Lovelace')

    room.doc.transact(() => room.doc.getText('content').insert(0, 'unsaved edit'))
    collab.onClose(room, conn)

    assert.equal(room.lastAuthorName, 'Ada Lovelace')
    remote.awareness.destroy()
    remote.doc.destroy()
  })

  test('closing the last connection flushes a pending draft with that name attached', async () => {
    const room = await harness.openRoom(collab, { id: 'page-onclose-2', siteId: 'site-1' })
    const pageDrafts = harness.pageDrafts()
    const conn = new FakeSocket() as any
    const identity = { userId: 'u1', address: '127.0.0.1' }
    collab.reserveSlot(identity)
    room.conns.set(conn, { clients: new Set(), alive: true, identity })
    const remote = attachIdentifiedClient(room, conn, 'Grace Hopper')

    room.doc.transact(() => room.doc.getText('content').insert(0, 'unsaved edit'))
    collab.onClose(room, conn)

    assert.equal(pageDrafts.save.mock.calls.length, 1)
    const [, , , authorId, authorName] = pageDrafts.save.mock.calls[0].arguments
    assert.equal(authorId, null, 'no real user id is ever resolved here, only a display name')
    assert.equal(authorName, 'Grace Hopper')
    assert.equal(collab.rooms.has('page-onclose-2'), false)
    remote.awareness.destroy()
    remote.doc.destroy()
  })

  test('a departing connection with no name leaves any prior attribution untouched', async () => {
    const room = await harness.openRoom(collab, { id: 'page-onclose-3', siteId: 'site-1' })
    room.lastAuthorName = 'Earlier Editor'
    const conn = new FakeSocket() as any
    const identity = { userId: 'u1', address: '127.0.0.1' }
    collab.reserveSlot(identity)
    room.conns.set(conn, { clients: new Set(), alive: true, identity })
    // -> An anonymous awareness state, same shape `collab.test.ts`'s own "no user field" case uses.
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalStateField('typing', true)
    awarenessProtocol.applyAwarenessUpdate(
      room.awareness,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
      conn
    )

    // -> A second, still-open connection keeps the room alive past this close, so `lastAuthorName`
    //    can be inspected without the room having already torn itself down.
    const stillOpen = new FakeSocket() as any
    room.conns.set(stillOpen, {
      clients: new Set(),
      alive: true,
      identity: { userId: 'u2', address: '127.0.0.2' }
    })

    collab.onClose(room, conn)

    assert.equal(room.lastAuthorName, 'Earlier Editor')
    awareness.destroy()
    doc.destroy()
    room.conns.delete(stillOpen)
  })
})
