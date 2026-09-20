import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

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
  let grantedPermissions: Set<string>
  let startingPublishState: 'draft' | 'published' | 'scheduled'

  let app: FastifyInstance

  before(async () => {
    // -> The PATCH handler calls `page.updatedAt.toTemporalInstant()` on every save
    await ensureTemporal()
    const wiki = {
      models: {
        pages: {
          getPage: async ({ id }: { id: string }) =>
            id === PAGE_ID
              ? { ...PAGE_FIXTURE, publishState: startingPublishState, updatedAt: new Date() }
              : null,
          updatePage: async (siteId: string, id: string, patch: any) => {
            updatePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: PAGE_FIXTURE.path,
              locale: PAGE_FIXTURE.locale,
              classification: patch.classification ?? PAGE_FIXTURE.classification,
              publishState: patch.publishState ?? startingPublishState,
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
    startingPublishState = PAGE_FIXTURE.publishState
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

  test('going from draft to scheduled also needs publish:pages', async () => {
    // FIXME: this sends draft -> scheduled, not the unpublish the title names -- the stubbed page
    // always starts as 'draft'. Covering published -> draft needs a fixture that starts published.
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'scheduled', publishStartDate: new Date().toISOString() }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('going from published back to draft (unpublishing) also needs publish:pages', async () => {
    startingPublishState = 'published'
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'draft' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
    assert.ok(checkAccessCalls.includes('publish:pages'))
  })

  test('unpublishing succeeds once the actor also holds publish:pages', async () => {
    startingPublishState = 'published'
    grantedPermissions = new Set(['write:pages', 'publish:pages'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { publishState: 'draft' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.equal(updatePageCalls[0].patch.publishState, 'draft')
  })
})
