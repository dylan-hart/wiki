import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RELAY_AWARENESS_WINDOW, RELAY_CHUNK_SIZE, RELAY_UPDATE_WINDOW } from './collab.ts'
import { FakeSocket, installCollabHarness, makeInstance, wire } from '../test/collabHarness.ts'

const harness = installCollabHarness()

function asInstance(id: string): void {
  ;(globalThis as any).CARDINAL.INSTANCE_ID = id
}

async function twoRooms(pageId: string, opts: { trackA?: boolean } = {}) {
  const a = makeInstance('A')
  const b = makeInstance('B')
  wire(a, b)
  const sent: any[] = []
  const deliver = a.publish
  a.publish = (envelope: any) => {
    sent.push({ ...envelope })
    deliver(envelope)
  }
  const page = { id: pageId, siteId: 'site-1' }
  a.peerPresence = { known: false, checkedAt: Date.now() }
  b.peerPresence = { known: false, checkedAt: Date.now() }
  asInstance('A')
  const roomA = opts.trackA === false ? await a.ensureRoom(page) : await harness.openRoom(a, page)
  asInstance('B')
  const roomB = await harness.openRoom(b, page)
  a.peerPresence = { known: true, checkedAt: Date.now() }
  b.peerPresence = { known: true, checkedAt: Date.now() }
  asInstance('A')
  return { a, b, roomA, roomB, sent }
}

function attachSocket(room: any): { conn: FakeSocket; frames: Uint8Array[] } {
  const conn = new FakeSocket()
  const frames: Uint8Array[] = []
  ;(conn as any).send = (message: Uint8Array) => frames.push(message)
  room.conns.set(conn, {
    clients: new Set(),
    alive: true,
    identity: { userId: 'u1', address: '127.0.0.1' }
  })
  return { conn, frames }
}

function type(room: any, text: string): void {
  for (const char of text) {
    room.doc.transact(() => {
      const content = room.doc.getText('content')
      content.insert(content.length, char)
    })
  }
}

const updatesOf = (sent: any[]) => sent.filter((e) => e.t === 'update')
const awarenessOf = (sent: any[]) => sent.filter((e) => e.t === 'awareness')

describe('document updates are merged per room before the relay', () => {
  test('a burst of keystrokes inside one window produces a single update NOTIFY', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { roomA, roomB, sent } = await twoRooms('batch-1')
    const { frames } = attachSocket(roomA)

    type(roomA, 'hello world')

    assert.equal(frames.length, 11, 'local sockets are still served one frame per keystroke')
    assert.equal(updatesOf(sent).length, 0, 'nothing is relayed before the window closes')

    t.mock.timers.tick(RELAY_UPDATE_WINDOW - 1)
    assert.equal(updatesOf(sent).length, 0)

    t.mock.timers.tick(1)
    assert.equal(updatesOf(sent).length, 1)
    assert.equal(
      roomB.doc.getText('content').toString(),
      roomA.doc.getText('content').toString(),
      'the merged payload carries every keystroke'
    )
    assert.equal(roomA.relayOutbox.updateTimer, null)
    assert.deepEqual(roomA.relayOutbox.updates, [])
  })

  test('edits in separate windows go out separately', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { roomA, roomB, sent } = await twoRooms('batch-2')

    type(roomA, 'one ')
    t.mock.timers.tick(RELAY_UPDATE_WINDOW)
    type(roomA, 'two')
    t.mock.timers.tick(RELAY_UPDATE_WINDOW)

    assert.equal(updatesOf(sent).length, 2)
    assert.equal(roomB.doc.getText('content').toString(), roomA.doc.getText('content').toString())
  })

  test('a relayed update is never batched back out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { a, roomA, sent } = await twoRooms('batch-3')
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(roomA.doc))
    peer.getText('content').insert(0, 'from B: ')

    asInstance('A')
    a.receiveRelay({
      i: 'B',
      r: 'batch-3',
      t: 'update',
      p: Buffer.from(Y.encodeStateAsUpdate(peer, Y.encodeStateVector(roomA.doc))).toString('base64')
    })
    t.mock.timers.tick(RELAY_UPDATE_WINDOW)

    assert.equal(updatesOf(sent).length, 0)
    assert.equal(roomA.relayOutbox.updateTimer, null)
    peer.destroy()
  })

  test('a merged payload over RELAY_CHUNK_SIZE still goes through the chunking path', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { roomA, roomB, sent } = await twoRooms('batch-4')

    for (let index = 0; index < 20; index++) {
      roomA.doc.transact(() => {
        roomA.doc.getText('content').insert(0, `${index}:${'q'.repeat(500)}`)
      })
    }
    t.mock.timers.tick(RELAY_UPDATE_WINDOW)

    const updates = updatesOf(sent)
    assert.ok(updates.length >= 2, 'the merged payload is split into chunks')
    assert.ok(updates.every((chunk) => chunk.m === updates[0].m && chunk.n === updates.length))
    assert.ok(updates.every((chunk) => chunk.p.length <= RELAY_CHUNK_SIZE))
    assert.equal(roomB.doc.getText('content').toString(), roomA.doc.getText('content').toString())
  })

  test('pageSaved() sends pending edits and the saved notice at once, as one update', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { a, roomA, roomB, sent } = await twoRooms('batch-5')
    const info = { versionDate: '2026-09-23T00:00:00.000Z', authorId: 'u1', authorName: 'Ada' }

    type(roomA, 'saved text')
    a.pageSaved('batch-5', info)

    assert.equal(updatesOf(sent).length, 1)
    assert.equal(sent.filter((e) => e.t === 'saved').length, 0)
    assert.deepEqual(roomB.doc.getMap('meta').get('lastSave'), info)
    assert.equal(roomB.doc.getText('content').toString(), roomA.doc.getText('content').toString())
    assert.equal(roomA.relayOutbox.updateTimer, null)
  })

  test('closing the room flushes what is still buffered', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { a, roomA, roomB, sent } = await twoRooms('batch-6', { trackA: false })

    type(roomA, 'last words')
    const expected = roomA.doc.getText('content').toString()
    a.closeRoomIfEmpty(roomA)

    assert.equal(updatesOf(sent).length, 1)
    assert.equal(roomB.doc.getText('content').toString(), expected)
    assert.equal(roomA.relayOutbox.updateTimer, null)
  })

  test('shutdown() flushes every room before the relay listener is released', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { a, roomA, roomB, sent } = await twoRooms('batch-7', { trackA: false })
    let sentAtClose = -1
    a.listenerHandle = {
      close: async () => {
        sentAtClose = sent.length
      }
    }

    type(roomA, 'going down')
    const expected = roomA.doc.getText('content').toString()
    await a.shutdown()

    assert.equal(updatesOf(sent).length, 1)
    assert.ok(sentAtClose >= 1, 'the flush happens before the listener closes')
    assert.equal(roomB.doc.getText('content').toString(), expected)
    assert.equal(roomA.relayOutbox.updateTimer, null)
  })
})

describe('awareness relays are throttled per room', () => {
  function client(name: string) {
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalStateField('user', { name })
    return {
      awareness,
      push(room: any, conn: FakeSocket) {
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
          conn
        )
      },
      destroy() {
        awareness.destroy()
        doc.destroy()
      }
    }
  }

  test('cursor moves inside one window relay once, carrying the latest state', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { roomA, roomB, sent } = await twoRooms('aw-1')
    const { conn } = attachSocket(roomA)
    const ada = client('Ada')

    for (let index = 0; index < 5; index++) {
      ada.awareness.setLocalStateField('cursor', index)
      ada.push(roomA, conn)
    }
    assert.equal(awarenessOf(sent).length, 0)

    t.mock.timers.tick(RELAY_AWARENESS_WINDOW - 1)
    assert.equal(awarenessOf(sent).length, 0)

    t.mock.timers.tick(1)
    assert.equal(awarenessOf(sent).length, 1)
    assert.equal((roomB.awareness.getStates().get(ada.awareness.clientID) as any)?.cursor, 4)
    assert.equal(roomA.relayOutbox.awarenessTimer, null)
    ada.destroy()
  })

  test('several clients changing in one window share one relay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { roomA, roomB, sent } = await twoRooms('aw-2')
    const { conn } = attachSocket(roomA)
    const ada = client('Ada')
    const grace = client('Grace')

    ada.push(roomA, conn)
    grace.push(roomA, conn)
    t.mock.timers.tick(RELAY_AWARENESS_WINDOW)

    assert.equal(awarenessOf(sent).length, 1)
    assert.ok(roomB.awareness.getStates().has(ada.awareness.clientID))
    assert.ok(roomB.awareness.getStates().has(grace.awareness.clientID))
    ada.destroy()
    grace.destroy()
  })

  test('a disconnect relays its removal immediately, without waiting out the window', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { a, roomA, roomB, sent } = await twoRooms('aw-3')
    const { conn } = attachSocket(roomA)
    const ada = client('Ada')
    const grace = client('Grace')

    const graceConn = attachSocket(roomA).conn
    ada.push(roomA, conn)
    grace.push(roomA, graceConn)
    t.mock.timers.tick(RELAY_AWARENESS_WINDOW)
    assert.ok(roomB.awareness.getStates().has(ada.awareness.clientID))

    grace.awareness.setLocalStateField('cursor', 7)
    grace.push(roomA, graceConn)
    const before = awarenessOf(sent).length
    a.onClose(roomA, conn)

    assert.equal(awarenessOf(sent).length, before + 1)
    assert.equal(roomB.awareness.getStates().has(ada.awareness.clientID), false)
    assert.equal((roomB.awareness.getStates().get(grace.awareness.clientID) as any)?.cursor, 7)
    assert.equal(roomA.relayOutbox.awarenessTimer, null)
    ada.destroy()
    grace.destroy()
  })
})
