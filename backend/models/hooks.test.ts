import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { jobHistory as jobHistoryTable } from '../db/schema.ts'

/**
 * `getDeliveryHistory()` is a filtered, paginated read against the shared `jobHistory` table (a
 * `task = 'dispatchWebhook'` + `payload->>'hookId'` match, backed by a partial expression index) —
 * squarely the kind of SQL orchestration CLAUDE.md says to verify against a real database rather than
 * a mock of the query builder.
 */
describe('hooks getDeliveryHistory (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let hooksModel: typeof import('./hooks.ts').hooks

  before(async () => {
    fixtures = await setupTestDb()
    ;({ hooks: hooksModel } = await import('./hooks.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Inserts one `jobHistory` row shaped like a `dispatchWebhook` execution (or another task/hook). */
  async function insertDelivery(
    hookId: string,
    overrides: Partial<{
      task: string
      event: string
      state: 'active' | 'completed' | 'failed' | 'interrupted'
      attempt: number
      maxRetries: number
      lastErrorMessage: string | null
      startedAt: Date
      completedAt: Date | null
    }> = {}
  ) {
    const {
      task = 'dispatchWebhook',
      event = 'page:create',
      state = 'completed',
      attempt = 1,
      maxRetries = 3,
      lastErrorMessage = null,
      startedAt = new Date(),
      completedAt = new Date()
    } = overrides
    await fixtures.db.insert(jobHistoryTable).values({
      task,
      state,
      payload: { hookId, event, data: {}, instance: 'test' },
      attempt,
      maxRetries,
      lastErrorMessage,
      createdAt: startedAt,
      startedAt,
      completedAt
    })
  }

  test('returns only dispatchWebhook deliveries for the requested hook', async () => {
    const hookId = randomUUID()
    const otherHookId = randomUUID()

    await insertDelivery(hookId, { event: 'page:create' })
    // -> Same task, different hook: must not leak in
    await insertDelivery(otherHookId, { event: 'page:edit' })
    // -> Same hookId, different task: must not leak in either — the payload shape is coincidental
    await insertDelivery(hookId, { task: 'cleanJobHistory', event: 'page:delete' })

    const page = await hooksModel.getDeliveryHistory(hookId)

    assert.equal(page.total, 1)
    assert.equal(page.deliveries.length, 1)
    assert.equal(page.deliveries[0]!.event, 'page:create')
  })

  test('orders by startedAt desc and reports fields per row', async () => {
    const hookId = randomUUID()
    const older = new Date(Date.now() - 60_000)
    const newer = new Date()

    await insertDelivery(hookId, {
      event: 'page:edit',
      state: 'failed',
      attempt: 2,
      maxRetries: 3,
      lastErrorMessage: 'The endpoint answered with HTTP 500.',
      startedAt: older,
      completedAt: older
    })
    await insertDelivery(hookId, {
      event: 'page:create',
      state: 'completed',
      attempt: 1,
      maxRetries: 3,
      lastErrorMessage: null,
      startedAt: newer,
      completedAt: newer
    })

    const page = await hooksModel.getDeliveryHistory(hookId)

    assert.equal(page.total, 2)
    assert.equal(page.deliveries.length, 2)
    assert.equal(page.deliveries[0]!.event, 'page:create')
    assert.equal(page.deliveries[0]!.state, 'completed')
    assert.equal(page.deliveries[0]!.lastErrorMessage, null)
    assert.equal(page.deliveries[1]!.event, 'page:edit')
    assert.equal(page.deliveries[1]!.state, 'failed')
    assert.equal(page.deliveries[1]!.attempt, 2)
    assert.equal(page.deliveries[1]!.lastErrorMessage, 'The endpoint answered with HTTP 500.')
  })

  test('total counts every match while deliveries is capped at limit', async () => {
    const hookId = randomUUID()
    for (let i = 0; i < 5; i++) {
      await insertDelivery(hookId, { event: 'page:create', startedAt: new Date(Date.now() - i) })
    }

    const page = await hooksModel.getDeliveryHistory(hookId, { limit: 2 })

    assert.equal(page.total, 5)
    assert.equal(page.deliveries.length, 2)
  })
})
