import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import readRoutes from './read.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { ensureTemporal } from '../../test/temporal.ts'

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

let queryCalls: Array<Record<string, unknown>>
let searchResults: Array<{ id: string; path: string; locale: string }>
let translationRowsCalls: Array<{ siteId: string; paths: string[] }>
let translationRows: Array<{ path: string; locale: string; updatedAt: Date }>

async function query(params: Record<string, unknown>) {
  queryCalls.push(params)
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
  queryCalls = []
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

test('forwards every include and exclude list to the search model', async () => {
  const res = await app.inject({
    method: 'GET',
    url:
      `/sites/${SITE_ID}/pages/search?path=docs&path=guides&excludePath=docs%2Fprivate` +
      '&locales=en,fr&excludeLocales=de&tags=a,b&excludeTags=old,stale' +
      '&editor=markdown&excludeEditor=code&excludeEditor=wysiwyg' +
      '&publishState=published&excludePublishState=draft'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(queryCalls.length, 1)
  const call = queryCalls[0]!
  assert.deepEqual(call.path, ['docs', 'guides'])
  assert.deepEqual(call.excludePath, ['docs/private'])
  assert.deepEqual(call.locales, ['en', 'fr'])
  assert.deepEqual(call.excludeLocales, ['de'])
  assert.deepEqual(call.tags, ['a', 'b'])
  assert.deepEqual(call.excludeTags, ['old', 'stale'])
  assert.deepEqual(call.editor, ['markdown'])
  assert.deepEqual(call.excludeEditor, ['code', 'wysiwyg'])
  assert.deepEqual(call.publishState, ['published'])
  assert.deepEqual(call.excludePublishState, ['draft'])
})

test('sends empty lists when no filter is given', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/pages/search` })
  assert.equal(res.statusCode, 200)
  const call = queryCalls[0]!
  for (const key of [
    'path',
    'excludePath',
    'locales',
    'excludeLocales',
    'tags',
    'excludeTags',
    'editor',
    'excludeEditor',
    'publishState',
    'excludePublishState'
  ]) {
    assert.deepEqual(call[key], [], key)
  }
})

test('rejects a publishState outside the known states in either list', async () => {
  for (const param of ['publishState', 'excludePublishState']) {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/search?${param}=bogus`
    })
    assert.equal(res.statusCode, 400, param)
  }
})
