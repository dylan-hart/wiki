import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import filesRoutes from './files.ts'

/**
 * Regression test for task 699: `/_files/*` serves uploaded file bytes resolved by hostname
 * independently of the page/shell hook in `index.ts`, so a disabled site's files stayed reachable by
 * direct URL forever. Asserts the same contract as `api/bootstrap.test.ts` — a disabled site answers
 * 403, distinguishable from the pre-existing 404 for a hostname that matches no site.
 */

const ENABLED_SITE_ID = 'enabled-site-id'
const DISABLED_SITE_ID = 'disabled-site-id'

const sites: Record<string, any> = {
  [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, hostname: 'wiki.example.com', isEnabled: true },
  [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, hostname: 'off.example.com', isEnabled: false }
}

async function getSiteByHostname({ hostname }: { hostname: string }) {
  return Object.values(sites).find((s) => s.hostname === hostname) ?? null
}

let resolveAssetPathCalls = 0

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    config: { security: {} },
    models: {
      sites: { getSiteByHostname },
      assets: {
        resolveAssetPath: async () => {
          resolveAssetPathCalls++
          return null
        }
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        checkAccess: () => false
      }
    }
  }
  app = fastify()
  await app.register(fastifySensible)
  await app.register(filesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('answers 404 for a hostname with no site behind it', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/some/file.png',
    headers: { host: 'nowhere.example.com' }
  })
  assert.equal(res.statusCode, 404)
})

test('answers 403, distinguishable from 404, for a resolved-but-disabled site, before ever resolving the path', async () => {
  resolveAssetPathCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: '/some/file.png',
    headers: { host: 'off.example.com' }
  })
  assert.equal(res.statusCode, 403)
  assert.notEqual(res.statusCode, 404)
  assert.match(res.json().message, /disabled/i)
  assert.equal(resolveAssetPathCalls, 0)
})

test('an enabled site passes the guard through to the normal asset-path resolution', async () => {
  resolveAssetPathCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: '/some/file.png',
    headers: { host: 'wiki.example.com' }
  })
  // -> Not found because resolveAssetPath is stubbed to return null, but the guard let it get there
  assert.equal(res.statusCode, 404)
  assert.equal(resolveAssetPathCalls, 1)
})

/**
 * Regression test for task 676: the `checkAccess` call here resolves its site from
 * `getSiteByHostname` rather than from a route param — a different source than every other call site
 * in this task, but the same fix — so a page rule scoped to one site (task 671) is enforced when a
 * file is served through `/_files/*` too.
 */
test('passes the hostname-resolved siteId through to checkAccess', async () => {
  const originalResolveAssetPath = (globalThis as any).WIKI.models.assets.resolveAssetPath
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  const calls: any[] = []
  ;(globalThis as any).WIKI.models.assets.resolveAssetPath = async () => ({
    id: 'asset-1',
    folderPath: '',
    fileName: 'file.png',
    locale: 'en',
    updatedAt: new Date()
  })
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return false
  }
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/file.png',
      headers: { host: 'wiki.example.com' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].siteId, ENABLED_SITE_ID)
  } finally {
    ;(globalThis as any).WIKI.models.assets.resolveAssetPath = originalResolveAssetPath
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
  }
})
