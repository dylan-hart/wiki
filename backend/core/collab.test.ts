import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import * as Y from 'yjs'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import collab, {
  RELAY_CHUNK_SIZE,
  RELAY_REASSEMBLY_TIMEOUT,
  PEER_STATE_TIMEOUT,
  buildSeed
} from './collab.ts'

/**
 * `core/collab.ts` covers two very different kinds of behavior, tested two very different ways:
 *
 * - `buildSeed` and `reassemble()` are pure functions of their arguments — no `WIKI`, no I/O — so they
 *   get ordinary unit tests, always run.
 * - Everything else in this file's doc comment ("Across instances") is a claim about what happens when
 *   *two real instances* race each other over postgres LISTEN/NOTIFY: a cold-start seeding race, a
 *   handshake timing out under latency, a relay message losing its sender mid-flight. A mock of the
 *   query builder would just restate the code under test, so these run two genuinely separate `WIKI`
 *   globals — one per worker thread, see `test/collabWorker.ts` — against a real, migrated database.
 */

describe('buildSeed', () => {
  const page = {
    content: '# Hello\n\nSome text.',
    title: 'Hello',
    description: 'A page',
    icon: 'mdi:home'
  }

  test('is deterministic: the same page always produces byte-identical bytes', () => {
    const a = buildSeed(page)
    const b = buildSeed(page)
    assert.deepEqual(a, b)
  })

  test('different content produces different bytes', () => {
    const a = buildSeed(page)
    const b = buildSeed({ ...page, content: 'different' })
    assert.notDeepEqual(a, b)
  })

  test('missing fields fall back to empty strings rather than throwing', () => {
    assert.doesNotThrow(() => buildSeed({}))
  })

  test('two instances cold-starting the same page converge to one copy of the text, not two', () => {
    // -> This is the guarantee the whole client-id-0 trick exists for: two instances that both give up
    //    waiting for a peer and seed independently must merge as if only one of them had seeded at all.
    const seedA = buildSeed(page)
    const seedB = buildSeed(page)

    const merged = new Y.Doc()
    Y.applyUpdate(merged, seedA)
    Y.applyUpdate(merged, seedB)

    const single = new Y.Doc()
    Y.applyUpdate(single, seedA)

    assert.equal(merged.getText('content').toString(), page.content)
    assert.equal(merged.getText('content').toString(), single.getText('content').toString())
    // -> Byte-identical states merge to a document of the identical size, not a doubled one.
    assert.deepEqual(Y.encodeStateAsUpdate(merged), Y.encodeStateAsUpdate(single))
  })
})

describe('RELAY_CHUNK_SIZE', () => {
  test('the worst-case relay envelope stays under the 8000-byte NOTIFY cap (task 478)', () => {
    // -> Every optional field populated, each at its real worst-case length: `i`/`to` are a 10-char
    //    `nanoid` (see `WIKI.INSTANCE_ID` in `index.ts`), `r` a full 36-char page uuid, `t` the longest
    //    of the five message types, and `m`/`c`/`n` generously long numbers — this is what `relay()`
    //    actually sends for a chunk of a large `update`/`state` message, not a hypothetical worse case.
    const worstCase = {
      i: 'V1StGXR8_Z',
      r: '550e8400-e29b-41d4-a716-446655440000',
      t: 'awareness',
      to: 'V1StGXR8_Z',
      m: '999999999',
      c: 999999,
      n: 999999,
      p: 'A'.repeat(RELAY_CHUNK_SIZE)
    }
    const bytes = Buffer.byteLength(JSON.stringify(worstCase))
    assert.ok(
      bytes <= 8000,
      `worst-case envelope is ${bytes} bytes, over postgres's 8000-byte NOTIFY cap`
    )
  })
})

describe('reassemble()', () => {
  function fresh(): typeof collab {
    // -> A shallow copy with its own `partials` map, so each test's chunk bookkeeping can't leak into
    //    another's — `reassemble` only ever touches `this.partials`, so this is a real isolated instance
    //    of just the piece under test, not a fake of it.
    return { ...collab, partials: new Map() }
  }

  test('assembles chunks that arrive in order', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 3,
      p
    })
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    assert.equal(c.reassemble(envelope(1, 'bb')), null)
    assert.equal(c.reassemble(envelope(2, 'cc')), 'aabbcc')
  })

  test('assembles chunks that arrive out of order', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 3,
      p
    })
    assert.equal(c.reassemble(envelope(2, 'cc')), null)
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    assert.equal(c.reassemble(envelope(1, 'bb')), 'aabbcc')
  })

  test('a duplicate chunk index is ignored rather than double-counted', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 2,
      p
    })
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    // -> Resent chunk 0: must not count down `remaining` a second time, or a real chunk 1 arriving
    //    later would leave `remaining` stuck above zero and the message never assembles.
    assert.equal(c.reassemble(envelope(0, 'aa')), null)
    assert.equal(c.reassemble(envelope(1, 'bb')), 'aabb')
  })

  test('different senders or message ids never share a partial', () => {
    const c = fresh()
    assert.equal(
      c.reassemble({ i: 'peerA', r: 'p', t: 'update', m: 'm1', c: 0, n: 2, p: 'A0' }),
      null
    )
    assert.equal(
      c.reassemble({ i: 'peerB', r: 'p', t: 'update', m: 'm1', c: 0, n: 2, p: 'B0' }),
      null
    )
    assert.equal(
      c.reassemble({ i: 'peerA', r: 'p', t: 'update', m: 'm1', c: 1, n: 2, p: 'A1' }),
      'A0A1'
    )
    assert.equal(
      c.reassemble({ i: 'peerB', r: 'p', t: 'update', m: 'm1', c: 1, n: 2, p: 'B1' }),
      'B0B1'
    )
  })

  test('a complete message removes its own partial, freeing the key for reuse', () => {
    const c = fresh()
    const envelope = (i: number, p: string) => ({
      i: 'peer',
      r: 'page1',
      t: 'update' as const,
      m: 'msg1',
      c: i,
      n: 1,
      p
    })
    assert.equal(c.reassemble(envelope(0, 'only')), 'only')
    assert.equal(c.partials.size, 0)
  })

  test('an incomplete message expires after RELAY_REASSEMBLY_TIMEOUT rather than leaking', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const c = fresh()
    // -> Stands in for an instance that goes down mid-relay: one chunk of two ever arrives.
    assert.equal(
      c.reassemble({ i: 'peer', r: 'page1', t: 'update', m: 'msg1', c: 0, n: 2, p: 'aa' }),
      null
    )
    assert.equal(c.partials.size, 1)

    t.mock.timers.tick(RELAY_REASSEMBLY_TIMEOUT - 1)
    assert.equal(c.partials.size, 1, 'not cleaned up before its deadline')

    t.mock.timers.tick(1)
    assert.equal(c.partials.size, 0, 'cleaned up once RELAY_REASSEMBLY_TIMEOUT elapses')
  })
})

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

describe('collaborative editing across instances (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let connectionString: string
  let a: WorkerHandle
  let b: WorkerHandle

  before(async () => {
    fixtures = await setupTestDb()
    connectionString = process.env.DATABASE_URL!
    ;[a, b] = await Promise.all([
      startInstance(connectionString, fixtures.schema, 'instance-a', fixtures.siteId),
      startInstance(connectionString, fixtures.schema, 'instance-b', fixtures.siteId)
    ])
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
      { id: fixtures.userId, permissions: ['manage:system'] }
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
      { id: fixtures.userId, permissions: ['manage:system'] }
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

    // -> Give the NOTIFY a moment to land, then confirm A actually captured the partial chunks.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const midway = await a.call('partialsSize')
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
      { id: fixtures.userId, permissions: ['manage:system'] }
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

    // -> Give the relay traffic time to fully drain before checking convergence.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const texts = new Set<string>()
    for (const { instance, id } of sessions) {
      const { text } = await instance.call('sessionText', { sessionId: id })
      texts.add(text)
    }
    const roomA = await a.call('roomText', { pageId: page.id })
    const roomB = await b.call('roomText', { pageId: page.id })
    texts.add(roomA.text)
    texts.add(roomB.text)

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
      { id: fixtures.userId, permissions: ['manage:system'] }
    )

    await a.call('ensureRoom', { pageId: page.id })
    await a.call('openSession', { pageId: page.id, sessionId: 'sess-a' })
    await a.call('openSession', { pageId: page.id, sessionId: 'sess-b' })

    // -> Both editing normally, before anyone goes offline.
    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'A1 ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B1 ' })
    await new Promise((resolve) => setTimeout(resolve, 300))

    // -> A's tab loses connectivity. The room is not torn down: B is still in it.
    await a.call('disconnectSession', { sessionId: 'sess-a' })
    const stillOpen = await a.call('roomText', { pageId: page.id })
    assert.equal(stillOpen.exists, true, 'the room must survive one of two sessions dropping')

    // -> A keeps typing locally -- past what `SYNC_TIMEOUT` would have given up waiting for -- and B
    //    keeps typing too, unaware A is gone.
    await a.call('sessionEdit', { sessionId: 'sess-a', text: 'OFFLINE-FROM-A ' })
    await a.call('sessionEdit', { sessionId: 'sess-b', text: 'B2-WHILE-A-OFFLINE ' })
    await new Promise((resolve) => setTimeout(resolve, 300))

    // -> Proof the disconnect was real, not a no-op: the room got B's edit but never saw A's, and A's
    //    own replica never heard about B's either.
    const whileOffline = await a.call('roomText', { pageId: page.id })
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
    //    the room gained while A was away.
    await a.call('reconnectSession', { pageId: page.id, sessionId: 'sess-a' })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const finalA = await a.call('sessionText', { sessionId: 'sess-a' })
    const finalB = await a.call('sessionText', { sessionId: 'sess-b' })
    const finalRoom = await a.call('roomText', { pageId: page.id })

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
