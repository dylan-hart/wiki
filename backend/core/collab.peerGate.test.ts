import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'
import { installCollabHarness, makeInstance, wire } from '../test/collabHarness.ts'

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
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'B'
    roomB.doc.transact(() => {
      const text = roomB.doc.getText('content')
      text.insert(text.length, ' AFTER A ON B')
    })

    const expected = roomA.doc.getText('content').toString()
    assert.ok(expected.startsWith('AFTER B ON A: BEFORE B: '))
    assert.ok(expected.endsWith(' AFTER A ON B'))
    assert.equal(roomB.doc.getText('content').toString(), expected)
  })
})
