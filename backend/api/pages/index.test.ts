import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { siteEnabledPreHandler } from '../../helpers/siteResolution.ts'
import { ensureTemporal } from '../../test/temporal.ts'

/**
 * The two describes that exercise the pages resource as a WHOLE rather than one of its sub-plugins:
 * a route-level fixture that spans the PATCH conflict check, the page-read route's `activeEditors`
 * and the search route in one app, and the site-enabled guard whose whole point is that it covers
 * every page route regardless of which file declares it. Both mount `./index.ts`, the aggregate, as
 * every other `api/pages/*.test.ts` here does.
 */

describe('pages API — concurrent-edit safety and search rule-permission audit', () => {
  /**
   * Regression test for the optimistic-concurrency check on `PATCH /sites/:siteId/pages/:pageId`
   * (task 542): the handler already fetches the current row before calling `updatePage()` for the
   * permission check, so an `expectedUpdatedAt` on the body is compared against `target.updatedAt`
   * right there (millisecond precision, via `Temporal.Instant`) rather than being plumbed into the
   * model. A mismatch skips the write entirely and answers 409 with enough of the current page for
   * the client to offer a diff/overwrite choice without a second round trip.
   *
   * `WIKI.models.pages` / `WIKI.models.groups` / `WIKI.collab` are stubbed, and an `onRequest` hook
   * stands in for `@fastify/session` by writing an authenticated session directly onto the request —
   * keeping this a self-contained unit test of the route's conflict-detection wiring rather than
   * pulling in the db/schema/drizzle/session-store graph.
   *
   * Also covers `GET /sites/:siteId/pages/:pageIdOrHash`'s `viewer.activeEditors` (task 546): the route
   * folds `WIKI.collab.participantInfo()` — itself covered directly, against the real `Awareness`
   * library, in `core/collab.test.ts` — into the same per-page-view response as `approvalState` and
   * `isWatching`. What is worth a route-level test here is the wiring around that call, not
   * `participantInfo()` itself: that it is only ever asked for on a site with `collaborativeEditing` on,
   * and that its answer reaches `viewer.activeEditors` unchanged.
   *
   * And `viewer.draft` (OpenProject #2455), right beside it: the same collab-feature gate, plus a
   * `write:pages` check `activeEditors` does not need. `WIKI.models.pageDrafts.summary()` itself is
   * covered directly in `models/pageDrafts.db.test.ts`; what's worth covering here is the wiring.
   */

  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'
  const STORED_UPDATED_AT = new Date('2026-08-17T10:00:00.000Z')

  let app: FastifyInstance
  let updatePageCalls: any[]
  let participantInfoCalls: string[]
  let siteCollabEnabled: boolean
  let participantInfoResult: { count: number; names: string[] }
  let searchPagesCalls: any[]
  let ruleGrantedPermissions: string[]
  let draftSummaryCalls: string[]
  let draftSummaryResult: { updatedAt: Date; authorName: string | null } | null
  let denyWriteForDraft: boolean

  function currentPage() {
    return {
      id: PAGE_ID,
      path: 'some-page',
      locale: 'en',
      tags: [],
      allowContributions: true,
      title: 'Stored Title',
      content: 'Stored content',
      authorName: 'Someone Else',
      updatedAt: STORED_UPDATED_AT
    }
  }

  before(async () => {
    await ensureTemporal()
    const wiki = {
      // -> `recordPageview()`'s isEnabled gate (OpenProject #2251) reads this; on, matching this
      //    fixture's pre-existing unconditional pageview stub, since pageviews are not what this
      //    describe block is testing.
      config: { pageviews: { isEnabled: true } },
      models: {
        pages: {
          getPage: async () => currentPage(),
          updatePage: async (siteId: string, id: string, patch: any, actor: any) => {
            updatePageCalls.push({ siteId, id, patch, actor })
            return { ...currentPage(), updatedAt: new Date(), authorId: actor.id }
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: ['write:pages'], groupIds: [] }),
          // -> Grants everything except `write:pages` when `denyWriteForDraft` is set -- the one
          //    permission `viewer.draft` (OpenProject #2455) is gated on, exercised below without
          //    disturbing every other test in this fixture, which relies on an unconditional grant.
          checkAccess: (_actor: any, permission: string) =>
            !(permission === 'write:pages' && denyWriteForDraft),
          groupIdsForRequest: () => [],
          // -> Regression stub for task 551's fix: the search route asks this rather than scanning
          //    `actor.permissions` (the GLOBAL list) for `write:pages`/`manage:pages`, which are page-rule
          //    permissions and never legitimately appear there. Driven per-test by
          //    `ruleGrantedPermissions`, standing in for "some rule across this actor's groups grants it".
          mayHoldPermissionSomewhere: (_actor: any, permissions: string[]) =>
            permissions.some((p) => ruleGrantedPermissions.includes(p))
        },
        approvals: {
          pageViewerState: async () => ({
            canSuggestEdits: false,
            hasOpenSuggestion: false,
            canReview: false,
            pendingSubmissions: []
          })
        },
        pageWatching: {
          isWatching: async () => false
        },
        search: {
          query: async (params: any) => {
            searchPagesCalls.push(params)
            return { results: [], totalHits: 0, suggestion: null }
          }
        },
        comments: {
          countForPage: async () => 0
        },
        // -> `revision` (OpenProject #2651): this fixture's `checkAccess` grants every page
        //    permission, `read:history` included, so the page read reaches the summary. A constant
        //    stub -- `read.revision.test.ts` owns what the field actually carries.
        pageHistory: {
          revisionSummary: async () => ({ ordinal: 1 })
        },
        // -> The route's best-effort pageview logging (OpenProject #1238) -- a no-op stub is all this
        //    fixture needs, since what's under test here is collab/search wiring, not pageviews.
        pageviews: {
          record: async () => {}
        },
        // -> `viewer.draft` (OpenProject #2455): the lightweight existence check folded into the same
        //    page-read response as `activeEditors`, on the same collab-feature gate.
        pageDrafts: {
          summary: async (pageId: string) => {
            draftSummaryCalls.push(pageId)
            return draftSummaryResult
          }
        }
      },
      collab: {
        pageSaved: () => {},
        participantInfo: (pageId: string) => {
          participantInfoCalls.push(pageId)
          return participantInfoResult
        }
      },
      get sites() {
        return {
          [SITE_ID]: { config: { features: { collaborativeEditing: siteCollabEnabled } } }
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: {
        authenticated: true,
        user: { id: 'author-1', email: 'author@example.com', name: 'Author' },
        permissions: []
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    updatePageCalls = []
    participantInfoCalls = []
    siteCollabEnabled = true
    participantInfoResult = { count: 0, names: [] }
    searchPagesCalls = []
    ruleGrantedPermissions = []
    draftSummaryCalls = []
    draftSummaryResult = null
    denyWriteForDraft = false
  })

  test('a save with no expectedUpdatedAt writes through as before', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: { title: 'New Title' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
  })

  test('a save whose expectedUpdatedAt matches the stored value writes through', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: {
        title: 'New Title',
        expectedUpdatedAt: STORED_UPDATED_AT.toISOString()
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
  })

  test('a save whose expectedUpdatedAt is stale is rejected with 409 and skips the write', async () => {
    const staleDate = new Date(STORED_UPDATED_AT.getTime() - 60_000).toISOString()
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: { title: 'New Title', expectedUpdatedAt: staleDate }
    })
    assert.equal(res.statusCode, 409)
    assert.equal(updatePageCalls.length, 0)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.equal(typeof body.message, 'string')
    assert.ok(body.page)
    assert.equal(body.page.title, 'Stored Title')
    assert.equal(body.page.content, 'Stored content')
    assert.equal(body.page.authorName, 'Someone Else')
    assert.equal(body.page.updatedAt, STORED_UPDATED_AT.toISOString())
  })

  /**
   * Escape-hatch guarantee for OpenProject #838 (upstream requarks/wiki #2256: "Conflict after
   * editing a page which can't be resolved"). A 409 must never be a dead end: the author's edit has
   * to remain saveable by re-submitting with the conflicting save's own `updatedAt` as the new
   * baseline -- exactly what `PageSaveConflictDialog.vue`'s "Save Anyway" does. This drives that
   * two-step sequence against the route directly: the refused save's response carries everything
   * needed for the retry (`body.page.updatedAt`), the retry is accepted, and what actually reaches
   * `updatePage()` is this author's own content, not the version that caused the conflict.
   */
  test("a 409 conflict is always recoverable: retrying with the response's updatedAt as the new baseline writes this author's content through", async () => {
    const staleDate = new Date(STORED_UPDATED_AT.getTime() - 60_000).toISOString()
    const refused = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: {
        title: "This author's title",
        content: "This author's content",
        expectedUpdatedAt: staleDate
      }
    })
    assert.equal(refused.statusCode, 409)
    assert.equal(updatePageCalls.length, 0)
    const conflictSnapshot = refused.json().page

    const retried = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: {
        title: "This author's title",
        content: "This author's content",
        expectedUpdatedAt: conflictSnapshot.updatedAt
      }
    })
    assert.equal(retried.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.equal(updatePageCalls[0].patch.title, "This author's title")
    assert.equal(updatePageCalls[0].patch.content, "This author's content")
  })

  test('expectedUpdatedAt is compared at millisecond precision, not nanosecond', async () => {
    // -> Same instant, just re-serialized without sub-millisecond noise
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: {
        title: 'New Title',
        expectedUpdatedAt: STORED_UPDATED_AT.toTemporalInstant().toString({
          smallestUnit: 'millisecond'
        })
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
  })

  test('GET page carries collab.participantInfo() through as viewer.activeEditors, on a site with the feature on', async () => {
    participantInfoResult = { count: 2, names: ['Ada Lovelace', 'Grace Hopper'] }
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(participantInfoCalls, [PAGE_ID])
    const body = res.json()
    assert.deepEqual(body.viewer.activeEditors, {
      count: 2,
      names: ['Ada Lovelace', 'Grace Hopper']
    })
  })

  test('GET page never asks collab for participants, and answers zero, on a site with collaborativeEditing off', async () => {
    siteCollabEnabled = false
    participantInfoResult = { count: 5, names: ['Should Not Appear'] }
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(participantInfoCalls, [])
    const body = res.json()
    assert.deepEqual(body.viewer.activeEditors, { count: 0, names: [] })
  })

  test('GET page answers activeEditors: { count: 0, names: [] } when nobody else has the page open', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(body.viewer.activeEditors, { count: 0, names: [] })
  })

  /**
   * `viewer.draft` (OpenProject #2455): the lightweight "there is a recovery draft" signal folded
   * into the same page-read response, on the same `collaborativeEditing` gate as `activeEditors` — but
   * gated additionally on `write:pages`, since a draft is nothing but a collaboration room's leftover
   * content and only matters to whoever could have written the room in the first place.
   */
  test('GET page carries pageDrafts.summary() through as viewer.draft, on a site with the feature on', async () => {
    draftSummaryResult = { updatedAt: STORED_UPDATED_AT, authorName: 'Ada Lovelace' }
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(draftSummaryCalls, [PAGE_ID])
    const body = res.json()
    assert.equal(body.viewer.draft.authorName, 'Ada Lovelace')
    assert.equal(body.viewer.draft.updatedAt, STORED_UPDATED_AT.toISOString())
  })

  test('GET page answers viewer.draft: null when there is no recovery draft', async () => {
    draftSummaryResult = null
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(draftSummaryCalls, [PAGE_ID])
    assert.equal(res.json().viewer.draft, null)
  })

  test('GET page never asks pageDrafts for a summary, and answers null, on a site with collaborativeEditing off', async () => {
    siteCollabEnabled = false
    draftSummaryResult = { updatedAt: STORED_UPDATED_AT, authorName: 'Should Not Appear' }
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(draftSummaryCalls, [])
    assert.equal(res.json().viewer.draft, null)
  })

  test('GET page never asks pageDrafts for a summary, and answers null, for a requester who may not write the page', async () => {
    denyWriteForDraft = true
    draftSummaryResult = { updatedAt: STORED_UPDATED_AT, authorName: 'Should Not Appear' }
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(draftSummaryCalls, [])
    assert.equal(res.json().viewer.draft, null)
  })

  /**
   * Regression tests for task 551's audit-sweep fix: the search route (`GET
   * /sites/:siteId/pages/search`) used to decide `includeDrafts`/`hideProtectedContent` by scanning
   * `actor.permissions` — the GLOBAL, group-wide permission list — for `write:pages`/`manage:pages`,
   * which are page-rule permissions a group's global `permissions` column never legitimately carries
   * (the group editor doesn't offer them, and nothing seeds them there). The check was effectively dead
   * for every real editor, contradicting the route's own documented behavior ("Drafts are included only
   * for someone who may write pages"). It now asks `WIKI.models.groups.mayHoldPermissionSomewhere()`,
   * which pools the actor's actual page rules instead — covered directly, against real rule rows, in
   * `models/groups.test.ts`; what's worth covering here is that the route wires that answer through to
   * both search options rather than the old `actor.permissions` scan.
   */
  test('search includes drafts and bypasses password-protected excerpts for an actor whose page rules grant write:pages, even though write:pages is absent from their global permission list', async () => {
    ruleGrantedPermissions = ['write:pages']
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/search`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(searchPagesCalls.length, 1)
    assert.equal(searchPagesCalls[0].includeDrafts, true)
    assert.equal(searchPagesCalls[0].hideProtectedContent, false)
  })

  test('search excludes drafts and hides password-protected excerpts for an actor with no write:pages/manage:pages rule anywhere', async () => {
    ruleGrantedPermissions = ['read:pages']
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/search`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(searchPagesCalls.length, 1)
    assert.equal(searchPagesCalls[0].includeDrafts, false)
    assert.equal(searchPagesCalls[0].hideProtectedContent, true)
  })

  /**
   * OpenProject #830 (upstream #6541, permission-filtered instant-search suggestions): this route is
   * what the header's live-preview panel calls (`HeaderSearch.vue`'s `fetchPreview()`, same URL, same
   * query params), so it is the "instant-search endpoint" that suggestion filtering must apply to.
   * `search.query()`'s own permission filtering (covered against a real database in
   * `modules/search/db/search.test.ts`) only works if it is actually handed the requester's access
   * actor -- this is the wiring proof that it is, for every request, not merely when `write:pages`
   * happens to be in play like the two tests above.
   */
  test('search wires the accessActor through to search.query, so results and suggestions can be permission-filtered', async () => {
    ruleGrantedPermissions = []
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/search?query=numbat`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(searchPagesCalls.length, 1)
    assert.deepEqual(searchPagesCalls[0].actor, { permissions: ['write:pages'], groupIds: [] })
  })
})

describe('pages API — isEnabled guard (task 699 / OpenProject #1587 / #1593)', () => {
  /**
   * Regression coverage for the disabled-site guard on `api/pages/`'s own site-scoped routes. Originally
   * (task 699) this guard was hand-applied inside three handlers — LIST, SEARCH and INCLUDE — and this
   * describe block registered `pagesRoutes` on its own to prove exactly those three. OpenProject
   * #1587/#1593 deleted all three hand-applied calls: the guard is now `siteEnabledPreHandler`
   * (`helpers/siteResolution.ts`), one `preHandler` `api/index.ts` registers on its guarded content-route
   * subtree, before any content route file (`api/pages/` is one of them; `sites.ts`, site administration
   * rather than content, deliberately is not — see `index.ts`'s own doc comment), so a route in
   * `api/pages/` no longer guards itself at all. Registering that same real preHandler here (not a
   * re-implementation of it — see the import) before `pagesRoutes`, exactly as `index.ts` orders it, is
   * what makes this describe block still a meaningful test of `api/pages/`'s routes rather than of the
   * preHandler itself (which `index.test.ts` already covers directly, across every `:siteId` route in
   * every `api/` file, discovered structurally rather than named one by one).
   *
   * Widened past the original three routes (of which LIST was deleted by OpenProject #1986 as a
   * permanently-empty stub with no caller — SEARCH and INCLUDE are what remain of the original
   * three here) to the rest of `api/pages/`'s previously-*unguarded* surface named in the audit this
   * task closes (`docs/audit-2026-08-24/correctness-api-routes.md` §1): GET PAGE, page history, a
   * single history version, and export. (`UNLOCK` is covered structurally in `index.test.ts`'s
   * route-surface scan instead of here, since it carries its own `onRequest` rate-limit hook ahead
   * of this preHandler, which would need its own stub setup to exercise safely.) Every case below
   * asserts a disabled site is refused before the handler runs — a stubbed model method's call
   * count staying at 0 is the proof of that, the same technique the original three cases already
   * used. The enabled-site pass-through case is kept only for the original three, which already had
   * inexpensive stubs for it; the newly-added routes would need considerably more model scaffolding
   * to reach 200 that adds nothing to what this task is actually regression-testing.
   */

  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
  const PAGE_ID = '33333333-3333-4333-8333-333333333333'
  const VERSION_ID = '44444444-4444-4444-8444-444444444444'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
    [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
  }

  let searchPagesCalls = 0
  let getPageCalls = 0
  let pageHistoryCalls = 0

  let app: FastifyInstance

  before(async () => {
    const wiki = {
      sites,
      models: {
        search: {
          query: async () => {
            searchPagesCalls++
            return { results: [], totalHits: 0 }
          }
        },
        pages: {
          getPage: async () => {
            getPageCalls++
            return null
          }
        },
        pageHistory: {
          getHistory: async () => {
            pageHistoryCalls++
            return { history: [], total: 0 }
          },
          getVersion: async () => {
            pageHistoryCalls++
            return null
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          mayHoldPermissionSomewhere: () => false
        }
      }
    }

    const wrappedRoutes: FastifyPluginAsync = async (instance) => {
      // -> Mirrors `api/index.ts`'s own registration order: the guard is a plugin-level hook, added
      //    before the route file it covers is registered — `api/pages/` no longer calls
      //    `guardSiteEnabled` itself (OpenProject #1593).
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(pagesRoutes)
    }

    app = await buildTestApp({
      routes: wrappedRoutes,
      ajv: true,
      wiki
    })
  })

  after(() => closeTestApp(app))

  test('SEARCH: answers 403 for a disabled site, without ever calling searchPages', async () => {
    searchPagesCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${DISABLED_SITE_ID}/pages/search?query=foo`
    })
    assert.equal(res.statusCode, 403)
    assert.equal(searchPagesCalls, 0)
  })

  test('SEARCH: an enabled site reaches searchPages as before', async () => {
    searchPagesCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${ENABLED_SITE_ID}/pages/search?query=foo`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(searchPagesCalls, 1)
  })

  test('INCLUDE: answers 403 for a disabled site, without ever calling getPage', async () => {
    getPageCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${DISABLED_SITE_ID}/pages/include?path=home`
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getPageCalls, 0)
  })

  test('INCLUDE: an enabled site reaches getPage as before', async () => {
    getPageCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${ENABLED_SITE_ID}/pages/include?path=home`
    })
    // -> 404 because getPage is stubbed to return null, but the guard let the request get there
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls, 1)
  })

  /*
    GET PAGE and PAGE HISTORY carried no `guardSiteEnabled` call at all before OpenProject #1587/
    #1593 -- neither was reachable through this describe's original three-route scope. Both now
    answer 403 through the shared preHandler wired above, with no route-specific stub required: the
    preHandler runs before the handler ever touches `WIKI.models`.
  */

  test('GET PAGE: answers 403 for a disabled site, without ever calling getPage', async () => {
    getPageCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${DISABLED_SITE_ID}/pages/abc123`
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /disabled/i)
    assert.equal(getPageCalls, 0)
  })

  test('PAGE HISTORY: answers 403 for a disabled site, without ever calling getHistory', async () => {
    pageHistoryCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${DISABLED_SITE_ID}/pages/${PAGE_ID}/history`
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /disabled/i)
    assert.equal(pageHistoryCalls, 0)
  })

  test('PAGE HISTORY VERSION: answers 403 for a disabled site, without ever calling getVersion', async () => {
    pageHistoryCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${DISABLED_SITE_ID}/pages/${PAGE_ID}/history/${VERSION_ID}`
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /disabled/i)
    assert.equal(pageHistoryCalls, 0)
  })

  test('EXPORT: answers 403 for a disabled site, without ever calling getPage', async () => {
    getPageCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${DISABLED_SITE_ID}/pages/${PAGE_ID}/export?format=html`
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /disabled/i)
    assert.equal(getPageCalls, 0)
  })

  /**
   * Regression tests for task 673: `mayOnPage` and `pagePermissionsFor` take an explicit `siteId`
   * and thread it into the `RulePageRef` given to `checkAccess`, so a page rule scoped to one site
   * (task 671) is actually enforced from these two call sites rather than silently matching every
   * site's rules. The two functions themselves are covered directly in `helpers/pageAccess.test.ts`
   * (where they now live); what stays here is the ROUTE half — that each route passes its own
   * `req.params.siteId` down into them rather than something else.
   */

  test('PAGE USER PERMISSIONS route: passes the route siteId through to pagePermissionsFor', async () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return false
    }
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${ENABLED_SITE_ID}/pages/userPermissions`,
        payload: { path: 'foo/bar' }
      })
      assert.equal(res.statusCode, 200)
      assert.ok(calls.length > 0)
      for (const page of calls) {
        assert.equal(page.siteId, ENABLED_SITE_ID)
      }
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
    }
  })

  test('RESOLVE ALIAS route: passes the route siteId through an inline page ref to mayOnPage', async () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    const originalGetPathFromAlias = (globalThis as any).WIKI.models.pages.getPathFromAlias
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return true
    }
    ;(globalThis as any).WIKI.models.pages.getPathFromAlias = async () => ({
      id: 'p1',
      path: 'some/path'
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${ENABLED_SITE_ID}/pages/alias/foo`
      })
      assert.equal(res.statusCode, 200)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].siteId, ENABLED_SITE_ID)
      assert.equal(calls[0].path, 'some/path')
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
      ;(globalThis as any).WIKI.models.pages.getPathFromAlias = originalGetPathFromAlias
    }
  })
})
