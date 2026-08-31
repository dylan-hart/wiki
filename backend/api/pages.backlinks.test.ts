import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { registerSchemas as registerPageImportSchema } from './schemas/pageImport.ts'

/**
 * Route-wiring tests for `GET /sites/:siteId/pages/:pageId/backlinks` (OpenProject #1914).
 *
 * Follows the same lightweight fastify-`inject` harness as `pages-export.test.ts`: a fake
 * `WIKI.models.pages`/`WIKI.models.groups` stand in for the real Drizzle-backed models, so this
 * exercises the route's wiring -- target-page gating via `loadReadablePage`, and the per-row
 * `mayOnPage('read:pages', ...)` filter over `listBacklinks` -- without a database.
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

let backlinkRows: {
  id: string
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  classification: string
}[]

async function getPage() {
  return pageFixture
}

async function listBacklinks(_siteId: string, _targetPath: string) {
  return backlinkRows
}

function actorForRequest(req: FastifyRequest) {
  const session = req.session as unknown as { testPagePermissions?: string[] } | undefined
  return { permissions: [] as string[], pagePermissions: session?.testPagePermissions ?? [] }
}

/**
 * A page-scoped permission is granted here per-`path` (via the `readablePaths` session field),
 * not blanket like `pages-export.test.ts`'s mock -- the whole point under test is that each
 * backlink row is checked independently.
 */
function checkAccess(
  actor: { permissions: string[]; pagePermissions: string[] },
  permission: string,
  page: { path: string }
): boolean {
  if (permission !== 'read:pages') return false
  return actor.pagePermissions.includes(`read:pages:${page.path}`)
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: { getPage, listBacklinks },
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

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  await registerErrorSchema(app)
  await registerPageSchema(app)
  await registerApprovalSchema(app)
  await registerPageImportSchema(app)
  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-test-session']
    if (typeof raw === 'string') {
      ;(req as any).session = JSON.parse(raw)
    }
  })
  app.setErrorHandler((error: any, req, reply) => {
    if (error.statusCode) {
      reply.code(error.statusCode).type('application/json').send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode,
        message: error.message
      })
    } else {
      reply.code(500).type('application/json').send({
        ok: false,
        error: 'Internal Server Error',
        statusCode: 500,
        message: 'Internal Server error'
      })
    }
  })
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  pageFixture = {
    id: PAGE_ID,
    path: 'docs/target',
    locale: 'en',
    title: 'Target Page',
    isLocked: false
  }
  backlinkRows = []
})

function sessionHeader(readablePaths: string[]) {
  return {
    'x-test-session': JSON.stringify({
      authenticated: true,
      user: { id: 'reader-1' },
      permissions: [],
      groups: [],
      testPagePermissions: readablePaths.map((path) => `read:pages:${path}`)
    })
  }
}

test('returns a page that links to the target when the caller may read it', async () => {
  backlinkRows = [
    {
      id: 'linker-1',
      path: 'docs/linker',
      locale: 'en',
      title: 'The Linker',
      icon: 'mdi:file',
      tags: [],
      classification: 'level-public'
    }
  ]
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/backlinks`,
    headers: sessionHeader(['docs/target', 'docs/linker'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [
    { id: 'linker-1', path: 'docs/linker', locale: 'en', title: 'The Linker', icon: 'mdi:file' }
  ])
})

test('drops a linking page the caller may not read:pages on', async () => {
  backlinkRows = [
    {
      id: 'linker-1',
      path: 'docs/linker',
      locale: 'en',
      title: 'The Linker',
      icon: null,
      tags: [],
      classification: 'level-public'
    },
    {
      id: 'linker-2',
      path: 'secret/linker',
      locale: 'en',
      title: 'Secret Linker',
      icon: null,
      tags: [],
      classification: 'level-public'
    }
  ]
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/backlinks`,
    // -> Can read the target and "docs/linker", but not "secret/linker"
    headers: sessionHeader(['docs/target', 'docs/linker'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    res.json().map((row: { path: string }) => row.path),
    ['docs/linker']
  )
})

test('answers 404 when the target page does not exist', async () => {
  pageFixture = null
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/backlinks`,
    headers: sessionHeader(['docs/target'])
  })
  assert.equal(res.statusCode, 404)
})

test('answers 404 when the caller cannot read:pages the target page itself', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/backlinks`,
    headers: sessionHeader([])
  })
  assert.equal(res.statusCode, 404)
})
