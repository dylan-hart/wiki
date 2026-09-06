/* eslint-disable no-console -- a throwaway load-test script: its stdout IS its result, and it runs outside a booted `WIKI`. */
/**
 * Throwaway load test for `core/collab.ts`'s chunked relay path — task 478.
 *
 * Not part of `npm run test`: this is a manual, ad-hoc script for the one investigation it was built
 * for, not a regression suite (see `core/collab.test.ts` for the permanent, CI-scale version of the
 * same claims). Run it against a disposable Postgres:
 *
 *   docker run --rm -d --name wiki-collab-load -p 56078:5432 \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56078/postgres \
 *     node --experimental-strip-types backend/scripts/collab-load-test.ts
 *
 * What it does:
 *   1. Seeds one page with a multi-megabyte markdown document.
 *   2. Boots three real, separate `core/collab.ts` instances (worker threads, own `WIKI` global, own
 *      postgres LISTEN/NOTIFY client, own `INSTANCE_ID` — see `test/collabWorker.ts`), standing in for
 *      "at least two backend instances".
 *   3. Opens several simulated editor sessions spread across those instances, each a genuinely separate
 *      Yjs replica synced over the real sync protocol (`openSession` in `test/collabWorker.ts` — the
 *      same message framing `frontend/src/composables/collab.js`'s `WebsocketProvider` speaks).
 *   4. Fires concurrent, bursty edits from all sessions at once, several rounds, including edits large
 *      enough that a single one requires many `RELAY_CHUNK_SIZE` chunks on its own.
 *   5. Confirms every session on every instance converges to byte-identical text, and that no instance
 *      is left holding an abandoned partial — the two ways a dropped or misordered chunk, or a
 *      premature `RELAY_REASSEMBLY_TIMEOUT`, would show up.
 *   6. Separately measures how long a cold room's `hello`/`state` handshake actually takes to fully
 *      reassemble once the room holds that multi-megabyte document, and compares it against
 *      `PEER_STATE_TIMEOUT`.
 */
import { Worker } from 'node:worker_threads'
import { setupTestDb, teardownTestDb } from '../test/db.ts'
import { PEER_STATE_TIMEOUT, RELAY_REASSEMBLY_TIMEOUT } from '../core/collab.ts'

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

function randomText(length: number): string {
  const words = ['collab', 'wiki', 'edit', 'markdown', 'burst', 'relay', 'chunk', 'session', 'text']
  let out = ''
  while (out.length < length) {
    out += words[Math.floor(Math.random() * words.length)] + ' '
  }
  return out.slice(0, length)
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL to a throwaway Postgres before running this script.')
  }

  const fixtures = await setupTestDb()
  const connectionString = process.env.DATABASE_URL!
  const { pages } = await import('../models/pages.ts')

  // -> ~3MB of markdown, comfortably "multi-megabyte" and, once encoded as a single Yjs insert op and
  //    base64'd, several hundred `RELAY_CHUNK_SIZE` chunks on its own.
  const seedContent = randomText(3 * 1024 * 1024)
  const page = await pages.createPage(
    fixtures.siteId,
    { path: 'collab/load-test', title: 'Load Test', editor: 'markdown', content: seedContent },
    { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
  )
  console.log(
    `Seeded page ${page.id} with ${seedContent.length.toLocaleString()} bytes of content.`
  )

  console.log('Starting 3 backend instances...')
  const [a, b, c] = await Promise.all([
    startInstance(connectionString, fixtures.schema, 'load-a', fixtures.siteId),
    startInstance(connectionString, fixtures.schema, 'load-b', fixtures.siteId),
    startInstance(connectionString, fixtures.schema, 'load-c', fixtures.siteId)
  ])
  const instances = [a, b, c]

  try {
    // -> Open the room on `a` first so it seeds from the stored page; `b` and `c` then cold-start via
    //    the peerState handshake, exercising exactly the multi-chunk `state` reply this task cares about.
    console.log('Opening room on instance a (seeds from stored page)...')
    const first = await a.call('ensureRoom', { pageId: page.id })
    console.log(`  room text length on a: ${first.length ?? first.text?.length}`)

    console.log('Opening rooms on b and c via the peerState handshake...')
    const bcStart = performance.now()
    await Promise.all([
      b.call('ensureRoom', { pageId: page.id }),
      c.call('ensureRoom', { pageId: page.id })
    ])
    console.log(
      `  b/c room open (incl. peerState handshake) took ${(performance.now() - bcStart).toFixed(0)}ms`
    )

    // -> Several simulated editor sessions spread across all three instances.
    const sessionsPerInstance = 2
    const sessionIds: { instance: WorkerHandle; id: string }[] = []
    for (const [idx, instance] of instances.entries()) {
      for (let s = 0; s < sessionsPerInstance; s++) {
        const id = `session-${idx}-${s}`
        await instance.call('openSession', { pageId: page.id, sessionId: id })
        sessionIds.push({ instance, id })
      }
    }
    console.log(
      `Opened ${sessionIds.length} simulated sessions across ${instances.length} instances.`
    )

    // -> Concurrent, bursty edits: several rounds, every session firing at once, sizes ranging from a
    //    few characters (a keystroke) to tens of KB (a paste) — large enough on the high end to force
    //    several chunks from a single update.
    const rounds = 6
    for (let round = 0; round < rounds; round++) {
      const edits = sessionIds.map(({ instance, id }) => {
        const size =
          Math.random() < 0.3
            ? 20000 + Math.floor(Math.random() * 30000)
            : 5 + Math.floor(Math.random() * 40)
        return instance.call('sessionEdit', { sessionId: id, text: randomText(size), position: 0 })
      })
      await Promise.all(edits)
      console.log(`  round ${round + 1}/${rounds} fired ${edits.length} concurrent edits`)
    }

    // -> Let the relay traffic drain. Generous: this is a load test, not a latency budget.
    console.log('Draining relay traffic...')
    await new Promise((resolve) => setTimeout(resolve, RELAY_REASSEMBLY_TIMEOUT + 2000))

    console.log('Checking convergence across every session and every room...')
    const texts = new Set<string>()
    for (const { instance, id } of sessionIds) {
      const { text } = await instance.call('sessionText', { sessionId: id })
      texts.add(text)
    }
    for (const instance of instances) {
      const { text } = await instance.call('roomText', { pageId: page.id })
      texts.add(text)
    }
    console.log(
      `  distinct texts across ${sessionIds.length} sessions + ${instances.length} rooms: ${texts.size}`
    )
    if (texts.size !== 1) {
      console.error(
        '  DIVERGENCE DETECTED — a chunk was dropped, misordered, or a partial expired early.'
      )
    } else {
      console.log(
        `  converged: all replicas hold the same ${[...texts][0]!.length.toLocaleString()} bytes`
      )
    }

    console.log(
      'Checking for leaked partials (evidence of a premature RELAY_REASSEMBLY_TIMEOUT)...'
    )
    for (const [idx, instance] of instances.entries()) {
      const { size } = await instance.call('partialsSize')
      console.log(`  instance ${idx}: ${size} partial(s) still held`)
      if (size > 0) {
        console.error('  LEAK DETECTED — a chunked message never finished reassembling.')
      }
    }

    // -> PEER_STATE_TIMEOUT check: a genuinely fresh 4th instance, with no room of its own, asks the
    //    cluster for state on a room that (after the edits above) holds several megabytes. Measured
    //    with a generous timeout so the real completion time is visible, then compared against the
    //    current constant.
    console.log('Starting a 4th, cold instance to measure the hello/state handshake...')
    const d = await startInstance(connectionString, fixtures.schema, 'load-d-cold', fixtures.siteId)
    try {
      console.log(
        `Measuring hello/state handshake time for the now-large room (PEER_STATE_TIMEOUT=${PEER_STATE_TIMEOUT}ms)...`
      )
      const { ms, gotState, bytes } = await d.call('measureStateHandshake', {
        pageId: page.id,
        timeoutMs: 30000
      })
      console.log(
        `  handshake ${gotState ? 'completed' : 'timed out'} in ${ms.toFixed(0)}ms (${bytes.toLocaleString()} update bytes)`
      )
      console.log(
        ms > PEER_STATE_TIMEOUT
          ? `  >>> exceeds PEER_STATE_TIMEOUT (${PEER_STATE_TIMEOUT}ms) — a real cold-start would have fallen back to buildSeed and missed this state`
          : `  within PEER_STATE_TIMEOUT (${PEER_STATE_TIMEOUT}ms)`
      )
    } finally {
      await d.close()
    }
  } finally {
    await Promise.all(instances.map((i) => i.close()))
    await teardownTestDb()
  }
}

main()
  .then(() => {
    console.log('Load test finished.')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Load test failed:', err)
    process.exit(1)
  })
