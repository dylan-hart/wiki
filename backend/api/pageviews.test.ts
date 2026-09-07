import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pageviewsRoutes from './pageviews.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import type { GraphPageRow } from './graph.ts'
import { zeroPageviewCountsForGraph, type PageviewCountsForGraph } from '../models/pageviews.ts'

const SITE_ID = '11111111-1111-1111-1111-111111111111'

function makePageRow(overrides: Partial<GraphPageRow> = {}): GraphPageRow {
  const path = overrides.path ?? 'docs/intro'
  return {
    id: path,
    path,
    locale: 'en',
    title: 'Intro',
    icon: null,
    tags: [],
    classification: 'level-public',
    relations: [],
    links: [],
    publishState: 'published',
    ...overrides
  }
}

function makeCounts(
  overrides: Partial<PageviewCountsForGraph['last2yr']['total']>
): PageviewCountsForGraph {
  const base = zeroPageviewCountsForGraph()
  base.last2yr.total = { ...base.last2yr.total, ...overrides }
  return base
}

describe('GET /sites/:siteId/pageviews', () => {
  let app: FastifyInstance
  let listAllForGraph: (siteId: string) => Promise<GraphPageRow[]>
  let countsForGraph: (siteId: string) => Promise<Map<string, PageviewCountsForGraph>>

  before(async () => {
    app = await buildTestApp({
      routes: pageviewsRoutes,
      schemas: 'all',
      permissions: true,
      session: 'header',
      wiki: {
        models: {
          pages: {
            listAllForGraph: (siteId: string) => listAllForGraph(siteId)
          },
          pageviews: {
            countsForGraph: (siteId: string) => countsForGraph(siteId)
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('refuses a caller without manage:system', async () => {
    listAllForGraph = async () => []
    countsForGraph = async () => new Map()

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pageviews`,
      headers: { 'x-test-permissions': 'read:pages' }
    })

    assert.equal(res.statusCode, 403)
  })

  test('sums browser + mcp + api into total, using the last2yr total (raw) figures', async () => {
    listAllForGraph = async (siteId) => {
      assert.equal(siteId, SITE_ID)
      return [makePageRow({ path: 'docs/intro', title: 'Intro' })]
    }
    countsForGraph = async () =>
      new Map([['docs/intro', makeCounts({ browser: 5, api: 2, mcp: 1, all: 8 })]])

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pageviews`,
      headers: { 'x-test-permissions': 'manage:system' }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [
      {
        pageId: 'docs/intro',
        path: 'docs/intro',
        locale: 'en',
        title: 'Intro',
        total: 8,
        browser: 5,
        mcp: 1,
        api: 2
      }
    ])
  })

  test('lists every page, zeroed when it has no pageview rows at all', async () => {
    listAllForGraph = async () => [
      makePageRow({ path: 'no-views', title: 'No Views' }),
      makePageRow({ path: 'has-views', title: 'Has Views' })
    ]
    countsForGraph = async () =>
      new Map([['has-views', makeCounts({ browser: 3, api: 0, mcp: 0, all: 3 })]])

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pageviews`,
      headers: { 'x-test-permissions': 'manage:system' }
    })

    assert.equal(res.statusCode, 200)
    const rows = res.json()
    assert.equal(rows.length, 2)
    const noViews = rows.find((r: { path: string }) => r.path === 'no-views')
    assert.deepEqual(noViews, {
      pageId: 'no-views',
      path: 'no-views',
      locale: 'en',
      title: 'No Views',
      total: 0,
      browser: 0,
      mcp: 0,
      api: 0
    })
  })

  test('an empty site (or tracking disabled, an empty counts map) answers an empty array', async () => {
    listAllForGraph = async () => []
    countsForGraph = async () => new Map()

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pageviews`,
      headers: { 'x-test-permissions': 'manage:system' }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [])
  })
})
