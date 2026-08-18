import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it, test } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'

import { registerSchemas } from './schemas/page.ts'
// -> 'Page#' nests a 'viewer.pendingSubmissions' item that $refs 'PageEditSubmission#', so that
//    schema has to exist too or Fastify fails to build the serializer at all.
import { registerSchemas as registerApprovalSchemas } from './schemas/approval.ts'
import pagesRoutes from './pages.ts'

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
        searchPages: async (params: any) => {
          searchPagesCalls.push(params)
          return { results: [], totalHits: 0 }
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
  assert.deepEqual(body.viewer.activeEditors, { count: 2, names: ['Ada Lovelace', 'Grace Hopper'] })
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
