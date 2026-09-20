/**
 * Worker-thread body for the multi-instance `core/collab.ts` races.
 *
 * A worker thread gets its own V8 isolate and module registry, which is the cheapest way to run two
 * real `collab.ts` instances against one database without two full `node backend` processes and the
 * HTTP/websocket stacks these races never touch. `CARDINAL.collab` must point at this worker's own
 * import: `relay`/`publish` read `CARDINAL.collab.listenClient` rather than a captured reference.
 *
 * The parent sends `{ id, cmd, ...args }` and gets `{ id, ok, ...result }` back, so it can `await`
 * a round trip per command over a message-based channel.
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

/** Mirrored from `core/collab.ts`, which does not export it. */
const MESSAGE_SYNC = 0

/**
 * A client replica with its own Yjs document, speaking the real sync protocol both ways as
 * `y-websocket`'s `WebsocketProvider` does in the browser. The `openSession` commands exercise
 * `relay()`/`reassemble()` through these rather than editing the room's document directly.
 */
interface Session {
  conn: WebSocket
  doc: Y.Doc
  room: Awaited<ReturnType<typeof import('../core/collab.ts').default.ensureRoom>>
  /**
   * `false` between `disconnectSession` and `reconnectSession`: the session's own `doc` keeps
   * accumulating local edits as it would while a real socket is down, but nothing may be relayed
   * out over the closed `conn` until a fresh one replaces it.
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

  global.CARDINAL = {
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
    // -> `listenerPool` must exist: `collab.init()` LISTENs on it, and an `undefined` one throws
    //    inside `connectListener`'s resilience loop, which then retries forever against a silent
    //    logger, so `init()` never resolves and this worker never posts its ready message. Sharing
    //    the one pool is fine here — nothing in these scenarios needs the two kept apart.
    dbManager: { pool, listenerPool: pool },
    logger: { error: noop, warn: noop, info: noop, debug: noop },
    cache: createCacheStub(),
    events: createEventsStub(),
    sites: { [siteId]: { id: siteId, config: { locales: { primary: 'en' } } } },
    sitesMappings: {},
    models
  } as unknown as CardinalGlobal

  const collab = (await import('../core/collab.ts')).default
  CARDINAL.collab = collab
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
    // -> Slow-link latency on `state` replies without touching collab.ts's own timing constants;
    //    the rest of the handshake still runs for real.
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
    // -> A user already mid-edit on this instance, with no websocket client needed to produce it.
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
    // -> Withholds one chunk, standing in for an instance that dies mid-relay: the receiving side's
    //    `partials` entry has to expire on its own.
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
    // -> The session must send its *own* sync step 1 back after `join()` sends the server's: a
    //    step 1 only asks the other side what it is missing, so nothing pulls the room's content
    //    down without it.
    case 'openSession': {
      const pageId = msg.pageId as string
      const sessionId = msg.sessionId as string
      const room = await collab.ensureRoom({ id: pageId, siteId })
      const doc = new Y.Doc()
      const conn = makeSessionSocket(collab, doc, room)
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        /*
          Re-reads the session rather than closing over `conn`/`room`: a `reconnectSession` swaps the
          transport out from under this long-lived listener, and the check below must see the current
          one. Origin is the session's own `conn` for an update the server pushed; anything else is
          this session's own edit.
        */
        const current = sessions.get(sessionId)
        if (!current || origin === current.conn) {
          return
        }
        // -> Hold the edit locally while disconnected, as a real `WebsocketProvider` does.
        if (!current.connected) {
          return
        }
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeUpdate(encoder, update)
        collab.onMessage(current.room, current.conn, encoding.toUint8Array(encoder))
      })
      // -> A distinct identity per session, so concurrent sessions never collide against each
      //    other's connection-cap slots.
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
    // -> An abrupt network drop: the server sees a closed socket, but this session's own `doc` is
    //    left alone, the way a browser tab's `WebsocketProvider` leaves its `Y.Doc` while offline.
    case 'disconnectSession': {
      const session = sessions.get(msg.sessionId as string)
      if (!session) {
        throw new Error(`No open session ${msg.sessionId as string}`)
      }
      collab.onClose(session.room, session.conn)
      session.connected = false
      return {}
    }
    // -> Keeps the session's own `doc` and rejoins with a fresh `conn`, which is what pushes the
    //    offline edits out *and* pulls down whatever the room gained while it was away.
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
    // -> Typed into the session's own replica, so it flows out through the `doc.on('update')`
    //    handler and the real relay/chunking path rather than straight into the room.
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
    // -> Times a `hello`/`state` handshake against a caller-supplied cutoff rather than
    //    `PEER_STATE_TIMEOUT`, so the measurement is independent of that constant's current value.
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
      await (CARDINAL.dbManager as { pool: Pool }).pool.end()
      return {}
    }
    default:
      throw new Error(`Unknown worker command: ${msg.cmd}`)
  }
}

/**
 * A `ws`-shaped socket backed by a real client-side Yjs document: exactly the surface
 * `collab.join()`/`onMessage()`/`onClose()` touch, answered synchronously in-process instead of
 * over a network.
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
