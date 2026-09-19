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
 * Runs against a real Postgres: the point is genuine cross-connection locking semantics, which a
 * mock `Pool` would only re-describe.
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
  // -> A head start, so `first` is the one holding the lock when `second` tries to acquire it.
  await delay(20)
  const second = withAdvisoryLock(key, async () => {
    order.push('second-start')
    order.push('second-end')
  })

  await Promise.all([first, second])
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

    // -> Raced against a timeout so a lock left held fails the test instead of stalling it.
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

    // -> Small backoff, so several polls (not one lucky one) land before the holder releases.
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

    // -> Held well past the contender's whole retry budget.
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
    assert.ok(
      Date.now() - startedAt < 400,
      'gave up far slower than its own backoff schedule allows'
    )

    await holder
  }
)

/**
 * No real Postgres: a live connection gives no way to make the unlock query alone reject.
 * `getLockPool()` constructs its own `Pool`, so the seam is `Pool.prototype.connect`.
 */
describe('when the unlock query itself rejects', () => {
  test('propagates the error thrown by fn unchanged, and discards rather than returns the client', async () => {
    const query = mock.fn(async (sql: string) => {
      if (sql.includes('_unlock(')) {
        throw new Error('connection terminated unexpectedly')
      }
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

    assert.equal(release.mock.calls.length, 1)
    assert.equal(release.mock.calls[0].arguments[0], true)
    assert.equal(warn.mock.calls.length, 1)
  })
})
