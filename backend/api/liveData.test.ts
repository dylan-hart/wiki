import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import liveDataRoutes from './liveData.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/** The route's own wiring only; `models/liveData.test.ts` covers `resolve()` itself. */
describe('POST /sites/:siteId/live-data/resolve', () => {
  const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'

  const sites: Record<string, any> = { [SITE_ID]: { id: SITE_ID } }

  let enabledKeys = new Set(['live-data'])
  let resolveCalls: Array<{ siteId: string; request: any }>
  let resolveResult: any = { value: 42, fetchedAt: '2026-08-21T00:00:00.000Z' }

  async function getEnabledKeys() {
    return enabledKeys
  }
  async function resolve(siteId: string, request: any) {
    resolveCalls.push({ siteId, request })
    return resolveResult
  }

  let app: FastifyInstance

  before(async () => {
    // -> The unknown-site 404 lives in `siteEnabledPreHandler`, not in the route, so a plugin-only
    //    app has to register it.
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(liveDataRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      session: (req: any) => {
        if (req.headers['x-test-api-key'] === 'true') {
          req.apiKey = { id: 'test-key', permissions: [] }
        }
        return req.headers['x-test-authenticated'] === 'true' ? { authenticated: true } : undefined
      },
      wiki: {
        sites,
        models: {
          blocks: { getEnabledKeys },
          liveData: { resolve }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    enabledKeys = new Set(['live-data'])
    resolveCalls = []
    resolveResult = { value: 42, fetchedAt: '2026-08-21T00:00:00.000Z' }
  })

  test('404s when the site does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sites/00000000-0000-0000-0000-000000000000/live-data/resolve',
      payload: { url: 'https://example.com', jsonPath: '$.v' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('404s when the live-data block is not enabled on this site', async () => {
    enabledKeys = new Set([])
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: { url: 'https://example.com', jsonPath: '$.v' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(resolveCalls.length, 0)
  })

  test('passes a credential-free body straight through to the model, anonymous or not', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      headers: { 'x-test-authenticated': 'true' },
      payload: {
        url: 'https://example.com/metrics',
        jsonPath: '$.cpu',
        refreshInterval: 30
      }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), resolveResult)
    assert.equal(resolveCalls.length, 1)
    assert.equal(resolveCalls[0]!.siteId, SITE_ID)
    assert.deepEqual(resolveCalls[0]!.request, {
      url: 'https://example.com/metrics',
      jsonPath: '$.cpu',
      refreshInterval: 30
    })
  })

  test('refuses an anonymous request carrying a credentialId (OpenProject #2202)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: {
        credentialId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
        url: 'https://example.com/metrics',
        jsonPath: '$.cpu',
        refreshInterval: 30
      }
    })
    assert.equal(res.statusCode, 401)
    assert.equal(resolveCalls.length, 0)
  })

  test('allows a credentialed request from a session-authenticated caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      headers: { 'x-test-authenticated': 'true' },
      payload: {
        credentialId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
        url: 'https://example.com/metrics',
        jsonPath: '$.cpu',
        refreshInterval: 30
      }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), resolveResult)
    assert.equal(resolveCalls.length, 1)
  })

  test('allows a credentialed request from a verified API key caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      headers: { 'x-test-api-key': 'true' },
      payload: {
        credentialId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
        url: 'https://example.com/metrics',
        jsonPath: '$.cpu',
        refreshInterval: 30
      }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), resolveResult)
    assert.equal(resolveCalls.length, 1)
  })

  test('rejects a body missing url or jsonPath', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: { url: 'https://example.com' }
    })
    assert.equal(res.statusCode, 400)
  })

  test('rejects an over-long url with a 400 (schema maxLength)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: { url: `https://example.com/${'a'.repeat(2048)}`, jsonPath: '$.v' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(resolveCalls.length, 0)
  })

  test('rejects an over-long jsonPath with a 400 (schema maxLength)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: { url: 'https://example.com/metrics', jsonPath: `$.${'a'.repeat(512)}` }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(resolveCalls.length, 0)
  })

  test('rejects a credentialId from an unauthenticated (anonymous) caller (OpenProject #2185)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: {
        credentialId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
        url: 'https://example.com/metrics',
        jsonPath: '$.cpu'
      }
    })
    assert.equal(res.statusCode, 401)
    assert.equal(resolveCalls.length, 0)
  })

  test('an anonymous credential-free request still succeeds (OpenProject #2185)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: { url: 'https://example.com/metrics', jsonPath: '$.cpu' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(resolveCalls.length, 1)
  })

  test("propagates the model's error status (e.g. a 502 from an unreachable endpoint)", async () => {
    ;(CARDINAL.models.liveData.resolve as any) = async () => {
      const err: any = new Error('Could not reach the endpoint: fetch failed')
      err.name = 'Bad Gateway'
      err.statusCode = 502
      throw err
    }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/live-data/resolve`,
      payload: { url: 'https://example.com', jsonPath: '$.v' }
    })
    assert.equal(res.statusCode, 502)
  })
})
