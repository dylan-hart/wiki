import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import thumbRoutes from './thumb.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * OpenProject #2178: `/_thumb/:fileName` used to answer any valid-UUID asset id with no
 * `read:assets` check and no site resolution at all -- reachable unauthenticated, from any
 * hostname. These lock down the fix: site resolution by hostname (mirroring `/_files/*`), a
 * `read:assets` check before bytes are ever sent, a `private` `Cache-Control` (since the reply now
 * depends on who asked), and 404 (not 403, except for a disabled site) on every refusal so the
 * endpoint still cannot be probed for existence.
 */
describe('/_thumb site scoping and read:assets enforcement (OpenProject #2178)', () => {
  const VALID_UUID = '11111111-1111-4111-8111-111111111111'

  const SITE_A_ID = 'site-a-id'
  const SITE_B_ID = 'site-b-id'

  const sites: Record<string, any> = {
    [SITE_A_ID]: { id: SITE_A_ID, hostname: 'a.example.com', isEnabled: true },
    [SITE_B_ID]: { id: SITE_B_ID, hostname: 'b.example.com', isEnabled: true },
    'disabled-site': { id: 'disabled-site', hostname: 'off.example.com', isEnabled: false }
  }

  const thumbnail = {
    siteId: SITE_A_ID,
    folderPath: 'docs',
    fileName: 'diagram.png',
    locale: 'en',
    preview: Buffer.from('thumb-bytes')
  }

  let getThumbnailCalls = 0
  let checkAccessResult = true
  let checkAccessCalls: any[] = []

  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      config: {},
      models: {
        sites: {
          getSiteByHostname: async ({ hostname }: { hostname: string }) =>
            Object.values(sites).find((s) => s.hostname === hostname) ?? null
        },
        assets: {
          getThumbnail: async (id: string) => {
            getThumbnailCalls++
            return id === VALID_UUID ? thumbnail : null
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: (_actor: any, _permission: string, page: any) => {
            checkAccessCalls.push(page)
            return checkAccessResult
          }
        }
      }
    })
    app = fastify()
    await app.register(fastifySensible)
    await app.register(thumbRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  test('an invalid UUID 404s before any query runs', async () => {
    getThumbnailCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: '/not-a-uuid.webp',
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getThumbnailCalls, 0)
  })

  test('an unauthenticated (denied) request for an asset answers 404, not the bytes', async () => {
    checkAccessResult = false
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}.webp`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(checkAccessCalls.length, 1)
    assert.equal(checkAccessCalls[0].siteId, SITE_A_ID)
    assert.equal(checkAccessCalls[0].path, 'docs/diagram.png')
    checkAccessResult = true
  })

  test("a request from site B's hostname for site A's asset id answers 404", async () => {
    checkAccessResult = true
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}.webp`,
      headers: { host: 'b.example.com' }
    })
    assert.equal(res.statusCode, 404)
    // -> Refused on the site mismatch, before checkAccess is ever consulted
    assert.equal(checkAccessCalls.length, 0)
  })

  test('a request for a disabled site is refused with 403 before checkAccess is asked', async () => {
    checkAccessResult = true
    checkAccessCalls = []
    // -> `thumbnail.siteId` is fixed to SITE_A_ID above, so point the request at a disabled site
    //    whose hostname resolves but whose asset lookup will mismatch -- guardSiteEnabled runs
    //    before that mismatch is ever checked, so it is what actually answers this request.
    const original = (globalThis as any).WIKI.models.assets.getThumbnail
    ;(globalThis as any).WIKI.models.assets.getThumbnail = async (id: string) =>
      id === VALID_UUID ? { ...thumbnail, siteId: 'disabled-site' } : null
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/${VALID_UUID}.webp`,
        headers: { host: 'off.example.com' }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(checkAccessCalls.length, 0)
    } finally {
      ;(globalThis as any).WIKI.models.assets.getThumbnail = original
    }
  })

  test('a permitted request returns the bytes with a private Cache-Control', async () => {
    checkAccessResult = true
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}.webp`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'private, max-age=600, must-revalidate')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.body, 'thumb-bytes')
  })

  test('a hostname with no site behind it answers 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}.webp`,
      headers: { host: 'nowhere.example.com' }
    })
    assert.equal(res.statusCode, 404)
  })
})
