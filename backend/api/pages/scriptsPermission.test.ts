import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

describe('pages API — write:scripts/write:styles gate scriptJsLoad/scriptJsUnload/scriptCss (OpenProject #3402)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  const PAGE_FIXTURE = {
    id: PAGE_ID,
    path: 'engineering/onboarding',
    locale: 'en',
    classification: null,
    publishState: 'published' as 'draft' | 'published' | 'scheduled',
    tags: [] as string[],
    scriptJsLoad: 'console.log(1)',
    scriptJsUnload: 'console.log(2)',
    scriptCss: 'body { color: red }'
  }

  let createPageCalls: any[]
  let updatePageCalls: any[]
  let checkAccessCalls: string[]
  let grantedPermissions: Set<string>

  let app: FastifyInstance

  before(async () => {
    // -> The PATCH handler calls `page.updatedAt.toTemporalInstant()`.
    await ensureTemporal()
    const wiki = {
      models: {
        pages: {
          getPage: async ({ id }: { id: string }) =>
            id === PAGE_ID ? { ...PAGE_FIXTURE, updatedAt: new Date() } : null,
          createPage: async (siteId: string, input: any) => {
            createPageCalls.push({ siteId, input })
            return { id: 'new-page-1', path: input.path, locale: input.locale ?? 'en' }
          },
          updatePage: async (siteId: string, id: string, patch: any) => {
            updatePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: PAGE_FIXTURE.path,
              locale: PAGE_FIXTURE.locale,
              classification: PAGE_FIXTURE.classification,
              publishState: patch.publishState ?? PAGE_FIXTURE.publishState,
              scriptJsLoad: patch.scriptJsLoad ?? PAGE_FIXTURE.scriptJsLoad,
              scriptJsUnload: patch.scriptJsUnload ?? PAGE_FIXTURE.scriptJsUnload,
              scriptCss: patch.scriptCss ?? PAGE_FIXTURE.scriptCss,
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
    createPageCalls = []
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

  const basePayload = { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }

  describe('PATCH — update', () => {
    test('changing scriptJsLoad without write:scripts is refused with 403, before updatePage runs', async () => {
      grantedPermissions = new Set(['write:pages'])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        headers: sessionHeader,
        payload: { scriptJsLoad: 'alert(1)' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updatePageCalls.length, 0)
      assert.ok(checkAccessCalls.includes('write:scripts'))
    })

    test('changing scriptJsUnload without write:scripts is refused with 403', async () => {
      grantedPermissions = new Set(['write:pages'])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        headers: sessionHeader,
        payload: { scriptJsUnload: 'alert(1)' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updatePageCalls.length, 0)
    })

    test('changing scriptCss without write:styles is refused with 403, before updatePage runs', async () => {
      grantedPermissions = new Set(['write:pages'])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        headers: sessionHeader,
        payload: { scriptCss: 'body { color: blue }' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updatePageCalls.length, 0)
      assert.ok(checkAccessCalls.includes('write:styles'))
    })

    test('changing scriptJsLoad succeeds once the actor also holds write:scripts', async () => {
      grantedPermissions = new Set(['write:pages', 'write:scripts'])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        headers: sessionHeader,
        payload: { scriptJsLoad: 'alert(1)' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
      assert.equal(updatePageCalls[0].patch.scriptJsLoad, 'alert(1)')
    })

    test('changing scriptCss succeeds once the actor also holds write:styles', async () => {
      grantedPermissions = new Set(['write:pages', 'write:styles'])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        headers: sessionHeader,
        payload: { scriptCss: 'body { color: blue }' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
    })

    test('write:scripts does not cover scriptCss, and write:styles does not cover scriptJsLoad', async () => {
      grantedPermissions = new Set(['write:pages', 'write:scripts'])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        headers: sessionHeader,
        payload: { scriptCss: 'body { color: blue }' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updatePageCalls.length, 0)
    })

    test('resubmitting the current scriptJsLoad/scriptCss unchanged needs neither permission, the same way an unchanged classification does not', async () => {
      grantedPermissions = new Set(['write:pages'])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        headers: sessionHeader,
        payload: {
          title: 'Onboarding, revised',
          scriptJsLoad: PAGE_FIXTURE.scriptJsLoad,
          scriptCss: PAGE_FIXTURE.scriptCss
        }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
      assert.ok(!checkAccessCalls.includes('write:scripts'))
      assert.ok(!checkAccessCalls.includes('write:styles'))
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
  })

  describe('POST — create', () => {
    test('creating a page with scriptJsLoad without write:scripts is refused with 403, before createPage runs', async () => {
      grantedPermissions = new Set(['write:pages', 'publish:pages'])
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages`,
        headers: sessionHeader,
        payload: { ...basePayload, scriptJsLoad: 'alert(1)' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(createPageCalls.length, 0)
      assert.ok(checkAccessCalls.includes('write:scripts'))
    })

    test('creating a page with scriptCss without write:styles is refused with 403', async () => {
      grantedPermissions = new Set(['write:pages', 'publish:pages'])
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages`,
        headers: sessionHeader,
        payload: { ...basePayload, scriptCss: 'body { color: red }' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(createPageCalls.length, 0)
      assert.ok(checkAccessCalls.includes('write:styles'))
    })

    test('creating a page with scripts succeeds once the actor holds write:scripts and write:styles', async () => {
      grantedPermissions = new Set([
        'write:pages',
        'publish:pages',
        'write:scripts',
        'write:styles'
      ])
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages`,
        headers: sessionHeader,
        payload: { ...basePayload, scriptJsLoad: 'alert(1)', scriptCss: 'body { color: red }' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(createPageCalls.length, 1)
    })

    test('creating a page with no scripts at all needs neither permission', async () => {
      grantedPermissions = new Set(['write:pages', 'publish:pages'])
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages`,
        headers: sessionHeader,
        payload: basePayload
      })
      assert.equal(res.statusCode, 200)
      assert.equal(createPageCalls.length, 1)
      assert.ok(!checkAccessCalls.includes('write:scripts'))
      assert.ok(!checkAccessCalls.includes('write:styles'))
    })
  })
})
