import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock, test } from 'node:test'
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
import pagesRoutes from './pages.ts'
import { MAX_IMPORT_BATCH_BYTES, MAX_IMPORT_SIZE } from '../models/import.ts'
import { resolvePageRule, type RulePageRef } from '../helpers/pageRules.ts'
import { CustomError } from '../helpers/common.ts'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import type { GroupRule } from '../models/groups.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { registerParamsSchemas } from './schemas/params.ts'

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
    await registerParamsSchemas(app)
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
 * OpenProject #1720: once `models/pages.ts#createPage()`/`updatePage()` refuse a render-less write up
 * front via `ensureCanRender()` (#1716), the two named errors it throws --
 * `renderUnsupportedEditor`/`renderPuppeteerMissing` -- must reach a REST caller as an actionable
 * `@fastify/sensible` error (400/503 with a message naming the cause), not an opaque 500. `WIKI.models
 * .pages.createPage`/`updatePage` are stubbed to throw directly, standing in for a render-less write
 * against a lean/non-markdown-unsupported instance without needing a real Puppeteer-less environment.
 */
describe('pages API — renderPuppeteerMissing / renderUnsupportedEditor mapped to actionable errors', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  let app: FastifyInstance
  let createPageCalls: any[]
  let updatePageCalls: any[]
  let createPageImpl: (...args: any[]) => Promise<any>
  let updatePageImpl: (...args: any[]) => Promise<any>

  function currentPage() {
    return {
      id: PAGE_ID,
      path: 'some-page',
      locale: 'en',
      tags: [],
      classification: null,
      editor: 'markdown'
    }
  }

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async () => currentPage(),
          createPage: async (...args: any[]) => {
            createPageCalls.push(args)
            return createPageImpl(...args)
          },
          updatePage: async (...args: any[]) => {
            updatePageCalls.push(args)
            return updatePageImpl(...args)
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
    // -> Mirrors `index.ts`'s real `setErrorHandler` -- see the identical comment on the
    //    `enforceApiKeySite` describe block above for why this is inlined rather than imported.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = {
        authenticated: true,
        user: { id: 'user-1' },
        permissions: []
      }
    })
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    createPageCalls = []
    updatePageCalls = []
  })

  test('CREATE page: renderPuppeteerMissing maps to 503 naming the missing extension, and no page is returned', async () => {
    createPageImpl = async () => {
      throw new CustomError(
        'renderPuppeteerMissing',
        'Rendering a page on the server needs the Puppeteer extension, which is not installed.',
        503
      )
    }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages`,
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 503)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /Puppeteer extension/)
    assert.equal(body.page, undefined)
    assert.equal(createPageCalls.length, 1)
  })

  test('CREATE page: renderUnsupportedEditor maps to 400 naming the editor', async () => {
    createPageImpl = async () => {
      throw new CustomError(
        'renderUnsupportedEditor',
        'Server-side rendering is not implemented for the ckeditor editor.'
      )
    }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages`,
      payload: { path: 'test-page', title: 'Test', editor: 'ckeditor', content: 'hello' }
    })
    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /ckeditor/)
    assert.equal(body.page, undefined)
    assert.equal(createPageCalls.length, 1)
  })

  test('CREATE page: an unrelated model error still falls through to the generic 500, not swallowed as a render refusal', async () => {
    createPageImpl = async () => {
      throw new Error('Something else entirely broke.')
    }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages`,
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 500)
    assert.equal(createPageCalls.length, 1)
  })

  test('UPDATE page: renderPuppeteerMissing maps to 503 naming the missing extension, and the page is left unmodified', async () => {
    updatePageImpl = async () => {
      throw new CustomError(
        'renderPuppeteerMissing',
        'Rendering a page on the server needs the Puppeteer extension, which is not installed.',
        503
      )
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: { content: 'new content, no render' }
    })
    assert.equal(res.statusCode, 503)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /Puppeteer extension/)
    assert.equal(body.page, undefined)
    assert.equal(updatePageCalls.length, 1)
  })

  test('UPDATE page: renderUnsupportedEditor maps to 400 naming the editor', async () => {
    updatePageImpl = async () => {
      throw new CustomError(
        'renderUnsupportedEditor',
        'Server-side rendering is not implemented for the ckeditor editor.'
      )
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: { content: 'new content, no render' }
    })
    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /ckeditor/)
    assert.equal(body.page, undefined)
    assert.equal(updatePageCalls.length, 1)
  })
})

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
    await ensureTemporal()
    ;(globalThis as any).WIKI = {
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
        },
        // -> The route's best-effort pageview logging (OpenProject #1238) -- a no-op stub is all this
        //    fixture needs, since what's under test here is collab/search wiring, not pageviews.
        pageviews: {
          record: async () => {}
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
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
    showSidebar: true,
    showTags: true,
    showToc: true,
    tocDepth: { min: 1, max: 2 },
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
    await registerParamsSchemas(app)
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

  /**
   * OpenProject #2232: `pages.password` now stores a one-way `bcrypt` verifier, and the point of
   * that is defeated if the API still hands the value back to whoever may edit the page. The `Page`
   * response schema has no `password` property any more — only `hasPassword` — so even a model that
   * (bug, or a future regression re-adding the field) put a raw `password` on the object would be
   * stripped by response serialization before it ever reached a client. This proves the whole path.
   */
  test('GET single page never returns a password field, even if the model handed one back', async () => {
    mayOnPageResult = true
    getPageResult = { ...samplePage, password: 'should-never-be-sent', hasPassword: true }
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.password, undefined)
    assert.equal(body.hasPassword, true)
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
      showSidebar: true,
      showTags: true,
      showToc: true,
      tocDepth: { min: 1, max: 2 },
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
      // -> `recordPageview()`'s isEnabled gate (OpenProject #2251) reads this; on, matching this
      //    fixture's pre-existing unconditional pageview stub, since pageviews are not what this
      //    describe block is testing.
      config: { pageviews: { isEnabled: true } },
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
        comments: { countForPage: async () => 0 },
        // -> The route's best-effort pageview logging (OpenProject #1238) -- a no-op stub, since
        //    this suite is about the read:source gate, not pageviews.
        pageviews: { record: async () => {} }
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
    await registerParamsSchemas(app)
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
 * Regression test for OpenProject #2251: `recordPageview()` in `pages.ts` used to write
 * `req.session.pageViewed = true` for every anonymous browser read unconditionally -- deliberately,
 * to defeat `saveUninitialized: false` so a returning anonymous reader is not miscounted as new --
 * *before* calling `WIKI.models.pageviews.record()`, whose own `isEnabled` guard lives in
 * `models/pageviews.ts`. That meant disabling pageview tracking still minted a session (and the
 * `Set-Cookie` + permanent `sessions` row that comes with it) for every anonymous page read; only the
 * `pageviews` insert itself stopped.
 *
 * This suite has no real `@fastify/session` plugin registered (see the other describes' own doc
 * comments for why), so it cannot observe an actual `Set-Cookie` header. What it CAN observe -- and
 * what is the exact mechanism that decides whether `@fastify/session` would emit one -- is whether
 * the route touches the session object at all: a session `@fastify/session` never sees written to
 * stays uninitialized and is never persisted or cookied. The `onRequest` hook below always attaches
 * an empty `session` object up front, mirroring what the real plugin lazily provides to every
 * request (including an anonymous one) before any handler runs.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — pageview session write respects isEnabled (OpenProject #2251)', () => {
  const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const PAGE_HASH = 'deadbeef'

  async function getPage() {
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
      render: '<p>Hello</p>',
      allowComments: false,
      allowContributions: false,
      showSidebar: true,
      showTags: true,
      showToc: true,
      tocDepth: { min: 1, max: 2 },
      navigationId: null,
      navigationMode: 'default',
      authorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      authorName: 'Test Author',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }

  // -> Every anonymous reader is granted `read:pages` -- what is under test here is the pageview
  //    session write, not page-rule resolution (covered by `helpers/pageRules.test.ts`).
  function actorForRequest() {
    return { permissions: [] as string[], pagePermissions: ['read:pages'] }
  }

  function checkAccess(
    actor: { permissions: string[]; pagePermissions: string[] },
    permission: string
  ): boolean {
    return actor.pagePermissions.includes(permission)
  }

  let app: FastifyInstance
  let recordMock: ReturnType<typeof mock.fn>
  let capturedSession: { pageViewed?: boolean } | undefined

  beforeEach(async () => {
    recordMock = mock.fn(async () => {})
    capturedSession = undefined
    ;(globalThis as any).WIKI = {
      config: { pageviews: { isEnabled: false } },
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
        comments: { countForPage: async () => 0 },
        pageviews: { record: recordMock }
      },
      sites: {}
    }

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
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
    // -> Mirrors what the real `@fastify/session` plugin does for every request, anonymous or not: it
    //    hands the handler an empty, un-persisted session object up front. Whether that object ends up
    //    written to (and therefore cookied and stored) is exactly what this suite asserts on.
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = {}
    })
    // -> Captured post-handler so the test can assert on the exact object the route wrote to,
    //    without needing a real `@fastify/session` plugin to serialize/cookie it.
    app.addHook('onResponse', async (req) => {
      capturedSession = (req as any).session
    })
    await registerPageImportSchema(app)
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('pageviews disabled: anonymous read never writes to the session and never records', async () => {
    ;(globalThis as any).WIKI.config.pageviews.isEnabled = false
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(capturedSession?.pageViewed, undefined)
    assert.equal(recordMock.mock.callCount(), 0)
  })

  test('pageviews enabled: anonymous read writes pageViewed onto the session and records', async () => {
    ;(globalThis as any).WIKI.config.pageviews.isEnabled = true
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(capturedSession?.pageViewed, true)
    assert.equal(recordMock.mock.callCount(), 1)
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
    convertToMarkdown = mock.fn(async () => ({ markdown: '# Converted\n' }))

    ;(globalThis as any).WIKI = {
      // -> `defaultLocale()` reads `WIKI.sites[siteId]?.config?.locales?.primary`, falling back to
      //    'en' -- an empty `sites` map is enough for that fallback to be exercised without throwing
      //    on an undefined `WIKI.sites`.
      sites: {},
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
    await registerParamsSchemas(app)
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
    convertToMarkdown.mock.mockImplementation(async () => ({ markdown: '# Converted\n' }))
  })

  function importUrl(query: Record<string, string> = {}) {
    const params = new URLSearchParams({
      fileName: 'notes.mediawiki',
      path: 'docs/new-page',
      ...query
    })
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

  test("detects the format from fileName's extension when no format is given (OpenProject #1209)", async () => {
    const body = Buffer.from('Some RST content')
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ fileName: 'design.rst' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.equal(convertToMarkdown.mock.callCount(), 1)
    assert.equal((convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format, 'rst')
  })

  test('an explicit format overrides what would otherwise be detected from fileName', async () => {
    const body = Buffer.from('== Hello ==')
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ fileName: 'notes.rst', format: 'mediawiki' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'mediawiki'
    )
  })

  test('answers 400 without asking the model when fileName has no recognized extension and no format is given', async () => {
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ fileName: 'README' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope')
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /Could not detect an import format/)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
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

  test("accepts format=markdown and passes the model's parsed title/description/tags through", async () => {
    convertToMarkdown.mock.mockImplementation(async () => ({
      markdown: '# Body\n',
      title: 'From Front Matter',
      description: 'A summary',
      tags: ['alpha', 'beta']
    }))

    const res = await app.inject({
      method: 'POST',
      url: importUrl({ format: 'markdown' }),
      headers: { 'content-type': 'text/markdown' },
      payload: Buffer.from('---\ntitle: From Front Matter\n---\n\n# Body\n')
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      ok: true,
      message: 'File converted successfully.',
      markdown: '# Body\n',
      title: 'From Front Matter',
      description: 'A summary',
      tags: ['alpha', 'beta']
    })
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'markdown'
    )
  })
})

/**
 * Builds a `multipart/form-data` body for `app.inject()`, using the platform's own `Response` to do
 * the encoding (boundary, per-part headers) rather than hand-rolling it — the same bytes a browser's
 * `fetch(..., { body: formData })` would send.
 */
async function buildMultipartPayload(
  files: {
    fieldName?: string
    fileName: string
    content: string
    type?: string
    /** Sent as this file's own `formats` field (OpenProject #1209) when given, overriding autodetection. */
    formatOverride?: string
  }[]
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData()
  for (const file of files) {
    form.append(
      file.fieldName ?? 'files',
      new Blob([file.content], { type: file.type ?? 'text/plain' }),
      file.fileName
    )
    // -> Interleaved right after its own file, same order the frontend sends them in — the route
    //    pairs a `formats` field with whichever upload it most recently pushed.
    if (file.fieldName === undefined || file.fieldName === 'files') {
      form.append('formats', file.formatOverride ?? '')
    }
  }
  const res = new Response(form)
  const payload = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type')!
  return { payload, contentType }
}

/**
 * Route-level test for `POST /sites/:siteId/pages/import/batch` (OpenProject #849).
 *
 * Same division of labor as the single-file import route above: conversion itself is
 * `models/import.ts`'s job, already covered by `models/import.test.ts`. What this suite checks is
 * the route's own wiring — the `write:pages` permission gate, that every uploaded file reaches the
 * model, and that one file failing does not stop the rest of the batch from converting.
 */
describe('POST /sites/:siteId/pages/import/batch', () => {
  let app: FastifyInstance
  let checkAccess: ReturnType<typeof mock.fn>
  let convertToMarkdown: ReturnType<typeof mock.fn>

  before(async () => {
    checkAccess = mock.fn(() => true)
    convertToMarkdown = mock.fn(async ({ data }: { data: Buffer }) => ({
      markdown: `# ${data.toString()}\n`
    }))

    ;(globalThis as any).WIKI = {
      sites: {},
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
    await registerParamsSchemas(app)
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
    convertToMarkdown.mock.mockImplementation(async ({ data }: { data: Buffer }) => ({
      markdown: `# ${data.toString()}\n`
    }))
  })

  function batchUrl(query: Record<string, string> = {}) {
    const params = new URLSearchParams({ path: 'docs/imported', ...query })
    return `/sites/11111111-1111-1111-1111-111111111111/pages/import/batch?${params.toString()}`
  }

  test('an anonymous request is refused before any file is read', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'a.mediawiki', content: '= A =' }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType, 'x-test-anon': 'true' },
      payload
    })
    assert.equal(res.statusCode, 401)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
  })

  test('refuses a caller without write:pages on the declared path', async () => {
    checkAccess.mock.mockImplementation(() => false)
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'a.mediawiki', content: '= A =' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 403)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
    const [, permission, page] = checkAccess.mock.calls[0].arguments as [
      unknown,
      string,
      { path: string }
    ]
    assert.equal(permission, 'write:pages')
    assert.equal(page.path, 'docs/imported')
  })

  test('rejects a request with no files without asking the model to convert anything', async () => {
    const { payload, contentType } = await buildMultipartPayload([])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 400)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
  })

  test("autodetects each file's format from its own extension (OpenProject #1209)", async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'first.mediawiki', content: 'First' },
      { fileName: 'second.rst', content: 'Second' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.results, [
      { fileName: 'first.mediawiki', ok: true, markdown: '# First\n' },
      { fileName: 'second.rst', ok: true, markdown: '# Second\n' }
    ])
    assert.equal(convertToMarkdown.mock.callCount(), 2)
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'mediawiki'
    )
    assert.equal((convertToMarkdown.mock.calls[1].arguments[0] as { format: string }).format, 'rst')
  })

  test("a per-file 'formats' override wins over that file's own detected extension", async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'first.mediawiki', content: 'First', formatOverride: 'textile' },
      { fileName: 'second.rst', content: 'Second' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'textile'
    )
    assert.equal((convertToMarkdown.mock.calls[1].arguments[0] as { format: string }).format, 'rst')
  })

  test('a file with an unrecognized extension fails only its own entry, without asking the model', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'README', content: 'no extension' },
      { fileName: 'second.rst', content: 'Second' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'README')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /Could not detect an import format/)
    assert.deepEqual(body.results[1], {
      fileName: 'second.rst',
      ok: true,
      markdown: '# Second\n'
    })
    assert.equal(convertToMarkdown.mock.callCount(), 1)
  })

  test('one file failing does not stop the rest of the batch from converting', async () => {
    convertToMarkdown.mock.mockImplementation(async ({ data }: { data: Buffer }) => {
      if (data.toString() === 'bad') {
        throw new CustomError(
          'importNoContent',
          'Pandoc converted this file but produced no usable content.',
          400
        )
      }
      return { markdown: `# ${data.toString()}\n` }
    })
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'good.mediawiki', content: 'good' },
      { fileName: 'bad.mediawiki', content: 'bad' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.results.length, 2)
    assert.deepEqual(body.results[0], {
      fileName: 'good.mediawiki',
      ok: true,
      markdown: '# good\n'
    })
    assert.equal(body.results[1].fileName, 'bad.mediawiki')
    assert.equal(body.results[1].ok, false)
    assert.match(body.results[1].message, /no usable content/)
  })

  /**
   * Regression test (OpenProject #849 fix): `@fastify/multipart`'s default `throwFileSizeLimit: true`
   * makes an oversized file's `toBuffer()` reject as the route's own comment describes, but it ALSO
   * latches that rejection and replays it out of `req.files()`'s iterator on the very next
   * `for await` step — even one that only advances past files already handled locally — turning "one
   * bad file fails independently" into a 413 for the whole batch regardless of how many files after
   * it converted fine. This sends a real oversized file (`MAX_IMPORT_SIZE`-plus-one, so the size
   * limit itself trips rather than being mocked) ahead of a good one and asserts the batch still
   * answers 200 with one failed entry and one successful one, not a request-level failure.
   */
  test('an oversized file fails only its own entry, not the whole batch', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'toobig.mediawiki', content: 'x'.repeat(MAX_IMPORT_SIZE + 1) },
      { fileName: 'fine.mediawiki', content: '= Fine =' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.results.length, 2)
    assert.equal(body.results[0].fileName, 'toobig.mediawiki')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /larger than the import limit/)
    assert.deepEqual(body.results[1], {
      fileName: 'fine.mediawiki',
      ok: true,
      markdown: '# = Fine =\n'
    })
  })

  test("autodetects format: markdown from .md and passes each result's parsed title/description/tags through", async () => {
    convertToMarkdown.mock.mockImplementation(async ({ data }: { data: Buffer }) => ({
      markdown: '# Body\n',
      title: `Title for ${data.toString()}`,
      tags: ['imported']
    }))
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'one.md', content: 'one' },
      { fileName: 'two.md', content: 'two' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(body.results, [
      {
        fileName: 'one.md',
        ok: true,
        markdown: '# Body\n',
        title: 'Title for one',
        tags: ['imported']
      },
      {
        fileName: 'two.md',
        ok: true,
        markdown: '# Body\n',
        title: 'Title for two',
        tags: ['imported']
      }
    ])
    for (const call of convertToMarkdown.mock.calls) {
      assert.equal((call.arguments[0] as { format: string }).format, 'markdown')
    }
  })

  /**
   * OpenProject #2204: the aggregate ceiling that backstops the whole batch, distinct from the
   * per-file `MAX_IMPORT_SIZE` regression test above — five files, each right at (not over) the
   * per-file limit so none is individually truncated, whose sum is still well past
   * `MAX_IMPORT_BATCH_BYTES` (four times a single file's own limit). The whole request must be
   * refused rather than converting the files that fit before the ceiling was crossed.
   */
  test('a batch exceeding the aggregate byte ceiling is refused, not partially converted', async () => {
    const perFile = 'x'.repeat(MAX_IMPORT_SIZE)
    const { payload, contentType } = await buildMultipartPayload(
      Array.from({ length: 5 }, (_, i) => ({
        fileName: `file-${i}.mediawiki`,
        content: perFile
      }))
    )

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.match(body.message, /aggregate limit/)
    assert.match(body.message, new RegExp(`${Math.round(MAX_IMPORT_BATCH_BYTES / 1024 / 1024)} MB`))
    assert.equal(convertToMarkdown.mock.callCount(), 0, 'no file should be converted once refused')
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
          checkAccess: (_actor: unknown, permission: string, page: RulePageRef) => {
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
    await registerParamsSchemas(app)
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

describe('pages API — isEnabled guard (task 699 / OpenProject #1587 / #1593)', () => {
  /**
   * Regression coverage for the disabled-site guard on `pages.ts`'s own site-scoped routes. Originally
   * (task 699) this guard was hand-applied inside three handlers — LIST, SEARCH and INCLUDE — and this
   * describe block registered `pagesRoutes` on its own to prove exactly those three. OpenProject
   * #1587/#1593 deleted all three hand-applied calls: the guard is now `siteEnabledPreHandler`
   * (`helpers/common.ts`), one `preHandler` `api/index.ts` registers on its guarded content-route
   * subtree, before any content route file (`pages.ts` is one of them; `sites.ts`, site administration
   * rather than content, deliberately is not — see `index.ts`'s own doc comment), so a route in
   * `pages.ts` no longer guards itself at all. Registering that same real preHandler here (not a
   * re-implementation of it — see the import) before `pagesRoutes`, exactly as `index.ts` orders it, is
   * what makes this describe block still a meaningful test of `pages.ts`'s routes rather than of the
   * preHandler itself (which `index.test.ts` already covers directly, across every `:siteId` route in
   * every `api/` file, discovered structurally rather than named one by one).
   *
   * Widened past the original three routes (of which LIST was deleted by OpenProject #1986 as a
   * permanently-empty stub with no caller — SEARCH and INCLUDE are what remain of the original
   * three here) to the rest of `pages.ts`'s previously-*unguarded* surface named in the audit this
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
    // -> Mirrors `api/index.ts`'s own registration order: the guard is a plugin-level hook, added
    //    before the route file it covers is registered — `pages.ts` no longer calls
    //    `guardSiteEnabled` itself (OpenProject #1593).
    app.addHook('preHandler', siteEnabledPreHandler)
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
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
  let listRecoverableResult: { items: any[]; nextCursor: string | null }
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
          listRecoverable: async (_siteId: string, _opts?: any) => listRecoverableResult,
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    listRecoverableResult = { items: [], nextCursor: null }
    getDeletedVersionResult = null
    checkAccessImpl = () => false
    recoverDeletedPageImpl = async () => {
      throw new Error('recoverDeletedPage should not be called in this test')
    }
  })

  test('GET /sites/:siteId/pages/deleted only includes rows the actor may read the history of', async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'visible',
          locale: 'en',
          title: 'Visible',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u1', name: 'Author One' }
        },
        {
          id: 'v2',
          path: 'hidden',
          locale: 'en',
          title: 'Hidden',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u2', name: 'Author Two' }
        }
      ],
      nextCursor: null
    }
    checkAccessImpl = (_actor, permission, page) =>
      permission === 'read:history' && page.path === 'visible'

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].path, 'visible')
    assert.equal(body.nextCursor, null)
    // -> No authorEmail anywhere in the response (OpenProject #2168)
    assert.equal(body.items[0].author.email, undefined)
    assert.ok(!JSON.stringify(body).includes('email'))
  })

  test("GET /sites/:siteId/pages/deleted checks read:history with the version's own tags/classification (OpenProject #2168)", async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'classified',
          locale: 'en',
          title: 'Classified',
          action: 'deleted',
          tags: ['secret'],
          classification: 'restricted-level-id',
          author: { id: 'u1', name: 'Author One' }
        }
      ],
      nextCursor: null
    }
    const seenChecks: any[] = []
    checkAccessImpl = (_actor, permission, page) => {
      if (permission === 'read:history') {
        seenChecks.push(page)
      }
      return false
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().items.length, 0)
    assert.deepEqual(seenChecks, [
      {
        path: 'classified',
        locale: 'en',
        tags: ['secret'],
        classification: 'restricted-level-id',
        siteId: SITE_ID
      }
    ])
  })

  test('GET /sites/:siteId/pages/deleted never carries authorEmail, even for a row the actor may read', async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'visible',
          locale: 'en',
          title: 'Visible',
          action: 'deleted',
          author: { id: 'u2', name: 'Someone' },
          tags: [],
          classification: null
        }
      ],
      nextCursor: null
    }
    checkAccessImpl = () => true

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].author.email, undefined)
  })

  test('GET /sites/:siteId/pages/deleted narrows by a TAG-scoped DENY rule', async () => {
    // -> Real rule-matching engine, mirroring the `allowPublic`/`denyConfidential` pair in the
    //    `GET .../pages/alias/:alias` TAG suite above: both TAG, so only the ALLOW-vs-DENY mode
    //    tiebreak decides — reachable only because `tags` is now threaded into `mayOnPage` here.
    const rules: GroupRule[] = [
      {
        id: 'allow-public',
        name: 'Allow public',
        roles: ['read:history'],
        match: 'TAG',
        mode: 'ALLOW',
        path: 'public',
        locales: [],
        sites: []
      },
      {
        id: 'deny-secret',
        name: 'Deny secret',
        roles: ['read:history'],
        match: 'TAG',
        mode: 'DENY',
        path: 'secret',
        locales: [],
        sites: []
      }
    ]
    checkAccessImpl = (_actor, permission, page) => {
      const rule = resolvePageRule(rules, permission, {
        path: page.path,
        locale: page.locale,
        siteId: SITE_ID,
        classification: page.classification ?? null,
        tags: page.tags ?? []
      })
      return rule ? rule.mode !== 'DENY' : false
    }
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'open',
          locale: 'en',
          title: 'Open',
          action: 'deleted',
          tags: ['public']
        },
        {
          id: 'v2',
          path: 'closed',
          locale: 'en',
          title: 'Closed',
          action: 'deleted',
          // -> Tagged BOTH: matches the broad ALLOW too, so this actually exercises the DENY tiebreak
          //    rather than just "no rule matched at all".
          tags: ['public', 'secret']
        }
      ],
      nextCursor: null
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].path, 'open')
  })

  test('GET /sites/:siteId/pages/deleted forwards nextCursor unchanged even when the permission filter shortens items', async () => {
    // -> The model's own page boundary says there is more (`nextCursor` set) even though every row on
    //    THIS page gets filtered out by the actor's permissions -- the route must not let a
    //    permission-shortened (here, emptied) page read as "end of list".
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'hidden',
          locale: 'en',
          title: 'Hidden',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u1', name: 'Author One' }
        }
      ],
      nextCursor: 'opaque-cursor-token'
    }
    checkAccessImpl = () => false

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(body.items, [])
    assert.equal(body.nextCursor, 'opaque-cursor-token')
  })

  test('GET /sites/:siteId/pages/deleted forwards limit and cursor query params to the model', async () => {
    const original = (globalThis as any).WIKI.models.pageHistory.listRecoverable
    let seenOpts: any
    try {
      ;(globalThis as any).WIKI.models.pageHistory.listRecoverable = async (
        _siteId: string,
        opts: any
      ) => {
        seenOpts = opts
        return { items: [], nextCursor: null }
      }
      checkAccessImpl = () => true

      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/pages/deleted?limit=10&cursor=abc123`
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(seenOpts, { limit: 10, cursor: 'abc123' })
    } finally {
      ;(globalThis as any).WIKI.models.pageHistory.listRecoverable = original
    }
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
    getDeletedVersionResult = {
      path: 'original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: [],
      classification: null
    }
    const seenTargets: any[] = []
    checkAccessImpl = (_actor, permission, page) => {
      // -> The source-side read:pages/read:source check (OpenProject #2168) runs first, against
      //    the version's OWN path -- granted here so this test can reach the write:pages check it
      //    actually exercises, against the TARGET path.
      if (permission === 'read:pages' || permission === 'read:source') {
        return true
      }
      if (permission === 'write:pages') {
        seenTargets.push(page)
        return false
      }
      // -> The source-side read:pages/read:source check runs first (OpenProject #2168) -- allowed
      //    here so the write:pages check below is what this test is actually exercising
      return permission === 'read:pages' || permission === 'read:source'
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { path: 'overridden', locale: 'fr' }
    })

    assert.equal(res.statusCode, 403)
    assert.deepEqual(seenTargets, [
      { path: 'overridden', locale: 'fr', classification: null, siteId: SITE_ID }
    ])
  })

  test('POST recover refuses when the caller cannot read the deleted path, even though they can write the destination (OpenProject #2168)', async () => {
    getDeletedVersionResult = {
      path: 'secret-original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: ['confidential'],
      classification: 'restricted-level-id'
    }
    // -> Holds write:pages everywhere but no read:pages/read:source anywhere -- e.g. a caller who
    //    only ever held `read:history` at this path, per the vulnerability this route-level check
    //    closes (OpenProject #2168).
    checkAccessImpl = (_actor, permission) => permission === 'write:pages'

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 403)
    const body = res.json()
    assert.match(body.message, /not allowed to read/)
  })

  test('POST recover checks read:pages/read:source against the SOURCE path even when the target is overridden', async () => {
    getDeletedVersionResult = {
      path: 'secret-original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: { tags: ['confidential'], classification: 'restricted-level-id' },
      tags: ['confidential'],
      classification: 'restricted-level-id'
    }
    const seenSourceChecks: any[] = []
    checkAccessImpl = (_actor, permission, page) => {
      if (permission === 'read:pages' || permission === 'read:source') {
        seenSourceChecks.push({ permission, page })
        // -> Denied at the source, regardless of the destination
        return false
      }
      // -> Freely allowed to write the (different) destination -- proves the refusal below is really
      //    about the source, not a blanket deny
      return permission === 'write:pages'
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { path: 'somewhere-else', locale: 'en' }
    })

    assert.equal(res.statusCode, 403)
    // -> Checked against the version's OWN path/tags/classification, not the override target
    assert.ok(
      seenSourceChecks.some(
        (c) =>
          c.page.path === 'secret-original' &&
          c.page.classification === 'restricted-level-id' &&
          c.permission === 'read:pages'
      )
    )
  })

  test('POST recover succeeds when the caller can read the deleted path and write the destination', async () => {
    getDeletedVersionResult = {
      path: 'original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: [],
      classification: null
    }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => ({ id: 'p1', path: 'original', locale: 'en', title: 'T' })

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
  })

  test('GET /sites/:siteId/pages/deleted carries no authorEmail on any row (OpenProject #2168)', async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'visible',
          locale: 'en',
          title: 'Visible',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u1', name: 'Someone' }
        }
      ],
      nextCursor: null
    }
    checkAccessImpl = () => true

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].author.email, undefined)
    assert.equal('authorEmail' in body.items[0], false)
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

  test('POST recover rejects an empty-string locale at the schema, before it can reach the handler (OpenProject #1024)', async () => {
    // -> Without `minLength: 1` here, `locale: ''` would pass validation, get permission-checked
    //   against `target.locale = ''` (locale-scoped rules fail closed on that, same as null -- see
    //   `helpers/pageRules.test.ts`), and then flow into `recoverDeletedPage` -> `createPage`, whose
    //   own `input.locale || defaultLocale(siteId)` treats '' as unset and silently recreates the
    //   page in the site's PRIMARY locale instead -- a different locale than the one just checked.
    //   Rejecting '' outright at the boundary is what keeps the checked locale and the written one
    //   the same value always.
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => {
      throw new Error('recoverDeletedPage should not be called for a schema-invalid body')
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { locale: '' }
    })

    assert.equal(res.statusCode, 400)
  })
})

/**
 * OpenProject #1859: `GET /sites/:siteId/pages/:pageId/history` is now a thin pass-through onto
 * `pageHistory.list`'s own keyset pagination -- `models/pageHistory.test.ts` covers the pagination and
 * no-`authorEmail` behavior itself against a real database, so this file only proves the route wires
 * the querystring through and shapes the model's error the way every other route here does.
 */
describe('GET /sites/:siteId/pages/:pageId/history — querystring wiring', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let getPageResult: any
  let listCalledWith: any[]
  let listImpl: (...args: any[]) => Promise<any>

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async () => getPageResult
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          groupIdsForRequest: () => []
        },
        pageHistory: {
          list: async (...args: any[]) => {
            listCalledWith = args
            return listImpl(...args)
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
    // -> Mirrors `index.ts`'s real `setErrorHandler`, same as the deleted-pages block above
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    getPageResult = { id: PAGE_ID, path: 'some-page', locale: 'en', isLocked: false }
    listCalledWith = []
    listImpl = async () => ({ items: [], nextCursor: null })
  })

  test('forwards limit and cursor from the querystring to the model, and returns its shape verbatim', async () => {
    listImpl = async () => ({
      items: [
        {
          id: 'v1',
          action: 'updated',
          via: 'editor',
          changedFields: [],
          reason: '',
          versionDate: '2026-01-01T00:00:00.000Z',
          locale: 'en',
          path: 'some-page',
          title: 'Some Page',
          author: { id: 'u1', name: 'Ada' }
        }
      ],
      nextCursor: 'opaque-cursor-token'
    })

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history?limit=10&cursor=abc`
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(listCalledWith, [SITE_ID, PAGE_ID, { limit: 10, cursor: 'abc' }])
    const body = res.json()
    assert.equal(body.nextCursor, 'opaque-cursor-token')
    assert.equal(body.items.length, 1)
    // -> No `email` anywhere on the author, matching `PageHistoryListEntry`'s narrower schema
    assert.equal('email' in body.items[0].author, false)
  })

  test('omitting the querystring applies the schema default (50) for limit, and no cursor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history`
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(listCalledWith, [SITE_ID, PAGE_ID, { limit: 50, cursor: undefined }])
  })

  test('surfaces an invalid-cursor rejection from the model as 400 JSON, not a 500', async () => {
    listImpl = async () => {
      throw new CustomError('pageHistoryInvalidCursor', 'This history cursor is not valid.', 400)
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history?cursor=not-valid`
    })

    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.error, 'pageHistoryInvalidCursor')
  })

  test('404s for a page the actor cannot read, without ever reaching pageHistory.list', async () => {
    getPageResult = null
    listImpl = async () => {
      throw new Error('list should not be called when the page is unreadable')
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history`
    })

    assert.equal(res.statusCode, 404)
  })

  test('403s for a password-locked page, without ever reaching pageHistory.list', async () => {
    getPageResult = { id: PAGE_ID, path: 'some-page', locale: 'en', isLocked: true }
    listImpl = async () => {
      throw new Error('list should not be called for a locked page')
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history`
    })

    assert.equal(res.statusCode, 403)
  })

  test('rejects a limit outside [1, 200] at the schema, before it can reach the handler', async () => {
    listImpl = async () => {
      throw new Error('list should not be called for a schema-invalid limit')
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history?limit=201`
    })

    assert.equal(res.statusCode, 400)
  })
})

/**
 * Route-level test for `PUT /sites/:siteId/pages/:pageId/path` — the destination permission check.
 *
 * `movePage` can now change a page's locale as well as its path, which makes where a page is going a
 * different place, in page-rule terms, from where it is: rules are matched on path AND locale, so the
 * source check alone would let a caller who may manage `en` push a page into a locale somebody else's
 * rules govern. The handler checks `manage:pages` against the page as it stands, and `write:pages`
 * against the destination ref — not `manage:pages` again: the group editor's own hint for
 * `manage:pages` promises "other locations the user has WRITE ACCESS to", and `write:pages` is the
 * same destination check `POST .../deleted/:versionId/recover` already makes (OpenProject #937).
 *
 * `checkAccess` is wired to the real `resolvePageRule` rather than a canned answer, so what passes
 * here is the actual rule-matching engine seeing the destination ref, not a stub agreeing it was
 * called.
 */
describe('PUT /sites/:siteId/pages/:pageId/path — destination permission', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  /**
   * Manage AND write anything in `en`, and nothing anywhere else — the rule the destination check
   * exists for. Both roles are needed: `manage:pages` for the source-page check, `write:pages` for
   * the destination check the same rule also has to satisfy in these "moving within `en`" cases.
   */
  const manageEnglish: GroupRule = {
    id: 'manage-en',
    name: 'Manage English',
    roles: ['manage:pages', 'write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['en'],
    sites: []
  }

  const realCheckAccess = (_actor: unknown, permission: string, page: RulePageRef) => {
    const rule = resolvePageRule([manageEnglish], permission, page)
    return rule ? rule.mode !== 'DENY' : false
  }

  let app: FastifyInstance
  let movePageCalls: any[] = []

  before(async () => {
    ;(globalThis as any).WIKI = {
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr'] } } } },
      models: {
        pages: {
          getPage: async () => ({
            id: PAGE_ID,
            path: 'docs/source',
            hash: 'hash-1',
            locale: 'en',
            title: 'Source',
            tags: []
          }),
          movePage: async (siteId: string, id: string, patch: any) => {
            movePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: patch.path,
              locale: patch.locale ?? 'en',
              title: 'Source',
              hash: 'hash-2'
            }
          }
        },
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          groupIdsForRequest: () => ['g1'],
          checkAccess: realCheckAccess
        }
      }
    }

    app = Fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
    await app.register(fastifySensible)
    // -> Stands in for `@fastify/session`, exactly as the import route's own suite above does.
    app.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      done()
    })
    app.setErrorHandler((error: any, _req, reply) => {
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    movePageCalls = []
    ;(globalThis as any).WIKI.models.groups.checkAccess = realCheckAccess
  })

  test('a move within the locale the caller manages is allowed, and carries no locale', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
    assert.equal(movePageCalls[0].patch.path, 'docs/destination')
    assert.equal(movePageCalls[0].patch.locale, undefined)
  })

  test('a move into a locale the caller does not manage is refused, before the model is asked', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', locale: 'fr' }
    })

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().message, 'You are not allowed to move this page there.')
    assert.equal(movePageCalls.length, 0)
  })

  test('the requested locale reaches the model when the caller may manage the destination', async () => {
    ;(globalThis as any).WIKI.models.groups.checkAccess = () => true

    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', locale: 'fr' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
    assert.equal(movePageCalls[0].patch.locale, 'fr')
    assert.equal(res.json().page.locale, 'fr')
  })

  test('managing the destination branch is not enough on its own: write:pages there is also required (OpenProject #937)', async () => {
    // -> A caller who may MANAGE (move things around within) `fr`, but was never granted WRITE access
    //    there, is exactly the gap #937 found: `manage:pages` on a destination branch used to be
    //    treated as sufficient to land a page in it, when the group editor's own copy for
    //    `manage:pages` promises only "locations the user has write access to".
    const manageFrenchOnly: GroupRule = {
      id: 'manage-fr-no-write',
      name: 'Manage (not write) French',
      roles: ['manage:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: ['fr'],
      sites: []
    }
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      actor: unknown,
      permission: string,
      page: RulePageRef
    ) => {
      const rule = resolvePageRule([manageEnglish, manageFrenchOnly], permission, page)
      return rule ? rule.mode !== 'DENY' : false
    }

    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', locale: 'fr' }
    })

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().message, 'You are not allowed to move this page there.')
    assert.equal(movePageCalls.length, 0)
  })
})

/**
 * Route-level test for `PUT /sites/:siteId/pages/:pageId/path`'s `includeTranslations` gate
 * (OpenProject #1026, spec item 3): the batch needs `manage:pages` on each twin's own path AND
 * `write:pages` on the shared destination for EVERY twin, not just the primary page -- checked here,
 * before the model is asked to do anything, so a caller who may manage `en` cannot drag a `de`
 * translation they have no rule over along for the ride. The destination check is `write:pages`, not
 * `manage:pages`, for the same reason the primary move's destination check is (OpenProject #937).
 */
describe('PUT /sites/:siteId/pages/:pageId/path — includeTranslations permission gate', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const FR_ID = '33333333-3333-4333-8333-333333333333'
  const DE_ID = '44444444-4444-4444-8444-444444444444'

  /**
   * Manage AND write `en` and `fr`, nothing else -- `de` is deliberately left ungoverned. Both roles
   * are needed on the same rule here since every twin's own path and the shared destination all fall
   * within `en`/`fr` in these fixtures.
   */
  const manageEnAndFr: GroupRule = {
    id: 'manage-en-fr',
    name: 'Manage EN+FR',
    roles: ['manage:pages', 'write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['en', 'fr'],
    sites: []
  }

  const realCheckAccess = (_actor: unknown, permission: string, page: RulePageRef) => {
    const rule = resolvePageRule([manageEnAndFr], permission, page)
    return rule ? rule.mode !== 'DENY' : false
  }

  let app: FastifyInstance
  let movePageCalls: any[] = []
  let translations: Array<{
    id: string
    path: string
    locale: string
    title: string
    tags: string[]
  }>

  before(async () => {
    ;(globalThis as any).WIKI = {
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr', 'de'] } } } },
      models: {
        pages: {
          getPage: async () => ({
            id: PAGE_ID,
            path: 'docs/source',
            hash: 'hash-1',
            locale: 'en',
            title: 'Source',
            tags: []
          }),
          getTranslations: async () => translations,
          movePage: async (siteId: string, id: string, patch: any) => {
            movePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: patch.path,
              locale: patch.locale ?? 'en',
              title: 'Source',
              hash: 'hash-2'
            }
          }
        },
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          groupIdsForRequest: () => ['g1'],
          checkAccess: realCheckAccess
        }
      }
    }

    app = Fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
    await app.register(fastifySensible)
    app.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      done()
    })
    app.setErrorHandler((error: any, _req, reply) => {
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    movePageCalls = []
    translations = []
    ;(globalThis as any).WIKI.models.groups.checkAccess = realCheckAccess
  })

  test('no twins: includeTranslations reaches the model with nothing to permission-check', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
    assert.equal(movePageCalls[0].patch.includeTranslations, true)
  })

  test('every twin permitted: the batch reaches the model', async () => {
    translations = [{ id: FR_ID, path: 'docs/source', locale: 'fr', title: 'Source FR', tags: [] }]
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
  })

  test('a twin whose destination the caller may manage but not write to refuses the whole batch (OpenProject #937)', async () => {
    // -> `en` keeps a full manage+write rule (the primary page's own path AND its destination both
    //    sit in `en`); `fr` is scoped to manage-only, on its own -- unlike `manageEnAndFr` above,
    //    this rule set gives the FR twin's OWN path `manage:pages` but grants `write:pages` nowhere
    //    in `fr`, so the twin may be moved away from `docs/source` but not written into the shared
    //    destination. That gap is exactly what #937 closes.
    const manageWriteEn: GroupRule = {
      id: 'manage-write-en',
      name: 'Manage+write English',
      roles: ['manage:pages', 'write:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: ['en'],
      sites: []
    }
    const manageOnlyFr: GroupRule = {
      id: 'manage-only-fr',
      name: 'Manage (not write) French',
      roles: ['manage:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: ['fr'],
      sites: []
    }
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      actor: unknown,
      permission: string,
      page: RulePageRef
    ) => {
      const rule = resolvePageRule([manageWriteEn, manageOnlyFr], permission, page)
      return rule ? rule.mode !== 'DENY' : false
    }
    translations = [{ id: FR_ID, path: 'docs/source', locale: 'fr', title: 'Source FR', tags: [] }]

    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })

    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /"fr"/)
    assert.equal(movePageCalls.length, 0)
  })

  test('a twin outside every rule refuses the whole batch, naming its locale, before the model is asked', async () => {
    translations = [
      { id: FR_ID, path: 'docs/source', locale: 'fr', title: 'Source FR', tags: [] },
      { id: DE_ID, path: 'docs/source', locale: 'de', title: 'Source DE', tags: [] }
    ]
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /"de"/)
    assert.equal(movePageCalls.length, 0)
  })

  test('includeTranslations is ignored on a locale-only move: getTranslations is never consulted', async () => {
    let getTranslationsCalled = false
    ;(globalThis as any).WIKI.models.pages.getTranslations = async () => {
      getTranslationsCalled = true
      return []
    }
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', title: 'Retitled', includeTranslations: true }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(getTranslationsCalled, false)
  })
})

/**
 * Route-level test for `GET /sites/:siteId/pages/:pageId/translations` (OpenProject #1026): the
 * query the move/rename dialog uses to decide whether to offer `includeTranslations` at all, and
 * how many. Gated on `manage:pages` on the page -- the same permission actually moving it needs.
 */
describe('GET /sites/:siteId/pages/:pageId/translations', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  let app: FastifyInstance
  let mayOnPageResult = true

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async () => ({
            id: PAGE_ID,
            path: 'docs/source',
            hash: 'hash-1',
            locale: 'en',
            title: 'Source',
            tags: []
          }),
          getTranslations: async () => [
            { id: 'fr-id', locale: 'fr', path: 'docs/source', title: 'Source FR' }
          ]
        },
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          checkAccess: () => mayOnPageResult
        }
      }
    }

    app = Fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
    await app.register(fastifySensible)
    app.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      done()
    })
    app.setErrorHandler((error: any, _req, reply) => {
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    mayOnPageResult = true
  })

  test('returns the twins as a flat list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translations`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [
      { id: 'fr-id', locale: 'fr', path: 'docs/source', title: 'Source FR' }
    ])
  })

  test('403 when the caller may not manage this page', async () => {
    mayOnPageResult = false
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translations`
    })
    assert.equal(res.statusCode, 403)
  })
})

/**
 * Regression test for bug #949 / task 995: `POST .../pages/userPermissions` used to default the
 * ref's locale to the site primary unconditionally (task 4's interim), so a caller asking about a
 * path in a non-primary locale got the PRIMARY locale's rule answer instead of the real one — rules
 * now fail closed on locale (`RulePageRef` requires it), so the wrong locale silently returns the
 * wrong permissions rather than erroring. The body now takes an explicit `locale`, which the frontend
 * threads through from the (path, locale) pair `Index.vue`'s route watcher already computed.
 *
 * `WIKI.models.groups.checkAccess` is wired to the real `resolvePageRule`, so a passing test proves
 * the locale in the request body is what reaches the rule engine — not just that some stub saw it.
 */
describe('POST /sites/:siteId/pages/userPermissions — locale (bug #949, task 995)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'

  /** Grants write:pages only in `fr` — the rule the locale param exists to let a caller reach. */
  const writeFrench: GroupRule = {
    id: 'write-fr',
    name: 'Write French',
    roles: ['write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['fr'],
    sites: []
  }

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr'] } } } },
      models: {
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          checkAccess: (_actor: unknown, permission: string, page: RulePageRef) => {
            const rule = resolvePageRule([writeFrench], permission, page)
            return rule ? rule.mode !== 'DENY' : false
          }
        }
      }
    }

    app = Fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
    await app.register(fastifySensible)
    app.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      done()
    })
    app.setErrorHandler((error: any, _req, reply) => {
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('an explicit French locale sees the French-scoped grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x', locale: 'fr' }
    })

    assert.equal(res.statusCode, 200)
    assert.ok(res.json().includes('write:pages'))
  })

  test('an explicit English locale does not see the French-scoped grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x', locale: 'en' }
    })

    assert.equal(res.statusCode, 200)
    assert.ok(!res.json().includes('write:pages'))
  })

  test('omitting locale falls back to the site primary (en), not the French grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x' }
    })

    assert.equal(res.statusCode, 200)
    assert.ok(!res.json().includes('write:pages'))
  })
})

/**
 * OpenProject #1864: `GET /sites/:siteId/pages/deleted`'s per-row `read:history` filter used to call
 * `mayOnPage(req, ...)` once per row, which rebuilds the actor internally on every call. It now
 * hoists `WIKI.models.groups.actorForRequest(req)` once per request and calls `checkAccess(actor,
 * ...)` per row directly -- the same shape `tree.ts`'s `visibleTreeItems()` and the graph route use.
 */
describe('GET /sites/:siteId/pages/deleted — actor hoisted out of the per-row filter (OpenProject #1864)', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'

  function makeRow(path: string) {
    return {
      id: path,
      action: 'deleted',
      via: 'editor',
      changedFields: [],
      reason: '',
      versionDate: new Date('2026-01-01T00:00:00.000Z'),
      locale: 'en',
      path,
      title: path,
      tags: [],
      classification: null,
      author: { id: 'user-1', name: 'Alice' }
    }
  }

  let app: FastifyInstance
  let actorForRequest: ReturnType<typeof mock.fn>
  let checkAccess: ReturnType<typeof mock.fn>

  before(async () => {
    actorForRequest = mock.fn(() => ({ groupIds: [], permissions: [] }))
    checkAccess = mock.fn(
      (_actor: unknown, _permission: string, page: { path: string }) => page.path !== 'secret'
    )
    ;(globalThis as any).WIKI = {
      sites: {},
      models: {
        pageHistory: {
          listRecoverable: async () => ({
            items: [makeRow('open-a'), makeRow('secret'), makeRow('open-b')],
            nextCursor: null
          })
        },
        groups: {
          actorForRequest,
          checkAccess
        }
      }
    }

    app = Fastify()
    await app.register(fastifySensible)
    await registerErrorSchema(app)
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerPageImportSchema(app)
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('filters out a row checkAccess refuses, keeping the rest', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/pages/deleted` })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      res
        .json()
        .items.map((row: { path: string }) => row.path)
        .sort(),
      ['open-a', 'open-b']
    )
  })

  test('builds the actor exactly once per request, not once per row', async () => {
    actorForRequest.mock.resetCalls()
    checkAccess.mock.resetCalls()

    await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/pages/deleted` })

    assert.equal(actorForRequest.mock.calls.length, 1)
    assert.equal(checkAccess.mock.calls.length, 3)
    const actor = actorForRequest.mock.calls[0]!.result
    for (const call of checkAccess.mock.calls) {
      assert.equal(call.arguments[0], actor)
    }
  })
})

/**
 * `POST /sites/:siteId/pages/bulk` (OpenProject #1882): the admin page inventory's bulk
 * delete/re-render/retag action. The behavior this proves is the thing that distinguishes it from
 * `POST …/classification-conflicts/resolve` elsewhere in this file -- that route refuses the WHOLE
 * request on the first page the caller may not act on; this one reports that one page as `skipped`
 * and keeps going, since a bulk action starts from an arbitrary admin-picked selection rather than a
 * conflict list the caller already knows they may act on.
 */
describe('POST /sites/:siteId/pages/bulk', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ALLOWED = '22222222-2222-4222-8222-222222222222'
  const PAGE_DENIED = '33333333-3333-4333-8333-333333333333'
  const PAGE_UNSAFE_RENDER = '44444444-4444-4444-8444-444444444444'

  let app: FastifyInstance
  let pageRows: Map<
    string,
    { id: string; path: string; locale: string; tags: string[]; classification: string }
  >
  let deleteCalls: string[]
  let renderCalls: string[]
  let updateCalls: { id: string; patch: any }[]
  let deniedIds: Set<string>

  function withSession(session: Record<string, any>) {
    return { 'x-test-session': JSON.stringify(session) }
  }

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: { port: 3000 },
      logger: { debug: () => {} },
      models: {
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        },
        groups: {
          actorForRequest: (req: any) => ({
            id: req.session?.user?.id ?? null,
            permissions: req.session?.permissions ?? [],
            groups: req.session?.groups ?? []
          }),
          // -> Denies exactly the page ids this test session put in `deniedIds` -- everything else
          //    passes, whatever permission is actually being asked for.
          checkAccess: (_actor: any, _permission: string, page: any) => !deniedIds.has(page.id),
          groupIdsForRequest: () => []
        },
        pages: {
          getPagesByIds: async (_siteId: string, ids: string[]) => {
            const out = new Map()
            for (const id of ids) {
              if (pageRows.has(id)) {
                out.set(id, pageRows.get(id))
              }
            }
            return out
          },
          deletePage: async (_siteId: string, id: string) => {
            deleteCalls.push(id)
            return true
          },
          queueRerender: async (_siteId: string, id: string) => {
            renderCalls.push(id)
            if (id === PAGE_UNSAFE_RENDER) {
              throw new Error('This editor cannot be rendered.')
            }
            return true
          },
          updatePage: async (_siteId: string, id: string, patch: any) => {
            updateCalls.push({ id, patch })
            return { id, ...patch }
          }
        }
      }
    }

    app = Fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
    await app.register(fastifySensible)
    app.decorateRequest('session', null as any)
    app.addHook('onRequest', async (req) => {
      const raw = req.headers['x-test-session']
      ;(req as any).session = typeof raw === 'string' ? JSON.parse(raw) : {}
    })
    app.setErrorHandler((error: any, _req, reply) => {
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
    await registerParamsSchemas(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    deleteCalls = []
    renderCalls = []
    updateCalls = []
    deniedIds = new Set()
    pageRows = new Map([
      [
        PAGE_ALLOWED,
        {
          id: PAGE_ALLOWED,
          path: 'docs/allowed',
          locale: 'en',
          tags: ['a', 'b'],
          classification: ''
        }
      ],
      [
        PAGE_DENIED,
        { id: PAGE_DENIED, path: 'docs/denied', locale: 'en', tags: [], classification: '' }
      ],
      [
        PAGE_UNSAFE_RENDER,
        { id: PAGE_UNSAFE_RENDER, path: 'docs/unsafe', locale: 'en', tags: [], classification: '' }
      ]
    ])
  })

  const AUTHED = withSession({ authenticated: true, user: { id: 'u1' }, permissions: [] })

  test('401 for an anonymous request, before touching any page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      payload: { pageIds: [PAGE_ALLOWED], action: 'delete' }
    })
    assert.equal(res.statusCode, 401)
    assert.equal(deleteCalls.length, 0)
  })

  test('a mixed selection deletes the allowed page and reports the denied one skipped, not a batch failure', async () => {
    deniedIds = new Set([PAGE_DENIED])
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_ALLOWED, PAGE_DENIED], action: 'delete' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(deleteCalls, [PAGE_ALLOWED])
    const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
    assert.equal(byId[PAGE_ALLOWED].status, 'done')
    assert.equal(byId[PAGE_DENIED].status, 'skipped')
    assert.equal(byId[PAGE_DENIED].path, 'docs/denied')
    assert.deepEqual(body.counts, { done: 1, skipped: 1 })
  })

  test('an id that does not exist on this site comes back notFound, not an error', async () => {
    const missing = '99999999-9999-4999-8999-999999999999'
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [missing], action: 'delete' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].status, 'notFound')
    assert.equal(body.counts.notFound, 1)
  })

  test('a page that throws while rendering is reported as error, and the rest of the batch still runs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_UNSAFE_RENDER, PAGE_ALLOWED], action: 'render' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(renderCalls, [PAGE_UNSAFE_RENDER, PAGE_ALLOWED])
    const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
    assert.equal(byId[PAGE_UNSAFE_RENDER].status, 'error')
    assert.match(byId[PAGE_UNSAFE_RENDER].message, /cannot be rendered/)
    assert.equal(byId[PAGE_ALLOWED].status, 'done')
  })

  test('retag adds and removes tags relative to each page’s own existing tags', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: {
        pageIds: [PAGE_ALLOWED],
        action: 'retag',
        addTags: ['c'],
        removeTags: ['a']
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updateCalls.length, 1)
    assert.deepEqual(new Set(updateCalls[0].patch.tags), new Set(['b', 'c']))
  })

  test('400 when retag is called with neither addTags nor removeTags', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_ALLOWED], action: 'retag' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(updateCalls.length, 0)
  })

  test('a repeated id in the selection is only acted on once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_ALLOWED, PAGE_ALLOWED], action: 'delete' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(deleteCalls, [PAGE_ALLOWED])
    assert.equal(res.json().results.length, 1)
  })
})
