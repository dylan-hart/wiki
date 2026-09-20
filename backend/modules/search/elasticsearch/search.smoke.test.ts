import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@elastic/elasticsearch'
import { search } from '../../../models/search.ts'
import { ElasticsearchSearchModule } from './search.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import type { AccessActor } from '../../../models/groups.ts'
import type { SearchIndexablePage } from '../../../models/search.ts'

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Runs against a *real* cluster, complementing `search.test.ts`'s fake-client coverage of the same
 * module: only a real cluster catches a typo'd filter clause or a mapping that does not support the
 * DSL this module builds. The permission rules themselves are not re-tested here — what is, is that
 * real hits survive the same per-row `checkAccess` post-filter a fake response does.
 *
 * Gated on `ELASTICSEARCH_TEST_URL` the way DB-backed suites gate on `DATABASE_URL`, so an unset
 * variable reports skipped rather than failing. `dev/docker-compose.search-test.yml` brings up a
 * cluster to point it at.
 */
function hasElasticsearch(): boolean {
  return Boolean(process.env.ELASTICSEARCH_TEST_URL)
}

describe(
  'ElasticsearchSearchModule (smoke, real Elasticsearch)',
  { skip: !hasElasticsearch() },
  () => {
    const siteId = 'smoke-site'
    const indexName = `wiki-smoke-${randomBytes(6).toString('hex')}`
    const hosts = process.env.ELASTICSEARCH_TEST_URL ?? ''
    let wikiHandle: { restore(): void }
    let mod: ElasticsearchSearchModule
    let cleanupClient: Client

    function fakePage(overrides: Partial<Record<string, any>> = {}): SearchIndexablePage {
      return {
        id: overrides.id ?? 'page-1',
        siteId,
        locale: 'en',
        path: 'docs/getting-started',
        title: 'Getting Started',
        description: 'How to get started',
        icon: null,
        tags: [],
        editor: 'markdown',
        publishState: 'published',
        isSearchable: true,
        password: null,
        searchContent: 'placeholder body content',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides
      } as unknown as SearchIndexablePage
    }

    before(async () => {
      wikiHandle = installTestWiki({
        SERVERPATH: backendDir,
        sites: {
          [siteId]: {
            config: {
              search: {
                engine: 'elasticsearch',
                engines: { elasticsearch: { hosts, indexName, analyzer: 'standard' } }
              }
            }
          }
        },
        models: {
          groups: {
            // -> Everything visible unless a test overrides it, so a filter test only ever asserts
            //    on what the ES query itself returned
            checkAccess: () => true
          }
        }
      })
      await search.refreshFromDisk()

      mod = new ElasticsearchSearchModule()
      await mod.init(siteId, { hosts, indexName, analyzer: 'standard' })
      cleanupClient = new Client({ nodes: [hosts] })

      // -> Each page is isolated by path, tag and locale, so a filter matching too broadly shows up
      //    below as an unexpected extra hit rather than as a silent pass
      await Promise.all([
        mod.created(
          fakePage({
            id: 'alpha',
            path: 'docs/alpha',
            title: 'Alpha Guide',
            tags: ['guide'],
            publishState: 'published',
            locale: 'en',
            editor: 'markdown'
          })
        ),
        mod.created(
          fakePage({
            id: 'beta',
            path: 'docs/beta',
            title: 'Beta Reference',
            tags: ['reference'],
            publishState: 'published',
            locale: 'en',
            editor: 'markdown'
          })
        ),
        mod.created(
          fakePage({
            id: 'gamma',
            path: 'guides/gamma',
            title: 'Gamma Draft',
            tags: ['guide', 'howto'],
            publishState: 'draft',
            locale: 'en',
            editor: 'markdown'
          })
        ),
        mod.created(
          fakePage({
            id: 'delta',
            path: 'docs/delta',
            title: 'Delta Notes',
            tags: ['guide'],
            publishState: 'published',
            locale: 'fr',
            editor: 'asciidoc'
          })
        ),
        mod.created(
          fakePage({
            id: 'vault',
            path: 'secret/vault',
            title: 'Vault Secrets',
            tags: [],
            publishState: 'published',
            locale: 'en',
            editor: 'markdown'
          })
        )
      ])
    })

    after(async () => {
      try {
        await cleanupClient.indices.delete({ index: indexName })
      } catch {
        // -> Best-effort: the throwaway container is torn down either way
      }
      wikiHandle.restore()
    })

    test('path filters to that subtree, excluding siblings and drafts outside it', async () => {
      const result = await mod.query({ siteId, path: 'docs' })
      const paths = result.results.map((r) => r.path).sort()
      assert.deepEqual(paths, ['docs/alpha', 'docs/beta', 'docs/delta'])
    })

    test('tags requires every named tag to be present', async () => {
      const result = await mod.query({ siteId, tags: ['guide'], includeDrafts: true })
      const paths = result.results.map((r) => r.path).sort()
      assert.deepEqual(paths, ['docs/alpha', 'docs/delta', 'guides/gamma'])
    })

    test('tags with two names ANDs them, matching only the page carrying both', async () => {
      const result = await mod.query({ siteId, tags: ['guide', 'howto'], includeDrafts: true })
      assert.deepEqual(
        result.results.map((r) => r.path),
        ['guides/gamma']
      )
    })

    test('draft pages are excluded by default', async () => {
      const result = await mod.query({ siteId, path: 'guides' })
      assert.deepEqual(result.results, [])
    })

    test('includeDrafts surfaces the draft page', async () => {
      const result = await mod.query({ siteId, path: 'guides', includeDrafts: true })
      assert.deepEqual(
        result.results.map((r) => r.path),
        ['guides/gamma']
      )
    })

    test('an explicit publishState filter finds only pages in that state', async () => {
      const result = await mod.query({ siteId, publishState: 'draft', includeDrafts: true })
      assert.deepEqual(
        result.results.map((r) => r.path),
        ['guides/gamma']
      )
    })

    test('publicOnly restricts to published, even with includeDrafts also set', async () => {
      const result = await mod.query({ siteId, publicOnly: true, includeDrafts: true })
      const paths = result.results.map((r) => r.path).sort()
      assert.ok(!paths.includes('guides/gamma'), 'draft page leaked through publicOnly')
      assert.deepEqual(paths, ['docs/alpha', 'docs/beta', 'docs/delta', 'secret/vault'])
    })

    test('locales filters to only that locale', async () => {
      const result = await mod.query({ siteId, locales: ['fr'] })
      assert.deepEqual(
        result.results.map((r) => r.path),
        ['docs/delta']
      )
    })

    test('editor filters to only that editor', async () => {
      const result = await mod.query({ siteId, editor: 'asciidoc' })
      assert.deepEqual(
        result.results.map((r) => r.path),
        ['docs/delta']
      )
    })

    test('free-text query matches on title', async () => {
      const result = await mod.query({ siteId, query: 'Alpha' })
      assert.deepEqual(
        result.results.map((r) => r.path),
        ['docs/alpha']
      )
    })

    test('a page denied by checkAccess is filtered out of real Elasticsearch hits, and totalHits follows', async () => {
      const denyVault = (_actor: AccessActor, _permission: string, page: { path: string }) =>
        page.path !== 'secret/vault'
      const previousCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = denyVault

      try {
        const result = await mod.query({
          siteId,
          publicOnly: true,
          actor: { groupIds: [], permissions: [] }
        })
        const paths = result.results.map((r) => r.path).sort()
        assert.ok(
          !paths.includes('secret/vault'),
          'denied page leaked through checkAccess filtering'
        )
        assert.deepEqual(paths, ['docs/alpha', 'docs/beta', 'docs/delta'])
        assert.equal(result.totalHits, 3)
      } finally {
        ;(globalThis as any).CARDINAL.models.groups.checkAccess = previousCheckAccess
      }
    })

    test('with no actor, every hit (including the one an actor would have had denied) comes back', async () => {
      const result = await mod.query({ siteId, publicOnly: true })
      const paths = result.results.map((r) => r.path).sort()
      assert.ok(paths.includes('secret/vault'), 'page missing with no actor to filter by')
    })
  }
)
