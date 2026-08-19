import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import collab, { PEER_STATE_TIMEOUT, RELAY_CHUNK_SIZE, RELAY_REASSEMBLY_TIMEOUT } from './collab.ts'

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

/**
 * Cross-instance regression coverage for `core/collab.ts` (task 705, feature 411) — the file's own
 * top-of-file comment lays out why the peer handshake and its determinism matter; these tests exercise
 * that against a genuinely departing peer rather than the happy path only:
 *
 *  (a) a room opened on one instance seeds a second instance's room via the hello/state handshake,
 *      rather than a second, duplicating call to the stored page;
 *  (b) a peer that never answers (indistinguishable, from the asker's side, from one that died before
 *      it could) resolves via `PEER_STATE_TIMEOUT`, not a hang;
 *  (c) a chunked update whose sender disappears mid-burst leaves the receiver's `partials` entry to be
 *      cleaned up by `RELAY_REASSEMBLY_TIMEOUT`, and never applies a partial update to the doc;
 *  (d) a `pageSaved()` notice relayed to an instance with no open room for that page — including one
 *      that currently has no room because it is mid-restart — is a safe no-op, not a phantom room.
 *
 * No database and no second `node backend` process: `hasPeers()`'s one query is bypassed by presetting
 * its cache, and "two instances" are two independent clones of the exported object (same methods,
 * independent `rooms`/`partials`/`awaitingState`) wired together by overriding `publish` to hand the
 * envelope straight to the other clone's `receiveRelay` — toggling the module-global `WIKI.INSTANCE_ID`
 * around each hop exactly as two real processes would each carry their own id. This is relay/room
 * bookkeeping with no SQL in it, so a real two-process harness (as built for task 704's scheduler work)
 * would mostly be re-proving the same logic slower and flakier, per CLAUDE.md's guidance to prefer a
 * unit test wherever a mock would not just be re-describing SQL.
 */

function makeInstance(id: string): any {
  return {
    ...collab,
    __id: id,
    rooms: new Map(),
    partials: new Map(),
    awaitingState: new Map(),
    listenClient: {},
    relaySeq: 0,
    peerPresence: { known: false, checkedAt: 0 }
  }
}

/**
 * Wire two instance clones' relay together: a publish from one hands the envelope straight to the
 * other's `receiveRelay`, toggling `WIKI.INSTANCE_ID` to whichever side is "currently running" for the
 * length of that one synchronous call — mirroring what a real NOTIFY delivery would look like from a
 * second process with its own instance id, without needing one.
 */
function wire(a: any, b: any): void {
  const byId: Record<string, any> = { [a.__id]: a, [b.__id]: b }
  for (const inst of [a, b]) {
    inst.publish = (envelope: any) => {
      for (const target of Object.values(byId)) {
        if (target.__id === envelope.i) {
          continue
        }
        const previous = (globalThis as any).WIKI.INSTANCE_ID
        ;(globalThis as any).WIKI.INSTANCE_ID = target.__id
        try {
          target.receiveRelay(envelope)
        } finally {
          ;(globalThis as any).WIKI.INSTANCE_ID = previous
        }
      }
    }
  }
}

const STORED_PAGE = {
  content: 'STORED PAGE CONTENT',
  title: 'Stored title',
  description: 'Stored description',
  icon: 'stored-icon'
}

let previousWiki: any
let getPageMock: any
/**
 * `awarenessProtocol.Awareness` (a room's cursor/presence tracker) starts a real `setInterval` of its
 * own to expire stale states - nothing above ever cleans it up on the happy path except a room
 * emptying out. Every room a test creates via {@link openRoom} is torn down the same way
 * `closeRoomIfEmpty` does in production, or the interval outlives the test and the process never exits.
 */
let createdRooms: any[]

async function openRoom(inst: any, page: { id: string; siteId: string }): Promise<any> {
  const room = await inst.ensureRoom(page)
  createdRooms.push(room)
  return room
}

before(() => {
  previousWiki = (globalThis as any).WIKI
})

beforeEach(() => {
  getPageMock = mock.fn(async () => ({ ...STORED_PAGE }))
  ;(globalThis as any).WIKI = {
    INSTANCE_ID: 'unset',
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    models: { pages: { getPage: getPageMock } }
  }
  createdRooms = []
})

afterEach(() => {
  for (const room of createdRooms) {
    room.awareness.destroy()
    room.doc.destroy()
  }
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

describe('(a) peer handshake: a room seeds from a live peer, not a duplicated stored page', () => {
  test("instance B opening the page after instance A gets A's live content, and never calls getPage", async () => {
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)

    const page = { id: 'page-1', siteId: 'site-1' }

    // A opens first, with nobody else around yet: it falls back to the stored page.
    a.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const roomA = await openRoom(a, page)
    assert.equal(getPageMock.mock.calls.length, 1)
    assert.equal(roomA.doc.getText('content').toString(), STORED_PAGE.content)

    // Someone edits it live on A - now A's real content differs from what the stored page holds.
    roomA.doc.transact(() => {
      roomA.doc.getText('content').insert(0, 'LIVE EDIT ON A: ')
    })
    const expectedContent = roomA.doc.getText('content').toString()
    assert.notEqual(expectedContent, STORED_PAGE.content)

    // B now opens the same page, knowing A is around.
    b.peerPresence = { known: true, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'B'
    const roomB = await openRoom(b, page)

    assert.equal(roomB.doc.getText('content').toString(), expectedContent)
    // Seeded from the peer, not a second call to the stored page - a second such call is exactly the
    // duplication the module's own top-of-file comment says the handshake exists to avoid.
    assert.equal(getPageMock.mock.calls.length, 1)
  })
})

describe('(b) peer handshake timeout when the peer instance is gone before it answers', () => {
  test('peerState resolves null after PEER_STATE_TIMEOUT and initRoom falls back to the stored page', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const b = makeInstance('B')
    // The 'hello' goes out into the void: from B's side, a peer that had the room but was killed
    // before it could reply looks identical to nobody answering at all.
    b.publish = () => {}
    b.peerPresence = { known: true, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'B'

    const roomPromise = b.ensureRoom({ id: 'page-2', siteId: 'site-1' }).then((room: any) => {
      createdRooms.push(room)
      return room
    })

    // Let the microtask chain (hasPeers() resolving, then peerState() registering its setTimeout) run
    // before advancing the fake clock - nothing here depends on wall-clock time, only on ordering.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }
    assert.equal(b.awaitingState.size, 1, 'peerState should be waiting on a reply by now')

    t.mock.timers.tick(PEER_STATE_TIMEOUT)

    const room = await roomPromise
    assert.equal(room.doc.getText('content').toString(), STORED_PAGE.content)
    assert.equal(b.awaitingState.size, 0, 'the timed-out wait must not linger in awaitingState')
    assert.equal(room.provisional, false)
  })
})

describe('(c) chunked relay reassembly when the sender is gone mid-burst', () => {
  /**
   * Two instances that each fall back to the stored page independently land on byte-identical Yjs
   * state (the determinism `buildSeed` exists for) - which is what lets a later diff between them be
   * compared exactly, rather than merged as two different replicas.
   */
  async function setupSenderAndReceiver(pageId: string) {
    const sender = makeInstance('SENDER')
    const receiver = makeInstance('RECEIVER')
    const sentChunks: any[] = []
    sender.publish = (envelope: any) => {
      sentChunks.push(envelope)
    }
    receiver.publish = () => {}
    sender.peerPresence = { known: false, checkedAt: Date.now() }
    receiver.peerPresence = { known: false, checkedAt: Date.now() }

    ;(globalThis as any).WIKI.INSTANCE_ID = 'SENDER'
    const senderRoom = await openRoom(sender, { id: pageId, siteId: 'site-1' })
    ;(globalThis as any).WIKI.INSTANCE_ID = 'RECEIVER'
    const receiverRoom = await openRoom(receiver, { id: pageId, siteId: 'site-1' })

    assert.equal(
      receiverRoom.doc.getText('content').toString(),
      senderRoom.doc.getText('content').toString(),
      "sanity check: both instances' independent stored-page fallback must be byte-identical"
    )

    ;(globalThis as any).WIKI.INSTANCE_ID = 'SENDER'
    senderRoom.doc.transact(() => {
      senderRoom.doc.getText('content').insert(0, `BIG EDIT: ${'z'.repeat(20000)}`)
    })

    assert.ok(
      sentChunks.length >= 2 && sentChunks.every((c) => c.m !== undefined),
      'the edit must actually need chunking for this test to mean anything'
    )
    return { sender, receiver, senderRoom, receiverRoom, sentChunks }
  }

  test('a partial burst is dropped after RELAY_REASSEMBLY_TIMEOUT and never touches the doc', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { receiver, receiverRoom, sentChunks } = await setupSenderAndReceiver('page-3')
    const before = receiverRoom.doc.getText('content').toString()

    ;(globalThis as any).WIKI.INSTANCE_ID = 'RECEIVER'
    // The sender is killed right after the first chunk - the rest of the burst never arrives.
    receiver.receiveRelay(sentChunks[0])
    assert.equal(receiver.partials.size, 1)
    assert.equal(receiverRoom.doc.getText('content').toString(), before)

    t.mock.timers.tick(RELAY_REASSEMBLY_TIMEOUT)

    assert.equal(receiver.partials.size, 0, 'the abandoned partial must be cleaned up, not leaked')
    assert.equal(
      receiverRoom.doc.getText('content').toString(),
      before,
      'no corrupted partial update may ever reach the doc'
    )
  })

  test('a partial burst that resumes before the timeout still reassembles correctly', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { receiver, senderRoom, receiverRoom, sentChunks } =
      await setupSenderAndReceiver('page-3b')

    ;(globalThis as any).WIKI.INSTANCE_ID = 'RECEIVER'
    receiver.receiveRelay(sentChunks[0])
    t.mock.timers.tick(RELAY_REASSEMBLY_TIMEOUT - 1)
    assert.equal(receiver.partials.size, 1, 'must not be dropped before the timeout elapses')

    for (const chunk of sentChunks.slice(1)) {
      receiver.receiveRelay(chunk)
    }

    assert.equal(receiver.partials.size, 0)
    assert.equal(
      receiverRoom.doc.getText('content').toString(),
      senderRoom.doc.getText('content').toString()
    )
  })

  test('a complete burst reassembles and applies exactly once', async () => {
    const { receiver, senderRoom, receiverRoom, sentChunks } =
      await setupSenderAndReceiver('page-4')

    ;(globalThis as any).WIKI.INSTANCE_ID = 'RECEIVER'
    for (const chunk of sentChunks) {
      receiver.receiveRelay(chunk)
    }

    assert.equal(receiver.partials.size, 0)
    assert.equal(
      receiverRoom.doc.getText('content').toString(),
      senderRoom.doc.getText('content').toString()
    )
  })

  test('RELAY_CHUNK_SIZE still matches the module comment (base64 chars per NOTIFY payload)', () => {
    assert.equal(RELAY_CHUNK_SIZE, 5000)
  })
})

describe('(d) pageSaved() to an instance with no open room for that page', () => {
  test('relays the notice when this instance itself has no room open for the page', () => {
    const inst = makeInstance('X')
    inst.relay = mock.fn()
    const info = { versionDate: '2026-08-18T00:00:00.000Z', authorId: 'u1', authorName: 'Ada' }

    inst.pageSaved('page-5', info)

    assert.equal(inst.relay.mock.calls.length, 1)
    assert.deepEqual(inst.relay.mock.calls[0].arguments[0], {
      r: 'page-5',
      t: 'saved',
      p: JSON.stringify(info)
    })
  })

  test('writes directly into the room when this instance already has it open', () => {
    const inst = makeInstance('X')
    inst.relay = mock.fn()
    const doc = new Y.Doc()
    inst.rooms.set('page-6', { doc, pageId: 'page-6' })
    const info = { versionDate: '2026-08-18T00:00:00.000Z', authorId: 'u1', authorName: 'Ada' }

    inst.pageSaved('page-6', info)

    assert.equal(inst.relay.mock.calls.length, 0)
    assert.deepEqual(doc.getMap('meta').get('lastSave'), info)
  })

  test('a relayed "saved" notice for a page with no open room - e.g. an instance mid-restart - is a safe no-op', () => {
    const inst = makeInstance('Y')
    ;(globalThis as any).WIKI.INSTANCE_ID = 'Y'
    const info = { versionDate: '2026-08-18T00:00:00.000Z', authorId: 'u1', authorName: 'Ada' }

    assert.doesNotThrow(() => {
      inst.receiveRelay({ i: 'X', r: 'page-7', t: 'saved', p: JSON.stringify(info) })
    })
    assert.equal(
      inst.rooms.size,
      0,
      'no phantom room may be created for a notice with nothing to attach to'
    )
  })

  test('a relayed "saved" notice is applied to the doc when the room does exist', () => {
    const inst = makeInstance('Y')
    ;(globalThis as any).WIKI.INSTANCE_ID = 'Y'
    const doc = new Y.Doc()
    inst.rooms.set('page-8', { doc, pageId: 'page-8', provisional: false })
    const info = { versionDate: '2026-08-18T00:00:00.000Z', authorId: 'u1', authorName: 'Ada' }

    inst.receiveRelay({ i: 'X', r: 'page-8', t: 'saved', p: JSON.stringify(info) })

    assert.deepEqual(doc.getMap('meta').get('lastSave'), info)
  })
})
