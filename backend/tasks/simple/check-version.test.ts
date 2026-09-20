import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as checkVersion } from './check-version.ts'
import { installTestWiki } from '../../test/mocks.ts'

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

function releasesResponse(releases: object[]): Response {
  return new Response(JSON.stringify(releases), { status: 200 })
}

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
  test('fetches the latest release and saves it to CARDINAL.config.update', async () => {
    globalThis.fetch = mock.fn(async () =>
      releasesResponse([{ tag_name: 'v3.1.0', published_at: '2026-08-01T00:00:00Z' }])
    ) as unknown as typeof fetch

    await checkVersion()

    assert.equal(CARDINAL.config.update.version, '3.1.0')
    assert.equal(CARDINAL.config.update.versionDate, '2026-08-01T00:00:00Z')
    assert.equal(saveToDb.mock.callCount(), 1)
  })

  test('merges into CARDINAL.config.update rather than replacing it, preserving an existing locales opt-out (OpenProject #2059)', async () => {
    // -> `update.locales` is an operator's opt-out of the daily `updateLocales` sync, and shares the
    //    `update` config object with the version fields this task writes.
    CARDINAL.config.update = { locales: false }
    globalThis.fetch = mock.fn(async () =>
      releasesResponse([{ tag_name: 'v3.1.0', published_at: '2026-08-01T00:00:00Z' }])
    ) as unknown as typeof fetch

    await checkVersion()

    assert.equal(CARDINAL.config.update.locales, false)
    assert.equal(CARDINAL.config.update.version, '3.1.0')
    assert.equal(CARDINAL.config.update.versionDate, '2026-08-01T00:00:00Z')
    assert.ok(CARDINAL.config.update.lastCheckedAt)
    assert.equal(saveToDb.mock.callCount(), 1)
  })

  test('does nothing when the instance is in offline mode (OpenProject #820)', async () => {
    CARDINAL.config = { offline: true }
    const fetchSpy = mock.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await assert.doesNotReject(checkVersion())

    assert.equal(fetchSpy.mock.callCount(), 0)
    assert.equal(saveToDb.mock.callCount(), 0)
  })

  test('the release fetch carries an AbortSignal', async () => {
    let capturedOpts: any
    globalThis.fetch = mock.fn(async (_url: string, opts?: any) => {
      capturedOpts = opts
      return releasesResponse([{ tag_name: 'v3.1.0', published_at: '2026-08-01T00:00:00Z' }])
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

  test("requests this repository's releases by default", async () => {
    const fetchSpy = mock.fn(async () => releasesResponse([]))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await checkVersion()

    assert.equal(
      (fetchSpy.mock.calls[0].arguments as unknown[])[0],
      'https://api.github.com/repos/dylan-hart/wiki/releases?per_page=30'
    )
  })

  test('update.releasesUrl overrides the feed', async () => {
    CARDINAL.config.update = { releasesUrl: 'https://git.example.com/api/releases' }
    const fetchSpy = mock.fn(async () => releasesResponse([]))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await checkVersion()

    assert.equal(
      (fetchSpy.mock.calls[0].arguments as unknown[])[0],
      'https://git.example.com/api/releases?per_page=30'
    )
  })

  test('picks the highest semver release, skipping drafts and non-semver tags', async () => {
    CARDINAL.version = '3.0.0-alpha.5'
    globalThis.fetch = mock.fn(async () =>
      releasesResponse([
        { tag_name: 'nightly', published_at: '2026-09-01T00:00:00Z' },
        { tag_name: 'v3.0.0-alpha.9', published_at: '2026-08-05T00:00:00Z' },
        { tag_name: 'v3.0.0-alpha.12', published_at: '2026-08-10T00:00:00Z' },
        { tag_name: 'v9.9.9', published_at: '2026-08-11T00:00:00Z', draft: true }
      ])
    ) as unknown as typeof fetch

    await checkVersion()

    assert.equal(CARDINAL.config.update.version, '3.0.0-alpha.12')
    assert.equal(CARDINAL.config.update.versionDate, '2026-08-10T00:00:00Z')
  })

  test('a stable running version ignores prereleases', async () => {
    CARDINAL.version = '3.0.0'
    globalThis.fetch = mock.fn(async () =>
      releasesResponse([
        { tag_name: 'v3.1.0-rc.1', published_at: '2026-08-10T00:00:00Z', prerelease: true },
        { tag_name: 'v3.0.1', published_at: '2026-08-05T00:00:00Z' }
      ])
    ) as unknown as typeof fetch

    await checkVersion()

    assert.equal(CARDINAL.config.update.version, '3.0.1')
  })

  test('no usable release leaves update.version untouched and saves nothing', async () => {
    globalThis.fetch = mock.fn(async () => releasesResponse([])) as unknown as typeof fetch

    await checkVersion()

    assert.equal(CARDINAL.config.update?.version, undefined)
    assert.equal(saveToDb.mock.callCount(), 0)
  })
})
