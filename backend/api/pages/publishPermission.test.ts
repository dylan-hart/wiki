import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * OpenProject #2421/#2465/#2466/#2468: publish/write role separation. `publishState` is carved out
 * of the PATCH route's ordinary `write:pages` gate in both directions --
 *   - `publish:pages` alone (no `write:pages`) is a valid, standalone grant that can toggle
 *     `publishState` on a page the actor cannot otherwise edit at all;
 *   - `write:pages` alone (no `publish:pages`) can edit every other field but never `publishState`.
 *
 * Route-level only, following `classification.test.ts`'s pattern directly above it (the direct
 * precedent this check's "changed AND different from current" shape is modeled on): a real Fastify
 * instance with `WIKI.models.pages`/`WIKI.models.groups` stubbed to the smallest surface each test
 * needs, rather than a database.
 */
describe('pages API — publish/write role separation (OpenProject #2421)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const CLASSIFICATION_ID = '30000000-0000-4000-8000-000000000001'

  const PAGE_FIXTURE = {
    id: PAGE_ID,
    path: 'engineering/onboarding',
    locale: 'en',
    classification: CLASSIFICATION_ID,
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
              classification: PAGE_FIXTURE.classification,
              publishState: patch.publishState ?? PAGE_FIXTURE.publishState,
              updatedAt: new Date(),
              authorName: ''
            }
          }
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
          isLowerThan: () => false
        },
        auditLog: {
          record: async () => {}
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
    grantedPermissions = new Set()
  })

  const sessionHeader = {
    'x-test-session': JSON.stringify({
      authenticated: true,
      user: { id: 'user-1' },
      permissions: []
    })
  }

  test('a publish:pages-only actor can toggle publishState on a page they cannot otherwise edit', async () => {
    grantedPermissions = new Set(['publish:pages'])
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

  test('a write:pages-only actor cannot change publishState', async () => {
    grantedPermissions = new Set(['write:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'published' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('a write:pages-only actor can still edit unrelated fields', async () => {
    grantedPermissions = new Set(['write:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { title: 'Onboarding, revised' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
  })

  test('a publish:pages-only actor cannot edit unrelated fields, even alone', async () => {
    grantedPermissions = new Set(['publish:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { title: 'Onboarding, revised' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('a publish:pages-only actor cannot smuggle an unrelated field in alongside a publishState change', async () => {
    grantedPermissions = new Set(['publish:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { title: 'Onboarding, revised', publishState: 'published' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('holding both write:pages and publish:pages can change publishState alongside other fields', async () => {
    grantedPermissions = new Set(['write:pages', 'publish:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { title: 'Onboarding, revised', publishState: 'published' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.equal(updatePageCalls[0].patch.publishState, 'published')
    assert.equal(updatePageCalls[0].patch.title, 'Onboarding, revised')
  })

  test('an actor with neither permission is refused before updatePage runs', async () => {
    grantedPermissions = new Set()
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'published' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('resubmitting the same publishState needs no extra permission beyond write:pages, the same way an unchanged classification does not', async () => {
    grantedPermissions = new Set(['write:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      // -> PAGE_FIXTURE.publishState is already 'draft'
      payload: { publishState: 'draft', title: 'Onboarding, revised' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.ok(!checkAccessCalls.includes('publish:pages'))
  })
})
