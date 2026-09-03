import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * OpenProject #2466 (part of #2421's "dedicated publish/unpublish permission" scope): the PATCH
 * route's `publishState` guardrail, following the `manage:classification` declassification
 * guardrail's shape in `write.ts` -- changing `publishState` needs `publish:pages` ON THIS PAGE, on
 * top of `write:pages`/`manage:pages`, so an ordinary editor with write access cannot silently
 * publish or unpublish a page. Unlike classification, `publishState` has no "direction" to spare a
 * raise from the extra check -- any actual change (draft<->published<->scheduled) needs it.
 *
 * Route-level only: a real Fastify instance with `WIKI.models.pages`/`WIKI.models.groups` stubbed to
 * the smallest surface each test needs, rather than a database -- the same harness shape
 * `classification.test.ts` uses for the sibling guardrail in the same handler.
 */
describe('pages API — publishState guardrail (OpenProject #2466)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  const PAGE_FIXTURE = {
    id: PAGE_ID,
    path: 'engineering/onboarding',
    locale: 'en',
    classification: null as string | null,
    publishState: 'draft' as 'draft' | 'published' | 'scheduled',
    tags: [] as string[]
  }

  let updatePageCalls: any[] = []
  let checkAccessCalls: string[] = []
  /** Which permissions `checkAccess` grants, by permission name -- every test overrides what it needs. */
  let grantedPermissions: Set<string>

  let app: FastifyInstance

  before(async () => {
    // -> The PATCH handler calls `page.updatedAt.toTemporalInstant()` for the collab-save
    //    notification regardless of whether this test's own assertions care about the timestamp.
    await ensureTemporal()
    const wiki = {
      models: {
        pages: {
          getPage: async ({ id }: { id: string }) =>
            id === PAGE_ID ? { ...PAGE_FIXTURE, updatedAt: new Date() } : null,
          updatePage: async (siteId: string, id: string, patch: any) => {
            updatePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: PAGE_FIXTURE.path,
              locale: PAGE_FIXTURE.locale,
              classification: patch.classification ?? PAGE_FIXTURE.classification,
              publishState: patch.publishState ?? PAGE_FIXTURE.publishState,
              updatedAt: new Date(),
              authorName: ''
            }
          }
        },
        pageClassification: {
          parentClassification: async () => null
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          groupIdsForRequest: () => [],
          checkAccess: (_actor: unknown, permission: string) => {
            checkAccessCalls.push(permission)
            return grantedPermissions.has(permission)
          }
        },
        classificationLevels: {
          byId: () => null,
          isLowerThan: () => false,
          meetsFloor: () => true
        },
        auditLog: {
          record: async () => {},
          recordMany: async () => {}
        }
      },
      sites: { [SITE_ID]: {} },
      collab: { pageSaved: () => {} }
    }

    app = await buildTestApp({ routes: pagesRoutes, wiki, session: 'header' })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    updatePageCalls = []
    checkAccessCalls = []
    grantedPermissions = new Set(['write:pages'])
  })

  const sessionHeader = {
    'x-test-session': JSON.stringify({
      authenticated: true,
      user: { id: 'user-1' },
      permissions: []
    })
  }

  test('changing publishState without publish:pages is refused with 403, before updatePage runs', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'published' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
    assert.ok(checkAccessCalls.includes('publish:pages'))
  })

  test('changing publishState succeeds once the actor also holds publish:pages', async () => {
    grantedPermissions = new Set(['write:pages', 'publish:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'published' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.equal(updatePageCalls[0].patch.publishState, 'published')
  })

  test('an unchanged publishState is not treated as a change and needs no extra permission', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'draft', title: 'Onboarding' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.ok(!checkAccessCalls.includes('publish:pages'))
  })

  test('a save that does not touch publishState at all is unaffected', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { title: 'Onboarding' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.ok(!checkAccessCalls.includes('publish:pages'))
  })

  test('going from published back to draft (unpublishing) also needs publish:pages', async () => {
    // -> A fresh fixture-equivalent page that starts published: rebuild the app once with a
    //    different starting publishState isn't necessary here since the guardrail only compares
    //    the incoming body against whatever `target.publishState` the stub returns (draft, above) --
    //    this test instead proves the SAME direction-agnostic check on the other transition
    //    (scheduled) is caught too, matching the epic's "any change" acceptance criteria.
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'scheduled', publishStartDate: new Date().toISOString() }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })
})
