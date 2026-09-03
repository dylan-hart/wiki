import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Route-wiring tests for `GET /sites/:siteId/pages/:pageId/translationStatus` (OpenProject #2475).
 *
 * Same lightweight fastify-`inject` harness as `read.backlinks.test.ts`: fake
 * `WIKI.models.pages`/`WIKI.models.groups` stand in for the real Drizzle-backed models, so this
 * exercises the route's wiring -- target-page gating via `requireReadablePage`, the
 * publishState/`read:pages` narrowing per candidate row, and handing the survivors to
 * `computeTranslationStatus` -- without a database.
 */

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

let pageFixture: {
  id: string
  path: string
  locale: string
  title: string
  isLocked: boolean
} | null

let statusRows: {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string
  publishState: 'draft' | 'published' | 'scheduled'
  updatedAt: Date
}[]

async function getPage() {
  return pageFixture
}

async function listTranslationStatusRows(_siteId: string, _path: string) {
  return statusRows
}

function actorForRequest(req: FastifyRequest) {
  const session = req.session as
    | { testPagePermissions?: string[]; authenticated?: boolean }
    | undefined
  return {
    permissions: [] as string[],
    pagePermissions: session?.testPagePermissions ?? [],
    authenticated: session?.authenticated === true
  }
}

/** Grants `read:pages` per-locale via a `read:pages:<locale>` marker in `testPagePermissions`,
 *  the same per-row-gating shape `read.backlinks.test.ts` uses per-path. */
function checkAccess(
  actor: { permissions: string[]; pagePermissions: string[] },
  permission: string,
  page: { locale: string }
): boolean {
  if (permission !== 'read:pages') return false
  return actor.pagePermissions.includes(`read:pages:${page.locale}`)
}

let app: FastifyInstance

before(async () => {
  const wiki = {
    sites: {
      [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr', 'de'] } } }
    },
    models: {
      pages: { getPage, listTranslationStatusRows },
      groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
      approvals: {
        pageViewerState: async () => ({
          canSuggestEdits: false,
          hasOpenSuggestion: false,
          canReview: false,
          pendingSubmissions: []
        })
      },
      pageWatching: { isWatching: async () => false }
    }
  }

  app = await buildTestApp({
    routes: pagesRoutes,
    ajv: true,
    wiki,
    session: 'header'
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  pageFixture = {
    id: PAGE_ID,
    path: 'docs/target',
    locale: 'en',
    title: 'Target Page',
    isLocked: false
  }
  statusRows = []
})

function sessionHeader(readableLocales: string[], { authenticated = true } = {}) {
  return {
    'x-test-session': JSON.stringify({
      authenticated,
      user: authenticated ? { id: 'reader-1' } : undefined,
      permissions: [],
      groups: [],
      testPagePermissions: readableLocales.map((locale) => `read:pages:${locale}`)
    })
  }
}

test('reports one entry per active locale, stale/missing computed against the primary', async () => {
  statusRows = [
    {
      id: 'en-1',
      path: 'docs/target',
      locale: 'en',
      tags: [],
      classification: 'level-public',
      publishState: 'published',
      updatedAt: new Date('2026-06-01T00:00:00Z')
    },
    {
      id: 'fr-1',
      path: 'docs/target',
      locale: 'fr',
      tags: [],
      classification: 'level-public',
      publishState: 'published',
      updatedAt: new Date('2026-01-01T00:00:00Z')
    }
    // -> `de` has no row at all -- missing
  ]
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translationStatus`,
    headers: sessionHeader(['en', 'fr', 'de'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [
    { locale: 'en', exists: true, stale: false },
    { locale: 'fr', exists: true, stale: true },
    { locale: 'de', exists: false, stale: false }
  ])
})

test('drops a translation row the caller may not read:pages on', async () => {
  statusRows = [
    {
      id: 'en-1',
      path: 'docs/target',
      locale: 'en',
      tags: [],
      classification: 'level-public',
      publishState: 'published',
      updatedAt: new Date('2026-06-01T00:00:00Z')
    },
    {
      id: 'fr-1',
      path: 'docs/target',
      locale: 'fr',
      tags: [],
      classification: 'level-public',
      publishState: 'published',
      updatedAt: new Date('2026-01-01T00:00:00Z')
    }
  ]
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translationStatus`,
    // -> May read the target page (`en`) but not the `fr` translation
    headers: sessionHeader(['en'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [
    { locale: 'en', exists: true, stale: false },
    { locale: 'fr', exists: false, stale: false },
    { locale: 'de', exists: false, stale: false }
  ])
})

test('hides an unpublished translation from an anonymous caller entirely', async () => {
  statusRows = [
    {
      id: 'en-1',
      path: 'docs/target',
      locale: 'en',
      tags: [],
      classification: 'level-public',
      publishState: 'published',
      updatedAt: new Date('2026-06-01T00:00:00Z')
    },
    {
      id: 'fr-1',
      path: 'docs/target',
      locale: 'fr',
      tags: [],
      classification: 'level-public',
      publishState: 'draft',
      updatedAt: new Date('2026-01-01T00:00:00Z')
    }
  ]
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translationStatus`,
    headers: sessionHeader(['en', 'fr'], { authenticated: false })
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    res.json().find((row: { locale: string }) => row.locale === 'fr'),
    { locale: 'fr', exists: false, stale: false }
  )
})

test('answers 404 when the target page does not exist', async () => {
  pageFixture = null
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translationStatus`,
    headers: sessionHeader(['en'])
  })
  assert.equal(res.statusCode, 404)
})

test('answers 404 when the caller cannot read:pages the target page itself', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translationStatus`,
    headers: sessionHeader([])
  })
  assert.equal(res.statusCode, 404)
})
