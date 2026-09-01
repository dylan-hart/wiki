import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { getJobExecutionContext, runWithJobExecutionContext } from './jobExecutionContext.ts'

describe('jobExecutionContext', () => {
  test('returns undefined outside any runWithJobExecutionContext call', () => {
    assert.equal(getJobExecutionContext(), undefined)
  })

  test('is visible synchronously inside the wrapped callback', () => {
    let seen: ReturnType<typeof getJobExecutionContext>
    runWithJobExecutionContext({ jobId: 'job-1', attempt: 1 }, () => {
      seen = getJobExecutionContext()
    })
    assert.deepEqual(seen, { jobId: 'job-1', attempt: 1 })
  })

  test('is visible across an await inside the wrapped callback', async () => {
    let seen: ReturnType<typeof getJobExecutionContext>
    await runWithJobExecutionContext({ jobId: 'job-2', attempt: 3 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen = getJobExecutionContext()
    })
    assert.deepEqual(seen, { jobId: 'job-2', attempt: 3 })
  })

  test('is gone once the wrapped callback has returned', async () => {
    await runWithJobExecutionContext({ jobId: 'job-3', attempt: 1 }, async () => {})
    assert.equal(getJobExecutionContext(), undefined)
  })

  test('a still-running continuation keeps its own captured context after a later, unrelated run starts', async () => {
    const seenByStale: ReturnType<typeof getJobExecutionContext>[] = []

    // -> Models the real scenario: a "stale" task is launched first and keeps running in the
    //    background (its continuation hasn't resumed yet), then a second, unrelated context is
    //    entered and exits before the stale one ever gets to read the store back.
    const stale = runWithJobExecutionContext({ jobId: 'job-4', attempt: 1 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      seenByStale.push(getJobExecutionContext())
    })

    await runWithJobExecutionContext({ jobId: 'job-4', attempt: 2 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })

    await stale

    assert.deepEqual(seenByStale, [{ jobId: 'job-4', attempt: 1 }])
  })

  test('two concurrent contexts do not leak into each other', async () => {
    const seen: Record<string, ReturnType<typeof getJobExecutionContext>> = {}

    await Promise.all([
      runWithJobExecutionContext({ jobId: 'job-a', attempt: 1 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        seen.a = getJobExecutionContext()
      }),
      runWithJobExecutionContext({ jobId: 'job-b', attempt: 5 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        seen.b = getJobExecutionContext()
      })
    ])

    assert.deepEqual(seen.a, { jobId: 'job-a', attempt: 1 })
    assert.deepEqual(seen.b, { jobId: 'job-b', attempt: 5 })
  })
})
