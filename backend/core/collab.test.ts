import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import * as Y from 'yjs'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import collab, { RELAY_REASSEMBLY_TIMEOUT, PEER_STATE_TIMEOUT, buildSeed } from './collab.ts'

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
})
