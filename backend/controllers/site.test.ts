import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import siteRoutes, { SITE_ASSET_FALLBACKS } from './site.ts'
import { svgMimeType } from '../helpers/images.ts'
import { SVG_CSP } from '../helpers/security.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

describe('GET /_site/current/<resource> — hostname resolution', () => {
  /**
   * Regression / verification coverage for `GET /_site/current/<resource>` (task 745, part 2), the
   * asset-serving counterpart of `GET /_api/sites/:siteIdorHostname`'s `strict` fix
   * (`api/sites.test.ts`). Both routes resolve a site the same way — `WIKI.models.sites
   * .getSiteByHostname({ hostname: req.hostname })` — so this suite proves that mechanism actually
   * picks the right site per-request across multiple hostnames, not just that the model function is
   * correct in isolation.
   *
   * `WIKI.models.sites.getSiteByHostname`/`getAsset` are stubbed to reproduce the real model's
   * exact/wildcard semantics (`models/sites.ts`) rather than pulling in the db/schema/drizzle graph —
   * same approach as `api/sites.test.ts`.
   */

  const SITE_A = { id: 'site-a', hostname: 'sitea.example.com', config: { assets: { logo: true } } }
  const SITE_B = { id: 'site-b', hostname: 'siteb.example.com', config: { assets: { logo: true } } }
  const SITE_WILDCARD = { id: 'site-wildcard', hostname: '*', config: { assets: { logo: true } } }

  const sitesMappings: Record<string, string> = {
    [SITE_A.hostname]: SITE_A.id,
    [SITE_B.hostname]: SITE_B.id,
    '*': SITE_WILDCARD.id
  }
  const sites: Record<string, any> = {
    [SITE_A.id]: SITE_A,
    [SITE_B.id]: SITE_B,
    [SITE_WILDCARD.id]: SITE_WILDCARD
  }

  /** Distinct bytes per site so a response can be attributed to exactly one of them. */
  const assetsBySiteId: Record<string, { mime: string; data: Buffer }> = {
    [SITE_A.id]: { mime: 'image/png', data: Buffer.from('logo-a') },
    [SITE_B.id]: { mime: 'image/png', data: Buffer.from('logo-b') },
    [SITE_WILDCARD.id]: { mime: 'image/png', data: Buffer.from('logo-wildcard') }
  }

  async function getSiteByHostname({ hostname }: { hostname: string }) {
    // -> Mirrors the real `Sites.getSiteByHostname`'s non-strict lookup: exact match, else the '*'
    //    wildcard mapping.
    const siteId = sitesMappings[hostname] || sitesMappings['*']
    return siteId ? sites[siteId] : null
  }

  async function getAsset(siteId: string, _kind: string) {
    return assetsBySiteId[siteId] ?? null
  }

  async function getAssetHash(siteId: string, _kind: string) {
    const asset = assetsBySiteId[siteId]
    return asset ? crypto.createHash('sha1').update(asset.data).digest('hex') : null
  }

  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      ROOTPATH: process.cwd(),
      models: {
        sites: {
          getSiteByHostname,
          getSiteById: async () => null,
          getAsset,
          getAssetHash
        }
      }
    })

    app = fastify()
    await app.register(siteRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  test("resolves site A's own logo when the Host header is site A's hostname", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/current/logo',
      headers: { host: SITE_A.hostname }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'logo-a')
  })

  test("resolves site B's own logo when the Host header is site B's hostname", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/current/logo',
      headers: { host: SITE_B.hostname }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'logo-b')
  })

  test("falls back to the '*' wildcard site when no site is registered for the hostname", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/current/logo',
      headers: { host: 'unregistered.example.com' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'logo-wildcard')
  })

  test(
    "a Host header carrying a port still resolves the bare-hostname site, not the '*' wildcard " +
      "(Fastify's req.hostname already strips the port before this route ever sees it)",
    async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/current/logo',
        headers: { host: `${SITE_A.hostname}:3000` }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.body, 'logo-a')
    }
  )

  /**
   * Task 759 (the SVG CSP lockdown) plus WP 1826/#2724 (cache headers/validator for the built-in
   * fallbacks): the ETag/`If-None-Match`/304 branch, the `Content-Security-Policy` header being
   * conditioned on `asset.mime === svgMimeType`, and both response branches' caching headers — an
   * uploaded asset and the `replyWithFile` fallback branch (nobody has uploaded anything for this
   * kind) now share the same `public, no-cache` policy and strong (sha1) `ETag`, each with its own
   * independent 304 path, so a redeployed fallback's new bytes are never stuck behind a stale
   * browser cache the way a day-long `max-age` at an unchanging URL used to leave them (#2724).
   *
   * Runs its own app + `WIKI` stub, saved/restored around the shared `globalThis.WIKI` the suite above
   * uses — same pattern `helpers/images.test.ts`'s Sharp-unavailable describe uses for the same reason:
   * the route handler reads `WIKI` off `globalThis` at request time, so only one stub can be active at
   * once, and this suite's data (a single site, a mutable asset) doesn't fit the multi-site fixture
   * above.
   */
  describe('GET /_site/current/<resource> — caching, ETag and the SVG Content-Security-Policy header', () => {
    const SITE = {
      id: 'site-etag',
      hostname: 'siteetag.example.com',
      config: { assets: {} as any }
    }

    let localApp: FastifyInstance
    let wikiHandle: { restore(): void }
    let serverDir: string
    /** What `getAsset` returns for the current test; null reproduces "nothing uploaded". */
    let currentAsset: { data: Buffer; mime: string } | null = null
    /**
     * Tracked as a `mock.fn` (WP 1852) so a test can assert a matching conditional request never
     * calls it — the whole point of answering from `getAssetHash` alone.
     */
    let getAsset: ReturnType<typeof mock.fn>

    before(async () => {
      serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-site-fallback-'))
      // -> Staged from `SITE_ASSET_FALLBACKS['logo']` itself rather than a second copy of the
      //    literal, so the real `replyWithFile` fallback branch has a real file to stream and this
      //    setup cannot drift from the table it is standing in for. The fallbacks are resolved
      //    against `SERVERPATH` now, not `ROOTPATH` (OpenProject #2611).
      const stagedLogo = path.join(serverDir, SITE_ASSET_FALLBACKS.logo)
      await fs.mkdir(path.dirname(stagedLogo), { recursive: true })
      await fs.writeFile(stagedLogo, '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>')

      getAsset = mock.fn(async () => currentAsset)
      wikiHandle = installTestWiki({
        SERVERPATH: serverDir,
        models: {
          sites: {
            getSiteByHostname: async () => SITE,
            getSiteById: async () => null,
            getAsset,
            getAssetHash: async () =>
              currentAsset
                ? crypto.createHash('sha1').update(currentAsset.data).digest('hex')
                : null
          }
        }
      })

      localApp = fastify()
      await localApp.register(siteRoutes)
      await localApp.ready()
    })

    after(async () => {
      await localApp.close()
      await fs.rm(serverDir, { recursive: true, force: true })
      wikiHandle.restore()
    })

    afterEach(() => {
      currentAsset = null
      SITE.config.assets = {}
      getAsset.mock.resetCalls()
    })

    test('an uploaded (non-SVG) asset gets an ETag, "public, no-cache", nosniff, and no CSP header', async () => {
      SITE.config.assets = { logo: true }
      currentAsset = { data: Buffer.from('raw-png-bytes'), mime: 'image/png' }

      const res = await localApp.inject({
        method: 'GET',
        url: '/current/logo',
        headers: { host: SITE.hostname }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.body, 'raw-png-bytes')
      assert.equal(res.headers['cache-control'], 'public, no-cache')
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.equal(
        res.headers['content-security-policy'],
        undefined,
        'a raster asset must never get the SVG lockdown header'
      )
      const expectedEtag = `"${crypto.createHash('sha1').update(currentAsset.data).digest('hex')}"`
      assert.equal(res.headers.etag, expectedEtag)
      assert.equal(
        getAsset.mock.callCount(),
        1,
        'a non-conditional (or mismatched) request must still load the blob to serve it'
      )
    })

    test('an uploaded SVG asset gets the CSP/sandbox lockdown header in addition to the same caching headers', async () => {
      SITE.config.assets = { logo: true }
      currentAsset = {
        data: Buffer.from('<svg><script>alert(1)</script></svg>'),
        mime: svgMimeType
      }

      const res = await localApp.inject({
        method: 'GET',
        url: '/current/logo',
        headers: { host: SITE.hostname }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-security-policy'], SVG_CSP)
      assert.equal(res.headers['cache-control'], 'public, no-cache')
      assert.ok(res.headers.etag)
    })

    test('a matching If-None-Match short-circuits to an empty 304, keeping ETag/Cache-Control on the response, WITHOUT ever loading the blob (WP 1852)', async () => {
      SITE.config.assets = { logo: true }
      currentAsset = { data: Buffer.from('raw-png-bytes'), mime: 'image/png' }
      const etag = `"${crypto.createHash('sha1').update(currentAsset.data).digest('hex')}"`

      const res = await localApp.inject({
        method: 'GET',
        url: '/current/logo',
        headers: { host: SITE.hostname, 'if-none-match': etag }
      })

      assert.equal(res.statusCode, 304)
      assert.equal(res.body, '')
      assert.equal(res.headers.etag, etag)
      assert.equal(res.headers['cache-control'], 'public, no-cache')
      assert.equal(
        getAsset.mock.callCount(),
        0,
        'a matching conditional request must never load the asset blob'
      )
    })

    test('a stale/mismatched If-None-Match still gets the full 200 response, not a 304', async () => {
      SITE.config.assets = { logo: true }
      currentAsset = { data: Buffer.from('raw-png-bytes'), mime: 'image/png' }

      const res = await localApp.inject({
        method: 'GET',
        url: '/current/logo',
        headers: { host: SITE.hostname, 'if-none-match': '"stale-etag-from-a-previous-upload"' }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.body, 'raw-png-bytes')
    })

    test(
      'the built-in fallback (nothing uploaded) is served with "public, no-cache", a strong ETag ' +
        'and a Last-Modified header, but no SVG lockdown headers (those only guard admin-uploaded ' +
        'bytes) — the same revalidating policy as an uploaded asset, so a redeployed fallback is ' +
        'never stuck behind a stale cache at this unchanging URL (#2724)',
      async () => {
        SITE.config.assets = { logo: false }
        currentAsset = null

        const res = await localApp.inject({
          method: 'GET',
          url: '/current/logo',
          headers: { host: SITE.hostname }
        })

        assert.equal(res.statusCode, 200)
        assert.match(res.body, /<svg/)
        assert.equal(res.headers['cache-control'], 'public, no-cache')
        assert.ok(res.headers.etag, 'expected an ETag on the fallback response')
        assert.equal(
          (res.headers.etag as string).startsWith('W/'),
          false,
          'expected a strong ETag, not a weak size/mtime one'
        )
        assert.ok(res.headers['last-modified'], 'expected a Last-Modified on the fallback response')
        assert.equal(res.headers['content-security-policy'], undefined)
        assert.equal(res.headers['x-content-type-options'], undefined)
      }
    )

    test(
      'a repeat request against the built-in fallback with a matching If-None-Match short-circuits ' +
        'to an empty 304, keeping its Cache-Control/ETag on the response',
      async () => {
        SITE.config.assets = { logo: false }
        currentAsset = null

        const first = await localApp.inject({
          method: 'GET',
          url: '/current/logo',
          headers: { host: SITE.hostname }
        })
        const etag = first.headers.etag as string
        assert.ok(etag)

        const second = await localApp.inject({
          method: 'GET',
          url: '/current/logo',
          headers: { host: SITE.hostname, 'if-none-match': etag }
        })

        assert.equal(second.statusCode, 304)
        assert.equal(second.body, '')
        assert.equal(second.headers.etag, etag)
        assert.equal(second.headers['cache-control'], 'public, no-cache')
      }
    )

    test(
      'a stale/mismatched If-None-Match against the built-in fallback still gets the full 200 ' +
        'response, not a 304',
      async () => {
        SITE.config.assets = { logo: false }
        currentAsset = null

        const res = await localApp.inject({
          method: 'GET',
          url: '/current/logo',
          headers: { host: SITE.hostname, 'if-none-match': '"stale-from-a-previous-redeploy"' }
        })

        assert.equal(res.statusCode, 200)
        assert.match(res.body, /<svg/)
      }
    )
  })
})

describe('GET /_site/:siteId/<resource> — isEnabled guard (task 699)', () => {
  /**
   * Regression test for task 699: `/_site/:siteId/:resource` (logo/favicon/login background) resolves
   * its own siteId independently of the page/shell hook in `index.ts`, so a disabled site's images
   * stayed reachable by direct URL forever. Asserts the same contract as `api/bootstrap.test.ts` — a
   * disabled site answers 403, distinguishable from the pre-existing 404 for a siteId/hostname that
   * matches nothing.
   */

  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: {
      id: ENABLED_SITE_ID,
      hostname: 'wiki.example.com',
      isEnabled: true,
      // -> An upload already on file, so the enabled-site test exercises the guard passing the request
      //    through to the served-bytes branch rather than the on-disk fallback file, which this test
      //    environment has no built `assets/` directory to serve
      config: { assets: { logo: true } }
    },
    [DISABLED_SITE_ID]: {
      id: DISABLED_SITE_ID,
      hostname: 'off.example.com',
      isEnabled: false,
      config: { assets: {} }
    }
  }

  async function getSiteById({ id }: { id: string }) {
    return sites[id] ?? null
  }

  async function getAsset(siteId: string, kind: string) {
    return sites[siteId]?.config?.assets?.[kind]
      ? { data: Buffer.from('fake-logo-bytes'), mime: 'image/webp' }
      : null
  }

  async function getAssetHash(siteId: string, kind: string) {
    const asset = await getAsset(siteId, kind)
    return asset ? crypto.createHash('sha1').update(asset.data).digest('hex') : null
  }

  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      ROOTPATH: process.cwd(),
      models: {
        sites: { getSiteById, getSiteByHostname: async () => null, getAsset, getAssetHash }
      }
    })
    app = fastify()
    await app.register(fastifySensible)
    await app.register(siteRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  test('answers 404 for a siteId that matches nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/00000000-0000-0000-0000-000000000000/logo'
    })
    assert.equal(res.statusCode, 404)
  })

  test('answers 403, distinguishable from 404, for a resolved-but-disabled site', async () => {
    const res = await app.inject({ method: 'GET', url: `/${DISABLED_SITE_ID}/logo` })
    assert.equal(res.statusCode, 403)
    assert.notEqual(res.statusCode, 404)
    assert.match(res.json().message, /disabled/i)
  })

  test('an enabled site serves its uploaded asset, past the guard', async () => {
    const res = await app.inject({ method: 'GET', url: `/${ENABLED_SITE_ID}/logo` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'fake-logo-bytes')
  })
})

describe('GET /_site/:siteId/<resource> — enforceApiKeySite (OpenProject #2201)', () => {
  /**
   * `:siteId` here can be `current`, a hostname, or a real UUID (see `site.ts`), never lifted straight
   * off the URL the way a params-only site-pin hook expects -- so this route calls
   * `enforceApiKeySite()` itself once it has resolved the real site behind whichever form was given.
   */

  const SITE_A = {
    id: '11111111-4111-4111-8111-111111111111',
    hostname: 'sitea.example.com',
    isEnabled: true,
    config: { assets: { logo: true } }
  }
  const SITE_B = {
    id: '22222222-4222-4222-8222-222222222222',
    hostname: 'siteb.example.com',
    isEnabled: true,
    config: { assets: { logo: true } }
  }
  const sites: Record<string, any> = { [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B }

  async function getSiteById({ id }: { id: string }) {
    return sites[id] ?? null
  }

  async function getAsset(_siteId: string, _kind: string) {
    return { data: Buffer.from('logo-bytes'), mime: 'image/webp' }
  }

  async function getAssetHash(_siteId: string, _kind: string) {
    return crypto.createHash('sha1').update('logo-bytes').digest('hex')
  }

  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      ROOTPATH: process.cwd(),
      models: {
        sites: { getSiteById, getSiteByHostname: async () => null, getAsset, getAssetHash }
      }
    })
    app = fastify()
    await app.register(fastifySensible)
    app.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).apiKey = { id: 'key-1', permissions: [], siteId: SITE_A.id }
      done()
    })
    await app.register(siteRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  test('refuses 403 when a key pinned to site A requests site B by UUID', async () => {
    const res = await app.inject({ method: 'GET', url: `/${SITE_B.id}/logo` })
    assert.equal(res.statusCode, 403)
  })

  test('lets a key pinned to site A through when it requests site A by UUID', async () => {
    const res = await app.inject({ method: 'GET', url: `/${SITE_A.id}/logo` })
    assert.equal(res.statusCode, 200)
  })
})

/**
 * The branding fallbacks used to point at `assets/_assets/`, which is `frontend/`'s `vite build`
 * output and is gitignored — so `node backend` against an unbuilt or merely stale `assets/` served
 * the wrong mark, or nothing at all, and nothing distinguished that from "no logo configured"
 * (OpenProject #2611). They are backend-owned committed files now, which is what makes asserting
 * that they exist a deterministic check rather than one that only holds after somebody has run a
 * build.
 *
 * This iterates `SITE_ASSET_FALLBACKS` rather than re-listing the paths, so a fourth asset kind is
 * covered the moment it is added.
 */
describe('SITE_ASSET_FALLBACKS — the backend owns its branding fallback files', () => {
  /** The real `backend/`, i.e. what `WIKI.SERVERPATH` resolves to in a running instance. */
  const serverPath = path.join(import.meta.dirname, '..')

  for (const [kind, relativePath] of Object.entries(SITE_ASSET_FALLBACKS)) {
    test(`the ${kind} fallback resolves to a real file inside backend/`, async () => {
      const resolved = path.join(serverPath, relativePath)
      const stats = await fs.stat(resolved)
      assert.equal(stats.isFile(), true, `${resolved} is not a file`)
    })

    test(`the ${kind} fallback stays inside backend/ rather than pointing at build output`, () => {
      const fromServerPath = path.relative(serverPath, path.resolve(serverPath, relativePath))
      assert.equal(
        path.isAbsolute(relativePath) || fromServerPath.startsWith('..'),
        false,
        `the ${kind} fallback escapes backend/: ${relativePath}`
      )
    })
  }

  /**
   * `frontend/public/_assets/logo-cardinal.svg` is a deliberate second copy — the Vite dev server
   * and the built bundle answer `/_assets/logo-cardinal.svg` for `AdminLayout.vue` and
   * `WelcomeOverlay.vue` out of `public/`, a different path space from the backend's own fallback
   * table, and the two are deliberately not unified. Two copies can drift, though, and a drifted
   * pair reproduces the exact symptom #2611 was filed for: the admin area showing one mark while
   * every other surface shows another. This is what stops that.
   */
  test('the backend logo fallback is byte-identical to the frontend public copy', async () => {
    const backendCopy = await fs.readFile(path.join(serverPath, SITE_ASSET_FALLBACKS.logo))
    const frontendCopy = await fs.readFile(
      path.join(serverPath, '..', 'frontend', 'public', '_assets', 'logo-cardinal.svg')
    )
    assert.equal(
      backendCopy.equals(frontendCopy),
      true,
      'backend/assets/branding/logo-cardinal.svg and frontend/public/_assets/logo-cardinal.svg have drifted apart'
    )
  })
})
