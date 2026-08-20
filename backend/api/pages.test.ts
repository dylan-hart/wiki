import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it, mock, test } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifySwagger from '@fastify/swagger'
import ajvFormats from 'ajv-formats'
import { registerSchemas } from './schemas/page.ts'
// -> 'Page#' nests a 'viewer.pendingSubmissions' item that $refs 'PageEditSubmission#', so that
//    schema has to exist too or Fastify fails to build the serializer at all.
import { registerSchemas as registerApprovalSchemas } from './schemas/approval.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { registerSchemas as registerPageImportSchema } from './schemas/pageImport.ts'
import pagesRoutes, { mayOnPage, pagePermissionsFor } from './pages.ts'
import { resolvePageRule } from '../helpers/pageRules.ts'
import { CustomError } from '../helpers/common.ts'
import type { GroupRule } from '../models/groups.ts'

/**
 * Task 601: `GET /sites/:siteId/pages/:pageIdOrHash` — the page-read route — must carry a real
 * `commentsCount` alongside `allowComments`, so the frontend's dead `commentsCount` store field
 * (`frontend/src/stores/page.js`) has something to hold once a page is fetched.
 *
 * Only that route is exercised here. The other handlers touching the `Page#` response schema
 * (create/update/unlock) are unaffected by this task and are left alone, matching the task's own
 * scope note.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — commentsCount', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'

  /** Minimal stand-in for what `WIKI.models.pages.getPage` hands back — nothing the route inspects. */
  function makeFakePage(overrides: Record<string, unknown> = {}) {
    return {
      id: PAGE_ID,
      path: 'some-page',
      hash: 'abc123',
      locale: 'en',
      title: 'Some Page',
      allowComments: true,
      allowContributions: true,
      tags: [],
      ...overrides
    }
  }

  let countForPageCalls: string[] = []
  let countForPageResult = 0

  function stubWiki() {
    countForPageCalls = []
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async () => makeFakePage()
        },
        groups: {
          // -> Grants every check, so the route reaches the response body under test
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          groupIdsForRequest: () => []
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
        comments: {
          countForPage: async (pageId: string) => {
            countForPageCalls.push(pageId)
            return countForPageResult
          }
        }
      },
      sites: {}
    }
  }

  async function buildApp() {
    const app = Fastify()
    await registerSchemas(app)
    await registerApprovalSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
    return app
  }

  let app: Awaited<ReturnType<typeof buildApp>>

  before(async () => {
    app = await buildApp()
  })

  beforeEach(() => {
    stubWiki()
  })

  it('includes commentsCount from the comments model in the response', async () => {
    countForPageResult = 4
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.commentsCount, 4)
    assert.equal(body.allowComments, true)
    assert.deepEqual(countForPageCalls, [PAGE_ID])
  })

  it('reflects a page with no comments as zero, not absent', async () => {
    countForPageResult = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.commentsCount, 0)
    assert.ok(Object.hasOwn(body, 'commentsCount'))
  })
})

/**
 * Route-wiring proof for `enforceApiKeySite` (`helpers/apiKeySite.ts`), on the two routes it was
 * wired into as this task's representative surface: `GET /sites/:siteId/pages/:pageIdOrHash` and
 * `POST /sites/:siteId/pages`. The helper's own behavior (null vs. matching vs. mismatched siteId) is
 * unit-tested in `helpers/apiKeySite.test.ts`; this file only proves it is actually reached first in
 * real route handlers, ahead of any model call — real route registration, real schemas, real
 * `@fastify/sensible` `reply.forbidden()`.
 *
 * `req.apiKey` is attached by a fixture `onRequest` hook that reads it off an `x-test-api-key` test
 * header, the same shape `models/apiKeys.ts#verify()` produces at runtime — nothing about the routes
 * themselves is test-specific.
 *
 * `WIKI.models.pages.getPage` is stubbed to return `null` so a request that clears the site-scope gate
 * falls through to the ordinary "page does not exist" 404 — which needs no `Page#` response payload —
 * rather than requiring a full page object satisfying that schema just to prove the gate was passed.
 */
describe('pages API — enforceApiKeySite site-scoping', () => {
  const SITE_A = '11111111-1111-4111-8111-111111111111'
  const SITE_B = '22222222-2222-4222-8222-222222222222'
  const PAGE_HASH = 'ab'.repeat(16)

  let getPageCalls: any[] = []
  let createPageCalls: any[] = []

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async (args: any) => {
            getPageCalls.push(args)
            return null
          },
          createPage: async (...args: any[]) => {
            createPageCalls.push(args)
            return { id: 'new-page-id' }
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          groupIdsForRequest: () => []
        }
      },
      sites: {}
    }

    app = Fastify()
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/etc. is a
    //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
    //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    app.addHook('onRequest', async (req) => {
      const rawKey = req.headers['x-test-api-key']
      if (typeof rawKey === 'string') {
        ;(req as any).apiKey = JSON.parse(rawKey)
      }
      const rawSession = req.headers['x-test-session']
      if (typeof rawSession === 'string') {
        ;(req as any).session = JSON.parse(rawSession)
      }
    })
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    getPageCalls = []
    createPageCalls = []
  })

  function apiKeyHeader(siteId: string | null) {
    return { 'x-test-api-key': JSON.stringify({ id: 'key-1', permissions: [], siteId }) }
  }

  test('GET page: refuses with 403 before touching the model when the key is scoped to a different site', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_A}/pages/${PAGE_HASH}`,
      headers: apiKeyHeader(SITE_B)
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getPageCalls.length, 0)
  })

  test('GET page: reaches the model when the key is scoped to the matching site', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_A}/pages/${PAGE_HASH}`,
      headers: apiKeyHeader(SITE_A)
    })
    assert.equal(res.statusCode, 404) // -> past the gate, into the ordinary "page not found" path
    assert.equal(getPageCalls.length, 1)
  })

  test('GET page: reaches the model when the key is unscoped (siteId: null)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_A}/pages/${PAGE_HASH}`,
      headers: apiKeyHeader(null)
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('CREATE page: refuses with 403 before touching the model when the key is scoped to a different site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_A}/pages`,
      headers: apiKeyHeader(SITE_B),
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(createPageCalls.length, 0)
  })

  test('CREATE page: passes the gate and reaches the model when the key is scoped to the matching site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_A}/pages`,
      headers: {
        ...apiKeyHeader(SITE_A),
        'x-test-session': JSON.stringify({
          authenticated: true,
          user: { id: 'user-1' },
          permissions: []
        })
      },
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(createPageCalls.length, 1)
  })

  test('CREATE page: refused by the ordinary unauthenticated check, not the site gate, when the key is unscoped and there is no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_A}/pages`,
      headers: apiKeyHeader(null),
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    // -> Past the site-scope gate (unscoped key): refused next by `actorFrom` (no session).
    assert.equal(res.statusCode, 401)
    assert.equal(createPageCalls.length, 0)
  })
})

describe('pages API — concurrent-edit safety and search rule-permission audit', () => {
  let previousTemporal: any
  let previousToTemporalInstant: any

  /**
   * Minimal stand-in for the subset of `Temporal` the route under test calls: `Temporal.Instant.from()`
   * plus `.epochMilliseconds` for the concurrency check, and `Date#toTemporalInstant().toString({
   * smallestUnit })` for the collab-save notification the handler already sends.
   *
   * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
   * older and doesn't expose it (same environment gap noted in `core/scheduler.test.ts` — not a spec
   * deviation). Installed only when genuinely missing, so a real Node 26 run exercises the native API.
   */
  function installFakeTemporal(): void {
    ;(globalThis as any).Temporal = {
      Instant: {
        from: (iso: string) => ({ epochMilliseconds: Date.parse(iso) })
      }
    }
    ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
      const epochMilliseconds = this.getTime()
      return {
        epochMilliseconds,
        toString: () => new Date(epochMilliseconds).toISOString()
      }
    }
  }

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
    previousTemporal = (globalThis as any).Temporal
    previousToTemporalInstant = (Date.prototype as any).toTemporalInstant
    if (typeof previousTemporal === 'undefined') {
      installFakeTemporal()
    }
    ;(globalThis as any).WIKI = {
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
          checkAccess: () => true,
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

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    // -> Stands in for `@fastify/session`: every injected request arrives already logged in.
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = {
        authenticated: true,
        user: { id: 'author-1', email: 'author@example.com', name: 'Author' },
        permissions: []
      }
    })
    await registerSchemas(app)
    await registerApprovalSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
    ;(globalThis as any).Temporal = previousTemporal
    ;(Date.prototype as any).toTemporalInstant = previousToTemporalInstant
  })

  beforeEach(() => {
    updatePageCalls = []
    participantInfoCalls = []
    siteCollabEnabled = true
    participantInfoResult = { count: 0, names: [] }
    searchPagesCalls = []
    ruleGrantedPermissions = []
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
})

/**
 * Task 602 regression coverage for `pages.ts`, the file this task's TDD change actually lands in:
 *
 * 1. `relations` and `toc` used to be `{ type: 'object', additionalProperties: true }` — accurate to
 *    nothing in particular. Both have exactly one producer (`PageRelationDialog.vue` for relations,
 *    `rendering.ts`'s `anchorHeadings`/`nestHeadings` for toc) with a fixed shape, so they are now
 *    `PageRelation#` / `PageTocNode#`. The first block below proves the tightened schema is not just
 *    documentation: fast-json-stringify silently drops a field the schema doesn't declare, so a
 *    response carrying one is proof the schema is actually narrower than before.
 * 2. `GET /sites/:siteId/pages/:pageIdOrHash` can reply 403 and 404 (`mayOnPage` / `getPage` returning
 *    null) but declared neither. The second block proves both are now declared AND that what the
 *    handler actually sends on those paths validates against the declared `ApiError` schema.
 */
describe('pages API — response schema completeness (task 602)', () => {
  const samplePage = {
    id: '11111111-1111-1111-1111-111111111111',
    path: 'foo',
    hash: 'abc123',
    alias: null,
    title: 'Foo',
    description: null,
    icon: null,
    locale: 'en',
    editor: 'markdown',
    contentType: 'text',
    publishState: 'published',
    publishStartDate: null,
    publishEndDate: null,
    isBrowsable: true,
    isSearchable: true,
    isLocked: false,
    relations: [
      {
        id: 'r1',
        position: 'left',
        label: 'Next',
        icon: 'la:arrow-left',
        target: '/bar',
        // -> Not part of `PageRelation`'s declared properties: proves the schema is enforced, not
        //    merely descriptive, since it must NOT survive serialization.
        bogusField: 'should be stripped'
      }
    ],
    tags: [],
    toc: [
      {
        key: 'h-intro',
        label: 'Intro',
        level: 1,
        children: []
      }
    ],
    render: '<p>hi</p>',
    allowComments: true,
    allowContributions: true,
    allowRatings: true,
    showSidebar: true,
    showTags: true,
    showToc: true,
    tocDepth: { min: 1, max: 2 },
    scriptJsLoad: '',
    scriptJsUnload: '',
    scriptCss: '',
    navigationId: null,
    navigationMode: 'default',
    authorId: '22222222-2222-2222-2222-222222222222',
    authorName: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z'
  }

  let app: FastifyInstance
  let mayOnPageResult = true
  let getPageResult: any = samplePage

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async () => getPageResult
        },
        groups: {
          actorForRequest: () => ({ groupIds: [], permissions: [] }),
          checkAccess: () => mayOnPageResult,
          groupIdsForRequest: () => []
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
        comments: {
          countForPage: async () => 0
        }
      },
      sites: {}
    }

    app = Fastify()
    await app.register(fastifySensible)
    await app.register(fastifySwagger, {
      hideUntagged: true,
      openapi: { openapi: '3.1.0', info: { title: 'test', version: '0.0.0' } }
    })
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()` etc. is a
    //    thrown `@fastify/sensible` error, and it is THIS handler — not fastify's default — that shapes
    //    it into the `{ ok, error, statusCode, message }` the `ApiError` schema below expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  /** Follows a `$ref` (however `@fastify/swagger` named the component) to the schema it points at. */
  function resolveRef(doc: any, schema: any): any {
    if (!schema?.$ref) return schema
    const name = schema.$ref.replace('#/components/schemas/', '')
    return doc.components.schemas[name]
  }

  test('Page relations and toc are no longer bare additionalProperties blobs', () => {
    const doc: any = app.swagger()
    const pageSchema = resolveRef(
      doc,
      doc.paths['/sites/{siteId}/pages/{pageIdOrHash}'].get.responses['200'].content[
        'application/json'
      ].schema
    )

    const relation = resolveRef(doc, pageSchema.properties.relations.items)
    assert.deepEqual(Object.keys(relation.properties).sort(), [
      'caption',
      'icon',
      'id',
      'label',
      'position',
      'target'
    ])
    assert.notEqual(relation.additionalProperties, true)

    const tocNode = resolveRef(doc, pageSchema.properties.toc.items)
    assert.deepEqual(Object.keys(tocNode.properties).sort(), ['children', 'key', 'label', 'level'])
    assert.notEqual(tocNode.additionalProperties, true)
  })

  test('GET single page declares its 403 and 404 responses', () => {
    const doc: any = app.swagger()
    const responses = doc.paths['/sites/{siteId}/pages/{pageIdOrHash}'].get.responses
    assert.ok(responses['403'], '403 must be declared: mayOnPage can refuse')
    assert.ok(responses['404'], '404 must be declared: getPage can return null')
  })

  test('a bogus field on a relation is stripped by the tightened schema', async () => {
    mayOnPageResult = true
    getPageResult = samplePage
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.relations[0].bogusField, undefined)
    assert.equal(body.relations[0].id, 'r1')
    assert.deepEqual(body.toc[0], { key: 'h-intro', label: 'Intro', level: 1, children: [] })
  })

  test('GET single page: 404 when the page does not exist, matching ApiError', async () => {
    getPageResult = null
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 404)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.equal(typeof body.message, 'string')
  })

  test('GET single page: 403 when mayOnPage refuses', async () => {
    getPageResult = samplePage
    mayOnPageResult = false
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 403)
    const body = res.json()
    assert.equal(body.ok, false)
    mayOnPageResult = true
  })
})

/**
 * Regression test for `GET /_api/sites/:siteId/pages/:pageIdOrHash`'s `withContent=true` path:
 * `PAGE_PERMISSIONS` in `pages.ts` declares `read:source`, but only `read:pages` was ever checked
 * before returning the raw `content` field — so a reader granted `read:pages` but not `read:source`
 * (a group that may see a page but not its markdown, e.g. one meant only to browse the rendered
 * result) could pull the source anyway by asking for `withContent=true`. Fixed by checking
 * `read:source` too, but only when content was actually requested — the plain page view (`render`
 * only) needs no more than `read:pages`, exactly as before.
 *
 * `WIKI.models.groups.actorForRequest` / `checkAccess` are stubbed to a minimal permission set
 * carried on the test session (`testPagePermissions`) rather than pulling in the real page-rules
 * resolver — this is a route-wiring test, not a `helpers/pageRules.ts` test (see
 * `helpers/pageRules.test.ts` for that). `WIKI.models.pages.getPage` is stubbed to hand back
 * `content` exactly when asked, mirroring the real model's `withContent` contract, so the test
 * would fail the same way the bug did if the route stopped checking `read:source`.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — withContent requires read:source', () => {
  const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const AUTHOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const PAGE_HASH = 'deadbeef'
  const RENDER_HTML = '<p>Hello</p>'
  const RAW_CONTENT = '# Hello'

  async function getPage({ withContent }: { withContent?: boolean }) {
    return {
      id: PAGE_ID,
      path: 'foo',
      hash: PAGE_HASH,
      alias: null,
      title: 'Foo',
      description: null,
      icon: null,
      locale: 'en',
      editor: 'markdown',
      contentType: 'markdown',
      publishState: 'published',
      publishStartDate: null,
      publishEndDate: null,
      isBrowsable: true,
      isSearchable: true,
      isLocked: false,
      relations: [],
      tags: [],
      toc: [],
      render: RENDER_HTML,
      ...(withContent ? { content: RAW_CONTENT } : {}),
      allowComments: false,
      allowContributions: false,
      allowRatings: false,
      showSidebar: true,
      showTags: true,
      showToc: true,
      tocDepth: { min: 1, max: 2 },
      scriptJsLoad: '',
      scriptJsUnload: '',
      scriptCss: '',
      navigationId: null,
      navigationMode: 'default',
      authorId: AUTHOR_ID,
      authorName: 'Test Author',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }

  function actorForRequest(req: any) {
    const session = req.session as unknown as { testPagePermissions?: string[] } | undefined
    // -> `permissions` (empty here) is the GLOBAL list `pagePermissionsFor`'s `manage:system` bypass
    //    reads; `pagePermissions` is this test's stand-in for what a group's RULES would grant.
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
    ;(globalThis as any).WIKI = {
      models: {
        pages: { getPage },
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
        comments: { countForPage: async () => 0 }
      },
      sites: {}
    }

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.forbidden()` etc. is a thrown
    //    `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that shapes it
    //    into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerSchemas(app)
    await registerApprovalSchemas(app)
    // -> Fakes what a real session cookie provides, keyed off a header instead so each test can set
    //    its own reader without a real @fastify/session plugin or database in the loop.
    app.addHook('onRequest', async (req) => {
      const raw = req.headers['x-test-session']
      if (typeof raw === 'string') {
        ;(req as any).session = JSON.parse(raw)
      }
    })
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
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

  test('read:pages alone renders the page without withContent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
      headers: sessionHeader(['read:pages'])
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.render, RENDER_HTML)
    assert.equal(body.content, undefined)
  })

  test('read:pages without read:source is forbidden from withContent=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
      headers: sessionHeader(['read:pages'])
    })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().content, undefined)
  })

  test('read:pages plus read:source is allowed withContent=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
      headers: sessionHeader(['read:pages', 'read:source'])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().content, RAW_CONTENT)
  })

  test('no read:pages at all is forbidden regardless of withContent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
      headers: sessionHeader([])
    })
    assert.equal(res.statusCode, 403)
  })
})

/**
 * Route-level test for `POST /sites/:siteId/pages/import`.
 *
 * The conversion itself (format validation, size limits, error surfacing) is `models/import.ts`'s
 * job and is covered in `models/import.test.ts`. What belongs to the route, and what this file
 * checks, is the wiring around it: that it is gated on the page-rule `write:pages` permission at the
 * declared `path` — checked in the handler, per the "No route-level permissions:" convention, since
 * `config.permissions` cannot see page rules — and that the uploaded bytes and declared format reach
 * the model unchanged.
 */
describe('POST /sites/:siteId/pages/import', () => {
  let app: FastifyInstance
  let checkAccess: ReturnType<typeof mock.fn>
  let convertToMarkdown: ReturnType<typeof mock.fn>

  before(async () => {
    checkAccess = mock.fn(() => true)
    convertToMarkdown = mock.fn(async () => '# Converted\n')

    ;(globalThis as any).WIKI = {
      models: {
        groups: {
          actorForRequest: () => ({ id: null, permissions: [] }),
          checkAccess,
          groupIdsForRequest: () => []
        },
        pageImport: {
          convertToMarkdown
        }
      }
    }

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    // -> Stands in for the real `@fastify/session` plugin, which this standalone app never registers:
    //    every request is an authenticated user unless it opts out with `x-test-anon`, so each test
    //    controls authorization through `checkAccess` rather than session plumbing.
    app.addHook('onRequest', (req, _reply, done) => {
      if (req.headers['x-test-anon'] !== 'true') {
        ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      }
      done()
    })
    await registerErrorSchema(app)
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    checkAccess.mock.resetCalls()
    checkAccess.mock.mockImplementation(() => true)
    convertToMarkdown.mock.resetCalls()
    convertToMarkdown.mock.mockImplementation(async () => '# Converted\n')
  })

  function importUrl(query: Record<string, string> = {}) {
    const params = new URLSearchParams({ format: 'mediawiki', path: 'docs/new-page', ...query })
    return `/sites/11111111-1111-1111-1111-111111111111/pages/import?${params.toString()}`
  }

  test('an anonymous request is refused before the model is asked to do anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      headers: { 'content-type': 'application/octet-stream', 'x-test-anon': 'true' },
      payload: Buffer.from('= Hi =')
    })
    assert.equal(res.statusCode, 401)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
  })

  test('refuses a caller without write:pages on the declared path', async () => {
    checkAccess.mock.mockImplementation(() => false)

    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('= Hi =')
    })
    assert.equal(res.statusCode, 403)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
    // -> Checked against the declared `path`, the same permission CREATE PAGE checks
    const [, permission, page] = checkAccess.mock.calls[0].arguments as [
      unknown,
      string,
      { path: string }
    ]
    assert.equal(permission, 'write:pages')
    assert.equal(page.path, 'docs/new-page')
  })

  test('rejects an empty body without asking the model to convert nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: importUrl(),
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0)
    })
    assert.equal(res.statusCode, 400)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
  })

  test('passes the uploaded bytes and declared format through to the model, unchanged', async () => {
    const body = Buffer.from('== Hello ==\n\nSome content.')
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ format: 'mediawiki' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      ok: true,
      message: 'File converted successfully.',
      markdown: '# Converted\n'
    })
    assert.equal(convertToMarkdown.mock.callCount(), 1)
    const call = convertToMarkdown.mock.calls[0].arguments[0] as { format: string; data: Buffer }
    assert.equal(call.format, 'mediawiki')
    assert.ok(Buffer.isBuffer(call.data))
    assert.equal(call.data.toString(), body.toString())
  })

  test('rejects a format the schema does not know about', async () => {
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ format: 'wordperfect' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope')
    })
    assert.equal(res.statusCode, 400)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
  })
})

/**
 * Regression test for `GET .../pages/alias/:alias` (feature 357, task 446).
 *
 * `Pages.getPathFromAlias()` used to select only `{ id, path }`, so this route's
 * `mayOnPage(req, 'read:pages', { path: target.path })` never saw a locale or any tags — a
 * locale- or tag-scoped page rule could never be evaluated for a page reached through its alias,
 * only a path-based one, silently. Fixed by selecting `locale`/`tags` too (`models/pages.ts`) and
 * threading both through into the `mayOnPage` call (`api/pages.ts`).
 *
 * `WIKI.models.groups.checkAccess` is wired to the real `resolvePageRule` from `helpers/pageRules.ts`
 * rather than a canned true/false, so a passing test here proves the actual rule-matching mechanism
 * sees the tags this route now passes through — not just that some stub was called with the right
 * shape. `WIKI.models.pages.getPathFromAlias` is stubbed to stand in for the (separately, DB-backed,
 * tested in `models/pages.test.ts`) fixed model method.
 */
describe('GET /sites/:siteId/pages/alias/:alias — locale/tags reach the page rule (task 446)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  // -> Tagged both 'public' (generally readable) and 'confidential' (specifically restricted), so the
  //    two rules below only disagree because of the tags this route now passes through.
  const ALIAS_TARGET = {
    id: 'page-1',
    path: 'engineering/roadmap',
    locale: 'en',
    tags: ['public', 'confidential']
  }

  let app: FastifyInstance
  let rules: GroupRule[]

  /** Grants read access to anything tagged 'public' — the baseline, page-context-independent ALLOW. */
  const allowPublic: GroupRule = {
    id: 'allow-public',
    name: 'Allow public',
    roles: ['read:pages'],
    match: 'TAG',
    mode: 'ALLOW',
    path: 'public',
    locales: [],
    sites: []
  }

  /** Same specificity and match type as `allowPublic` (both TAG), so only the mode tiebreak decides. */
  const denyConfidential: GroupRule = {
    id: 'deny-confidential',
    name: 'Deny confidential',
    roles: ['read:pages'],
    match: 'TAG',
    mode: 'DENY',
    path: 'confidential',
    locales: [],
    sites: []
  }

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPathFromAlias: async () => ALIAS_TARGET
        },
        groups: {
          actorForRequest: () => ({ groupIds: ['fixture-group'], permissions: [] }),
          // -> The real rule-matching engine, not a stub answer — see file header.
          checkAccess: (_actor: unknown, permission: string, page: { path: string }) => {
            const rule = resolvePageRule(rules, permission, page)
            return rule ? rule.mode !== 'DENY' : false
          }
        }
      }
    }

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/etc. is a thrown
    //    `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that shapes
    //    it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    rules = []
  })

  test('an alias-resolved read is allowed when only a TAG rule grants it', async () => {
    // -> Baseline: with no DENY in play, the tags the route now passes through are what let this
    //    TAG-scoped ALLOW rule fire at all (it cannot match without them).
    rules = [allowPublic]

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
    })

    assert.equal(res.statusCode, 200)
    // -> The response schema publishes `id`/`path`/`locale` — `tags` is for the permission check
    //    only and is not part of the wire response.
    assert.deepEqual(res.json(), { id: 'page-1', path: 'engineering/roadmap', locale: 'en' })
  })

  test('a TAG-scoped DENY rule is honored on an alias-resolved read', async () => {
    // -> Both rules match this page (tagged 'public' AND 'confidential'); equal specificity and match
    //    type means the DENY wins the tiebreak. Reachable only because the route now threads
    //    `target.tags` into `mayOnPage` — before the fix, neither TAG rule could ever match at all,
    //    since `page.tags` was always empty.
    rules = [allowPublic, denyConfidential]

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
    })

    // -> Resolving an alias the caller may not read answers 404, identically to an alias that does
    //    not exist at all — see the route's own comment.
    assert.equal(res.statusCode, 404)
  })
})

describe('pages API — isEnabled guard (task 699)', () => {
  /**
   * Regression test for task 699: the siteId-scoped page READ routes trust a `siteId` the client
   * already has cached, so a client that fetched one before its site was disabled could otherwise keep
   * reading indefinitely — none of these are reached through the page/shell hook in `index.ts` (task
   * 695), which only ever sees a hostname-addressed navigation, not an already-cached siteId.
   *
   * Covers the three routes task 699 names: LIST, SEARCH and INCLUDE. Asserts the same 403-vs-404-ish
   * contract as the other entry points in this task — here there is no "site not found" branch to
   * contrast with (`guardSiteEnabled` deliberately leaves an unknown siteId to whatever the route
   * already did with one, see its doc comment), so this only proves the disabled case answers 403 and
   * an enabled site is unaffected.
   */

  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
    [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
  }

  let searchPagesCalls = 0
  let getPageCalls = 0

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
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
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          mayHoldPermissionSomewhere: () => false
        }
      }
    }

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/etc. is a
    //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
    //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('LIST: answers 403 for a disabled site', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${DISABLED_SITE_ID}/pages` })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /disabled/i)
  })

  test('LIST: an enabled site still answers its (currently always-empty) list', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${ENABLED_SITE_ID}/pages` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [])
  })

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

  /**
   * Regression tests for task 673: `mayOnPage` and `pagePermissionsFor` take an explicit `siteId`
   * and thread it into the `RulePageRef` given to `checkAccess`, so a page rule scoped to one site
   * (task 671) is actually enforced from these two call sites rather than silently matching every
   * site's rules. Exercised directly rather than through a route, since both are plain functions
   * exported for exactly this reason. Sharing this describe's app/WIKI setup rather than standing up
   * its own, since both cover the same siteId-scoped page routes.
   */

  test('mayOnPage: threads siteId into the RulePageRef passed to checkAccess', () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return true
    }
    try {
      const result = mayOnPage({} as any, 'read:pages', ENABLED_SITE_ID, { path: 'foo/bar' })
      assert.equal(result, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].siteId, ENABLED_SITE_ID)
      assert.equal(calls[0].path, 'foo/bar')
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
    }
  })

  test('pagePermissionsFor: threads siteId into every RulePageRef it checks', () => {
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
      pagePermissionsFor({} as any, ENABLED_SITE_ID, { path: 'foo/bar' })
      assert.ok(calls.length > 0)
      for (const page of calls) {
        assert.equal(page.siteId, ENABLED_SITE_ID)
        assert.equal(page.path, 'foo/bar')
      }
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
    }
  })

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

/**
 * Route-wiring tests for `GET /sites/:siteId/pages/deleted` and
 * `POST /sites/:siteId/pages/deleted/:versionId/recover`.
 *
 * `WIKI.models.pageHistory` and `WIKI.models.groups` are stubbed rather than backed by a real
 * database — the model layer (listRecoverable, getDeletedVersion, recoverDeletedPage) already has
 * its own coverage from the task that added it. What this file checks is the route's own logic: that
 * the list is filtered per row by `read:history` rather than answered as a whole-list 403, that
 * recovery is checked against the TARGET path (override when given, otherwise the deleted version's
 * own path), and that a `CustomError` thrown by the model (a duplicate path, an invalid locale)
 * reaches the client as clean JSON at its own status code rather than a generic 500.
 *
 * There is no real session plugin here: a request's `session` is set directly from the
 * `x-test-session` header (JSON-encoded), which is all `actorFrom`/`mayOnPage` ever read.
 */
describe('GET/POST /sites/:siteId/pages/deleted — recoverable-page routes', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const VERSION_ID = '22222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let listRecoverableResult: any[]
  let getDeletedVersionResult: any
  let recoverDeletedPageImpl: (...args: any[]) => Promise<any>
  let checkAccessImpl: (actor: any, permission: string, page: any) => boolean

  function withSession(session: Record<string, any>) {
    return { 'x-test-session': JSON.stringify(session) }
  }

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        groups: {
          actorForRequest: (req: any) => ({
            id: req.session?.user?.id ?? null,
            permissions: req.session?.permissions ?? [],
            groups: req.session?.groups ?? []
          }),
          checkAccess: (actor: any, permission: string, page: any) =>
            checkAccessImpl(actor, permission, page),
          groupIdsForRequest: () => []
        },
        pageHistory: {
          listRecoverable: async (_siteId: string) => listRecoverableResult,
          getDeletedVersion: async (_siteId: string, _versionId: string) => getDeletedVersionResult,
          recoverDeletedPage: async (...args: any[]) => recoverDeletedPageImpl(...args)
        }
      }
    }

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    app.decorateRequest('session', null as any)
    app.addHook('onRequest', async (req) => {
      const raw = req.headers['x-test-session']
      ;(req as any).session = typeof raw === 'string' ? JSON.parse(raw) : {}
    })
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/etc. is a
    //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
    //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    listRecoverableResult = []
    getDeletedVersionResult = null
    checkAccessImpl = () => false
    recoverDeletedPageImpl = async () => {
      throw new Error('recoverDeletedPage should not be called in this test')
    }
  })

  test('GET /sites/:siteId/pages/deleted only includes rows the actor may read the history of', async () => {
    listRecoverableResult = [
      { id: 'v1', path: 'visible', locale: 'en', title: 'Visible', action: 'deleted' },
      { id: 'v2', path: 'hidden', locale: 'en', title: 'Hidden', action: 'deleted' }
    ]
    checkAccessImpl = (_actor, permission, page) =>
      permission === 'read:history' && page.path === 'visible'

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.length, 1)
    assert.equal(body[0].path, 'visible')
  })

  test('POST recover requires a logged in user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({}),
      payload: {}
    })

    assert.equal(res.statusCode, 401)
  })

  test('POST recover answers 404 for an id that names no deleted version', async () => {
    getDeletedVersionResult = null

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 404)
  })

  test('POST recover checks write:pages against the target path, not the original', async () => {
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    const seenTargets: any[] = []
    checkAccessImpl = (_actor, permission, page) => {
      if (permission === 'write:pages') {
        seenTargets.push(page)
      }
      return false
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { path: 'overridden', locale: 'fr' }
    })

    assert.equal(res.statusCode, 403)
    assert.deepEqual(seenTargets, [{ path: 'overridden', locale: 'fr', siteId: SITE_ID }])
  })

  test('POST recover recreates the page and returns it', async () => {
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    let calledWith: any[] = []
    recoverDeletedPageImpl = async (...args: any[]) => {
      calledWith = args
      return { id: 'p1', path: 'original', locale: 'en', title: 'T' }
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.page.path, 'original')
    assert.equal(calledWith[0], SITE_ID)
    assert.equal(calledWith[1], VERSION_ID)
    assert.equal(calledWith[2].id, 'u1')
  })

  test('POST recover surfaces a duplicate-path conflict as 409 JSON, not a 500', async () => {
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => {
      throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 409)
    const body = res.json()
    assert.equal(body.error, 'pageDuplicatePath')
    assert.equal(body.statusCode, 409)
  })

  test('POST recover surfaces an invalid-locale rejection as 400 JSON, not a 500', async () => {
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => {
      throw new CustomError('pageInvalidLocale', 'This locale does not exist for this site.', 400)
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { locale: 'zz' }
    })

    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.error, 'pageInvalidLocale')
    assert.equal(body.statusCode, 400)
  })
})
