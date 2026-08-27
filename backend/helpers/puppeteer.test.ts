import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { getPuppeteerLaunchArgs } from './puppeteer.ts'

/**
 * `getPuppeteerLaunchArgs` is the sole place `--no-sandbox` can enter a launch, so this is a pure
 * unit test against a stubbed `WIKI.config.security`/`WIKI.logger` — no database, no real Puppeteer
 * (an extension the operator installs, not a backend dependency) needed.
 */
describe('getPuppeteerLaunchArgs', () => {
  let warnCalls: any[]

  beforeEach(() => {
    warnCalls = []
    ;(globalThis as any).WIKI = {
      config: {
        security: {
          allowPuppeteerNoSandbox: false
        }
      },
      logger: {
        warn: (...args: any[]) => warnCalls.push(args)
      }
    }
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
    ;(globalThis as any).WIKI.config.security.allowPuppeteerNoSandbox = true
    const args = getPuppeteerLaunchArgs()
    assert.deepEqual(args, ['--disable-dev-shm-usage', '--no-sandbox'])
  })

  test('logs a warning when the config key is set', () => {
    ;(globalThis as any).WIKI.config.security.allowPuppeteerNoSandbox = true
    getPuppeteerLaunchArgs()
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /--no-sandbox/)
  })
})
