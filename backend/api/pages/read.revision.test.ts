import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * The response serializer would turn a `null` into a `0` against an `integer` field, so absence is
 * asserted with `undefined`/`in`, never falsiness. `buildTestApp` registers the real shared schemas,
 * so asserting through the HTTP response also proves `Page#` declares each field: an undeclared one
 * would be stripped.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — revision (OpenProject #2651)', () => {
  const SITE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const PAGE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const PAGE_HASH = 'c0ffee01'

  let revisionSummaryCalls: string[] = []
  let revisionSummaryResult: { ordinal: number; changeCount?: number; via: string } = {
    ordinal: 1,
    via: 'editor'
  }

  function makeFakePage() {
    return {
      id: PAGE_ID,
      path: 'some/page',
      hash: PAGE_HASH,
      locale: 'en',
      title: 'Some Page',
      allowComments: false,
      allowContributions: false,
      tags: [],
      authorId: '99999999-9999-4999-8999-999999999999',
      authorName: 'Test Author'
    }
  }

  function actorForRequest(req: any) {
    const session = req.session as unknown as { testPagePermissions?: string[] } | undefined
    return { permissions: [] as string[], pagePermissions: session?.testPagePermissions ?? [] }
  }

  function checkAccess(
    actor: { permissions: string[]; pagePermissions: string[] },
    permission: string
  ): boolean {
    return actor.pagePermissions.includes(permission)
  }

  let app: FastifyInstance

  before(async () => {
    const wiki = {
      // -> Off, so the route's best-effort pageview write stays out of a suite that is not about it
      config: { pageviews: { isEnabled: false } },
      models: {
        pages: { getPage: async () => makeFakePage() },
        groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
        approvals: {
          pageViewerState: async () => ({
            canSuggestEdits: false,
            hasOpenSuggestion: false,
            canReview: false,
            pendingSubmissions: []
          })
        },
        pageWatching: { isWatching: async () => false },
        comments: { countForPage: async () => 0 },
        pageviews: { record: async () => {} },
        pageHistory: {
          revisionSummary: async (pageId: string) => {
            revisionSummaryCalls.push(pageId)
            return revisionSummaryResult
          }
        }
      },
      sites: {}
    }

    app = await buildTestApp({ routes: pagesRoutes, ajv: true, wiki, session: 'header' })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    revisionSummaryCalls = []
    revisionSummaryResult = { ordinal: 1, via: 'editor' }
  })

  function sessionHeader(pagePermissions: string[]) {
    return {
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: 'reader-1' },
        permissions: [],
        groups: [],
        testPagePermissions: pagePermissions
      })
    }
  }

  async function readPage(pagePermissions: string[]) {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
      headers: sessionHeader(pagePermissions)
    })
    assert.equal(res.statusCode, 200)
    return res.json()
  }

  test('read:history carries the ordinal and change count back with the page', async () => {
    revisionSummaryResult = { ordinal: 14, changeCount: 6, via: 'editor' }
    const body = await readPage(['read:pages', 'read:history'])
    assert.deepEqual(body.revision, { ordinal: 14, changeCount: 6, via: 'editor' })
    assert.deepEqual(revisionSummaryCalls, [PAGE_ID])
  })

  test('a page with nothing to compare against reports the ordinal with no change count', async () => {
    revisionSummaryResult = { ordinal: 1, via: 'editor' }
    const body = await readPage(['read:pages', 'read:history'])
    // -> Absent, not zeroed: `rev 1` renders alone, and a `· 0 changes` clause never occurs
    assert.deepEqual(body.revision, { ordinal: 1, via: 'editor' })
    assert.equal('changeCount' in body.revision, false)
  })

  test('without read:history the page still reads, with no revision block at all', async () => {
    revisionSummaryResult = { ordinal: 14, changeCount: 6, via: 'editor' }
    const body = await readPage(['read:pages'])
    assert.equal(body.title, 'Some Page')
    assert.equal(body.revision, undefined)
    assert.deepEqual(revisionSummaryCalls, [])
  })

  test('a newest row written via MCP answers revision.via mcp through the real Page# schema', async () => {
    revisionSummaryResult = { ordinal: 3, via: 'mcp' }
    const body = await readPage(['read:pages', 'read:history'])
    assert.equal(body.revision.via, 'mcp')
  })

  test('a newest row written via the editor answers revision.via editor', async () => {
    revisionSummaryResult = { ordinal: 3, via: 'editor' }
    const body = await readPage(['read:pages', 'read:history'])
    assert.equal(body.revision.via, 'editor')
  })

  test('read:history alone is not a way past the page read gate', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
      headers: sessionHeader(['read:history'])
    })
    assert.equal(res.statusCode, 403)
    assert.deepEqual(revisionSummaryCalls, [])
  })
})
