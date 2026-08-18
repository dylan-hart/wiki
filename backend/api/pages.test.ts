import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'

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
        checkAccess: () => true
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
    }
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

describe('GET /sites/:siteId/pages/:pageIdOrHash — commentsCount', () => {
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
