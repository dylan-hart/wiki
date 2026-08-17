import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  RebuildResult,
  SearchEngineDefinition,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult
} from './search.ts'

/**
 * A fixture page, cast through `unknown` rather than filled field-for-field: the point of this suite
 * is that `SearchModule`'s hooks compose with the page row and with the reused `SearchPagesResult` /
 * `RebuildResult` shapes, not to re-describe every `pages` column (already covered by `db/schema.ts`
 * and `models/pages.test.ts`).
 */
function fakePage(overrides: Partial<{ id: string; siteId: string; path: string }> = {}) {
  return {
    id: 'page-1',
    siteId: 'site-1',
    path: 'getting-started',
    locale: 'en',
    title: 'Getting Started',
    ...overrides
  } as unknown as SearchIndexablePage
}

/**
 * A minimal in-memory `SearchModule`, exercised the way `models/search.ts`'s future `ensureModule()`
 * (task #558) will call a real one: every hook mandatory, `query`/`rebuild` returning the exact shapes
 * `models/search.ts` already produces today, so a caller written against the Postgres `db` provider
 * needs no special-casing for a second engine.
 */
function makeFakeSearchModule(): { calls: string[]; module: SearchModule } {
  const calls: string[] = []
  const module: SearchModule = {
    async init(siteId, config) {
      calls.push(`init:${siteId}:${JSON.stringify(config)}`)
    },
    async created(page) {
      calls.push(`created:${page.id}`)
    },
    async updated(page) {
      calls.push(`updated:${page.id}`)
    },
    async deleted(siteId, pageId) {
      calls.push(`deleted:${siteId}:${pageId}`)
    },
    async renamed(siteId, page, previousPath) {
      calls.push(`renamed:${siteId}:${page.id}:${previousPath}`)
    },
    async query(params: SearchPagesParams): Promise<SearchPagesResult> {
      calls.push(`query:${params.siteId}:${params.query ?? ''}`)
      return { results: [], totalHits: 0 }
    },
    async rebuild(siteId: string): Promise<RebuildResult> {
      calls.push(`rebuild:${siteId}`)
      return { pages: 0, locales: [] }
    }
  }
  return { calls, module }
}

describe('SearchModule interface', () => {
  test('every hook is callable and its return shape matches the reused Search* types', async () => {
    const { calls, module } = makeFakeSearchModule()
    const page = fakePage({ id: 'page-1', siteId: 'site-1' })

    await module.init('site-1', { apiKey: 'secret' })
    await module.created(page)
    await module.updated(page)
    await module.deleted('site-1', 'page-2')
    await module.renamed('site-1', page, 'old-path')
    const queryResult = await module.query({ siteId: 'site-1', query: 'wiki' })
    const rebuildResult = await module.rebuild('site-1')

    assert.deepEqual(calls, [
      'init:site-1:{"apiKey":"secret"}',
      'created:page-1',
      'updated:page-1',
      'deleted:site-1:page-2',
      'renamed:site-1:page-1:old-path',
      'query:site-1:wiki',
      'rebuild:site-1'
    ])
    assert.deepEqual(queryResult, { results: [], totalHits: 0 })
    assert.deepEqual(rebuildResult, { pages: 0, locales: [] })
  })
})

describe('SearchEngineDefinition', () => {
  test('carries a props map of ModuleProp, same as StorageDefinition / AuthModule', () => {
    const definition: SearchEngineDefinition = {
      key: 'db',
      title: 'Database',
      description: 'PostgreSQL full-text search.',
      vendor: 'Wiki.js',
      website: 'https://js.wiki',
      props: {
        termHighlighting: {
          default: false,
          type: 'boolean',
          title: 'Term Highlighting',
          hint: '',
          enum: false,
          enumDisplay: 'select',
          multiline: false,
          sensitive: false,
          readOnly: false,
          icon: 'text-box-search',
          order: 100,
          if: []
        }
      }
    }

    assert.equal(definition.key, 'db')
    assert.equal(definition.props.termHighlighting.type, 'boolean')
    // -> dictOverrides is a locale -> dictionary map, not representable by ModuleProp, so it is
    //    deliberately absent from props (see the comment on SearchEngineDefinition in search.ts).
    assert.equal((definition.props as Record<string, unknown>).dictOverrides, undefined)
  })
})
