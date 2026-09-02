import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as checkVersion } from './check-version.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * `task()` is the daily `checkVersion` scheduled job: it fetches the latest release off GitHub and
 * saves it into `WIKI.config.update`. No database or real network involved — `fetch` and
 * `WIKI.configSvc.saveToDb` are stubbed, the same no-`WIKI`-global-until-`beforeEach` pattern
 * `send-watch-digests.test.ts` uses.
 */

let wikiHandle: { restore(): void }
let previousFetch: typeof fetch
let saveToDb: ReturnType<typeof mock.fn>
let loggerInfo: ReturnType<typeof mock.fn>
let loggerError: ReturnType<typeof mock.fn>

before(() => {
  previousFetch = globalThis.fetch
})

after(() => {
  wikiHandle.restore()
  globalThis.fetch = previousFetch
})

beforeEach(() => {
  saveToDb = mock.fn(async () => true)
  loggerInfo = mock.fn()
  loggerError = mock.fn()
  wikiHandle = installTestWiki({
    config: {},
    configSvc: { saveToDb },
    logger: { info: loggerInfo, error: loggerError, warn: mock.fn(), debug: mock.fn() }
  })
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

  test('merges into WIKI.config.update rather than replacing it, preserving an existing locales opt-out (OpenProject #2059)', async () => {
    // -> 2026-08-24 audit finding §5 / OpenProject #2059: `update` also holds `locales` (an
    //    operator's opt-out of the daily `updateLocales` sync, `base.yml`'s `update.locales`) -- a
    //    bare assignment previously discarded it on every run after the first.
    WIKI.config.update = { locales: false }
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ tag_name: 'v3.1.0', published_at: '2026-08-01T00:00:00Z' }), {
          status: 200
        })
    ) as unknown as typeof fetch

    await checkVersion()

    assert.equal(WIKI.config.update.locales, false)
    assert.equal(WIKI.config.update.version, '3.1.0')
    assert.equal(WIKI.config.update.versionDate, '2026-08-01T00:00:00Z')
    assert.ok(WIKI.config.update.lastCheckedAt)
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

  // OpenProject #2253: the fetch carries an abort timeout and a non-ok response is rejected
  // rather than fed to .json().
  test('the release fetch carries an AbortSignal', async () => {
    let capturedOpts: any
    globalThis.fetch = mock.fn(async (_url: string, opts?: any) => {
      capturedOpts = opts
      return new Response(
        JSON.stringify({ tag_name: 'v3.1.0', published_at: '2026-08-01T00:00:00Z' }),
        {
          status: 200
        }
      )
    }) as unknown as typeof fetch

    await checkVersion()

    assert.ok(capturedOpts?.signal instanceof AbortSignal, 'fetch call is missing an AbortSignal')
  })

  test('a non-ok response fails the task without saving', async () => {
    globalThis.fetch = mock.fn(
      async () => new Response('Internal Server Error', { status: 500 })
    ) as unknown as typeof fetch

    await assert.rejects(checkVersion())

    assert.equal(saveToDb.mock.callCount(), 0)
  })
})
