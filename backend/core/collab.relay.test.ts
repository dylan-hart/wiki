/**
 * `core/collab.ts`'s peer handshake and relay, exercised against a genuinely departing peer rather
 * than the happy path only (task 705, feature 411) — the module's own top-of-file comment lays out
 * why the handshake and its determinism matter:
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
 * Plus the pieces those paths are built from: `buildSeed`, the relay chunk size and `reassemble()`.
 * Pure — the two "instances" are `test/collabHarness.ts#makeInstance` clones, no database and no
 * second `node backend` process. Split out of `core/collab.test.ts` (TEST-F14); see that file's
 * header for the whole map.
 */
import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'
import * as Y from 'yjs'
import collab, {
  PEER_STATE_TIMEOUT,
  RELAY_CHUNK_SIZE,
  RELAY_REASSEMBLY_TIMEOUT,
  buildSeed
} from './collab.ts'
import { installCollabHarness, makeInstance, STORED_PAGE, wire } from '../test/collabHarness.ts'

const harness = installCollabHarness()

describe('(a) peer handshake: a room seeds from a live peer, not a duplicated stored page', () => {
  test("instance B opening the page after instance A gets A's live content, and never calls getPage", async () => {
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)

    const page = { id: 'page-1', siteId: 'site-1' }

    // A opens first, with nobody else around yet: it falls back to the stored page.
    a.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'A'
    const roomA = await harness.openRoom(a, page)
    assert.equal(harness.getPage().mock.calls.length, 1)
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
    const roomB = await harness.openRoom(b, page)

    assert.equal(roomB.doc.getText('content').toString(), expectedContent)
    // Seeded from the peer, not a second call to the stored page - a second such call is exactly the
    // duplication the module's own top-of-file comment says the handshake exists to avoid.
    assert.equal(harness.getPage().mock.calls.length, 1)
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
      harness.trackRoom(room)
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
    const senderRoom = await harness.openRoom(sender, { id: pageId, siteId: 'site-1' })
    ;(globalThis as any).WIKI.INSTANCE_ID = 'RECEIVER'
    const receiverRoom = await harness.openRoom(receiver, { id: pageId, siteId: 'site-1' })

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
