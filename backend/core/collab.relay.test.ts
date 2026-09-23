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

    a.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'A'
    const roomA = await harness.openRoom(a, page)
    assert.equal(harness.getPage().mock.calls.length, 1)
    assert.equal(roomA.doc.getText('content').toString(), STORED_PAGE.content)

    roomA.doc.transact(() => {
      roomA.doc.getText('content').insert(0, 'LIVE EDIT ON A: ')
    })
    const expectedContent = roomA.doc.getText('content').toString()
    assert.notEqual(expectedContent, STORED_PAGE.content)

    b.peerPresence = { known: true, checkedAt: Date.now() }
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'B'
    const roomB = await harness.openRoom(b, page)

    assert.equal(roomB.doc.getText('content').toString(), expectedContent)
    // Still A's single call: B seeded from the peer, not the stored page.
    assert.equal(harness.getPage().mock.calls.length, 1)
  })
})

describe('(b) peer handshake timeout when the peer instance is gone before it answers', () => {
  test('peerState resolves null after PEER_STATE_TIMEOUT and initRoom falls back to the stored page', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const b = makeInstance('B')
    // The 'hello' goes nowhere: a peer killed before replying looks the same as nobody answering.
    b.publish = () => {}
    b.peerPresence = { known: true, checkedAt: Date.now() }
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'B'

    const roomPromise = b.ensureRoom({ id: 'page-2', siteId: 'site-1' }).then((room: any) => {
      harness.trackRoom(room)
      return room
    })

    // Let the microtask chain (hasPeers() resolving, then peerState() registering its setTimeout)
    // run before advancing the fake clock.
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
   * Both instances fall back to the stored page independently; `buildSeed`'s determinism makes
   * their Yjs state byte-identical, which is what lets the sender's diff apply on the receiver.
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

    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'SENDER'
    const senderRoom = await harness.openRoom(sender, { id: pageId, siteId: 'site-1' })
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'RECEIVER'
    const receiverRoom = await harness.openRoom(receiver, { id: pageId, siteId: 'site-1' })

    assert.equal(
      receiverRoom.doc.getText('content').toString(),
      senderRoom.doc.getText('content').toString(),
      "sanity check: both instances' independent stored-page fallback must be byte-identical"
    )

    sender.peerPresence = { known: true, checkedAt: Date.now() }
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'SENDER'
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

    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'RECEIVER'
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

    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'RECEIVER'
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

    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'RECEIVER'
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
    inst.rooms.set('page-6', {
      doc,
      pageId: 'page-6',
      draftPersist: { timer: null, pendingSince: null }
    })
    const info = { versionDate: '2026-08-18T00:00:00.000Z', authorId: 'u1', authorName: 'Ada' }

    inst.pageSaved('page-6', info)

    assert.equal(inst.relay.mock.calls.length, 0)
    assert.deepEqual(doc.getMap('meta').get('lastSave'), info)
  })

  test('a relayed "saved" notice for a page with no open room - e.g. an instance mid-restart - is a safe no-op', () => {
    const inst = makeInstance('Y')
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'Y'
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
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'Y'
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
    const seedA = buildSeed(page)
    const seedB = buildSeed(page)

    const merged = new Y.Doc()
    Y.applyUpdate(merged, seedA)
    Y.applyUpdate(merged, seedB)

    const single = new Y.Doc()
    Y.applyUpdate(single, seedA)

    assert.equal(merged.getText('content').toString(), page.content)
    assert.equal(merged.getText('content').toString(), single.getText('content').toString())
    assert.deepEqual(Y.encodeStateAsUpdate(merged), Y.encodeStateAsUpdate(single))
  })
})

describe('RELAY_CHUNK_SIZE', () => {
  test('the worst-case relay envelope stays under the 8000-byte NOTIFY cap (task 478)', () => {
    // -> Every optional field populated at its real worst-case length: `i`/`to` a 10-char hex
    //    `CARDINAL.INSTANCE_ID`, `r` a 36-char page uuid, `m`/`c`/`n` generously long numbers.
    const worstCase = {
      i: 'V1StGXR8_Z',
      r: '550e8400-e29b-41d4-a716-446655440000',
      t: 'wysiwyg-claimed',
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
    // -> Its own `partials` map, so tests cannot leak chunks into each other; `reassemble` touches
    //    nothing else on `this`.
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
    // -> Resent chunk 0: counting it twice would zero `remaining` and assemble without chunk 1
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
