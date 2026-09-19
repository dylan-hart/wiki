/**
 * Two real `core/collab.ts` instances — two worker threads, each with its own `CARDINAL` global and
 * its own postgres LISTEN/NOTIFY client — against one real database: what a single-process clone
 * (`test/collabHarness.ts#makeInstance`) cannot stand in for.
 */
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { after, before, beforeEach, describe, test } from 'node:test'
import { PEER_STATE_TIMEOUT, RELAY_REASSEMBLY_TIMEOUT } from './collab.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

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

/**
 * On timeout returns the last-observed value rather than throwing, so the caller's own assert
 * reports the real mismatch instead of a generic timeout.
 */
async function pollUntil<T>(
  poll: () => Promise<T>,
  isDone: (value: T) => boolean,
  { timeoutMs = 10000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await poll()
    if (isDone(value) || Date.now() >= deadline) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

describe('collaborative editing across instances (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let connectionString: string
  let a: WorkerHandle
  let b: WorkerHandle
  let dbWiki: any

  before(async () => {
    fixtures = await setupTestDb()
    dbWiki = (globalThis as any).CARDINAL
    connectionString = process.env.DATABASE_URL!
    ;[a, b] = await Promise.all([
      startInstance(connectionString, fixtures.schema, 'instance-a', fixtures.siteId),
      startInstance(connectionString, fixtures.schema, 'instance-b', fixtures.siteId)
    ])
  })

  // TODO: drop this hook and `dbWiki` -- nothing in this file replaces the `CARDINAL` that
  //    `setupTestDb()` installs.
  beforeEach(() => {
    ;(globalThis as any).CARDINAL = dbWiki
  })

  after(async () => {
    await Promise.all([a?.close(), b?.close()])
    await teardownTestDb()
  })

  test('two instances cold-starting the same room in the same instant converge byte-identically', async () => {
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/cold-start',
        title: 'Cold Start',
        editor: 'markdown',
        content: 'Original content.'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    const [resA, resB] = await Promise.all([
      a.call('ensureRoom', { pageId: page.id }),
      b.call('ensureRoom', { pageId: page.id })
    ])

    assert.equal(resA.text, 'Original content.')
    assert.equal(resB.text, 'Original content.')
    // -> Byte-identical Yjs state, not just equal text: differing seeds concatenate on merge
    assert.equal(resA.state, resB.state)
  })

  test('a peerState handshake that lands after PEER_STATE_TIMEOUT still converges the room', async () => {
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/late-handshake',
        title: 'Late Handshake',
        editor: 'markdown',
        content: 'Stored text.'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    await b.call('ensureRoom', { pageId: page.id })
    await b.call('localEdit', { pageId: page.id, text: ' Extra from B.' })

    // -> Let B's live `update` broadcast reach A and be dropped (A has no room yet). Otherwise A
    //    can register its room while the broadcast is in flight and pick the edit up that way,
    //    masking the late peerState handshake this test exercises.
    await new Promise((resolve) => setTimeout(resolve, 200))

    await b.call('delayStateReplies', { ms: PEER_STATE_TIMEOUT + 200 })

    const resA = await a.call('ensureRoom', { pageId: page.id })
    // -> The handshake timed out, so A fell back to the stored page, without B's edit
    assert.equal(resA.text, 'Stored text.')

    // -> B's delayed reply is still in flight
    await new Promise((resolve) => setTimeout(resolve, 400))
    const caughtUp = await a.call('roomText', { pageId: page.id })
    assert.equal(caughtUp.text, 'Stored text. Extra from B.')
  })

  test('a partial relay message from an instance that goes quiet mid-relay still expires, not leaks', async () => {
    // -> `reassemble()` tracks chunks by envelope key alone, so this page id needs no room
    const pageId = 'relay-only-no-room'
    await b.call('publishIncomplete', {
      pageId,
      totalLength: 12000,
      chunkSize: 5000,
      skipChunk: 2,
      messageId: 'msg-crash'
    })

    const midway = await pollUntil(
      () => a.call('partialsSize'),
      (result) => result.size === 1
    )
    assert.equal(midway.size, 1, 'the two delivered chunks are held, waiting for the third')

    // -> Polled, not one RELAY_REASSEMBLY_TIMEOUT sleep and a single check: that leaves no margin
    //    for scheduling jitter under CI load. Only a genuine leak outlasts this ceiling.
    const after = await pollUntil(
      () => a.call('partialsSize'),
      (result) => result.size === 0,
      { timeoutMs: RELAY_REASSEMBLY_TIMEOUT * 3 }
    )
    assert.equal(after.size, 0, 'the abandoned partial was dropped rather than held forever')
  })

  test('concurrent bursty edits from several sessions across two instances converge with no dropped chunks or leaked partials', async () => {
    // -> A scaled-down `scripts/collab-load-test.ts`, sized to run on every change
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/concurrent-load',
        title: 'Concurrent Load',
        editor: 'markdown',
        content: 'Seed. '
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    await a.call('ensureRoom', { pageId: page.id })
    await b.call('ensureRoom', { pageId: page.id })

    const sessions = [
      { instance: a, id: 'sess-a0' },
      { instance: a, id: 'sess-a1' },
      { instance: b, id: 'sess-b0' },
      { instance: b, id: 'sess-b1' }
    ]
    for (const { instance, id } of sessions) {
      await instance.call('openSession', { pageId: page.id, sessionId: id })
    }

    // -> Every third session's edit exceeds RELAY_CHUNK_SIZE, so multi-chunk relays interleave with
    //    the small ones rather than chunking and concurrency being tested separately.
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        sessions.map(({ instance, id }, index) => {
          const big = index % 3 === 0
          const text = big ? 'x'.repeat(15000) : `edit-${round}-${index} `
          return instance.call('sessionEdit', { sessionId: id, text, position: 0 })
        })
      )
    }

    const texts = await pollUntil(
      async () => {
        const collected = new Set<string>()
        for (const { instance, id } of sessions) {
          const { text } = await instance.call('sessionText', { sessionId: id })
          collected.add(text)
        }
        const roomA = await a.call('roomText', { pageId: page.id })
        const roomB = await b.call('roomText', { pageId: page.id })
        collected.add(roomA.text)
        collected.add(roomB.text)
        return collected
      },
      (collected) => collected.size === 1
    )

    assert.equal(
      texts.size,
      1,
      'every session and every room must converge to byte-identical text — more than one distinct ' +
        'text means a chunk was dropped or misordered'
    )

    const partialsA = await a.call('partialsSize')
    const partialsB = await b.call('partialsSize')
    assert.equal(partialsA.size, 0, 'instance a must not be left holding an abandoned partial')
    assert.equal(partialsB.size, 0, 'instance b must not be left holding an abandoned partial')

    for (const { instance, id } of sessions) {
      await instance.call('closeSession', { sessionId: id })
    }
  })

  test('a session that disconnects mid-edit, keeps typing offline, and reconnects merges cleanly (task 482)', async () => {
    const { pages } = await import('../models/pages.ts')
    const page = await pages.createPage(
      fixtures.siteId,
      {
        path: 'collab/reconnect-offline-edits',
        title: 'Reconnect Offline Edits',
        editor: 'markdown',
        content: 'Seed. '
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )

    await a.call('ensureRoom', { pageId: page.id })
    await a.call('openSession', { pageId: page.id, sessionId: 'sess-a' })
    await a.call('openSession', { pageId: page.id, sessionId: 'sess-b' })

    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'A1 ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B1 ' })
    await pollUntil(
      () => a.call('roomText', { pageId: page.id }),
      (result) => result.text.includes('A1') && result.text.includes('B1')
    )

    await a.call('disconnectSession', { sessionId: 'sess-a' })
    const stillOpen = await a.call('roomText', { pageId: page.id })
    assert.equal(stillOpen.exists, true, 'the room must survive one of two sessions dropping')

    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'OFFLINE-FROM-A ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B2-WHILE-A-OFFLINE ' })

    // -> Proves the disconnect was real, not a no-op
    const whileOffline = await pollUntil(
      () => a.call('roomText', { pageId: page.id }),
      (result) => result.text.includes('B2-WHILE-A-OFFLINE')
    )
    assert.ok(
      whileOffline.text.includes('B2-WHILE-A-OFFLINE'),
      "B's edit while A was away reached the room"
    )
    assert.ok(
      !whileOffline.text.includes('OFFLINE-FROM-A'),
      "A's offline edit must not reach the room until it reconnects"
    )
    const aWhileOffline = await a.call('sessionText', { sessionId: 'sess-a' })
    assert.ok(
      !aWhileOffline.text.includes('B2-WHILE-A-OFFLINE'),
      "A's own replica must not see B's edit while genuinely disconnected"
    )

    await a.call('reconnectSession', { pageId: page.id, sessionId: 'sess-a' })

    const { finalA, finalB, finalRoom } = await pollUntil(
      async () => ({
        finalA: await a.call('sessionText', { sessionId: 'sess-a' }),
        finalB: await a.call('sessionText', { sessionId: 'sess-b' }),
        finalRoom: await a.call('roomText', { pageId: page.id })
      }),
      (result) =>
        result.finalA.text === result.finalRoom.text && result.finalB.text === result.finalRoom.text
    )

    assert.equal(
      finalA.text,
      finalRoom.text,
      "A's replica must converge with the room after reconnecting"
    )
    assert.equal(finalB.text, finalRoom.text, "B's replica must still agree with the room")

    for (const fragment of ['A1', 'B1', 'OFFLINE-FROM-A', 'B2-WHILE-A-OFFLINE']) {
      const occurrences = finalRoom.text.split(fragment).length - 1
      assert.equal(
        occurrences,
        1,
        `"${fragment}" must appear exactly once, not ${occurrences} times`
      )
    }

    await a.call('closeSession', { sessionId: 'sess-a' })
    await a.call('closeSession', { sessionId: 'sess-b' })
  })
})
