import { test, describe, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import {
  withAdvisoryLock,
  AdvisoryLockAcquisitionError,
  _resetLockPoolForTests
} from './advisoryLock.ts'

let wikiHandle: { restore(): void }
import { installTestWiki } from '../test/mocks.ts'

/**
 * Exercises `withAdvisoryLock` against a real Postgres instance — the whole point of this helper is
 * genuine cross-connection locking semantics (`pg_try_advisory_lock`/`pg_advisory_unlock`), which a
 * mock `Pool` would only re-describe rather than verify. See `dispatch-storage.test.ts` for the
 * dependency-injected `withLock` unit tests that cover the caller's own control flow instead.
 *
 * Skipped unless `DATABASE_URL` points at a real database — see `contentSync.test.ts` for the same
 * convention. Migrations are not required: this only ever calls
 * `pg_try_advisory_lock`/`pg_advisory_unlock`, which need no schema.
 *
 * `withAdvisoryLock` builds its own dedicated pool lazily from `WIKI.dbManager.config` (see that
 * file's header doc for why — never `WIKI.db.$client`, the request-serving pool), so the global stub
 * here only needs to supply that shape, plus `INSTANCE_ID` for the pool's `application_name`.
 * `_resetLockPoolForTests()` drops the cached pool in `after()` so the test process can exit; nothing
 * under `backend/` builds a second `Pool` directly against `DATABASE_URL` here.
 */
const DATABASE_URL = process.env.DATABASE_URL
const skip = DATABASE_URL
  ? false
  : 'requires DATABASE_URL (a Postgres instance, no migrations needed)'

before(() => {
  if (!DATABASE_URL) {
    return
  }
  wikiHandle = installTestWiki({
    dbManager: { config: { connectionString: DATABASE_URL } },
    INSTANCE_ID: 'advisory-lock-test'
  })
})

after(async () => {
  if (!DATABASE_URL) {
    return
  }
  await _resetLockPoolForTests()
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
  // -> `second-start` never lands between `first-start` and `first-end` — it backs off and retries
  //    until `first` has fully released the lock, rather than interleaving with it.
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

test(
  'a contended acquisition backs off and retries rather than blocking, and eventually succeeds',
  { skip },
  async () => {
    const key = `advisory-lock-test-backoff-success-${Date.now()}`
    const order: string[] = []

    const holder = withAdvisoryLock(key, async () => {
      order.push('holder-start')
      await delay(120)
      order.push('holder-end')
    })
    await delay(10)

    // -> Small backoff parameters so the retry loop actually runs several non-blocking attempts
    //    (rather than one lucky poll) before the holder releases at ~120ms, without the test itself
    //    waiting out production-sized delays.
    const contender = withAdvisoryLock(
      key,
      async () => {
        order.push('contender-start')
      },
      { maxAttempts: 20, baseDelayMs: 15, maxDelayMs: 30 }
    )

    await Promise.all([holder, contender])
    assert.deepEqual(order, ['holder-start', 'holder-end', 'contender-start'])
  }
)

test(
  'a contended acquisition gives up with AdvisoryLockAcquisitionError rather than blocking indefinitely',
  { skip },
  async () => {
    const key = `advisory-lock-test-backoff-giveup-${Date.now()}`

    // -> Holds the lock well past the contender's whole retry budget, so the contender is guaranteed
    //    to exhaust its attempts and reject instead of hanging or eventually succeeding.
    const holder = withAdvisoryLock(key, async () => {
      await delay(500)
    })
    await delay(10)

    const startedAt = Date.now()
    await assert.rejects(
      withAdvisoryLock(key, async () => 'unreachable', {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 20
      }),
      AdvisoryLockAcquisitionError
    )
    // -> Bounds how long giving up took: proof this actually backed off and quit rather than hanging
    //    until something external (a test timeout) killed it.
    assert.ok(
      Date.now() - startedAt < 400,
      'gave up far slower than its own backoff schedule allows'
    )

    await holder
  }
)

/**
 * Unlike the suite above, this needs no real Postgres: the whole point is to control which of the
 * two queries rejects, which a real connection gives no way to steer deliberately. `getLockPool()`
 * builds its dedicated pool from `WIKI.dbManager.config` (never `WIKI.db.$client`, the
 * request-serving pool — see this file's own header doc for why), so this mocks `Pool.prototype.connect`
 * itself rather than reaching into a client shape `withAdvisoryLock` never touches.
 */
describe('when the unlock query itself rejects', () => {
  test('propagates the error thrown by fn unchanged, and discards rather than returns the client', async () => {
    const query = mock.fn(async (sql: string) => {
      if (sql.includes('_unlock(')) {
        throw new Error('connection terminated unexpectedly')
      }
      // -> `try_advisory_lock` must report success on the first poll, or `withAdvisoryLock` would
      //    loop retrying the acquisition instead of ever reaching `fn`.
      return { rows: [{ locked: true }] }
    })
    const release = mock.fn()
    const client = { query, release }
    const connectMock = mock.method(Pool.prototype, 'connect', async () => client)
    const warn = mock.fn()

    wikiHandle = installTestWiki({
      dbManager: { config: {} },
      INSTANCE_ID: 'advisory-lock-unlock-reject-test',
      logger: { warn }
    })
    try {
      await assert.rejects(
        withAdvisoryLock('some-key', async () => {
          throw new Error('boom from fn')
        }),
        /boom from fn/
      )
    } finally {
      connectMock.mock.restore()
      await _resetLockPoolForTests()
      wikiHandle.restore()
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
