import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import {
  MAX_CONCURRENT_BROWSERS,
  MAX_QUEUED_LAUNCHES,
  getPuppeteerLaunchArgs,
  launchUnderSemaphore,
  resetLaunchSemaphoreForTests
} from './puppeteer.ts'

import { installTestWiki } from '../test/mocks.ts'

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

    // Give the microtask queue a turn: `launch` is only called once the awaited slot is claimed.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(launchCalls, MAX_CONCURRENT_BROWSERS)

    // Each close frees exactly one slot, letting exactly one more queued launch start.
    for (let i = 0; i < attemptCount; i++) {
      resolvers[i](makeBrowser())
      const browser = await attempts[i]

      const stillQueued = attemptCount - (i + 1) > MAX_CONCURRENT_BROWSERS - 1
      if (stillQueued) {
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

    // Fail the ceiling's worth of launches. Had a failure kept its slot, the batch below would
    // queue forever instead of starting.
    for (let i = 0; i < MAX_CONCURRENT_BROWSERS; i++) {
      await assert.rejects(() => launchUnderSemaphore('launchFailed', failingLaunch), /boom/)
    }
    assert.equal(launchCalls, MAX_CONCURRENT_BROWSERS)

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
      // Left pending forever on purpose; `beforeEach`'s reset is what keeps these attempts out of
      // the next test.
      return new Promise(() => {})
    }

    for (let i = 0; i < MAX_CONCURRENT_BROWSERS + MAX_QUEUED_LAUNCHES; i++) {
      void launchUnderSemaphore('exportOverloaded', neverLaunch)
    }
    await new Promise((resolve) => setImmediate(resolve))

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

describe('getPuppeteerLaunchArgs', () => {
  let warnCalls: any[]

  beforeEach(() => {
    warnCalls = []
    installTestWiki({
      config: {
        security: {
          allowPuppeteerNoSandbox: false
        }
      },
      logger: {
        warn: (...args: any[]) => warnCalls.push(args)
      }
    })
  })

  afterEach(() => {
    mock.restoreAll()
  })

  test('omits --no-sandbox by default', () => {
    const args = getPuppeteerLaunchArgs()
    assert.deepEqual(args, ['--disable-dev-shm-usage'])
  })

  test('does not warn when the config key is left at its default', () => {
    getPuppeteerLaunchArgs()
    assert.equal(warnCalls.length, 0)
  })

  test('includes --no-sandbox when security.allowPuppeteerNoSandbox is set', () => {
    ;(globalThis as any).CARDINAL.config.security.allowPuppeteerNoSandbox = true
    const args = getPuppeteerLaunchArgs()
    assert.deepEqual(args, ['--disable-dev-shm-usage', '--no-sandbox'])
  })

  test('logs a warning when the config key is set', () => {
    ;(globalThis as any).CARDINAL.config.security.allowPuppeteerNoSandbox = true
    getPuppeteerLaunchArgs()
    assert.equal(warnCalls.length, 1)
    const [scope, message, fields] = warnCalls[0]!
    assert.equal(scope, 'render')
    assert.match(message, /--no-sandbox/)
    assert.equal(fields.setting, 'security.allowPuppeteerNoSandbox')
  })
})
