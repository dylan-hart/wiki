/**
 * Two real `core/collab.ts` instances — two worker threads, each with its own `WIKI` global, its own
 * room maps and its own postgres LISTEN/NOTIFY client — racing against one real database. The one
 * part of this module a single-process clone (`test/collabHarness.ts#makeInstance`) genuinely cannot
 * stand in for.
 *
 * Split out of `core/collab.test.ts` (TEST-F14); see that file's header for the whole map. The
 * worker body each thread runs is `test/collabWorker.ts`.
 */
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { after, before, beforeEach, describe, test } from 'node:test'
import { PEER_STATE_TIMEOUT, RELAY_REASSEMBLY_TIMEOUT } from './collab.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

// ----------------------------------------
// Multi-instance: two real `collab.ts`, two real WIKI globals, one real database
// ----------------------------------------

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
 * Bounded poll replacing a fixed `setTimeout` drain: re-runs `poll()` until `isDone()` accepts its
 * result or `timeoutMs` elapses, sleeping `intervalMs` between attempts. The success path returns as
 * soon as the awaited state actually settles rather than waiting out a worst-case guess every time,
 * and the failure path still returns the last-observed value (not throw) so the caller's own assert
 * produces the real mismatch rather than a generic timeout error — matching the shape
 * `e2e/tests/scheduler.spec.js`'s `expect(...).toPass({ timeout })` uses for the same reason.
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
  // -> The real, DB-backed `WIKI` `setupTestDb()` installs, captured once so `beforeEach` below can
  //    re-assert it before every test in THIS describe.
  let dbWiki: any

  before(async () => {
    fixtures = await setupTestDb()
    dbWiki = (globalThis as any).WIKI
    connectionString = process.env.DATABASE_URL!
    ;[a, b] = await Promise.all([
      startInstance(connectionString, fixtures.schema, 'instance-a', fixtures.siteId),
      startInstance(connectionString, fixtures.schema, 'instance-b', fixtures.siteId)
    ])
  })

  // -> The file-level `beforeEach` above (registered for every test in this whole file, not just one
  //    describe) overwrites `globalThis.WIKI` with its own minimal stub -- no `sites`, no `db` --
  //    right before every test runs, including these. Node's test runner cascades hooks
  //    outer-to-inner, so this describe-scoped `beforeEach` runs after that one and puts the real,
  //    DB-backed `WIKI` back before each test body here actually executes; without it, a call this
  //    describe's tests make in the main process (e.g. `pages.createPage`) sees a `WIKI.sites` with
  //    no entry for `fixtures.siteId` at all.
  beforeEach(() => {
    ;(globalThis as any).WIKI = dbWiki
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

    // -> Fired together, not awaited one at a time: this is what forces both instances to ask the
    //    cluster for the same page's room before either one has it, which is the exact race
    //    `ensureRoom`/`initRoom`'s doc comments describe.
    const [resA, resB] = await Promise.all([
      a.call('ensureRoom', { pageId: page.id }),
      b.call('ensureRoom', { pageId: page.id })
    ])

    assert.equal(resA.text, 'Original content.')
    assert.equal(resB.text, 'Original content.')
    // -> Not just equal text: byte-identical Yjs state, proving neither instance's ops got concatenated
    //    with the other's — the failure mode a non-deterministic seed would produce.
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

    // -> B opens the room first and picks up an edit nobody told A about yet — standing in for a user
    //    already mid-edit on B when A's editor opens the same page.
    await b.call('ensureRoom', { pageId: page.id })
    await b.call('localEdit', { pageId: page.id, text: ' Extra from B.' })

    // -> Give B's live `update` broadcast time to reach A and be dropped: A has no room for this page
    //    yet, so `receiveRelay`'s `update` case is a no-op. Without this wait, A calling `ensureRoom` a
    //    few milliseconds later can accidentally register its room while that broadcast is still in
    //    flight and pick the edit up that way — a real but incidental path that would mask the one this
    //    test exists to exercise: the peerState handshake itself catching a late-arriving peer.
    await new Promise((resolve) => setTimeout(resolve, 200))

    // -> Realistic network latency: B's reply to A's `hello` is delayed past PEER_STATE_TIMEOUT, so A's
    //    peerState() times out and falls back to buildSeed before B's answer ever lands.
    await b.call('delayStateReplies', { ms: PEER_STATE_TIMEOUT + 200 })

    const resA = await a.call('ensureRoom', { pageId: page.id })
    // -> Falls back to the stored page — the edit B made is not in it, because the handshake timed out.
    assert.equal(resA.text, 'Stored text.')

    // -> B's delayed answer is still on its way; once it lands, A must end up with B's edit too rather
    //    than permanently missing it because nobody was still waiting for the reply.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const caughtUp = await a.call('roomText', { pageId: page.id })
    assert.equal(caughtUp.text, 'Stored text. Extra from B.')
  })

  test('a partial relay message from an instance that goes quiet mid-relay still expires, not leaks', async () => {
    // -> `reassemble()` accounts for chunks purely by envelope key — no room needs to exist for this
    //    page id, which is the point: B "goes down" mid multi-chunk relay, publishing only 2 of the 3
    //    chunks a real update would have split into, and A must not hold the remainder forever.
    const pageId = 'relay-only-no-room'
    await b.call('publishIncomplete', {
      pageId,
      totalLength: 12000,
      chunkSize: 5000,
      skipChunk: 2,
      messageId: 'msg-crash'
    })

    // -> Poll for the NOTIFY to land instead of a fixed wait, then confirm A actually captured the
    //    partial chunks.
    const midway = await pollUntil(
      () => a.call('partialsSize'),
      (result) => result.size === 1
    )
    assert.equal(midway.size, 1, 'the two delivered chunks are held, waiting for the third')

    await new Promise((resolve) => setTimeout(resolve, RELAY_REASSEMBLY_TIMEOUT))
    const after = await a.call('partialsSize')
    assert.equal(after.size, 0, 'the abandoned partial was dropped rather than held forever')
  })

  test('concurrent bursty edits from several sessions across two instances converge with no dropped chunks or leaked partials', async () => {
    // -> A scaled-down, CI-fast version of task 478's throwaway load test
    //    (`scripts/collab-load-test.ts`, run manually at multi-megabyte scale): the same claim — several
    //    simulated sessions, spread across real separate instances, firing concurrent bursty edits
    //    (some large enough on their own to need several `RELAY_CHUNK_SIZE` chunks) — at a size this
    //    suite can afford to run on every change.
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

    // -> Three rounds, every session editing at once each round; every third session's edit is well
    //    over RELAY_CHUNK_SIZE base64 characters on its own, forcing genuine multi-chunk relay traffic
    //    to interleave with the smaller ones rather than testing chunking and concurrency separately.
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        sessions.map(({ instance, id }, index) => {
          const big = index % 3 === 0
          const text = big ? 'x'.repeat(15000) : `edit-${round}-${index} `
          return instance.call('sessionEdit', { sessionId: id, text, position: 0 })
        })
      )
    }

    // -> Poll for convergence instead of a fixed drain: the success path returns as soon as the relay
    //    has actually settled, and a genuine drop or misorder still fails after a generous deadline
    //    rather than masquerading as a timing shortfall.
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
    // -> The literal scenario the doc comment at the top of this file promises and task 482 exists to
    //    verify end to end: two browser tabs on the same page (here, two sessions on the same instance
    //    -- the room stays open throughout because B never leaves), one goes offline, keeps being typed
    //    into locally, and comes back. No text may be duplicated or dropped in either direction.
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

    // -> Both editing normally, before anyone goes offline.
    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'A1 ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B1 ' })
    // -> Poll for both edits to reach the room instead of a fixed wait.
    await pollUntil(
      () => a.call('roomText', { pageId: page.id }),
      (result) => result.text.includes('A1') && result.text.includes('B1')
    )

    // -> A's tab loses connectivity. The room is not torn down: B is still in it.
    await a.call('disconnectSession', { sessionId: 'sess-a' })
    const stillOpen = await a.call('roomText', { pageId: page.id })
    assert.equal(stillOpen.exists, true, 'the room must survive one of two sessions dropping')

    // -> A keeps typing locally -- past what `SYNC_TIMEOUT` would have given up waiting for -- and B
    //    keeps typing too, unaware A is gone.
    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'OFFLINE-FROM-A ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B2-WHILE-A-OFFLINE ' })

    // -> Poll for B's edit to reach the room instead of a fixed wait, then confirm the disconnect was
    //    real, not a no-op: the room got B's edit but never saw A's, and A's own replica never heard
    //    about B's either.
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

    // -> Connectivity restored. The reconnect must both push A's offline edits out and pull down what
    //    the room gained while A was away. Poll for convergence instead of a fixed wait.
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
