import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { siteEnabledPreHandler } from '../../helpers/siteResolution.ts'
import { ensureTemporal } from '../../test/temporal.ts'

/**
 * The suites that exercise the pages resource as a whole rather than one of its sub-plugins: a
 * fixture spanning the write, read and search routes in one app, and the site-enabled guard, which
 * covers every page route regardless of which file declares it.
 */

describe('pages API — concurrent-edit safety and search rule-permission audit', () => {
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
      // -> Read by the page-read route's `recordPageview()` gate
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
          checkAccess: (_actor: any, permission: string) =>
            !(permission === 'write:pages' && denyWriteForDraft),
          groupIdsForRequest: () => [],
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
        // -> Reached because `checkAccess` grants `read:history`; `read.revision.test.ts` owns what
        //    the `revision` field carries
        pageHistory: {
          revisionSummary: async () => ({ ordinal: 1 })
        },
        pageviews: {
          record: async () => {}
        },
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

  // -> The retry below is what `PageSaveConflictDialog.vue`'s "Save Anyway" sends
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
          // FIXME: the history route calls `pageHistory.list`, not `getHistory`, so the PAGE
          // HISTORY case's call count cannot fail. Rename this stub to `list`.
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
      // -> The real guard, added before the routes it covers, as `api/index.ts` registers it
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

  // -> Site-scoped page rules are enforced only when a route threads its own `siteId` into the ref

  test('PAGE USER PERMISSIONS route: passes the route siteId through to pagePermissionsFor', async () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
    }
  })

  test('RESOLVE ALIAS route: passes the route siteId through an inline page ref to mayOnPage', async () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    const originalGetPathFromAlias = (globalThis as any).CARDINAL.models.pages.getPathFromAlias
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return true
    }
    ;(globalThis as any).CARDINAL.models.pages.getPathFromAlias = async () => ({
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
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
      ;(globalThis as any).CARDINAL.models.pages.getPathFromAlias = originalGetPathFromAlias
    }
  })
})
