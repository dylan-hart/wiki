import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'
import * as Y from 'yjs'
import { notifierStats } from '../helpers/pubsub.ts'
import { installCollabHarness, makeInstance, STORED_PAGE, wire } from '../test/collabHarness.ts'
import { RELAY_CHUNK_SIZE } from './collab.ts'

const harness = installCollabHarness()

const PEER_PRESENCE_TTL = 15 * 1000

function recording(id: string): { inst: any; sent: any[] } {
  const inst = makeInstance(id)
  const sent: any[] = []
  inst.publish = (envelope: any) => {
    sent.push(envelope)
  }
  ;(globalThis as any).CARDINAL.INSTANCE_ID = id
  return { inst, sent }
}

function stubPresenceQuery(rows: unknown[] | Error): {
  execute: any
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const execute = mock.fn(async () => {
    await gate
    if (rows instanceof Error) {
      throw rows
    }
    return { rows }
  })
  ;(globalThis as any).CARDINAL.db = { execute }
  return { execute, release }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

describe('single instance: no wiki_collab NOTIFY for edits or cursors', () => {
  test('opening a room and editing it publishes nothing while no peer is known', async () => {
    const { inst, sent } = recording('SOLO')
    inst.peerPresence = { known: false, checkedAt: Date.now() }

    const room = await harness.openRoom(inst, { id: 'gate-1', siteId: 'site-1' })
    room.doc.transact(() => {
      room.doc.getText('content').insert(0, 'typed on a single instance ')
    })
    room.awareness.setLocalState({ user: { name: 'Ada' } })

    assert.equal(sent.length, 0)
  })

  test('an edit after the presence cache expires is held, then dropped when the check finds no peer', async () => {
    const { inst, sent } = recording('SOLO')
    inst.peerPresence = { known: false, checkedAt: Date.now() - PEER_PRESENCE_TTL - 1 }
    const query = stubPresenceQuery([])

    inst.relay({ r: 'gate-2', t: 'update', p: 'AAAA' })
    inst.relay({ r: 'gate-2', t: 'awareness', p: 'BBBB' })
    assert.equal(inst.peerGated.length, 2)

    query.release()
    await settle()

    assert.equal(sent.length, 0)
    assert.equal(inst.peerGated.length, 0)
    assert.equal(query.execute.mock.calls.length, 1, 'concurrent held relays share one check')
    assert.equal(inst.peerPresence.known, false)

    inst.relay({ r: 'gate-2', t: 'update', p: 'CCCC' })
    assert.equal(sent.length, 0)
    assert.equal(inst.peerGated.length, 0, 'a fresh "no peers" answer drops without holding')
  })

  test('hello, state, saved and wysiwyg-* are never gated', () => {
    const { inst, sent } = recording('SOLO')
    inst.peerPresence = { known: false, checkedAt: Date.now() }

    inst.relay({ r: 'gate-3', t: 'hello' })
    inst.relay({ r: 'gate-3', t: 'state', to: 'OTHER', p: 'AAAA' })
    inst.relay({ r: 'gate-3', t: 'saved', p: '{}' })
    inst.relay({ r: 'gate-3', t: 'wysiwyg-claim' })
    inst.relay({ r: 'gate-3', t: 'wysiwyg-claimed', to: 'OTHER' })

    assert.deepEqual(
      sent.map((e) => e.t),
      ['hello', 'state', 'saved', 'wysiwyg-claim', 'wysiwyg-claimed']
    )
  })
})

describe('peers present', () => {
  test('held messages go out in order once the check finds a peer, and later ones go straight out', async () => {
    const { inst, sent } = recording('A')
    inst.peerPresence = { known: false, checkedAt: 0 }
    const query = stubPresenceQuery([{ '?column?': 1 }])

    inst.relay({ r: 'gate-4', t: 'update', p: 'one' })
    inst.relay({ r: 'gate-4', t: 'awareness', p: 'two' })
    assert.equal(sent.length, 0)

    query.release()
    await settle()
    inst.relay({ r: 'gate-4', t: 'update', p: 'three' })

    assert.deepEqual(
      sent.map((e) => e.p),
      ['one', 'two', 'three']
    )
  })

  test('a relay made while held messages wait queues behind them even if the cache turned fresh', async () => {
    const { inst, sent } = recording('A')
    inst.peerPresence = { known: false, checkedAt: 0 }
    const query = stubPresenceQuery([])

    inst.relay({ r: 'gate-5', t: 'update', p: 'first' })
    inst.receiveRelay({ i: 'B', r: 'gate-5', t: 'hello' })
    inst.relay({ r: 'gate-5', t: 'update', p: 'second' })
    assert.equal(sent.length, 0)

    query.release()
    await settle()

    assert.deepEqual(
      sent.map((e) => e.p),
      ['first', 'second']
    )
  })

  test('a query that started before a peer\'s message arrived cannot overwrite that proof with "no peers"', async () => {
    const { inst } = recording('A')
    inst.peerPresence = { known: false, checkedAt: 0 }
    const query = stubPresenceQuery([])

    const answer = inst.hasPeers()
    inst.receiveRelay({ i: 'B', r: 'gate-6', t: 'saved', p: '{}' })
    query.release()

    assert.equal(await answer, true)
    assert.equal(inst.peerPresence.known, true)
  })

  test('a failed presence check assumes company and sends what it held', async () => {
    const { inst, sent } = recording('A')
    inst.peerPresence = { known: false, checkedAt: 0 }
    const query = stubPresenceQuery(new Error('connection refused'))

    inst.relay({ r: 'gate-7', t: 'update', p: 'held' })
    query.release()
    await settle()

    assert.deepEqual(
      sent.map((e) => e.p),
      ['held']
    )
  })

  test('any message from another instance marks peers present, even one addressed elsewhere', () => {
    const { inst } = recording('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }

    inst.receiveRelay({ i: 'B', r: 'gate-8', t: 'wysiwyg-claimed', to: 'C' })

    assert.equal(inst.peerPresence.known, true)
  })

  test('its own echoed message does not count as a peer', () => {
    const { inst } = recording('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }

    inst.receiveRelay({ i: 'A', r: 'gate-9', t: 'update', p: '' })

    assert.equal(inst.peerPresence.known, false)
  })
})

describe('a second instance starting inside the presence TTL', () => {
  test('converges: edits dropped before its hello arrive in the state reply, later edits are relayed', async () => {
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)
    const page = { id: 'gate-10', siteId: 'site-1' }
    const aSent: any[] = []
    const aPublish = a.publish
    a.publish = (envelope: any) => {
      aSent.push(envelope)
      aPublish(envelope)
    }

    a.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'A'
    const roomA = await harness.openRoom(a, page)
    roomA.doc.transact(() => {
      roomA.doc.getText('content').insert(0, 'BEFORE B: ')
    })
    a.flushRelayUpdates(roomA)
    assert.equal(aSent.length, 0, 'A is alone, so nothing leaves it')

    b.peerPresence = { known: true, checkedAt: Date.now() }
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'B'
    const roomB = await harness.openRoom(b, page)
    assert.equal(roomB.doc.getText('content').toString(), roomA.doc.getText('content').toString())
    assert.equal(a.peerPresence.known, true, "B's hello told A it has company")

    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'A'
    roomA.doc.transact(() => {
      roomA.doc.getText('content').insert(0, 'AFTER B ON A: ')
    })
    a.flushRelayUpdates(roomA)
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'B'
    roomB.doc.transact(() => {
      const text = roomB.doc.getText('content')
      text.insert(text.length, ' AFTER A ON B')
    })
    b.flushRelayUpdates(roomB)

    const expected = roomA.doc.getText('content').toString()
    assert.ok(expected.startsWith('AFTER B ON A: BEFORE B: '))
    assert.ok(expected.endsWith(' AFTER A ON B'))
    assert.equal(roomB.doc.getText('content').toString(), expected)
  })
})

/**
 * `wire()` delivers synchronously, so one resync round trip completes inside the call that starts
 * it. `db.execute` answers every presence check with a peer.
 */
describe('resync after relay messages were lost', () => {
  function pair(): { a: any; b: any } {
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)
    ;(globalThis as any).CARDINAL.db = {
      execute: mock.fn(async () => ({ rows: [{ '?column?': 1 }] }))
    }
    return { a, b }
  }

  function as(id: string): void {
    ;(globalThis as any).CARDINAL.INSTANCE_ID = id
  }

  function edit(inst: any, room: any, id: string, index: number, text: string): void {
    as(id)
    room.doc.transact(() => {
      room.doc.getText('content').insert(index, text)
    })
    inst.flushRelayUpdates(room)
  }

  function assertConverged(roomA: any, roomB: any, ...fragments: string[]): void {
    const textA = roomA.doc.getText('content').toString()
    assert.equal(roomB.doc.getText('content').toString(), textA)
    for (const fragment of fragments) {
      assert.ok(textA.includes(fragment), `expected ${JSON.stringify(fragment)} in ${textA}`)
    }
    assert.equal(roomA.doc.store.pendingStructs, null, 'A still holds updates it cannot apply')
    assert.equal(roomB.doc.store.pendingStructs, null, 'B still holds updates it cannot apply')
  }

  /**
   * A room opened while its instance knows of no peer seeds itself at once, rather than waiting out
   * `PEER_STATE_TIMEOUT` for a `state` reply nobody has a room to send.
   */
  async function openAlone(inst: any, id: string, page: { id: string; siteId: string }) {
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    as(id)
    const room = await harness.openRoom(inst, page)
    inst.peerPresence = { known: true, checkedAt: Date.now() }
    return room
  }

  async function openBoth(a: any, b: any, page: { id: string; siteId: string }) {
    const roomA = await openAlone(a, 'A', page)
    b.peerPresence = { known: true, checkedAt: Date.now() }
    as('B')
    const roomB = await harness.openRoom(b, page)
    return { roomA, roomB }
  }

  test('a listener reconnect resyncs open rooms both ways, so edits dropped during the gap are not lost', async () => {
    const { a, b } = pair()
    const { roomA, roomB } = await openBoth(a, b, { id: 'resync-1', siteId: 'site-1' })

    as('A')
    a.onListenerClient(null)
    edit(a, roomA, 'A', 0, 'LOST ON A ')
    edit(b, roomB, 'B', roomB.doc.getText('content').length, ' MISSED BY A')
    assert.ok(!roomB.doc.getText('content').toString().includes('LOST ON A'))

    as('A')
    a.onListenerClient({})
    await settle()
    edit(a, roomA, 'A', 0, 'AFTER ')

    assertConverged(roomA, roomB, 'AFTER LOST ON A ', ' MISSED BY A')
  })

  test('a reconnect with no rooms open, or the first connect, sends nothing', async () => {
    const { a } = pair()
    const sent: any[] = []
    a.publish = (envelope: any) => sent.push(envelope)
    as('A')

    a.onListenerClient({})
    a.onListenerClient(null)
    a.onListenerClient({})
    await settle()

    assert.deepEqual(sent, [])
  })

  test('a stale "no peers" cache: the first message from a peer resyncs a room that seeded itself from the stored page', async () => {
    const { a, b } = pair()
    const page = { id: 'resync-2', siteId: 'site-1' }

    const roomB = await openAlone(b, 'B', page)
    edit(b, roomB, 'B', 0, 'EARLIER ON B ')

    // -> A's check ran while B's relay connection was missing from pg_stat_activity
    a.peerPresence = { known: false, checkedAt: Date.now() }
    as('A')
    const roomA = await harness.openRoom(a, page)
    edit(a, roomA, 'A', roomA.doc.getText('content').length, ' DROPPED ON A')

    edit(b, roomB, 'B', 0, 'LATER ON B ')

    assert.equal(a.peerPresence.known, true)
    assertConverged(roomA, roomB, 'LATER ON B EARLIER ON B ', ' DROPPED ON A')
  })

  test('a presence check flipping from "no peers" to "company" resyncs open rooms', async () => {
    const { a, b } = pair()
    const { roomA, roomB } = await openBoth(a, b, { id: 'resync-3', siteId: 'site-1' })

    a.peerPresence = { known: false, checkedAt: Date.now() }
    edit(a, roomA, 'A', 0, 'DROPPED ')
    assert.ok(!roomB.doc.getText('content').toString().includes('DROPPED'))

    as('A')
    await a.refreshPeers()

    assertConverged(roomA, roomB, 'DROPPED ')
  })

  test('a room still filling itself when peers appear resyncs once it is ready', async () => {
    const { a, b } = pair()
    const page = { id: 'resync-4', siteId: 'site-1' }

    const roomB = await openAlone(b, 'B', page)
    edit(b, roomB, 'B', 0, 'ON B ')

    let releasePage!: () => void
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve
    })
    harness.getPage().mock.mockImplementationOnce(async () => {
      await pageGate
      return { ...STORED_PAGE }
    })
    a.peerPresence = { known: false, checkedAt: Date.now() }
    as('A')
    const opening = harness.openRoom(a, page)
    await settle()
    assert.equal(a.rooms.get(page.id).provisional, true)

    edit(b, roomB, 'B', 0, 'WHILE A OPENS ')
    as('A')
    releasePage()
    const roomA = await opening

    assertConverged(roomA, roomB, 'WHILE A OPENS ON B ')
  })

  test('one resync per room per transition, however many peer messages follow', async () => {
    const { a, b } = pair()
    const { roomA, roomB } = await openBoth(a, b, { id: 'resync-5', siteId: 'site-1' })
    const aSent: any[] = []
    const aPublish = a.publish
    a.publish = (envelope: any) => {
      aSent.push(envelope)
      aPublish(envelope)
    }

    a.peerPresence = { known: false, checkedAt: Date.now() }
    edit(b, roomB, 'B', 0, 'one ')
    edit(b, roomB, 'B', 0, 'two ')
    edit(b, roomB, 'B', 0, 'three ')

    const broadcasts = aSent.filter((e) => e.t === 'resync' && !e.to)
    assert.equal(broadcasts.length, 1)
    assertConverged(roomA, roomB, 'three two one ')
  })

  test('a broadcast resync is answered with a diff and a resync back; an addressed one with a diff only', async () => {
    const { inst, sent } = recording('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    const room = await harness.openRoom(inst, { id: 'resync-6', siteId: 'site-1' })
    inst.peerPresence = { known: true, checkedAt: Date.now() }
    const vector = Buffer.from(Y.encodeStateVector(new Y.Doc())).toString('base64')

    inst.receiveRelay({ i: 'B', r: 'resync-6', t: 'resync', p: vector })
    assert.deepEqual(
      sent.map((e) => [e.t, e.to]),
      [
        ['diff', 'B'],
        ['resync', 'B']
      ]
    )
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Buffer.from(sent[0].p, 'base64'))
    assert.equal(replica.getText('content').toString(), room.doc.getText('content').toString())

    sent.length = 0
    inst.receiveRelay({ i: 'B', r: 'resync-6', t: 'resync', to: 'A', p: vector })
    assert.deepEqual(
      sent.map((e) => [e.t, e.to]),
      [['diff', 'B']]
    )

    sent.length = 0
    inst.receiveRelay({ i: 'B', r: 'no-such-room', t: 'resync', p: vector })
    assert.deepEqual(sent, [])
  })
})

describe('relay drops are counted in the pubsub metrics', () => {
  function relayStats() {
    return notifierStats().find((s) => s.channel === 'collaboration relay')!
  }

  test('a relay while the listener is reconnecting counts as no_client, one per NOTIFY it would have taken', () => {
    const { inst, sent } = recording('A')
    inst.peerPresence = { known: true, checkedAt: Date.now() }
    inst.listenClient = null
    const before = relayStats().droppedNoClient

    inst.relay({ r: 'metrics-1', t: 'update', p: 'AAAA' })
    inst.relay({ r: 'metrics-1', t: 'hello' })
    inst.relay({ r: 'metrics-1', t: 'update', p: 'A'.repeat(RELAY_CHUNK_SIZE * 2 + 1) })

    assert.equal(sent.length, 0)
    assert.equal(relayStats().droppedNoClient, before + 5)
  })

  test('an edit the peer gate drops counts as no_peer, whether dropped at once or after being held', async () => {
    const { inst } = recording('SOLO')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    const before = relayStats().droppedNoPeer

    inst.relay({ r: 'metrics-2', t: 'update', p: 'AAAA' })
    assert.equal(relayStats().droppedNoPeer, before + 1)

    inst.peerPresence = { known: false, checkedAt: 0 }
    const query = stubPresenceQuery([])
    inst.relay({ r: 'metrics-2', t: 'update', p: 'BBBB' })
    inst.relay({ r: 'metrics-2', t: 'awareness', p: 'CCCC' })
    assert.equal(relayStats().droppedNoPeer, before + 1, 'held, not yet dropped')
    query.release()
    await settle()

    assert.equal(relayStats().droppedNoPeer, before + 3)
  })
})
