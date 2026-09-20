import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

describe('POST /sites/:siteId/pages/:pageId/collab/wysiwyg-seed-claim', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let pageResult: any
  let checkAccessImpl: (actor: any, permission: string, page: any) => boolean
  let claimCalls: string[]
  let claimResult: boolean

  function withSession(session: Record<string, any>) {
    return { 'x-test-session': JSON.stringify(session) }
  }

  before(async () => {
    const wiki = {
      models: {
        groups: {
          actorForRequest: (req: any) => ({
            id: req.session?.user?.id ?? null,
            permissions: req.session?.permissions ?? [],
            groups: req.session?.groups ?? []
          }),
          checkAccess: (actor: any, permission: string, page: any) =>
            checkAccessImpl(actor, permission, page),
          groupIdsForRequest: () => []
        },
        pages: {
          getPage: async (_opts: any) => pageResult
        }
      },
      collab: {
        claimWysiwygSeed: async (pageId: string) => {
          claimCalls.push(pageId)
          return claimResult
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: (req: any) => {
        const raw = req.headers['x-test-session']
        return typeof raw === 'string' ? JSON.parse(raw) : {}
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    pageResult = {
      id: PAGE_ID,
      path: 'some-page',
      locale: 'en',
      tags: [],
      classification: null,
      isLocked: false
    }
    checkAccessImpl = () => true
    claimCalls = []
    claimResult = true
  })

  function post() {
    return app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/collab/wysiwyg-seed-claim`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
  }

  test('answers 404 when the page itself does not exist', async () => {
    pageResult = null
    const res = await post()
    assert.equal(res.statusCode, 404)
    assert.deepEqual(claimCalls, [])
  })

  test('answers 403 when the requester may read but not write the page', async () => {
    checkAccessImpl = (_actor, permission) => permission === 'read:pages'
    const res = await post()
    assert.equal(res.statusCode, 403)
    assert.deepEqual(claimCalls, [])
  })

  test('passes the granted verdict straight through', async () => {
    claimResult = true
    const res = await post()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { granted: true })
    assert.deepEqual(claimCalls, [PAGE_ID])
  })

  test('passes the denied verdict straight through', async () => {
    claimResult = false
    const res = await post()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { granted: false })
  })

  test('a locked page is not a barrier, matching the collaboration websocket', async () => {
    pageResult.isLocked = true
    const res = await post()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { granted: true })
  })
})
