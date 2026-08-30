import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { Worker } from 'node:worker_threads'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import collab, {
  MAX_CONNECTIONS_PER_ADDRESS,
  MAX_CONNECTIONS_PER_USER,
  PEER_STATE_TIMEOUT,
  RELAY_CHUNK_SIZE,
  RELAY_REASSEMBLY_TIMEOUT,
  buildSeed
} from './collab.ts'

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
    // -> Fresh per instance, not shared with the real `collab` singleton: `{ ...collab }` above only
    //    shallow-copies these, and a Map is a reference - without overriding them here every instance
    //    made by this helper would count connections into the same two Maps as each other and as
    //    whatever else in this process still holds the real `collab` export.
    connectionsByUser: new Map(),
    connectionsByAddress: new Map(),
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

/**
 * A stand-in `ws` `WebSocket` good enough for `capture()`/`join()`/`onClose()` (task 2200): it tracks
 * `readyState` and dispatches `close` to whatever `capture()` wired up, exactly the surface a real
 * socket exercises here, with none of it going over an actual network.
 */
class MockSocket {
  readyState = 1
  OPEN = 1
  listeners = new Map<string, ((...args: any[]) => void)[]>()
  on(event: string, handler: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(handler)
    this.listeners.set(event, list)
    return this
  }
  send(): void {}
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    for (const handler of this.listeners.get('close') ?? []) {
      handler(code, reason)
    }
  }
}

/** Joins a fresh mock socket to a page the same way `controllers/collab.ts` does: capture, then join. */
async function joinPage(
  inst: any,
  pageId: string,
  identity: { userId: string; address: string }
): Promise<MockSocket> {
  const conn = new MockSocket()
  const session = inst.capture(conn as any)
  await inst.join(conn as any, { id: pageId, siteId: 'site-1' }, session, identity)
  return conn
}

describe('(e) connection cap: per-user/per-address ceiling (task 2200)', () => {
  /*
    Every room these tests open holds exactly one connection, so closing that connection always empties
    and self-destroys the room via `closeRoomIfEmpty()` - which already calls `awareness.destroy()` /
    `doc.destroy()`. Closing every accepted connection at the end of each test is therefore full
    teardown on its own; nothing here needs the shared `createdRooms`/`afterEach` fixture (a)-(d) above
    use, and reusing it would risk destroying the same room's awareness/doc twice.
  */
  test('a connection past the per-user ceiling is refused and leaves no room allocated', async () => {
    const inst = makeInstance('CAP')
    ;(globalThis as any).WIKI.INSTANCE_ID = 'CAP'
    // -> No peer to ask for state: skips hasPeers()'s DB round trip (there is no WIKI.db in this
    //    test's global stub) and falls straight to the mocked getPage(), same as tests (a)-(c) above.
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    const identity = { userId: 'user-at-ceiling', address: 'addr-shared' }

    const accepted: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      const pageId = `page-cap-user-${i}`
      const conn = await joinPage(inst, pageId, identity)
      accepted.push(conn)
      assert.equal(conn.readyState, conn.OPEN, `connection ${i} under the ceiling must be accepted`)
      assert.ok(inst.rooms.has(pageId), `connection ${i} under the ceiling must get a room`)
    }
    assert.equal(inst.connectionsByUser.get(identity.userId), MAX_CONNECTIONS_PER_USER)

    const refusedPageId = 'page-cap-user-refused'
    const refused = await joinPage(inst, refusedPageId, identity)

    assert.equal(refused.readyState, 3, 'the connection past the ceiling must be closed')
    assert.equal(
      inst.rooms.has(refusedPageId),
      false,
      'a refused connection must never allocate a room for the page it asked for'
    )
    assert.equal(
      inst.connectionsByUser.get(identity.userId),
      MAX_CONNECTIONS_PER_USER,
      'a refusal must not itself count against the ceiling'
    )

    for (const conn of accepted) {
      conn.close()
    }
  })

  test('a connection past the per-address ceiling is refused, independent of user id', async () => {
    const inst = makeInstance('CAP')
    ;(globalThis as any).WIKI.INSTANCE_ID = 'CAP'
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    const address = 'addr-at-ceiling'

    const accepted: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_ADDRESS; i++) {
      const pageId = `page-cap-addr-${i}`
      // -> A different user id each time, so only the address ceiling - not the per-user one - is
      //    what this test is exercising.
      const conn = await joinPage(inst, pageId, { userId: `user-${i}`, address })
      accepted.push(conn)
      assert.equal(conn.readyState, conn.OPEN)
    }

    const refused = await joinPage(inst, 'page-cap-addr-refused', {
      userId: 'user-one-more',
      address
    })
    assert.equal(refused.readyState, 3)
    assert.equal(inst.rooms.has('page-cap-addr-refused'), false)

    for (const conn of accepted) {
      conn.close()
    }
  })

  test('closing a socket releases its slot, letting a further connection through', async () => {
    const inst = makeInstance('CAP')
    ;(globalThis as any).WIKI.INSTANCE_ID = 'CAP'
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    const identity = { userId: 'user-releases', address: 'addr-releases' }

    const conns: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      conns.push(await joinPage(inst, `page-cap-release-${i}`, identity))
    }
    assert.equal(inst.connectionsByUser.get(identity.userId), MAX_CONNECTIONS_PER_USER)

    // -> One tab closes normally - a real `close()` and a real `terminate()` both reach `onClose()`
    //    the same way (see the file's "Connection cap" doc comment), so exercising the ordinary close
    //    here covers both.
    conns[0].close()
    assert.equal(
      inst.connectionsByUser.get(identity.userId),
      MAX_CONNECTIONS_PER_USER - 1,
      'closing a socket must release exactly the one slot it held'
    )

    const reconnected = await joinPage(inst, 'page-cap-release-reconnect', identity)

    assert.equal(
      reconnected.readyState,
      reconnected.OPEN,
      'a legitimate reconnect must not find the ceiling still exhausted'
    )
    assert.equal(inst.connectionsByUser.get(identity.userId), MAX_CONNECTIONS_PER_USER)

    reconnected.close()
    for (const conn of conns.slice(1)) {
      conn.close()
    }
  })
})

describe('buildSeed', () => {
  const page = {
    content: '# Hello\n\nSome text.',
    title: 'Hello',
    description: 'A page',
    icon: 'mdi:home'
  }

  test('is deterministic: the same page always produces byte-identical bytes', () => {
    const a = buildSeed(page)
    const b = buildSeed(page)
    assert.deepEqual(a, b)
  })

  test('different content produces different bytes', () => {
    const a = buildSeed(page)
    const b = buildSeed({ ...page, content: 'different' })
    assert.notDeepEqual(a, b)
  })

  test('missing fields fall back to empty strings rather than throwing', () => {
    assert.doesNotThrow(() => buildSeed({}))
  })

  test('two instances cold-starting the same page converge to one copy of the text, not two', () => {
    // -> This is the guarantee the whole client-id-0 trick exists for: two instances that both give up
    //    waiting for a peer and seed independently must merge as if only one of them had seeded at all.
    const seedA = buildSeed(page)
    const seedB = buildSeed(page)

    const merged = new Y.Doc()
    Y.applyUpdate(merged, seedA)
    Y.applyUpdate(merged, seedB)

    const single = new Y.Doc()
    Y.applyUpdate(single, seedA)

    assert.equal(merged.getText('content').toString(), page.content)
    assert.equal(merged.getText('content').toString(), single.getText('content').toString())
    // -> Byte-identical states merge to a document of the identical size, not a doubled one.
    assert.deepEqual(Y.encodeStateAsUpdate(merged), Y.encodeStateAsUpdate(single))
  })
})

describe('RELAY_CHUNK_SIZE', () => {
  test('the worst-case relay envelope stays under the 8000-byte NOTIFY cap (task 478)', () => {
    // -> Every optional field populated, each at its real worst-case length: `i`/`to` are a 10-char
    //    `nanoid` (see `WIKI.INSTANCE_ID` in `index.ts`), `r` a full 36-char page uuid, `t` the longest
    //    of the five message types, and `m`/`c`/`n` generously long numbers — this is what `relay()`
    //    actually sends for a chunk of a large `update`/`state` message, not a hypothetical worse case.
    const worstCase = {
      i: 'V1StGXR8_Z',
      r: '550e8400-e29b-41d4-a716-446655440000',
      t: 'awareness',
      to: 'V1StGXR8_Z',
      m: '999999999',
      c: 999999,
      n: 999999,
      p: 'A'.repeat(RELAY_CHUNK_SIZE)
    }
    const bytes = Buffer.byteLength(JSON.stringify(worstCase))
    assert.ok(
      bytes <= 8000,
      `worst-case envelope is ${bytes} bytes, over postgres's 8000-byte NOTIFY cap`
    )
  })
})

describe('reassemble()', () => {
  function fresh(): typeof collab {
    // -> A shallow copy with its own `partials` map, so each test's chunk bookkeeping can't leak into
    //    another's — `reassemble` only ever touches `this.partials`, so this is a real isolated instance
    //    of just the piece under test, not a fake of it.
    return { ...collab, partials: new Map() }
  }

  test('assembles chunks that arrive in order', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 3,
      p
    })
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    assert.equal(c.reassemble(envelope(1, 'bb')), null)
    assert.equal(c.reassemble(envelope(2, 'cc')), 'aabbcc')
  })

  test('assembles chunks that arrive out of order', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 3,
      p
    })
    assert.equal(c.reassemble(envelope(2, 'cc')), null)
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    assert.equal(c.reassemble(envelope(1, 'bb')), 'aabbcc')
  })

  test('a duplicate chunk index is ignored rather than double-counted', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 2,
      p
    })
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    // -> Resent chunk 0: must not count down `remaining` a second time, or a real chunk 1 arriving
    //    later would leave `remaining` stuck above zero and the message never assembles.
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    assert.equal(c.reassemble(envelope(1, 'bb')), 'aabb')
  })

  test('different senders or message ids never share a partial', () => {
    const c = fresh()
    assert.equal(
      c.reassemble({ i: 'peerA', r: 'p', t: 'update', m: 'm1', c: 0, n: 2, p: 'A0' }),
      null
    )
    assert.equal(
      c.reassemble({ i: 'peerB', r: 'p', t: 'update', m: 'm1', c: 0, n: 2, p: 'B0' }),
      null
    )
    assert.equal(
      c.reassemble({ i: 'peerA', r: 'p', t: 'update', m: 'm1', c: 1, n: 2, p: 'A1' }),
      'A0A1'
    )
    assert.equal(
      c.reassemble({ i: 'peerB', r: 'p', t: 'update', m: 'm1', c: 1, n: 2, p: 'B1' }),
      'B0B1'
    )
  })

  test('a complete message removes its own partial, freeing the key for reuse', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 1,
      p
    })
    assert.equal(c.reassemble(envelope(0, 'only')), 'only')
    assert.equal(c.partials.size, 0)
  })

  test('an incomplete message expires after RELAY_REASSEMBLY_TIMEOUT rather than leaking', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const c = fresh()
    // -> Stands in for an instance that goes down mid-relay: one chunk of two ever arrives.
    assert.equal(
      c.reassemble({ i: 'peer', r: 'page1', t: 'update', m: 'msg1', c: 0, n: 2, p: 'aa' }),
      null
    )
    assert.equal(c.partials.size, 1)

    t.mock.timers.tick(RELAY_REASSEMBLY_TIMEOUT - 1)
    assert.equal(c.partials.size, 1, 'not cleaned up before its deadline')

    t.mock.timers.tick(1)
    assert.equal(c.partials.size, 0, 'cleaned up once RELAY_REASSEMBLY_TIMEOUT elapses')
  })
})

// ----------------------------------------
// Multi-instance: two real `collab.ts`, two real WIKI globals, one real database
// ----------------------------------------

interface WorkerHandle {
  worker: Worker
  call(cmd: string, args?: Record<string, unknown>): Promise<any>
  close(): Promise<void>
}

function startInstance(
  connectionString: string,
  schema: string,
  instanceId: string,
  siteId: string
): Promise<WorkerHandle> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../test/collabWorker.ts', import.meta.url), {
      workerData: { connectionString, schema, instanceId, siteId }
    })
    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

    worker.on(
      'message',
      (msg: { id: number; ok: boolean; error?: string; [key: string]: unknown }) => {
        if (msg.id === 0) {
          if (msg.ok) {
            const call = (cmd: string, args: Record<string, unknown> = {}): Promise<any> =>
              new Promise((res, rej) => {
                const id = nextId++
                pending.set(id, { resolve: res, reject: rej })
                worker.postMessage({ id, cmd, ...args })
              })
            resolve({
              worker,
              call,
              async close() {
                await call('shutdown').catch(() => {})
                await worker.terminate()
              }
            })
          } else {
            reject(new Error(msg.error))
          }
          return
        }
        const waiter = pending.get(msg.id)
        if (!waiter) {
          return
        }
        pending.delete(msg.id)
        if (msg.ok) {
          waiter.resolve(msg)
        } else {
          waiter.reject(new Error(msg.error))
        }
      }
    )
    worker.on('error', reject)
  })
}

/**
 * Bounded poll replacing a fixed `setTimeout` drain: re-runs `poll()` until `isDone()` accepts its
 * result or `timeoutMs` elapses, sleeping `intervalMs` between attempts. The success path returns as
 * soon as the awaited state actually settles rather than waiting out a worst-case guess every time,
 * and the failure path still returns the last-observed value (not throw) so the caller's own assert
 * produces the real mismatch rather than a generic timeout error — matching the shape
 * `e2e/tests/scheduler.spec.js`'s `expect(...).toPass({ timeout })` uses for the same reason.
 */
async function pollUntil<T>(
  poll: () => Promise<T>,
  isDone: (value: T) => boolean,
  { timeoutMs = 10000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await poll()
    if (isDone(value) || Date.now() >= deadline) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

describe('collaborative editing across instances (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let connectionString: string
  let a: WorkerHandle
  let b: WorkerHandle

  before(async () => {
    fixtures = await setupTestDb()
    connectionString = process.env.DATABASE_URL!
    ;[a, b] = await Promise.all([
      startInstance(connectionString, fixtures.schema, 'instance-a', fixtures.siteId),
      startInstance(connectionString, fixtures.schema, 'instance-b', fixtures.siteId)
    ])
  })

  after(async () => {
    await Promise.all([a?.close(), b?.close()])
    await teardownTestDb()
  })

  test('two instances cold-starting the same room in the same instant converge byte-identically', async () => {
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/cold-start',
        title: 'Cold Start',
        editor: 'markdown',
        content: 'Original content.'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    // -> Fired together, not awaited one at a time: this is what forces both instances to ask the
    //    cluster for the same page's room before either one has it, which is the exact race
    //    `ensureRoom`/`initRoom`'s doc comments describe.
    const [resA, resB] = await Promise.all([
      a.call('ensureRoom', { pageId: page.id }),
      b.call('ensureRoom', { pageId: page.id })
    ])

    assert.equal(resA.text, 'Original content.')
    assert.equal(resB.text, 'Original content.')
    // -> Not just equal text: byte-identical Yjs state, proving neither instance's ops got concatenated
    //    with the other's — the failure mode a non-deterministic seed would produce.
    assert.equal(resA.state, resB.state)
  })

  test('a peerState handshake that lands after PEER_STATE_TIMEOUT still converges the room', async () => {
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/late-handshake',
        title: 'Late Handshake',
        editor: 'markdown',
        content: 'Stored text.'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    // -> B opens the room first and picks up an edit nobody told A about yet — standing in for a user
    //    already mid-edit on B when A's editor opens the same page.
    await b.call('ensureRoom', { pageId: page.id })
    await b.call('localEdit', { pageId: page.id, text: ' Extra from B.' })

    // -> Give B's live `update` broadcast time to reach A and be dropped: A has no room for this page
    //    yet, so `receiveRelay`'s `update` case is a no-op. Without this wait, A calling `ensureRoom` a
    //    few milliseconds later can accidentally register its room while that broadcast is still in
    //    flight and pick the edit up that way — a real but incidental path that would mask the one this
    //    test exists to exercise: the peerState handshake itself catching a late-arriving peer.
    await new Promise((resolve) => setTimeout(resolve, 200))

    // -> Realistic network latency: B's reply to A's `hello` is delayed past PEER_STATE_TIMEOUT, so A's
    //    peerState() times out and falls back to buildSeed before B's answer ever lands.
    await b.call('delayStateReplies', { ms: PEER_STATE_TIMEOUT + 200 })

    const resA = await a.call('ensureRoom', { pageId: page.id })
    // -> Falls back to the stored page — the edit B made is not in it, because the handshake timed out.
    assert.equal(resA.text, 'Stored text.')

    // -> B's delayed answer is still on its way; once it lands, A must end up with B's edit too rather
    //    than permanently missing it because nobody was still waiting for the reply.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const caughtUp = await a.call('roomText', { pageId: page.id })
    assert.equal(caughtUp.text, 'Stored text. Extra from B.')
  })

  test('a partial relay message from an instance that goes quiet mid-relay still expires, not leaks', async () => {
    // -> `reassemble()` accounts for chunks purely by envelope key — no room needs to exist for this
    //    page id, which is the point: B "goes down" mid multi-chunk relay, publishing only 2 of the 3
    //    chunks a real update would have split into, and A must not hold the remainder forever.
    const pageId = 'relay-only-no-room'
    await b.call('publishIncomplete', {
      pageId,
      totalLength: 12000,
      chunkSize: 5000,
      skipChunk: 2,
      messageId: 'msg-crash'
    })

    // -> Poll for the NOTIFY to land instead of a fixed wait, then confirm A actually captured the
    //    partial chunks.
    const midway = await pollUntil(
      () => a.call('partialsSize'),
      (result) => result.size === 1
    )
    assert.equal(midway.size, 1, 'the two delivered chunks are held, waiting for the third')

    await new Promise((resolve) => setTimeout(resolve, RELAY_REASSEMBLY_TIMEOUT))
    const after = await a.call('partialsSize')
    assert.equal(after.size, 0, 'the abandoned partial was dropped rather than held forever')
  })

  test('concurrent bursty edits from several sessions across two instances converge with no dropped chunks or leaked partials', async () => {
    // -> A scaled-down, CI-fast version of task 478's throwaway load test
    //    (`scripts/collab-load-test.ts`, run manually at multi-megabyte scale): the same claim — several
    //    simulated sessions, spread across real separate instances, firing concurrent bursty edits
    //    (some large enough on their own to need several `RELAY_CHUNK_SIZE` chunks) — at a size this
    //    suite can afford to run on every change.
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/concurrent-load',
        title: 'Concurrent Load',
        editor: 'markdown',
        content: 'Seed. '
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    await a.call('ensureRoom', { pageId: page.id })
    await b.call('ensureRoom', { pageId: page.id })

    const sessions = [
      { instance: a, id: 'sess-a0' },
      { instance: a, id: 'sess-a1' },
      { instance: b, id: 'sess-b0' },
      { instance: b, id: 'sess-b1' }
    ]
    for (const { instance, id } of sessions) {
      await instance.call('openSession', { pageId: page.id, sessionId: id })
    }

    // -> Three rounds, every session editing at once each round; every third session's edit is well
    //    over RELAY_CHUNK_SIZE base64 characters on its own, forcing genuine multi-chunk relay traffic
    //    to interleave with the smaller ones rather than testing chunking and concurrency separately.
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        sessions.map(({ instance, id }, index) => {
          const big = index % 3 === 0
          const text = big ? 'x'.repeat(15000) : `edit-${round}-${index} `
          return instance.call('sessionEdit', { sessionId: id, text, position: 0 })
        })
      )
    }

    // -> Poll for convergence instead of a fixed drain: the success path returns as soon as the relay
    //    has actually settled, and a genuine drop or misorder still fails after a generous deadline
    //    rather than masquerading as a timing shortfall.
    const texts = await pollUntil(
      async () => {
        const collected = new Set<string>()
        for (const { instance, id } of sessions) {
          const { text } = await instance.call('sessionText', { sessionId: id })
          collected.add(text)
        }
        const roomA = await a.call('roomText', { pageId: page.id })
        const roomB = await b.call('roomText', { pageId: page.id })
        collected.add(roomA.text)
        collected.add(roomB.text)
        return collected
      },
      (collected) => collected.size === 1
    )

    assert.equal(
      texts.size,
      1,
      'every session and every room must converge to byte-identical text — more than one distinct ' +
        'text means a chunk was dropped or misordered'
    )

    const partialsA = await a.call('partialsSize')
    const partialsB = await b.call('partialsSize')
    assert.equal(partialsA.size, 0, 'instance a must not be left holding an abandoned partial')
    assert.equal(partialsB.size, 0, 'instance b must not be left holding an abandoned partial')

    for (const { instance, id } of sessions) {
      await instance.call('closeSession', { sessionId: id })
    }
  })

  test('a session that disconnects mid-edit, keeps typing offline, and reconnects merges cleanly (task 482)', async () => {
    // -> The literal scenario the doc comment at the top of this file promises and task 482 exists to
    //    verify end to end: two browser tabs on the same page (here, two sessions on the same instance
    //    -- the room stays open throughout because B never leaves), one goes offline, keeps being typed
    //    into locally, and comes back. No text may be duplicated or dropped in either direction.
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/reconnect-offline-edits',
        title: 'Reconnect Offline Edits',
        editor: 'markdown',
        content: 'Seed. '
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    await a.call('ensureRoom', { pageId: page.id })
    await a.call('openSession', { pageId: page.id, sessionId: 'sess-a' })
    await a.call('openSession', { pageId: page.id, sessionId: 'sess-b' })

    // -> Both editing normally, before anyone goes offline.
    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'A1 ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B1 ' })
    // -> Poll for both edits to reach the room instead of a fixed wait.
    await pollUntil(
      () => a.call('roomText', { pageId: page.id }),
      (result) => result.text.includes('A1') && result.text.includes('B1')
    )

    // -> A's tab loses connectivity. The room is not torn down: B is still in it.
    await a.call('disconnectSession', { sessionId: 'sess-a' })
    const stillOpen = await a.call('roomText', { pageId: page.id })
    assert.equal(stillOpen.exists, true, 'the room must survive one of two sessions dropping')

    // -> A keeps typing locally -- past what `SYNC_TIMEOUT` would have given up waiting for -- and B
    //    keeps typing too, unaware A is gone.
    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'OFFLINE-FROM-A ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B2-WHILE-A-OFFLINE ' })

    // -> Poll for B's edit to reach the room instead of a fixed wait, then confirm the disconnect was
    //    real, not a no-op: the room got B's edit but never saw A's, and A's own replica never heard
    //    about B's either.
    const whileOffline = await pollUntil(
      () => a.call('roomText', { pageId: page.id }),
      (result) => result.text.includes('B2-WHILE-A-OFFLINE')
    )
    assert.ok(
      whileOffline.text.includes('B2-WHILE-A-OFFLINE'),
      "B's edit while A was away reached the room"
    )
    assert.ok(
      !whileOffline.text.includes('OFFLINE-FROM-A'),
      "A's offline edit must not reach the room until it reconnects"
    )
    const aWhileOffline = await a.call('sessionText', { sessionId: 'sess-a' })
    assert.ok(
      !aWhileOffline.text.includes('B2-WHILE-A-OFFLINE'),
      "A's own replica must not see B's edit while genuinely disconnected"
    )

    // -> Connectivity restored. The reconnect must both push A's offline edits out and pull down what
    //    the room gained while A was away. Poll for convergence instead of a fixed wait.
    await a.call('reconnectSession', { pageId: page.id, sessionId: 'sess-a' })

    const { finalA, finalB, finalRoom } = await pollUntil(
      async () => ({
        finalA: await a.call('sessionText', { sessionId: 'sess-a' }),
        finalB: await a.call('sessionText', { sessionId: 'sess-b' }),
        finalRoom: await a.call('roomText', { pageId: page.id })
      }),
      (result) =>
        result.finalA.text === result.finalRoom.text && result.finalB.text === result.finalRoom.text
    )

    assert.equal(
      finalA.text,
      finalRoom.text,
      "A's replica must converge with the room after reconnecting"
    )
    assert.equal(finalB.text, finalRoom.text, "B's replica must still agree with the room")

    for (const fragment of ['A1', 'B1', 'OFFLINE-FROM-A', 'B2-WHILE-A-OFFLINE']) {
      const occurrences = finalRoom.text.split(fragment).length - 1
      assert.equal(
        occurrences,
        1,
        `"${fragment}" must appear exactly once, not ${occurrences} times`
      )
    }

    await a.call('closeSession', { sessionId: 'sess-a' })
    await a.call('closeSession', { sessionId: 'sess-b' })
  })
})
