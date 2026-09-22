import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { CustomError } from '../helpers/common.ts'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { createSiteAdminAccessStub } from '../test/mocks.ts'
import pageTemplatesRoutes from './pageTemplates.ts'

const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
const OTHER_SITE_ID = '6e0d9a2f-3c4b-4d6e-8f70-8b9c0d1e2f3a'
const TEMPLATE_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

const TEMPLATES = [
  {
    id: TEMPLATE_ID,
    locale: null,
    name: 'Meeting notes',
    description: '',
    editor: 'markdown',
    content: '# Notes',
    createdBy: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z'
  }
]

describe('/sites/:siteId/page-templates', () => {
  const sites: Record<string, any> = { [SITE_ID]: { id: SITE_ID, config: {} } }

  let listCalls: any[] = []
  let createCalls: any[] = []
  let updateCalls: any[] = []
  let deleteCalls: any[] = []
  let accessChecks: any[] = []
  let createError: Error | null = null
  let sitePermissions: string[] = []
  let pagePermissions: string[] = []

  function actorForRequest(req: any) {
    const header = req.headers['x-test-permissions']
    const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
    return { groupIds: [], permissions }
  }

  function checkSiteAccess(actor: { permissions: string[] }, permission: string, siteId: string) {
    return sitePermissions.includes(`${permission}@${siteId}`)
  }

  function checkAccess(_actor: any, permission: string, page: any) {
    accessChecks.push({ permission, page })
    return pagePermissions.includes(permission)
  }

  let app: FastifyInstance

  before(async () => {
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(pageTemplatesRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      session: (req: any) => {
        const site = req.headers['x-test-site-permissions']
        sitePermissions = typeof site === 'string' ? site.split(',').filter(Boolean) : []
        const page = req.headers['x-test-page-permissions']
        pagePermissions = typeof page === 'string' ? page.split(',').filter(Boolean) : []
        return { authenticated: true, user: { id: 'user-1' } }
      },
      wiki: {
        sites,
        models: {
          groups: {
            actorForRequest,
            groupIdsForRequest: () => [],
            checkSiteAccess,
            checkAccess,
            checkSiteAdminAccess: createSiteAdminAccessStub(actorForRequest, checkSiteAccess)
          },
          pageTemplates: {
            async list(siteId: string, locale?: string) {
              listCalls.push({ siteId, locale })
              return TEMPLATES
            },
            async create(...args: any[]) {
              if (createError) {
                throw createError
              }
              createCalls.push(args)
              return { ...TEMPLATES[0], ...args[1] }
            },
            async update(...args: any[]) {
              updateCalls.push(args)
              return { ...TEMPLATES[0], ...args[2] }
            },
            async delete(...args: any[]) {
              deleteCalls.push(args)
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    listCalls = []
    createCalls = []
    updateCalls = []
    deleteCalls = []
    accessChecks = []
    createError = null
  })

  const url = `/sites/${SITE_ID}/page-templates`

  describe('GET', () => {
    test('write:pages at the base path lists the templates for that locale', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?basePath=/docs/guides/&locale=fr`,
        headers: { 'x-test-page-permissions': 'write:pages' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().length, 1)
      assert.deepEqual(listCalls, [{ siteId: SITE_ID, locale: 'fr' }])
      assert.deepEqual(accessChecks[0], {
        permission: 'write:pages',
        page: { path: 'docs/guides', locale: 'fr', classification: null, siteId: SITE_ID }
      })
    })

    test('an absent locale asks about, and filters by, the site primary locale', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?basePath=docs`,
        headers: { 'x-test-page-permissions': 'write:pages' }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(listCalls, [{ siteId: SITE_ID, locale: 'en' }])
      assert.equal(accessChecks[0].page.locale, 'en')
    })

    test('a caller without write:pages at the path is refused', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?basePath=docs&locale=en`,
        headers: { 'x-test-page-permissions': 'read:pages' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(listCalls.length, 0)
    })

    test('omitting basePath without site administration checks the site root', async () => {
      const allowed = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-test-page-permissions': 'write:pages' }
      })
      assert.equal(allowed.statusCode, 200)
      assert.equal(accessChecks[0].page.path, '')
      assert.deepEqual(listCalls, [{ siteId: SITE_ID, locale: 'en' }])

      const refused = await app.inject({ method: 'GET', url })
      assert.equal(refused.statusCode, 403)
      assert.equal(listCalls.length, 1)
    })

    test('manage:sites may list every template with no basePath', async () => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-test-permissions': 'manage:sites' }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(listCalls, [{ siteId: SITE_ID, locale: undefined }])
    })

    test('site:templates on this site may list every template with no basePath', async () => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-test-site-permissions': `site:templates@${SITE_ID}` }
      })
      assert.equal(res.statusCode, 200)
    })
  })

  describe('POST', () => {
    const payload = { name: 'Runbook', editor: 'markdown', content: '# Runbook' }

    test('site:templates on this site may create a template', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-test-site-permissions': `site:templates@${SITE_ID}` },
        payload
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().name, 'Runbook')
      assert.equal(createCalls.length, 1)
      assert.equal(createCalls[0][0], SITE_ID)
      assert.equal(createCalls[0][2], 'user-1')
      assert.deepEqual(createCalls[0][3], { scripts: false, styles: false })
    })

    test('the author’s own write:scripts and write:styles drive the sanitizer permissions', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: {
          'x-test-permissions': 'manage:sites',
          'x-test-page-permissions': 'write:scripts'
        },
        payload
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(createCalls[0][3], { scripts: true, styles: false })
    })

    test('site:templates on a different site does not permit it', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-test-site-permissions': `site:templates@${OTHER_SITE_ID}` },
        payload
      })
      assert.equal(res.statusCode, 403)
      assert.equal(createCalls.length, 0)
    })

    test('write:pages alone does not permit it', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-test-page-permissions': 'write:pages' },
        payload
      })
      assert.equal(res.statusCode, 403)
    })

    test('a body with no name is a 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-test-permissions': 'manage:sites' },
        payload: { content: 'x' }
      })
      assert.equal(res.statusCode, 400)
    })

    test('an editor outside the closed list is a 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-test-permissions': 'manage:sites' },
        payload: { name: 'X', editor: 'redirect' }
      })
      assert.equal(res.statusCode, 400)
    })

    test('a duplicate name is a 409', async () => {
      createError = new CustomError('pageTemplateDuplicateName', 'A template exists.', 409)
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-test-permissions': 'manage:sites' },
        payload
      })
      assert.equal(res.statusCode, 409)
    })
  })

  describe('PUT', () => {
    const putUrl = `${url}/${TEMPLATE_ID}`

    test('site:templates on this site may update a template', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: putUrl,
        headers: { 'x-test-site-permissions': `site:templates@${SITE_ID}` },
        payload: { name: 'Renamed' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().name, 'Renamed')
      assert.deepEqual(updateCalls[0].slice(0, 3), [SITE_ID, TEMPLATE_ID, { name: 'Renamed' }])
    })

    test('a caller without site administration is refused', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: putUrl,
        headers: { 'x-test-page-permissions': 'write:pages' },
        payload: { name: 'Renamed' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updateCalls.length, 0)
    })
  })

  describe('DELETE', () => {
    const deleteUrl = `${url}/${TEMPLATE_ID}`

    test('manage:sites may delete a template', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: deleteUrl,
        headers: { 'x-test-permissions': 'manage:sites' }
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { ok: true })
      assert.deepEqual(deleteCalls, [[SITE_ID, TEMPLATE_ID]])
    })

    test('a caller without site administration is refused', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: deleteUrl,
        headers: { 'x-test-page-permissions': 'write:pages' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(deleteCalls.length, 0)
    })
  })
})
