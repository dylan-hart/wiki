import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import collab from './collab.ts'

/**
 * Every `Awareness` created here is `.destroy()`ed: its constructor starts an interval timer, and a
 * live one is an open handle that keeps `node --test` from exiting.
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
