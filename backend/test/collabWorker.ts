/**
 * Worker-thread body for the multi-instance `core/collab.ts` races exercised by
 * `core/collab.crossInstance.db.test.ts`.
 *
 * Each worker is a genuinely separate `WIKI` global — a worker thread gets its own V8 isolate and its
 * own module registry, so this is the smallest way to run two real `collab.ts` instances (own `rooms`,
 * `partials`, `awaitingState`, own postgres LISTEN/NOTIFY client, own `INSTANCE_ID`) against the same
 * database without paying for two full `node backend` processes and their HTTP/websocket stacks, which
 * is infrastructure this module's races do not touch. `WIKI.collab` is set to this worker's own
 * `collab.ts` import, since `relay`/`publish` close over `WIKI.collab.listenClient` rather than a
 * reference captured at import time.
 *
 * Driven by postMessage: the parent sends `{ id, cmd, ...args }`, this replies `{ id, ok, ...result }`
 * (or `{ id, ok: false, error }`), so the test file can `await` a request/response round trip per
 * command despite the underlying channel being message-based.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { relations } from '../db/relations.ts'
import { createCacheStub, createEventsStub } from './mocks.ts'
import type { WikiDb } from '../core/db.ts'
import type { WebSocket } from 'ws'

interface WorkerInit {
  connectionString: string
  schema: string
  instanceId: string
  siteId: string
}

/** y-websocket message types, mirrored from `core/collab.ts` — not exported there, so restated here. */
const MESSAGE_SYNC = 0

/**
 * A stand-in `ws` `WebSocket` good enough for `collab.join()`/`collab.onMessage()`: it has its own Yjs
 * document and speaks the real sync protocol both ways, the same as `y-websocket`'s `WebsocketProvider`
 * does in the browser — see `frontend/src/composables/collab.js`. Used by the `openSession` family of
 * commands to load-test `relay()`/`reassemble()` with genuinely separate client replicas rather than
 * editing the room's document directly, which is what `localEdit` does for the simpler races.
 */
interface Session {
  conn: WebSocket
  doc: Y.Doc
  room: Awaited<ReturnType<typeof import('../core/collab.ts').default.ensureRoom>>
  /**
   * Whether this session's transport is currently live, mirroring what a real `WebsocketProvider`'s
   * `wsconnected` means to the browser side. `false` between `disconnectSession` and `reconnectSession`
   * — task 482's whole scenario: a session's own `doc` keeps accumulating local edits exactly as it
   * would while a real socket is down, but nothing may be relayed out over the (closed) `conn` until a
   * fresh one replaces it.
   */
  connected: boolean
}

const sessions = new Map<string, Session>()

const { connectionString, schema, instanceId, siteId } = workerData as WorkerInit

async function boot(): Promise<void> {
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` })
  const db = drizzle({ client: pool, relations }) as WikiDb
  const models = (await import('../models/index.ts')).default
  const noop = () => {}

  global.WIKI = {
    IS_DEBUG: false,
    ROOTPATH: process.cwd(),
    SERVERPATH: process.cwd(),
    INSTANCE_ID: instanceId,
    startedAt: new Date(),
    version: 'test',
    releaseDate: 'test',
    devMode: true,
    auth: { groups: {}, strategies: {} },
    config: {},
    data: {},
    db,
    // -> `collab.init()` LISTENs on `WIKI.dbManager.listenerPool`, a dedicated pool kept separate
    //    from the main `pool` (`core/db.ts`'s own `init()`) -- not present here without this, so
    //    `helpers/pubsub.ts#connectListener`'s `pool.connect()` throws on `undefined`, gets caught by
    //    its own resilience loop (`reconnect()`'s `while (!closed)`, meant for a genuinely dropped
    //    connection re-establishing on its own) and retries forever, every `retryDelayMs` (3s),
    //    logged nowhere since `logger.warn` below is a no-op -- `collab.init()` never resolves, and
    //    this worker never posts back the ready message `startInstance()` is awaiting with no
    //    timeout of its own. Reusing the same `pool` is fine here: this worker's own test scenarios
    //    have no reason to keep the two pools genuinely separate the way a real instance does.
    dbManager: { pool, listenerPool: pool },
    logger: { error: noop, warn: noop, info: noop, debug: noop },
    cache: createCacheStub(),
    events: createEventsStub(),
    sites: { [siteId]: { id: siteId, config: { locales: { primary: 'en' } } } },
    sitesMappings: {},
    models
  } as unknown as WikiGlobal

  const collab = (await import('../core/collab.ts')).default
  WIKI.collab = collab
  await collab.init()

  parentPort!.on('message', async (msg: { id: number; cmd: string; [key: string]: unknown }) => {
    try {
      const result = await handle(collab, msg)
      parentPort!.postMessage({ id: msg.id, ok: true, ...result })
    } catch (err: any) {
      parentPort!.postMessage({ id: msg.id, ok: false, error: err.message })
    }
  })

  parentPort!.postMessage({ id: 0, ok: true, ready: true })
}

async function handle(
  collab: typeof import('../core/collab.ts').default,
  msg: { cmd: string; [key: string]: unknown }
): Promise<Record<string, unknown>> {
  switch (msg.cmd) {
    case 'ensureRoom': {
      const room = await collab.ensureRoom({ id: msg.pageId as string, siteId })
      return {
        state: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64'),
        text: room.doc.getText('content').toString(),
        provisional: room.provisional,
        roomCount: collab.rooms.size
      }
    }
    case 'peerState': {
      const update = await collab.peerState(msg.pageId as string)
      return { state: update ? Buffer.from(update).toString('base64') : null }
    }
    // -> Simulates realistic network latency on this instance's replies to a peer's `hello`, without
    //    touching the timing constants collab.ts itself uses: everything past `hello` still runs the
    //    real handshake, just delayed the way a slow link would delay it.
    case 'delayStateReplies': {
      const ms = msg.ms as number
      const original = collab.relay.bind(collab)
      collab.relay = (envelope) => {
        if (envelope.t === 'state') {
          setTimeout(() => original(envelope), ms)
        } else {
          original(envelope)
        }
      }
      return {}
    }
    // -> Applies a local text change with a non-relayed origin, exactly as a connected editor's sync
    //    message would — standing in for a user already mid-edit on this instance, with no live
    //    websocket client needed to produce it.
    case 'localEdit': {
      const room = collab.rooms.get(msg.pageId as string)
      if (!room) {
        throw new Error(`No room open for page ${msg.pageId as string}`)
      }
      room.doc.transact(() => {
        const text = room.doc.getText('content')
        text.insert(text.length, msg.text as string)
      }, 'test-local-edit')
      return {}
    }
    case 'roomText': {
      const room = collab.rooms.get(msg.pageId as string)
      return { text: room ? room.doc.getText('content').toString() : null, exists: Boolean(room) }
    }
    case 'partialsSize': {
      return { size: collab.partials.size }
    }
    // -> Publishes a multi-chunk relay message but withholds one chunk, standing in for an instance
    //    that dies mid-relay: the receiving side's `partials` entry should still expire on its own.
    case 'publishIncomplete': {
      const payload = 'x'.repeat(msg.totalLength as number)
      const chunkSize = msg.chunkSize as number
      const count = Math.ceil(payload.length / chunkSize)
      const skipChunk = msg.skipChunk as number
      for (let index = 0; index < count; index++) {
        if (index === skipChunk) {
          continue
        }
        collab.publish({
          i: instanceId,
          r: msg.pageId as string,
          t: 'update',
          p: payload.slice(index * chunkSize, (index + 1) * chunkSize),
          m: msg.messageId as string,
          c: index,
          n: count
        })
      }
      return {}
    }
    // -> Opens a genuinely separate client replica against a room, syncing it the way a real
    //    `WebsocketProvider` connection does: the server's `join()` sends sync step 1 (its state
    //    vector) as it always does, and — the part a direct API call would skip — this session sends
    //    its *own* step 1 right back, which is what actually pulls the room's real content down; a
    //    step 1 only ever asks the other side what it is missing, never carries content itself.
    case 'openSession': {
      const pageId = msg.pageId as string
      const sessionId = msg.sessionId as string
      const room = await collab.ensureRoom({ id: pageId, siteId })
      const doc = new Y.Doc()
      const conn = makeSessionSocket(collab, doc, room)
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        /*
          Re-reads the session on every update rather than closing over `conn`/`room`: after a
          `reconnectSession`, this is the same long-lived listener but the session's live transport has
          been swapped out from under it, and the check below must see the *current* one. Origin is the
          session's own `conn` for an update this session just applied from the server (see
          `makeSessionSocket`'s `readSyncMessage` calls); anything else is this session's own edit.
        */
        const current = sessions.get(sessionId)
        if (!current || origin === current.conn) {
          return
        }
        // -> Not connected: hold the edit locally, exactly as a real `WebsocketProvider` does while its
        //    socket is down. Relaying it anyway would erase the point of `disconnectSession`.
        if (!current.connected) {
          return
        }
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeUpdate(encoder, update)
        collab.onMessage(current.room, current.conn, encoding.toUint8Array(encoder))
      })
      // -> A distinct synthetic identity per simulated session, so this load test's own concurrent
      //    sessions never collide against each other's connection-cap slots.
      await collab.join(
        conn,
        { id: pageId, siteId },
        { room: null, pending: [], pendingBytes: 0 },
        {
          userId: `worker-user-${sessionId}`,
          address: `worker-addr-${sessionId}`
        }
      )
      const step1 = encoding.createEncoder()
      encoding.writeVarUint(step1, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(step1, doc)
      collab.onMessage(room, conn, encoding.toUint8Array(step1))
      sessions.set(sessionId, { conn, doc, room, connected: true })
      return { text: doc.getText('content').toString(), length: doc.getText('content').length }
    }
    // -> Simulates an abrupt network drop (devtools offline, a killed instance): the server notices
    //    exactly the way it would for a real closed socket -- `onClose` retracts this session's
    //    awareness and drops it from `room.conns` -- but this session's own `doc` is left completely
    //    alone, the same as a browser tab's `WebsocketProvider` leaves its `Y.Doc` alone while offline.
    case 'disconnectSession': {
      const session = sessions.get(msg.sessionId as string)
      if (!session) {
        throw new Error(`No open session ${msg.sessionId as string}`)
      }
      collab.onClose(session.room, session.conn)
      session.connected = false
      return {}
    }
    // -> Restores connectivity for a session that reused its *own* `doc` throughout the outage
    //    (`sessionEdit` still works while disconnected — see the `connected` check above): a fresh
    //    `conn` rejoins the room exactly the way `openSession` first joined, so the reconnect pushes
    //    this session's offline edits out *and* pulls down whatever the room gained while it was away,
    //    the two halves of the reconnect-and-resync task 482 exists to verify.
    case 'reconnectSession': {
      const sessionId = msg.sessionId as string
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`No open session ${sessionId}`)
      }
      const pageId = msg.pageId as string
      const room = await collab.ensureRoom({ id: pageId, siteId })
      const conn = makeSessionSocket(collab, session.doc, room)
      sessions.set(sessionId, { conn, doc: session.doc, room, connected: true })
      await collab.join(
        conn,
        { id: pageId, siteId },
        { room: null, pending: [], pendingBytes: 0 },
        {
          userId: `worker-user-${sessionId}`,
          address: `worker-addr-${sessionId}`
        }
      )
      const step1 = encoding.createEncoder()
      encoding.writeVarUint(step1, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(step1, session.doc)
      collab.onMessage(room, conn, encoding.toUint8Array(step1))
      return { text: session.doc.getText('content').toString() }
    }
    // -> A burst of local typing from one simulated session: inserted into that session's own
    //    replica, exactly like a Monaco edit would be, so it flows out through the `doc.on('update')`
    //    handler above and through the real relay/chunking path rather than being written to the room
    //    directly.
    case 'sessionEdit': {
      const session = sessions.get(msg.sessionId as string)
      if (!session) {
        throw new Error(`No open session ${msg.sessionId as string}`)
      }
      const text = session.doc.getText('content')
      const at = Math.max(
        0,
        Math.min((msg.position as number | undefined) ?? text.length, text.length)
      )
      session.doc.transact(() => {
        text.insert(at, msg.text as string)
      }, 'test-session-edit')
      return {}
    }
    case 'sessionText': {
      const session = sessions.get(msg.sessionId as string)
      const text = session?.doc.getText('content')
      return { text: text ? text.toString() : null, length: text?.length ?? 0 }
    }
    case 'closeSession': {
      const session = sessions.get(msg.sessionId as string)
      if (session) {
        collab.onClose(session.room, session.conn)
        session.doc.destroy()
        sessions.delete(msg.sessionId as string)
      }
      return {}
    }
    // -> Times a full `hello`/`state` handshake without `PEER_STATE_TIMEOUT`'s own cutoff, so a load
    //    test can measure how long a large document's chunked `state` reply actually takes to
    //    reassemble under real (if same-box) NOTIFY latency, independent of whatever the constant is
    //    currently set to.
    case 'measureStateHandshake': {
      const pageId = msg.pageId as string
      const timeoutMs = msg.timeoutMs as number
      const start = performance.now()
      const update: Uint8Array | null = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          collab.awaitingState.delete(pageId)
          resolve(null)
        }, timeoutMs)
        collab.awaitingState.set(pageId, (u: Uint8Array) => {
          clearTimeout(timer)
          collab.awaitingState.delete(pageId)
          resolve(u)
        })
        collab.relay({ r: pageId, t: 'hello' })
      })
      return {
        ms: performance.now() - start,
        gotState: update !== null,
        bytes: update?.length ?? 0
      }
    }
    case 'shutdown': {
      for (const session of sessions.values()) {
        collab.onClose(session.room, session.conn)
        session.doc.destroy()
      }
      sessions.clear()
      await collab.shutdown()
      await (WIKI.dbManager as { pool: Pool }).pool.end()
      return {}
    }
    default:
      throw new Error(`Unknown worker command: ${msg.cmd}`)
  }
}

/**
 * Build a `ws`-shaped socket backed by a real client-side Yjs document, satisfying exactly the surface
 * `collab.join()`/`collab.onMessage()`/`collab.onClose()` touch (`readyState`, `OPEN`, `send`, `on`,
 * `close`, `terminate`, `ping`) with none of it going over an actual network — everything below is a
 * synchronous, in-process stand-in for the round trip a browser tab's `WebsocketProvider` makes.
 */
function makeSessionSocket(
  collab: typeof import('../core/collab.ts').default,
  doc: Y.Doc,
  room: Awaited<ReturnType<typeof import('../core/collab.ts').default.ensureRoom>>
): WebSocket {
  const conn = {
    readyState: 1,
    OPEN: 1,
    on() {},
    close() {},
    terminate() {},
    ping() {},
    send(data: Uint8Array) {
      const decoder = decoding.createDecoder(data)
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
        // -> Awareness traffic is real too, but this load test only asserts on document convergence.
        return
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      // -> `conn` as origin: what tags an update applied here as "came from the server", so the
      //    `doc.on('update')` handler in `openSession` knows not to relay it straight back out.
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
      if (encoding.length(encoder) > 1) {
        collab.onMessage(room, conn as unknown as WebSocket, encoding.toUint8Array(encoder))
      }
    }
  }
  return conn as unknown as WebSocket
}

boot().catch((err) => {
  parentPort?.postMessage({ id: 0, ok: false, error: err.message })
})
