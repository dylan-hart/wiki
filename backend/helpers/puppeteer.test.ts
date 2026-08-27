import { describe, test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getPuppeteerLaunchArgs, BASE_PUPPETEER_LAUNCH_ARGS } from './puppeteer.ts'

/**
 * `getPuppeteerLaunchArgs` reads `WIKI.config.rendering.puppeteerNoSandbox` and logs through
 * `WIKI.logger.warn` when the fallback is taken — a pure unit test of that branch, no database
 * and no real Puppeteer/Chromium involved.
 */
describe('getPuppeteerLaunchArgs', () => {
  let warnCalls: any[][]

  before(() => {
    ;(globalThis as any).WIKI = {
      config: { rendering: { puppeteerNoSandbox: false } },
      logger: {
        warn: (...args: any[]) => warnCalls.push(args)
      }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    warnCalls = []
    ;(globalThis as any).WIKI.config.rendering.puppeteerNoSandbox = false
  })

  test('omits --no-sandbox by default', () => {
    const args = getPuppeteerLaunchArgs()
    assert.deepEqual(args, BASE_PUPPETEER_LAUNCH_ARGS)
    assert.equal(args.includes('--no-sandbox'), false)
  })

  test('does not log a warning by default', () => {
    getPuppeteerLaunchArgs()
    assert.equal(warnCalls.length, 0)
  })

  test('includes --no-sandbox only when the config key is set', () => {
    ;(globalThis as any).WIKI.config.rendering.puppeteerNoSandbox = true
    const args = getPuppeteerLaunchArgs()
    assert.equal(args.includes('--no-sandbox'), true)
    // -> The rest of the base args are still present, unmodified
    for (const arg of BASE_PUPPETEER_LAUNCH_ARGS) {
      assert.equal(args.includes(arg), true)
    }
  })

  test('logs a warning when the fallback is taken', () => {
    ;(globalThis as any).WIKI.config.rendering.puppeteerNoSandbox = true
    getPuppeteerLaunchArgs()
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /no-sandbox/)
  })

  test('does not mutate BASE_PUPPETEER_LAUNCH_ARGS across calls', () => {
    const before = [...BASE_PUPPETEER_LAUNCH_ARGS]
    ;(globalThis as any).WIKI.config.rendering.puppeteerNoSandbox = true
    getPuppeteerLaunchArgs()
    assert.deepEqual(BASE_PUPPETEER_LAUNCH_ARGS, before)
  })
})
