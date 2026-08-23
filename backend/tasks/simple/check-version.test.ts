import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as checkVersion } from './check-version.ts'

/**
 * `task()` is the daily `checkVersion` scheduled job: it fetches the latest release off GitHub and
 * saves it into `WIKI.config.update`. No database or real network involved — `fetch` and
 * `WIKI.configSvc.saveToDb` are stubbed, the same no-`WIKI`-global-until-`beforeEach` pattern
 * `send-watch-digests.test.ts` uses.
 */

let previousWiki: any
let previousFetch: typeof fetch
let saveToDb: ReturnType<typeof mock.fn>
let loggerInfo: ReturnType<typeof mock.fn>
let loggerError: ReturnType<typeof mock.fn>

before(() => {
  previousWiki = (globalThis as any).WIKI
  previousFetch = globalThis.fetch
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
  globalThis.fetch = previousFetch
})

beforeEach(() => {
  saveToDb = mock.fn(async () => true)
  loggerInfo = mock.fn()
  loggerError = mock.fn()
  ;(globalThis as any).WIKI = {
    config: {},
    configSvc: { saveToDb },
    logger: { info: loggerInfo, error: loggerError, warn: mock.fn(), debug: mock.fn() }
  }
})

describe('check-version.task', () => {
  test('fetches the latest release and saves it to WIKI.config.update', async () => {
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ tag_name: 'v3.1.0', published_at: '2026-08-01T00:00:00Z' }), {
          status: 200
        })
    ) as unknown as typeof fetch

    await checkVersion()

    assert.equal(WIKI.config.update.version, '3.1.0')
    assert.equal(WIKI.config.update.versionDate, '2026-08-01T00:00:00Z')
    assert.equal(saveToDb.mock.callCount(), 1)
  })

  test('does nothing when the instance is in offline mode (OpenProject #820)', async () => {
    WIKI.config = { offline: true }
    const fetchSpy = mock.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await assert.doesNotReject(checkVersion())

    assert.equal(fetchSpy.mock.callCount(), 0)
    assert.equal(saveToDb.mock.callCount(), 0)
  })
})
