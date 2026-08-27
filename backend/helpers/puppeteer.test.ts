import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MAX_CONCURRENT_BROWSERS, MAX_QUEUED_LAUNCHES, runWithBrowserSlot } from './puppeteer.ts'

/**
 * `runWithBrowserSlot` is what `launchPuppeteerBrowser` funnels every real launch through — see its
 * own doc comment. Testing it directly against a stub launcher (rather than through
 * `launchPuppeteerBrowser` itself) exercises the exact same gating logic without touching the real
 * dynamic `import('puppeteer')`, which this file never does.
 *
 * A "browser" here is the smallest shape the semaphore cares about: something with a `close()` a
 * caller eventually calls. `deferred()` builds a promise a test can resolve/reject from outside,
 * standing in for a slow `puppeteer.launch()` a test wants to hold open to observe queueing.
 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function stubBrowser() {
  return { close: async () => {} }
}

/** Flush every microtask queued so far, without letting a macrotask (timer, I/O) run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('runWithBrowserSlot', () => {
  test('never runs more than MAX_CONCURRENT_BROWSERS launches at once', async () => {
    const holds = Array.from({ length: MAX_CONCURRENT_BROWSERS }, () =>
      deferred<{ close: () => Promise<void> }>()
    )
    let started = 0
    const ceilingAttempts = holds.map((hold) =>
      runWithBrowserSlot('testError', async () => {
        started++
        return hold.promise
      })
    )
    await tick()
    assert.equal(
      started,
      MAX_CONCURRENT_BROWSERS,
      'the ceiling worth of launches should have started'
    )

    // One more, while the ceiling is full: must queue rather than start.
    let overflowStarted = false
    const overflowAttempt = runWithBrowserSlot('testError', async () => {
      overflowStarted = true
      return stubBrowser()
    })
    await tick()
    assert.equal(overflowStarted, false, 'a launch past the ceiling must not start yet')
    assert.equal(started, MAX_CONCURRENT_BROWSERS, 'the ceiling must not have grown past its limit')

    // Free one slot; the queued launch should now be free to start.
    for (const hold of holds) {
      hold.resolve(stubBrowser())
    }
    const ceilingBrowsers = await Promise.all(ceilingAttempts)
    await ceilingBrowsers[0].close()

    const overflowBrowser = await overflowAttempt
    assert.equal(overflowStarted, true, 'the queued launch should start once a slot frees up')
    await overflowBrowser.close()

    for (const browser of ceilingBrowsers.slice(1)) {
      await browser.close()
    }
  })

  test('a failed launch releases its slot rather than leaking it', async () => {
    await assert.rejects(
      () =>
        runWithBrowserSlot('testError', async () => {
          throw new Error('boom')
        }),
      /boom/
    )

    // If the failed attempt above had leaked its slot, one of these MAX_CONCURRENT_BROWSERS launches
    // would be left queued instead of starting immediately.
    const started: number[] = []
    const attempts = Array.from({ length: MAX_CONCURRENT_BROWSERS }, (_unused, i) =>
      runWithBrowserSlot('testError', async () => {
        started.push(i)
        return stubBrowser()
      })
    )
    await tick()
    assert.deepEqual(
      started.slice().sort(),
      Array.from({ length: MAX_CONCURRENT_BROWSERS }, (_u, i) => i),
      'every one of these launches should have started, proving the failed launch above gave its slot back'
    )

    const browsers = await Promise.all(attempts)
    for (const browser of browsers) {
      await browser.close()
    }
  })

  test('a caller past the bounded waiter queue is rejected with a 503, not left hanging', async () => {
    // Occupy the ceiling for real, and keep it occupied (never close these yet).
    const ceilingAttempts = Array.from({ length: MAX_CONCURRENT_BROWSERS }, () =>
      runWithBrowserSlot('testError', async () => stubBrowser())
    )
    const ceilingBrowsers = await Promise.all(ceilingAttempts)

    // Fill the waiter queue up to its bound. Each of these is stuck behind the full ceiling above, so
    // none of them has called its own launch function yet — resolving the deferred now is safe; it
    // will only be read once this waiter is actually woken further down.
    const queuedHolds = Array.from({ length: MAX_QUEUED_LAUNCHES }, () =>
      deferred<{ close: () => Promise<void> }>()
    )
    const queuedAttempts = queuedHolds.map((hold) =>
      runWithBrowserSlot('testError', () => hold.promise)
    )
    await tick()

    // One more, past both the ceiling and the full waiter queue, must reject immediately with a 503
    // rather than join the queue and hang.
    await assert.rejects(
      () => runWithBrowserSlot('testError', async () => stubBrowser()),
      (err: any) => {
        assert.equal(err.name, 'testError')
        assert.equal(err.statusCode, 503)
        return true
      }
    )

    // Clean up in FIFO order: each close() frees exactly one slot for the next queued waiter, so
    // awaiting-then-closing one at a time drains the whole queue without deadlocking on Promise.all.
    for (const hold of queuedHolds) {
      hold.resolve(stubBrowser())
    }
    for (const browser of ceilingBrowsers) {
      await browser.close()
    }
    for (const attempt of queuedAttempts) {
      const browser = await attempt
      await browser.close()
    }
  })
})
