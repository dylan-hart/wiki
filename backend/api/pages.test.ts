import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'

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
 */

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const PAGE_ID = '22222222-2222-2222-2222-222222222222'
const STORED_UPDATED_AT = new Date('2026-08-17T10:00:00.000Z')

let app: FastifyInstance
let updatePageCalls: any[]

function currentPage() {
  return {
    id: PAGE_ID,
    path: 'some-page',
    locale: 'en',
    tags: [],
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
        actorForRequest: () => ({ permissions: ['write:pages'] }),
        checkAccess: () => true
      }
    },
    collab: {
      pageSaved: () => {}
    }
  }

  app = fastify({
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
  await registerPageSchema(app)
  await registerApprovalSchema(app)
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
