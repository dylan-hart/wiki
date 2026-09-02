import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createDeferred } from './common.ts'
import { paginate } from './pagination.ts'

describe('paginate', () => {
  test('returns the page of rows alongside the unwrapped total', async () => {
    const result = await paginate({
      rows: async () => [{ id: 'a' }, { id: 'b' }],
      total: async () => [{ total: 57 }]
    })

    assert.deepEqual(result, { total: 57, rows: [{ id: 'a' }, { id: 'b' }] })
  })

  test('runs both queries concurrently rather than one after the other', async () => {
    const rowsStarted = createDeferred()
    const totalStarted = createDeferred()

    const pending = paginate({
      rows: async () => {
        rowsStarted.resolve()
        // -> Only settles once the count query has ALSO started: a sequential implementation
        //    deadlocks here instead of resolving.
        await totalStarted.promise
        return [{ id: 'a' }]
      },
      total: async () => {
        totalStarted.resolve()
        await rowsStarted.promise
        return [{ total: 1 }]
      }
    })

    assert.deepEqual(await pending, { total: 1, rows: [{ id: 'a' }] })
  })

  test('reports zero rather than undefined when the count query returns nothing', async () => {
    const result = await paginate({
      rows: async () => [],
      total: async () => []
    })

    assert.deepEqual(result, { total: 0, rows: [] })
  })

  test('propagates a failure from either query', async () => {
    await assert.rejects(
      paginate({
        rows: async () => {
          throw new Error('rows blew up')
        },
        total: async () => [{ total: 0 }]
      }),
      /rows blew up/
    )
    await assert.rejects(
      paginate({
        rows: async () => [],
        total: async () => {
          throw new Error('count blew up')
        }
      }),
      /count blew up/
    )
  })
})
