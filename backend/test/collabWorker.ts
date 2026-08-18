/**
 * Worker-thread body for the multi-instance `core/collab.ts` races exercised by `core/collab.test.ts`.
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
import * as Y from 'yjs'
import { relations } from '../db/relations.ts'
import { createCacheStub, createEventsStub } from './mocks.ts'
import type { WikiDb } from '../core/db.ts'

interface WorkerInit {
  connectionString: string
  schema: string
  instanceId: string
  siteId: string
}

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
    dbManager: { pool },
    logger: { error: noop, warn: noop, info: noop, debug: noop, verbose: noop, silly: noop },
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
    case 'shutdown': {
      await collab.shutdown()
      await (WIKI.dbManager as { pool: Pool }).pool.end()
      return {}
    }
    default:
      throw new Error(`Unknown worker command: ${msg.cmd}`)
  }
}

boot().catch((err) => {
  parentPort?.postMessage({ id: 0, ok: false, error: err.message })
})
