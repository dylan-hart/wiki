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

/** `conn` as the update's origin is what makes `ensureRoom()`'s awareness handler record the client
 * id on that connection's `clients`, as a real socket's own awareness frame would. */
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
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalStateField('typing', true)
    awarenessProtocol.applyAwarenessUpdate(
      room.awareness,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
      conn
    )

    // -> A second, still-open connection keeps the room from tearing itself down on this close
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
