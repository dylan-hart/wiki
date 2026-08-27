import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import {
  MAX_CONCURRENT_BROWSERS,
  MAX_QUEUED_LAUNCHES,
  launchUnderSemaphore,
  resetLaunchSemaphoreForTests
} from './puppeteer.ts'

/**
 * `launchUnderSemaphore` is the process-wide gate `launchPuppeteerBrowser` puts every real
 * `puppeteer.launch()` call through (OpenProject #2258/#2259). Tested directly here with a stubbed
 * `launch`, rather than through `launchPuppeteerBrowser` itself, so nothing needs the real `puppeteer`
 * package or Node module-mocking — the semaphore's behavior does not depend on what `launch` actually
 * does, only on when it is allowed to run.
 */
describe('launchUnderSemaphore', () => {
  beforeEach(() => {
    resetLaunchSemaphoreForTests()
  })

  function makeBrowser() {
    return { close: async () => {} }
  }

  test('never lets more launches run than the concurrency ceiling', async () => {
    const resolvers: Array<(value: any) => void> = []
    let launchCalls = 0

    function launch() {
      launchCalls++
      return new Promise((resolve) => {
        resolvers.push(resolve)
      })
    }

    const attemptCount = MAX_CONCURRENT_BROWSERS + 2
    const attempts = Array.from({ length: attemptCount }, () => launchUnderSemaphore('t', launch))

    // Give the microtask queue a turn: only the ceiling's worth of launches should actually have
    // started — the rest are waiting on a slot, not yet calling `launch` at all.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(launchCalls, MAX_CONCURRENT_BROWSERS)

    // Resolve and close one launch at a time. Each close should free exactly one slot, letting
    // exactly one more queued launch start — never more than the ceiling at once.
    for (let i = 0; i < attemptCount; i++) {
      resolvers[i](makeBrowser())
      const browser = await attempts[i]

      const stillQueued = attemptCount - (i + 1) > MAX_CONCURRENT_BROWSERS - 1
      if (stillQueued) {
        // A queued launch has not been let through yet — closing frees its slot.
        assert.equal(launchCalls, MAX_CONCURRENT_BROWSERS + i)
      }

      await browser.close()

      if (stillQueued) {
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(launchCalls, MAX_CONCURRENT_BROWSERS + i + 1)
      }
    }

    assert.equal(launchCalls, attemptCount)
  })

  test('a failed launch releases its slot immediately, not only on close', async () => {
    let launchCalls = 0
    async function failingLaunch() {
      launchCalls++
      throw new Error('boom')
    }

    // Fail exactly `MAX_CONCURRENT_BROWSERS` times, sequentially. If a failure did not free its
    // slot, the ceiling would fill up on real launches never reached and this loop would hang.
    for (let i = 0; i < MAX_CONCURRENT_BROWSERS; i++) {
      await assert.rejects(() => launchUnderSemaphore('launchFailed', failingLaunch), /boom/)
    }
    assert.equal(launchCalls, MAX_CONCURRENT_BROWSERS)

    // The ceiling should be back to fully free: a fresh batch at exactly the ceiling should all
    // start immediately with no queueing.
    let concurrentOkLaunches = 0
    async function okLaunch() {
      concurrentOkLaunches++
      return makeBrowser()
    }
    const oks = Array.from({ length: MAX_CONCURRENT_BROWSERS }, () =>
      launchUnderSemaphore('t', okLaunch)
    )
    const browsers = await Promise.all(oks)
    assert.equal(concurrentOkLaunches, MAX_CONCURRENT_BROWSERS)

    await Promise.all(browsers.map((browser) => browser.close()))
  })

  test('rejects a caller past the bounded waiter queue with a 503 rather than queuing indefinitely', async () => {
    function neverLaunch() {
      // Never resolves — standing in for a launch a caller is still waiting on. These attempts
      // are deliberately left pending forever; `beforeEach`'s `resetLaunchSemaphoreForTests()`
      // is what keeps this from leaking into the next test, not any cleanup here.
      return new Promise(() => {})
    }

    // Fill the ceiling, then fill the waiter queue right up to its bound.
    for (let i = 0; i < MAX_CONCURRENT_BROWSERS + MAX_QUEUED_LAUNCHES; i++) {
      void launchUnderSemaphore('exportOverloaded', neverLaunch)
    }
    await new Promise((resolve) => setImmediate(resolve))

    // One more, past the bound, must be rejected right away — never left hanging.
    await assert.rejects(
      () => launchUnderSemaphore('exportOverloaded', neverLaunch),
      (err: any) => {
        assert.equal(err.name, 'exportOverloaded')
        assert.equal(err.statusCode, 503)
        return true
      }
    )
  })
})
