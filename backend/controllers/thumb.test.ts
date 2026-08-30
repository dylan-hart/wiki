import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import thumbRoutes from './thumb.ts'

/**
 * OpenProject #2178: `/_thumb/:fileName` used to answer any valid-UUID asset id with no
 * `read:assets` check and no site resolution at all -- reachable unauthenticated, from any
 * hostname. These lock down the fix: site resolution by hostname (mirroring `/_files/*`), a
 * `read:assets` check before bytes are ever sent, a `private` `Cache-Control` (since the reply now
 * depends on who asked), and 404 (not 403) on every refusal so the endpoint still cannot be probed
 * for existence.
 */
describe('thumb routes (OpenProject #2178)', () => {
  const SITE_A_ID = 'site-a'
  const SITE_B_ID = 'site-b'
  const VALID_ASSET_ID = '11111111-1111-4111-8111-111111111111'

  const sites: Record<string, any> = {
    [SITE_A_ID]: { id: SITE_A_ID, hostname: 'a.example.com', isEnabled: true },
    [SITE_B_ID]: { id: SITE_B_ID, hostname: 'b.example.com', isEnabled: true },
    'disabled-site': { id: 'disabled-site', hostname: 'off.example.com', isEnabled: false }
  }

  async function getSiteByHostname({ hostname }: { hostname: string }) {
    return Object.values(sites).find((s) => s.hostname === hostname) ?? null
  }

  let assetForServing: any
  let checkAccessResult: boolean
  let checkAccessCalls: any[]
  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: {},
      models: {
        sites: { getSiteByHostname },
        assets: {
          getThumbnailForServing: async () => assetForServing
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: (_actor: any, _permission: string, page: any) => {
            checkAccessCalls.push(page)
            return checkAccessResult
          }
        }
      }
    }
    app = fastify()
    await app.register(fastifySensible)
    await app.register(thumbRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('an invalid UUID 404s before any model call is made', async () => {
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: '/not-a-uuid.webp',
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('an unauthenticated request for an asset with no thumbnail 404s', async () => {
    assetForServing = null
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_ASSET_ID}.webp`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(checkAccessCalls.length, 0)
  })

  test('a request from a hostname whose site does not own the asset 404s, before checkAccess is asked', async () => {
    assetForServing = {
      preview: Buffer.from('bytes'),
      siteId: SITE_B_ID,
      folderPath: 'docs',
      fileName: 'diagram.png',
      locale: 'en'
    }
    checkAccessResult = true
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_ASSET_ID}.webp`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(checkAccessCalls.length, 0)
  })

  test('a request for a disabled site is refused before checkAccess is asked', async () => {
    assetForServing = {
      preview: Buffer.from('bytes'),
      siteId: 'disabled-site',
      folderPath: '',
      fileName: 'diagram.png',
      locale: 'en'
    }
    checkAccessResult = true
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_ASSET_ID}.webp`,
      headers: { host: 'off.example.com' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(checkAccessCalls.length, 0)
  })

  test('a permitted, same-site request is refused a 403 in favor of a 404 when read:assets denies it', async () => {
    assetForServing = {
      preview: Buffer.from('bytes'),
      siteId: SITE_A_ID,
      folderPath: 'docs',
      fileName: 'diagram.png',
      locale: 'en'
    }
    checkAccessResult = false
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_ASSET_ID}.webp`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(checkAccessCalls.length, 1)
    assert.deepEqual(checkAccessCalls[0], {
      path: 'docs/diagram.png',
      siteId: SITE_A_ID,
      locale: 'en',
      classification: null
    })
  })

  test('a permitted request returns the bytes with a private Cache-Control', async () => {
    assetForServing = {
      preview: Buffer.from('the thumbnail bytes'),
      siteId: SITE_A_ID,
      folderPath: '',
      fileName: 'diagram.png',
      locale: 'en'
    }
    checkAccessResult = true
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_ASSET_ID}.webp`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'the thumbnail bytes')
    assert.match(res.headers['cache-control'] as string, /^private,/)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    // -> A path with no folder does not grow a leading slash
    assert.equal(checkAccessCalls[0].path, 'diagram.png')
  })
})
