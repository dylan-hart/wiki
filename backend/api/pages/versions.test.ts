import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

describe('GET /sites/:siteId/versions/:versionId', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'
  const VERSION_ID = '33333333-3333-3333-3333-333333333333'

  let app: FastifyInstance
  let getPageResult: any
  let getVersionByIdResult: any
  let getVersionByIdCalledWith: any[]
  let checkAccessCalls: Array<{ permission: string; page: any }>
  let checkAccessImpl: (permission: string, page: any) => boolean

  before(async () => {
    const wiki = {
      models: {
        pages: {
          getPage: async () => getPageResult
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: (_actor: any, permission: string, page: any) => {
            checkAccessCalls.push({ permission, page })
            return checkAccessImpl(permission, page)
          },
          groupIdsForRequest: () => []
        },
        pageHistory: {
          getVersionById: async (...args: any[]) => {
            getVersionByIdCalledWith = args
            return getVersionByIdResult
          }
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: () => ({ user: { id: 'u1' } })
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    getPageResult = {
      id: PAGE_ID,
      path: 'current/path',
      locale: 'en',
      tags: [],
      classification: null,
      isLocked: false
    }
    getVersionByIdResult = {
      id: VERSION_ID,
      pageId: PAGE_ID,
      action: 'updated',
      via: 'editor',
      changedFields: ['content'],
      reason: '',
      versionDate: '2026-01-01T00:00:00.000Z',
      locale: 'en',
      path: 'old/path',
      title: 'Old Title',
      content: '# Old',
      contentType: 'markdown',
      author: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
      meta: { secret: 'value' }
    }
    getVersionByIdCalledWith = []
    checkAccessCalls = []
    checkAccessImpl = () => true
  })

  const url = () => `/sites/${SITE_ID}/versions/${VERSION_ID}`

  test('returns the version with the page as it stands now, and no email or meta', async () => {
    const res = await app.inject({ method: 'GET', url: url() })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(getVersionByIdCalledWith, [SITE_ID, VERSION_ID])
    const body = res.json()
    assert.equal(body.id, VERSION_ID)
    assert.equal(body.title, 'Old Title')
    assert.equal(body.content, '# Old')
    assert.equal(body.contentType, 'markdown')
    assert.deepEqual(body.page, { id: PAGE_ID, path: 'current/path', locale: 'en' })
    assert.equal('email' in body.author, false)
    assert.equal(body.author.name, 'Ada')
    assert.equal('meta' in body, false)
    assert.equal('pageId' in body, false)
  })

  test('judges read:history at the still-live page current path, not the version path', async () => {
    await app.inject({ method: 'GET', url: url() })

    const history = checkAccessCalls.find((call) => call.permission === 'read:history')
    assert.ok(history, 'read:history should be checked')
    assert.equal(history!.page.path, 'current/path')
    assert.notEqual(history!.page.path, 'old/path')
  })

  test('404s for an unknown version, without loading any page', async () => {
    getVersionByIdResult = null
    getPageResult = new Proxy(
      {},
      {
        get() {
          throw new Error('no page should be looked up for an unknown version')
        }
      }
    )

    const res = await app.inject({ method: 'GET', url: url() })

    assert.equal(res.statusCode, 404)
  })

  test('404s once the page is deleted, although its history row survives', async () => {
    getPageResult = null

    const res = await app.inject({ method: 'GET', url: url() })

    assert.equal(res.statusCode, 404)
    assert.equal('content' in res.json(), false)
  })

  test('404s for a page the caller cannot read, never confirming it exists', async () => {
    checkAccessImpl = (permission) => permission !== 'read:pages'

    const res = await app.inject({ method: 'GET', url: url() })

    assert.equal(res.statusCode, 404)
  })

  test('403s when the caller can read the page but not its history', async () => {
    checkAccessImpl = (permission) => permission !== 'read:history'

    const res = await app.inject({ method: 'GET', url: url() })

    assert.equal(res.statusCode, 403)
    assert.equal('content' in res.json(), false)
  })

  test('403s for a password-locked page, distinct from the 404 of a missing one', async () => {
    getPageResult = { ...getPageResult, isLocked: true }

    const res = await app.inject({ method: 'GET', url: url() })

    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /password protected/)
  })

  test('rejects a version id that is not a uuid at the schema', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/versions/not-a-uuid` })

    assert.equal(res.statusCode, 400)
    assert.deepEqual(getVersionByIdCalledWith, [])
  })
})
