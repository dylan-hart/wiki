/**
 * `core/collab.ts`'s admission control: what `capture()` buffers before a connection is authorized,
 * what `refuse()` does once a cap trips, and the per-user/per-address connection ceilings. Pure — no
 * database.
 *
 * Split out of `core/collab.test.ts` (TEST-F14); see that file's header for the whole map.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, mock, test } from 'node:test'
import collab, {
  MAX_CONNECTIONS_PER_ADDRESS,
  MAX_CONNECTIONS_PER_USER,
  MAX_PENDING_BYTES,
  MAX_PENDING_FRAMES,
  REFUSAL_GRACE_PERIOD
} from './collab.ts'
import { FakeSocket, installCollabHarness, makeInstance } from '../test/collabHarness.ts'

installCollabHarness()

/**
 * `capture()`'s pending-frame cap (task 2196, from the 2026-08-24 security audit,
 * `docs/audit-2026-08-24/security/09-dos-resource.md` §3): before a socket has a room to hand its
 * frames to, every message it sends is copied into `session.pending`. That listener is live the
 * instant the socket opens — well before authentication or the site's feature flag is checked — so an
 * unauthenticated caller that just keeps writing must not be able to grow that array without bound.
 * `capture` is exercised directly here, against a minimal stand-in for a `ws` `WebSocket` (an
 * `EventEmitter` plus a mocked `terminate()`), rather than through the real socket lifecycle in
 * `controllers/collab.ts` — nothing under test here needs an actual network connection.
 */
describe('collab.capture: pending-frame cap', () => {
  /** The minimal shape `capture()` actually uses: `.on()` (via EventEmitter) and `.terminate()`. */
  function makeConn() {
    const conn = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof mock.fn> }
    conn.terminate = mock.fn()
    return conn
  }

  function send(conn: EventEmitter, byteLength: number): void {
    conn.emit('message', Buffer.alloc(byteLength))
  }

  test('buffers frames as long as both the entry-count and byte caps are unexceeded', () => {
    const conn = makeConn()
    const session = collab.capture(conn as any)

    send(conn, 8)
    send(conn, 8)

    assert.equal(session.pending.length, 2)
    assert.equal(session.pendingBytes, 16)
    assert.equal(conn.terminate.mock.callCount(), 0)
  })

  test('terminates the connection once the entry-count cap is exceeded, without buffering the frame that tipped it over', () => {
    const conn = makeConn()
    const session = collab.capture(conn as any)

    for (let i = 0; i < MAX_PENDING_FRAMES; i++) {
      send(conn, 1)
    }
    assert.equal(session.pending.length, MAX_PENDING_FRAMES)
    assert.equal(conn.terminate.mock.callCount(), 0)

    send(conn, 1)

    assert.equal(session.pending.length, MAX_PENDING_FRAMES)
    assert.equal(conn.terminate.mock.callCount(), 1)
  })

  test('terminates the connection once the byte cap is exceeded, without buffering the frame that tipped it over', () => {
    const conn = makeConn()
    const session = collab.capture(conn as any)

    send(conn, MAX_PENDING_BYTES)
    assert.equal(session.pendingBytes, MAX_PENDING_BYTES)
    assert.equal(conn.terminate.mock.callCount(), 0)

    send(conn, 1)

    assert.equal(session.pendingBytes, MAX_PENDING_BYTES)
    assert.equal(conn.terminate.mock.callCount(), 1)
  })

  test('a frame arriving after the cap has already tripped is also refused, not silently buffered', () => {
    const conn = makeConn()
    const session = collab.capture(conn as any)

    for (let i = 0; i < MAX_PENDING_FRAMES + 3; i++) {
      send(conn, 1)
    }

    assert.equal(session.pending.length, MAX_PENDING_FRAMES)
    assert.equal(conn.terminate.mock.callCount(), 3)
  })

  test('once a room is attached, messages are handed off live and never touch the pending buffer', () => {
    const conn = makeConn()
    const session = collab.capture(conn as any)
    const onMessageMock = mock.method(collab, 'onMessage', () => {})
    try {
      session.room = {} as any
      send(conn, 8)

      assert.equal(onMessageMock.mock.callCount(), 1)
      assert.equal(session.pending.length, 0)
      assert.equal(session.pendingBytes, 0)
      assert.equal(conn.terminate.mock.callCount(), 0)
    } finally {
      onMessageMock.mock.restore()
    }
  })
})

/**
 * (e) OpenProject #2196: `capture()`'s pre-auth `session.pending` buffer is bounded by both entry
 * count and total bytes, terminating (not merely closing) a connection that exceeds either — and
 * `refuse()`, the helper `controllers/collab.ts`'s five refusal points now call instead of
 * `conn.close()` directly, sends the close frame a cooperating client needs but no longer leaves a
 * non-cooperating one sitting in `CLOSING` for `ws`'s full 30s default.
 */
describe('(e) collab pre-auth frame buffer cap and refusal termination', () => {
  test('buffers ordinary frames normally, well under the cap', () => {
    const socket = new FakeSocket()
    const session = collab.capture(socket as any)

    socket.emit('message', Buffer.from('sync step 1'))
    socket.emit('message', Buffer.from('sync step 2'))

    assert.equal(session.pending.length, 2)
    assert.equal(socket.terminated, false)
  })

  test('terminates the connection once the entry-count cap is exceeded, dropping the buffer', () => {
    const socket = new FakeSocket()
    const session = collab.capture(socket as any)

    for (let i = 0; i < MAX_PENDING_FRAMES; i++) {
      socket.emit('message', Buffer.from(`frame ${i}`))
    }
    assert.equal(session.pending.length, MAX_PENDING_FRAMES, 'every frame up to the cap is kept')
    assert.equal(socket.terminated, false)

    // -> One frame past the cap terminates the connection rather than growing the buffer further
    socket.emit('message', Buffer.from('one too many'))
    assert.equal(socket.terminated, true)
    assert.equal(
      session.pending.length,
      MAX_PENDING_FRAMES,
      'the frame that tripped the cap is never itself buffered'
    )
  })

  test('terminates the connection once the total-byte cap is exceeded, even in very few frames', () => {
    const socket = new FakeSocket()
    const session = collab.capture(socket as any)

    socket.emit('message', Buffer.alloc(MAX_PENDING_BYTES))
    assert.equal(socket.terminated, false)
    assert.equal(session.pending.length, 1)

    socket.emit('message', Buffer.from('a'))
    assert.equal(socket.terminated, true)
    assert.equal(session.pending.length, 1)
  })

  test('a message arriving after a room is attached is handled normally, not buffered or capped', () => {
    const socket = new FakeSocket()
    const session = collab.capture(socket as any)
    const onMessage = mock.method(collab, 'onMessage', () => {})
    const room = { pageId: 'p' } as any
    session.room = room

    try {
      socket.emit('message', Buffer.from('post-join message'))
      assert.equal(onMessage.mock.calls.length, 1)
      assert.equal(onMessage.mock.calls[0].arguments[0], room)
      assert.equal(session.pending.length, 0)
    } finally {
      onMessage.mock.restore()
    }
  })

  test('refuse() sends the close frame immediately, for a cooperating client to act on', () => {
    const socket = new FakeSocket()
    collab.refuse(socket as any, 4403, 'You are not allowed to edit this page')

    assert.deepEqual(socket.closeCalls, [
      { code: 4403, reason: 'You are not allowed to edit this page' }
    ])
  })

  test('refuse() terminates a non-cooperating socket once the grace period elapses', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const socket = new FakeSocket()

    collab.refuse(socket as any, 4401, 'Authentication is required')
    assert.equal(
      socket.terminated,
      false,
      'not terminated immediately - close() gets its grace period'
    )

    t.mock.timers.tick(REFUSAL_GRACE_PERIOD)
    assert.equal(socket.terminated, true)
  })

  test('refuse() does not terminate a socket that already finished closing on its own', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const socket = new FakeSocket()

    collab.refuse(socket as any, 4404, 'This page does not exist')
    // -> The cooperating client's own close frame arrives well inside the grace period
    socket.readyState = socket.CLOSED

    t.mock.timers.tick(REFUSAL_GRACE_PERIOD)
    assert.equal(socket.terminated, false, 'terminate() is never called once already CLOSED')
  })
})

/**
 * (f) Task 2200: a per-user and per-address ceiling on concurrent collaboration sockets, checked and
 * reserved by `join()` before `ensureRoom()` ever runs — so a refusal never allocates, or reuses, a
 * room — and released by `onClose()`, so a legitimate reconnect loop can't exhaust its own ceiling.
 *
 * `fakeConn()` is a minimal `ws`-shaped stand-in good enough for `join()`/`onClose()`'s surface
 * (`readyState`, `OPEN`, `on`, `close`) — no real socket needed since nothing here exercises the sync
 * protocol itself, only the reservation bookkeeping around it.
 */
describe('(f) connection cap: per-user and per-address ceilings', () => {
  interface FakeConn {
    readyState: number
    OPEN: number
    on: (event: string, cb: (...args: any[]) => void) => void
    close: (code?: number, reason?: string) => void
    closedCode: number | null
    closedReason: string | null
  }

  function fakeConn(): FakeConn {
    const conn: FakeConn = {
      readyState: 1,
      OPEN: 1,
      closedCode: null,
      closedReason: null,
      on: () => {},
      close(code, reason) {
        conn.readyState = 3
        conn.closedCode = code ?? null
        conn.closedReason = reason ?? null
      }
    }
    return conn
  }

  /** Tears down every room this test opened, exactly as `closeRoomIfEmpty` would once empty. */
  function destroyRoom(inst: any, pageId: string): void {
    const room = inst.rooms.get(pageId)
    if (room) {
      room.awareness.destroy()
      room.doc.destroy()
      inst.rooms.delete(pageId)
    }
  }

  test('a connection past the per-user ceiling is refused, and it allocates no room', async () => {
    const inst = makeInstance('cap-user')
    // -> No peer to wait on: without this, every room's initRoom() would burn a real
    //    PEER_STATE_TIMEOUT querying for a nonexistent peer, the same seeding test (a) above does.
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'cap-user'
    const userId = 'capped-user'
    const opened: { conn: FakeConn; session: any; pageId: string }[] = []

    try {
      for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
        const conn = fakeConn()
        const session: any = { room: null, pending: [] }
        const pageId = `page-cap-user-${i}`
        await inst.join(conn, { id: pageId, siteId: 'site-1' }, session, {
          userId,
          address: `10.0.0.${i}`
        })
        assert.ok(session.room, `connection ${i} should have been let in under the ceiling`)
        opened.push({ conn, session, pageId })
      }
      assert.equal(inst.rooms.size, MAX_CONNECTIONS_PER_USER)

      const refusedConn = fakeConn()
      const refusedSession: any = { room: null, pending: [] }
      const refusedPageId = 'page-cap-user-refused'
      await inst.join(refusedConn, { id: refusedPageId, siteId: 'site-1' }, refusedSession, {
        userId,
        address: '10.0.0.999'
      })

      assert.equal(refusedSession.room, null, 'a refused connection must not join a room')
      assert.equal(refusedConn.closedCode, 4429)
      assert.equal(
        inst.rooms.has(refusedPageId),
        false,
        'a refused connection must not allocate a room for its page'
      )
      assert.equal(
        inst.rooms.size,
        MAX_CONNECTIONS_PER_USER,
        'the refusal must leave the existing room count unchanged'
      )

      // -> Releasing one of the ceiling's own slots (a real close event, same path `terminate()` takes)
      //    must free up room for a fresh connection from the same user.
      const first = opened[0]
      inst.onClose(first.session.room, first.conn)
      const retryConn = fakeConn()
      const retrySession: any = { room: null, pending: [] }
      const retryPageId = 'page-cap-user-retry'
      await inst.join(retryConn, { id: retryPageId, siteId: 'site-1' }, retrySession, {
        userId,
        address: '10.0.0.1000'
      })
      assert.ok(
        retrySession.room,
        'after a slot is released, a subsequent connection for the same user must succeed'
      )
      inst.onClose(retrySession.room, retryConn)
      destroyRoom(inst, retryPageId)
    } finally {
      for (const { conn, session, pageId } of opened.slice(1)) {
        inst.onClose(session.room, conn)
        destroyRoom(inst, pageId)
      }
      destroyRoom(inst, 'page-cap-user-0')
    }
  })

  test('a connection past the per-address ceiling is refused, regardless of user id', async () => {
    const inst = makeInstance('cap-address')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'cap-address'
    const address = '203.0.113.5'
    const opened: { conn: FakeConn; session: any; pageId: string }[] = []

    try {
      for (let i = 0; i < MAX_CONNECTIONS_PER_ADDRESS; i++) {
        const conn = fakeConn()
        const session: any = { room: null, pending: [] }
        const pageId = `page-cap-addr-${i}`
        await inst.join(conn, { id: pageId, siteId: 'site-1' }, session, {
          userId: `user-${i}`,
          address
        })
        assert.ok(session.room, `connection ${i} should have been let in under the ceiling`)
        opened.push({ conn, session, pageId })
      }

      const refusedConn = fakeConn()
      const refusedSession: any = { room: null, pending: [] }
      const refusedPageId = 'page-cap-addr-refused'
      await inst.join(refusedConn, { id: refusedPageId, siteId: 'site-1' }, refusedSession, {
        userId: 'yet-another-user',
        address
      })

      assert.equal(refusedSession.room, null, 'a refused connection must not join a room')
      assert.equal(refusedConn.closedCode, 4429)
      assert.equal(
        inst.rooms.has(refusedPageId),
        false,
        'a refused connection must not allocate a room for its page'
      )
    } finally {
      for (const { conn, session, pageId } of opened) {
        inst.onClose(session.room, conn)
        destroyRoom(inst, pageId)
      }
    }
  })

  test('closing a socket releases both its user and address slots', async () => {
    const inst = makeInstance('cap-release')
    inst.peerPresence = { known: false, checkedAt: Date.now() }
    ;(globalThis as any).WIKI.INSTANCE_ID = 'cap-release'
    const identity = { userId: 'release-user', address: '198.51.100.1' }
    const conn = fakeConn()
    const session: any = { room: null, pending: [] }
    const pageId = 'page-cap-release'

    await inst.join(conn, { id: pageId, siteId: 'site-1' }, session, identity)
    assert.ok(session.room)
    assert.equal(inst.userConnections.get(identity.userId), 1)
    assert.equal(inst.addressConnections.get(identity.address), 1)

    inst.onClose(session.room, conn)

    assert.equal(
      inst.userConnections.has(identity.userId),
      false,
      'the user slot must be released, not merely decremented to a lingering zero'
    )
    assert.equal(
      inst.addressConnections.has(identity.address),
      false,
      'the address slot must be released, not merely decremented to a lingering zero'
    )
    destroyRoom(inst, pageId)
  })
})
