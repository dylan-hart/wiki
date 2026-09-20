import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import readRoutes from './read.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { ensureTemporal } from '../../test/temporal.ts'

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

let searchResults: Array<{ id: string; path: string; locale: string }>
let translationRowsCalls: Array<{ siteId: string; paths: string[] }>
let translationRows: Array<{ path: string; locale: string; updatedAt: Date }>

async function query() {
  return {
    results: searchResults,
    totalHits: searchResults.length,
    totalHitsApproximate: false,
    suggestion: null
  }
}

async function getTranslationRows(siteId: string, paths: string[]) {
  translationRowsCalls.push({ siteId, paths })
  return translationRows
}

let app: FastifyInstance

before(async () => {
  await ensureTemporal()
  const wiki = {
    sites: {
      [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr'] } } }
    },
    models: {
      search: { query },
      pages: { getTranslationRows },
      groups: {
        actorForRequest: () => ({ permissions: [], groupIds: [] }),
        mayHoldPermissionSomewhere: () => false
      }
    }
  }

  app = await buildTestApp({ routes: readRoutes, ajv: true, wiki, session: 'header' })
})

after(() => closeTestApp(app))

beforeEach(() => {
  searchResults = [
    { id: 'page-1', path: 'docs/one', locale: 'en' },
    { id: 'page-2', path: 'docs/two', locale: 'en' }
  ]
  translationRowsCalls = []
  translationRows = [
    { path: 'docs/one', locale: 'en', updatedAt: new Date('2026-06-01T00:00:00.000Z') },
    { path: 'docs/two', locale: 'en', updatedAt: new Date('2026-06-01T00:00:00.000Z') },
    { path: 'docs/two', locale: 'fr', updatedAt: new Date('2026-01-01T00:00:00.000Z') }
  ]
})

test('attaches localeStatus per result when includeLocaleStatus=true', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search?includeLocaleStatus=true`
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()

  assert.equal(translationRowsCalls.length, 1)
  assert.equal(translationRowsCalls[0]!.siteId, SITE_ID)
  assert.deepEqual([...translationRowsCalls[0]!.paths].sort(), ['docs/one', 'docs/two'])

  const one = body.results.find((r: { path: string }) => r.path === 'docs/one')
  assert.deepEqual(
    one.localeStatus.map((e: { locale: string; state: string }) => [e.locale, e.state]),
    [
      ['en', 'primary'],
      ['fr', 'missing']
    ]
  )

  const two = body.results.find((r: { path: string }) => r.path === 'docs/two')
  assert.deepEqual(
    two.localeStatus.map((e: { locale: string; state: string }) => [e.locale, e.state]),
    [
      ['en', 'primary'],
      ['fr', 'stale']
    ]
  )
})

test('batches the join once for every result sharing a path, not once per row', async () => {
  searchResults = [
    { id: 'page-1', path: 'docs/one', locale: 'en' },
    { id: 'page-1-fr', path: 'docs/one', locale: 'fr' }
  ]
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search?includeLocaleStatus=true`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(translationRowsCalls.length, 1)
  assert.deepEqual(translationRowsCalls[0]!.paths, ['docs/one'])
})

test('an empty result set skips the join call entirely', async () => {
  searchResults = []
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search?includeLocaleStatus=true`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(translationRowsCalls.length, 0)
})
