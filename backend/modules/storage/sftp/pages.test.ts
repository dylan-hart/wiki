import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { before, describe, test } from 'node:test'
import type Client from 'ssh2-sftp-client'
import {
  exportPages,
  remotePathForPage,
  resolveLocaleInfo,
  type PageExportLocaleInfo,
  type PageExportRow
} from './pages.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { ensureTemporal } from '../../../test/temporal.ts'

/**
 * `injectFrontMatter` (called indirectly through `exportPages`) converts `createdAt`/`updatedAt` via
 * `Date#toTemporalInstant()`. This sandbox's Node is v25.9.0, which lacks it natively — same gap
 * `helpers/pageSerialization.test.ts` documents.
 */
before(() => ensureTemporal())

const MULTI_LOCALE: PageExportLocaleInfo = { defaultLocale: 'en', namespacingEnabled: true }
const SINGLE_LOCALE: PageExportLocaleInfo = { defaultLocale: 'en', namespacingEnabled: false }

function makeRow(overrides: Partial<PageExportRow> = {}): PageExportRow {
  return {
    id: '1',
    locale: 'en',
    path: 'guides/setup',
    contentType: 'markdown',
    content: '# Setup\n\nDo the thing.',
    title: 'Setup',
    description: null,
    tags: [],
    createdAt: null,
    updatedAt: null,
    ...overrides
  }
}

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return makeStorageTarget('sftp', {
    id: 'target-1',
    title: 'SFTP',
    contentTypes: { activeTypes: ['pages'], largeThreshold: '5MB' },
    assetDelivery: {
      isStreamingSupported: false,
      isDirectAccessSupported: false,
      streaming: false,
      directAccess: false
    },
    sync: {
      supportedModes: ['push'],
      schedule: false,
      mode: 'push',
      scheduleOverride: null,
      supportsContentSync: false
    },
    config: { basePath: '/srv/wiki' },
    ...overrides
  })
}

function makeStubClient(overrides: Record<string, any> = {}): any {
  return {
    exists: mock.fn(async () => 'd' as const),
    mkdir: mock.fn(async () => 'ok'),
    put: mock.fn(async () => 'ok'),
    ...overrides
  }
}

describe('remotePathForPage', () => {
  test('namespaces a non-default-locale page under its locale code', () => {
    const result = remotePathForPage(
      { locale: 'fr', path: 'guides/setup', contentType: 'markdown' },
      MULTI_LOCALE
    )
    assert.equal(result, 'fr/guides/setup.md')
  })

  test('does not namespace the site default locale even when namespacing applies', () => {
    const result = remotePathForPage(
      { locale: 'en', path: 'guides/setup', contentType: 'markdown' },
      MULTI_LOCALE
    )
    assert.equal(result, 'guides/setup.md')
  })

  test('never namespaces on a single-locale site, regardless of the page locale', () => {
    const result = remotePathForPage(
      { locale: 'fr', path: 'guides/setup', contentType: 'markdown' },
      SINGLE_LOCALE
    )
    assert.equal(result, 'guides/setup.md')
  })

  test('picks the extension from contentType', () => {
    assert.equal(
      remotePathForPage({ locale: 'en', path: 'notes', contentType: 'asciidoc' }, SINGLE_LOCALE),
      'notes.adoc'
    )
    assert.equal(
      remotePathForPage({ locale: 'en', path: 'notes', contentType: 'html' }, SINGLE_LOCALE),
      'notes.html'
    )
  })
})

describe('resolveLocaleInfo', () => {
  test('flags namespacing on for a site with more than one active locale', () => {
    const info = resolveLocaleInfo({ config: { locales: { primary: 'en', active: ['en', 'fr'] } } })
    assert.deepEqual(info, { defaultLocale: 'en', namespacingEnabled: true })
  })

  test('flags namespacing off for a single-locale site', () => {
    const info = resolveLocaleInfo({ config: { locales: { primary: 'en', active: ['en'] } } })
    assert.deepEqual(info, { defaultLocale: 'en', namespacingEnabled: false })
  })

  test('falls back sensibly when locale config is absent', () => {
    assert.deepEqual(resolveLocaleInfo(undefined), {
      defaultLocale: 'en',
      namespacingEnabled: false
    })
  })
})

describe('exportPages', () => {
  test('writes a namespaced page under its locale directory with front matter injected', async () => {
    const client = makeStubClient()
    const target = makeTarget()
    const row = makeRow({ locale: 'fr', path: 'guides/setup', title: 'Configuration' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportPages(client as unknown as Client, target, {
      localeInfo: MULTI_LOCALE,
      fetchBatch
    })

    assert.equal(client.put.mock.calls.length, 1)
    const [body, remotePath] = client.put.mock.calls[0].arguments
    assert.equal(remotePath, '/srv/wiki/fr/guides/setup.md')
    assert.equal(
      body.toString('utf8'),
      '---\ntitle: Configuration\n---\n\n# Setup\n\nDo the thing.'
    )

    // -> The containing directory was ensured (each segment checked) before the write
    const checkedPaths = client.exists.mock.calls.map((c: any) => c.arguments[0])
    assert.deepEqual(checkedPaths, ['/srv/wiki/fr', '/srv/wiki/fr/guides'])
    // -> The stub reports every segment as already existing, so nothing needed creating
    assert.equal(client.mkdir.mock.calls.length, 0)
  })

  test('writes a non-namespaced page (default locale) flat under basePath', async () => {
    const client = makeStubClient()
    const target = makeTarget()
    const row = makeRow({ locale: 'en', path: 'about', title: 'About' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportPages(client as unknown as Client, target, {
      localeInfo: MULTI_LOCALE,
      fetchBatch
    })

    assert.equal(client.put.mock.calls.length, 1)
    const [, remotePath] = client.put.mock.calls[0].arguments
    assert.equal(remotePath, '/srv/wiki/about.md')
    // -> A root-level page has no containing directory to create
    assert.equal(client.exists.mock.calls.length, 0)
    assert.equal(client.mkdir.mock.calls.length, 0)
  })

  test('does nothing when pages is not in target.contentTypes.activeTypes', async () => {
    const client = makeStubClient()
    const target = makeTarget({ contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' } })
    const fetchBatch = mock.fn(async () => [])

    await exportPages(client as unknown as Client, target, {
      localeInfo: SINGLE_LOCALE,
      fetchBatch
    })

    assert.equal(fetchBatch.mock.calls.length, 0)
    assert.equal(client.put.mock.calls.length, 0)
  })

  test('keyset-paginates across multiple batches until a short page is returned', async () => {
    const client = makeStubClient()
    const target = makeTarget()
    const batches: PageExportRow[][] = [
      [makeRow({ id: 'a', path: 'one' }), makeRow({ id: 'b', path: 'two' })],
      [makeRow({ id: 'c', path: 'three' })],
      []
    ]
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) => {
      if (afterId === null) return batches[0]
      if (afterId === 'b') return batches[1]
      throw new Error(`unexpected afterId ${afterId}`)
    })

    await exportPages(client as unknown as Client, target, {
      localeInfo: SINGLE_LOCALE,
      fetchBatch,
      pageSize: 2
    })

    // -> Stops once a batch shorter than the page size comes back, never issuing a third,
    //    empty-returning call
    assert.equal(fetchBatch.mock.calls.length, 2)
    assert.equal(fetchBatch.mock.calls[0].arguments[0].afterId, null)
    assert.equal(fetchBatch.mock.calls[1].arguments[0].afterId, 'b')
    assert.equal(client.put.mock.calls.length, 3)
  })
})
