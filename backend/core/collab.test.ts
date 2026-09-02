/**
 * `core/collab.ts#participantInfo()`: the "someone else has this page open" accessor, read straight
 * off whatever room already exists. Pure — no `WIKI` global, no database.
 *
 * The rest of this module's coverage lives in three siblings, split out of one 1,433-line file
 * (TEST-F14) so the pure/DB boundary is a filename property rather than something a reader has to
 * derive from a `{ skip }` option per describe: `collab.capture.test.ts` (the pre-auth frame buffer
 * and the connection caps), `collab.relay.test.ts` (the peer handshake, chunked relay and seeding)
 * and `collab.crossInstance.db.test.ts`. What more than one of them needs to stand an instance up
 * lives in `test/collabHarness.ts`.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import collab from './collab.ts'

/**
 * Unit test for `participantInfo()` (task 546): a cheap "someone else has this page open" signal read
 * straight off whatever collab room already exists for a page — no new tracking, no query. Exercised
 * against the real `Awareness` state exactly as `ensureRoom()`/`join()` populate it in production and
 * as `composables/collab.js` sets it client-side (`awareness.setLocalStateField('user', {...})`),
 * rather than a hand-rolled stand-in for the library.
 *
 * Reaches into `collab.rooms` directly instead of going through the websocket handshake in
 * `controllers/collab.ts`, so this is a pure unit test of the accessor rather than of the socket
 * lifecycle — and needs no `WIKI` global, since `participantInfo` touches nothing but the room map and
 * the awareness instance already inside it.
 *
 * Every `Awareness` created here is `.destroy()`ed once the test is done with it, exactly as
 * `closeRoomIfEmpty()` does for a real room: the constructor starts an interval timer of its own (to
 * expire stale clients), and leaving one running is an open handle that keeps `node --test` from ever
 * exiting rather than a leak this test's assertions would catch.
 */
describe('collab.participantInfo', () => {
  interface Handle {
    awareness: awarenessProtocol.Awareness
    doc: Y.Doc
  }

  function makeAwareness(): Handle {
    const doc = new Y.Doc()
    return { awareness: new awarenessProtocol.Awareness(doc), doc }
  }

  function destroy(...handles: Handle[]): void {
    for (const { awareness, doc } of handles) {
      awareness.destroy()
      doc.destroy()
    }
  }

  /** Merges a "remote" client's awareness state into a room's, the way a real join() would. */
  function mergeIn(room: awarenessProtocol.Awareness, remote: awarenessProtocol.Awareness): void {
    awarenessProtocol.applyAwarenessUpdate(
      room,
      awarenessProtocol.encodeAwarenessUpdate(remote, [remote.clientID]),
      'test'
    )
  }

  test('a page nobody has open on this instance answers empty', () => {
    assert.deepEqual(collab.participantInfo('no-such-page'), { count: 0, names: [] })
  })

  test('counts every connected awareness client and collects their names', () => {
    const room = makeAwareness()
    // -> As `ensureRoom()` does: the server itself is not a participant, so it carries no local state.
    room.awareness.setLocalState(null)
    const ada = makeAwareness()
    ada.awareness.setLocalStateField('user', { name: 'Ada Lovelace' })
    const grace = makeAwareness()
    grace.awareness.setLocalStateField('user', { name: 'Grace Hopper' })
    mergeIn(room.awareness, ada.awareness)
    mergeIn(room.awareness, grace.awareness)

    collab.rooms.set('page-1', { awareness: room.awareness } as any)
    try {
      const info = collab.participantInfo('page-1')
      assert.equal(info.count, 2)
      assert.deepEqual([...info.names].sort(), ['Ada Lovelace', 'Grace Hopper'])
    } finally {
      collab.rooms.delete('page-1')
      destroy(room, ada, grace)
    }
  })

  test('an awareness state with no user field is counted but contributes no name', () => {
    const room = makeAwareness()
    room.awareness.setLocalState(null)
    const anon = makeAwareness()
    anon.awareness.setLocalStateField('typing', true)
    mergeIn(room.awareness, anon.awareness)

    collab.rooms.set('page-2', { awareness: room.awareness } as any)
    try {
      const info = collab.participantInfo('page-2')
      assert.equal(info.count, 1)
      assert.deepEqual(info.names, [])
    } finally {
      collab.rooms.delete('page-2')
      destroy(room, anon)
    }
  })
})
