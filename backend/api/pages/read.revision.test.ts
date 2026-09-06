import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `GET /sites/:siteId/pages/:pageIdOrHash` — the `revision` block (OpenProject #2651), the backing
 * data for the page metadata rail's `rev 14 · 6 changes` line.
 *
 * Three things are the route's own, and are what this file pins:
 *
 * 1. **The gate.** `read:history` is a PAGE RULE permission, so it is checked with `mayOnPage`
 *    against this page, not declared as a route-level `config.permissions` (that hook reads the
 *    group-wide list and would refuse everybody). A reader without it still gets the page.
 * 2. **Absence, not zero.** `revision` is missing entirely for such a reader, and `changeCount` is
 *    missing for a page with nothing to compare against. The two states render differently, and the
 *    response serializer would happily turn a `null` into a `0` against an `integer` field — so the
 *    assertions here are `undefined`/`in`, never falsiness.
 * 3. **No wasted query.** `revisionSummary` is not called at all when the gate refuses.
 *
 * The summary's own arithmetic is not re-tested here; `models/pageHistory.revision.db.test.ts` owns
 * it against a real database. `buildTestApp` registers the real shared schemas, so a field this
 * route returns but `Page#` does not declare would be stripped before these assertions see it —
 * which is the point of asserting through the HTTP response rather than the handler's return value.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — revision (OpenProject #2651)', () => {
  const SITE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const PAGE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const PAGE_HASH = 'c0ffee01'

  let revisionSummaryCalls: string[] = []
  let revisionSummaryResult: { ordinal: number; changeCount?: number } = { ordinal: 1 }

  /** Minimal stand-in for what `getPage` hands back — only what the handler and `Page#` touch. */
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

  /** `pagePermissions` stands in for what a group's RULES grant on this page; `permissions` is the
   *  global list `pagePermissionsFor`'s `manage:system` bypass reads, and stays empty. */
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
    revisionSummaryResult = { ordinal: 1 }
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
    revisionSummaryResult = { ordinal: 14, changeCount: 6 }
    const body = await readPage(['read:pages', 'read:history'])
    assert.deepEqual(body.revision, { ordinal: 14, changeCount: 6 })
    assert.deepEqual(revisionSummaryCalls, [PAGE_ID])
  })

  test('a page with nothing to compare against reports the ordinal with no change count', async () => {
    revisionSummaryResult = { ordinal: 1 }
    const body = await readPage(['read:pages', 'read:history'])
    // -> Absent, not zeroed: `rev 1` renders alone, and a `· 0 changes` clause never occurs
    assert.deepEqual(body.revision, { ordinal: 1 })
    assert.equal('changeCount' in body.revision, false)
  })

  test('without read:history the page still reads, with no revision block at all', async () => {
    revisionSummaryResult = { ordinal: 14, changeCount: 6 }
    const body = await readPage(['read:pages'])
    assert.equal(body.title, 'Some Page')
    assert.equal(body.revision, undefined)
    // -> And the summary is never derived for a reader who could not be shown it
    assert.deepEqual(revisionSummaryCalls, [])
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
