import { test, describe, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { withAdvisoryLock } from './advisoryLock.ts'

/**
 * Exercises `withAdvisoryLock` against a real Postgres instance — the whole point of this helper is
 * genuine cross-connection locking semantics (`pg_advisory_lock`/`pg_advisory_unlock`), which a mock
 * `Pool` would only re-describe rather than verify. See `dispatch-storage.test.ts` for the
 * dependency-injected `withLock` unit tests that cover the caller's own control flow instead.
 *
 * Skipped unless `DATABASE_URL` points at a real database — see `contentSync.test.ts` for the same
 * convention. Migrations are not required: this only ever calls `pg_advisory_lock`/`_unlock`, which
 * need no schema.
 */
const DATABASE_URL = process.env.DATABASE_URL
const skip = DATABASE_URL
  ? false
  : 'requires DATABASE_URL (a Postgres instance, no migrations needed)'

let pool: Pool

before(() => {
  if (!DATABASE_URL) {
    return
  }
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 })
  ;(globalThis as any).WIKI = { db: { $client: pool } }
})

after(async () => {
  if (!DATABASE_URL) {
    return
  }
  await pool.end()
})

test('serializes two concurrent holders of the same key', { skip }, async () => {
  const key = `advisory-lock-test-same-${Date.now()}`
  const order: string[] = []

  const first = withAdvisoryLock(key, async () => {
    order.push('first-start')
    await delay(150)
    order.push('first-end')
  })
  // -> Give `first` a head start so it is the one holding the lock when `second` tries to acquire it.
  await delay(20)
  const second = withAdvisoryLock(key, async () => {
    order.push('second-start')
    order.push('second-end')
  })

  await Promise.all([first, second])
  // -> `second-start` never lands between `first-start` and `first-end` — it blocks until `first`
  //    has fully released the lock, rather than interleaving with it.
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
})

test('two different keys do not serialize against each other', { skip }, async () => {
  const order: string[] = []
  const keyA = `advisory-lock-test-a-${Date.now()}`
  const keyB = `advisory-lock-test-b-${Date.now()}`

  const a = withAdvisoryLock(keyA, async () => {
    order.push('a-start')
    await delay(100)
    order.push('a-end')
  })
  await delay(20)
  const b = withAdvisoryLock(keyB, async () => {
    // -> If `b` were blocked behind `a`'s key, this would never run before `a-end`.
    order.push('b-start')
    order.push('b-end')
  })

  await Promise.all([a, b])
  assert.ok(
    order.indexOf('b-start') < order.indexOf('a-end'),
    `expected interleaving, got ${order}`
  )
})

test(
  'releases the lock even when fn throws, so a later holder is not blocked forever',
  { skip },
  async () => {
    const key = `advisory-lock-test-throw-${Date.now()}`

    await assert.rejects(
      withAdvisoryLock(key, async () => {
        throw new Error('boom')
      }),
      /boom/
    )

    // -> Races the second acquisition against a short timeout: if the first call's failure left the
    //    lock held, this hangs past the timeout and the test fails instead of passing vacuously.
    const acquired = await Promise.race([
      withAdvisoryLock(key, async () => 'acquired'),
      delay(1000).then(() => 'timed-out')
    ])
    assert.equal(acquired, 'acquired')
  }
)

/**
 * Unlike the suite above, this needs no real Postgres: the whole point is to control which of the
 * two queries rejects, which a real connection gives no way to steer deliberately. A fake `Pool`/
 * `Client` pair is exactly what `WIKI.db.$client` is expected to be shaped like — not a mock of
 * locking semantics themselves, just of which query fails.
 */
describe('when the unlock query itself rejects', () => {
  test('propagates the error thrown by fn unchanged, and discards rather than returns the client', async () => {
    const query = mock.fn(async (sql: string) => {
      if (sql.includes('_unlock(')) {
        throw new Error('connection terminated unexpectedly')
      }
    })
    const release = mock.fn()
    const client = { query, release }
    const connect = mock.fn(async () => client)
    const warn = mock.fn()

    const previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { db: { $client: { connect } }, logger: { warn } }
    try {
      await assert.rejects(
        withAdvisoryLock('some-key', async () => {
          throw new Error('boom from fn')
        }),
        /boom from fn/
      )
    } finally {
      ;(globalThis as any).WIKI = previousWiki
    }

    // -> `fn`'s own error survives unchanged — not replaced by the unlock query's rejection.
    // -> The client is discarded (`release(true)`), not returned to the pool with an uncertain lock
    //    state.
    assert.equal(release.mock.calls.length, 1)
    assert.equal(release.mock.calls[0].arguments[0], true)
    // -> The unlock failure is logged rather than silently dropped.
    assert.equal(warn.mock.calls.length, 1)
  })
})
