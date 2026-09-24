import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import collab, { PEER_STATE_TIMEOUT } from './collab.ts'
import { installCollabHarness, makeInstance, wire } from '../test/collabHarness.ts'

const harness = installCollabHarness()

describe('claimWysiwygSeed: no room open for the page', () => {
  test('resolves false immediately, with no relay traffic', async () => {
    const relayCalls: any[] = []
    const inst = makeInstance('A')
    inst.relay = (envelope: any) => relayCalls.push(envelope)

    const granted = await inst.claimWysiwygSeed('page-none')

    assert.equal(granted, false)
    assert.deepEqual(relayCalls, [])
  })
})

describe('claimWysiwygSeed: single instance (no peers)', () => {
  test('the first caller is granted, with no relay traffic at all', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    const relayCalls: any[] = []
    inst.relay = (envelope: any) => relayCalls.push(envelope)
    const room = await harness.openRoom(inst, { id: 'page-1', siteId: 'site-1' })

    const granted = await inst.claimWysiwygSeed('page-1')

    assert.equal(granted, true)
    assert.equal(room.wysiwygSeeded, true)
    assert.deepEqual(relayCalls, [])
  })

  test('a second caller on the same instance is denied, synchronously, before either resolves', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    await harness.openRoom(inst, { id: 'page-2', siteId: 'site-1' })

    const [first, second] = await Promise.all([
      inst.claimWysiwygSeed('page-2'),
      inst.claimWysiwygSeed('page-2')
    ])

    assert.deepEqual([first, second].sort(), [false, true])
  })

  test('a third caller after the first has resolved is also denied', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    await harness.openRoom(inst, { id: 'page-3', siteId: 'site-1' })

    assert.equal(await inst.claimWysiwygSeed('page-3'), true)
    assert.equal(await inst.claimWysiwygSeed('page-3'), false)
  })
})

describe('claimWysiwygSeed: cross-instance, a peer already holds the claim', () => {
  test("instance B's claim is denied when A already granted its own", async () => {
    const a = makeInstance('A')
    const b = makeInstance('B')
    wire(a, b)
    a.peerPresence = { known: false, checkedAt: Date.now() }
    b.peerPresence = { known: true, checkedAt: Date.now() }

    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'A'
    await harness.openRoom(a, { id: 'page-4', siteId: 'site-1' })
    assert.equal(await a.claimWysiwygSeed('page-4'), true)

    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'B'
    await harness.openRoom(b, { id: 'page-4', siteId: 'site-1' })
    const granted = await b.claimWysiwygSeed('page-4')

    assert.equal(granted, false)
    assert.equal(b.rooms.get('page-4').wysiwygSeeded, true)
  })
})

describe('claimWysiwygSeed: cross-instance, nobody answers in time', () => {
  test('falls back to granting locally after PEER_STATE_TIMEOUT, matching peerState()', async (t) => {
    const b = makeInstance('B')
    b.publish = () => {}
    // -> No peers while the room is created, so `ensureRoom()` seeds immediately rather than
    //    waiting out a real, not yet mocked, peerState() timeout of its own.
    b.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'B'
    await harness.openRoom(b, { id: 'page-5', siteId: 'site-1' })

    // -> Only now do timers get faked and peers "appear"; with `publish` stubbed, the ask goes
    //    out into the void.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    b.peerPresence = { known: true, checkedAt: Date.now() }

    const claimPromise = b.claimWysiwygSeed('page-5')

    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }
    assert.equal(b.awaitingWysiwygClaim.size, 1, 'should be waiting on a reply by now')

    t.mock.timers.tick(PEER_STATE_TIMEOUT)

    assert.equal(await claimPromise, true)
    assert.equal(b.awaitingWysiwygClaim.size, 0, 'the timed-out wait must not linger')
  })
})

/**
 * Already aware of its peer, so the message under test is not also this instance's first sign of
 * company -- which would resync every open room, and these stub rooms have no document to resync.
 */
function instanceWithPeer(id: string): any {
  const inst = makeInstance(id)
  inst.peerPresence = { known: true, checkedAt: Date.now() }
  return inst
}

describe('receiveRelay: wysiwyg-claim', () => {
  test('replies wysiwyg-claimed only when this instance already holds the claim', () => {
    const inst = instanceWithPeer('X')
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'X'
    const relayCalls: any[] = []
    inst.relay = (envelope: any) => relayCalls.push(envelope)
    inst.rooms.set('page-6', { pageId: 'page-6', wysiwygSeeded: true })

    inst.receiveRelay({ i: 'Y', r: 'page-6', t: 'wysiwyg-claim' })

    assert.deepEqual(relayCalls, [{ r: 'page-6', t: 'wysiwyg-claimed', to: 'Y' }])
  })

  test('answers with silence when this instance has no claim on the room (or no room at all)', () => {
    const inst = instanceWithPeer('X')
    ;(globalThis as any).CARDINAL.INSTANCE_ID = 'X'
    const relayCalls: any[] = []
    inst.relay = (envelope: any) => relayCalls.push(envelope)
    inst.rooms.set('page-7', { pageId: 'page-7', wysiwygSeeded: false })

    inst.receiveRelay({ i: 'Y', r: 'page-7', t: 'wysiwyg-claim' })
    inst.receiveRelay({ i: 'Y', r: 'page-does-not-exist', t: 'wysiwyg-claim' })

    assert.deepEqual(relayCalls, [])
  })
})

describe('receiveRelay: wysiwyg-claimed', () => {
  test('marks the room seeded and resolves a pending local wait', () => {
    const inst = instanceWithPeer('X')
    inst.rooms.set('page-8', { pageId: 'page-8', wysiwygSeeded: false })
    let resolved = false
    // -> As in `claimWysiwygSeed`: the waiter removes itself, `receiveRelay` only invokes it.
    inst.awaitingWysiwygClaim.set('page-8', () => {
      resolved = true
      inst.awaitingWysiwygClaim.delete('page-8')
    })

    inst.receiveRelay({ i: 'Y', r: 'page-8', t: 'wysiwyg-claimed' })

    assert.equal(inst.rooms.get('page-8').wysiwygSeeded, true)
    assert.equal(resolved, true)
    assert.equal(inst.awaitingWysiwygClaim.has('page-8'), false)
  })

  test('a proactive grant notice for a room with no open room here is a safe no-op', () => {
    const inst = makeInstance('X')

    assert.doesNotThrow(() => {
      inst.receiveRelay({ i: 'Y', r: 'page-does-not-exist', t: 'wysiwyg-claimed' })
    })
    assert.equal(inst.rooms.size, 0)
  })
})

describe('CollabRoom.wysiwygSeeded starts false on every freshly created room', () => {
  test('ensureRoom() initializes it alongside provisional/lastAuthorName', async () => {
    const inst = makeInstance('A')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    const room = await harness.openRoom(inst, { id: 'page-9', siteId: 'site-1' })

    assert.equal(room.wysiwygSeeded, false)
  })
})

describe('the real collab singleton', () => {
  test('exposes claimWysiwygSeed', () => {
    assert.equal(typeof collab.claimWysiwygSeed, 'function')
  })
})
