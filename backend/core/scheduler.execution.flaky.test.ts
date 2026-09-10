/**
 * QUARANTINED — this file is in the `*.flaky.*` lane and does NOT run under `npm run test`. It runs
 * under `npm run test:flaky`, which CI reports on but does not gate on. See
 * `docs/decisions/flaky-test-quarantine.md` for the lane's rules.
 *
 * **Expires 2026-12-10.** By then this test is either fixed or deleted.
 *
 * **Why it is here.** OpenProject #2992: CI run 34474218555 (2026-09-10) failed this test not on its
 * own `elapsed >= 5500` assertion but on node:test's own 600000ms per-test ceiling — the backup timer
 * (`helpers/timeout.ts#withTimeout`'s freestanding `setTimeout`, registered synchronously and
 * independent of the worker thread's fate) never fired inside ten real minutes, only six seconds
 * after it should have. That is not a product bug: the sibling abort-ceiling test below, built on the
 * exact same harness, passed in that same run, and nothing in `core/scheduler.ts` or
 * `helpers/timeout.ts` had changed recently. A plain `setTimeout` missing its own 6-second ceiling by
 * two orders of magnitude means the whole event loop was starved at that moment — consistent with
 * that run's backend suite taking ~693s end to end — not that `executeOnWorker` is wrong. Whether a
 * real poolifier worker thread crashes, gets scheduled, and is reaped inside any fixed wall-clock
 * budget is a fact about the whole run's resource contention, not about the code under test, which is
 * exactly `docs/decisions/flaky-test-quarantine.md`'s "event-loop/wall-clock timing margin" category.
 *
 * Its sibling in `core/scheduler.execution.test.ts` ("a hung-but-alive task is aborted at the
 * taskTimeout ceiling") asserts the OTHER ceiling on the same harness and stayed in the default lane:
 * a starved event loop only delays it further past its own upper bound, so a slow run cannot falsify
 * it the way it can this test's exact lower bound.
 *
 * **The fix that retires it.** There is no way to make a real worker-thread crash-and-reap race
 * deterministic without replacing the real `FixedThreadPool` this test exists to exercise (see the
 * task 704 (a) comment on its sibling) with a mock of one — which is the coverage gap
 * `docs/decisions/testing-strategy.md` wrote this suite to close in the first place. Retiring this
 * quarantine means either accepting a materially looser bound (so an event-loop stall inside CI's own
 * per-test ceiling no longer trips it) or giving `executeOnWorker` an injectable "worker exited"
 * signal a unit test can drive directly, with the real-pool version kept as a slower, non-gating
 * confidence check rather than the assertion of record.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { FixedThreadPool } from 'poolifier'
import { ensureTemporal } from '../test/temporal.ts'
import { installTestWiki } from '../test/mocks.ts'

let scheduler: any

before(async () => {
  await ensureTemporal()
  scheduler = (await import('./scheduler.ts')).default
})

describe('executeOnWorker (real worker pool) — backup timer on a worker crash', () => {
  let wikiHandle: { restore(): void }
  let pool: any

  before(() => {
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      // -> 1s: short enough to keep the suite fast, long enough that the two ceilings (taskTimeout
      //    alone vs. taskTimeout + the fixed 5s TASK_TIMEOUT_GRACE) land clearly apart in wall time.
      config: { scheduler: { taskTimeout: 1 } }
    })
  })

  after(() => {
    wikiHandle.restore()
  })

  afterEach(async () => {
    await pool?.destroy()
    // -> Mirrors the same OpenProject #2927 leaked-handle guard as the non-flaky sibling file — a
    //    worker node still registered here is a thread still running, and `--test-force-exit` is what
    //    turns that into a named failure instead of a silent hang.
    assert.equal(
      pool?.workerNodes.length ?? 0,
      0,
      'pool.destroy() returned with a worker node (a live thread) still registered'
    )
    pool = null
  })

  test('a worker that exits mid-task is caught only by the backup timer, after taskTimeout + grace', async () => {
    pool = new FixedThreadPool(
      1,
      path.join(import.meta.dirname, '../test/fixtures/schedulerCrashWorker.ts'),
      {
        errorHandler: () => {},
        exitHandler: () => {}
      }
    )
    scheduler.workerPool = pool

    const start = Date.now()
    await assert.rejects(scheduler.executeOnWorker({ task: 'x', payload: { mode: 'crash' } }))
    const elapsed = Date.now() - start
    // -> The worker is gone before the abort signal has anything left to abort, so only the backup
    //    `setTimeout` at taskTimeout + TASK_TIMEOUT_GRACE (1s + 5s = 6s) rejects this.
    assert.ok(elapsed >= 5500, `expected the backup timer (~6s) to fire, took ${elapsed}ms`)
  })
})
