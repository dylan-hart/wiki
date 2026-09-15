import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastify from 'fastify'
import { registerSchemas } from './site.ts'
import { buildSitePayload } from '../sites.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * Regression coverage for task 489: `editors.code` has to be registered on the shared `Site` schema
 * exactly the way `asciidoc`/`markdown`/`wysiwyg` are (`isActive`/`config`) — otherwise a PUT to
 * `sites/:siteId` carrying `editors: { code: { isActive: true } }` (what `AdminEditors.vue`'s `save()`
 * sends) is silently stripped by Fastify's schema-based serialization/validation rather than reaching
 * the model, and the code editor could never actually be turned on for a site.
 *
 * Reads the schema back out of Fastify (`app.getSchema`) rather than re-implementing its own copy of
 * `site.ts`'s object literal, so this fails the moment the real registration drifts from what is
 * asserted here.
 */
test('the Site schema registers editors.code alongside asciidoc/markdown/wysiwyg', async () => {
  const app = fastify()
  await registerSchemas(app)
  await app.ready()

  const siteSchema = app.getSchema('Site') as any
  const editors = siteSchema.properties.editors.properties

  assert.ok(editors.code, 'editors.code is missing from the Site schema')
  assert.deepEqual(
    editors.code,
    editors.markdown,
    'editors.code should have the same shape as editors.markdown'
  )

  await app.close()
})

/**
 * Task 2235: `buildSitePayload()` (api/sites.ts) used to spread `...site.config` ahead of the row and
 * computed fields, so any key that ever landed in a site's config blob reached the response the
 * moment this schema also declared it — nothing stated or tested that the two had to be kept in sync.
 * `search` is the load-bearing case: it's where active search-engine credentials live
 * (`WIKI.sites[siteId]?.config?.search?.engines?.[key]`, e.g. Algolia's `apiKey` and AWS CloudSearch's
 * `secretAccessKey` — see `models/search.ts:402`/`:535`), seeded under the same top-level `search` key
 * as `search.engine`/`search.config` (`models/sites.ts`'s `createSite` defaults), and it stayed out of
 * a reader's browser only because the `Site` schema above declares no top-level `search` property.
 * `buildSitePayload` is the body of two `publicAccess: true` routes (`GET /sites/:siteIdorHostname`
 * and `GET /_api/bootstrap`), so a caller passing a `search`-bearing config here — reproducing exactly
 * what `models/sites.ts` seeds — must never see it echoed back, regardless of what a future schema
 * edit declares.
 *
 * Asserts the full key set, not just `search`'s absence: an allow-list drifting silently out of step
 * with the `Site` schema (a key spread back in, or named here but never declared on `Site`) is exactly
 * the failure mode this test exists to catch.
 */
test('buildSitePayload returns exactly the allow-listed keys and never `search`', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: 'https://test.docs.example/docs', replication: { isEnabled: true } },
    models: {
      // -> Availability moved off `rendering` when `models/rendering.ts` was split; the payload
      //    builder reads it here now.
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' }
    }
  })

  const payload = await buildSitePayload({
    id: 'site-id',
    hostname: 'example.test',
    isEnabled: true,
    config: {
      title: 'A Site',
      description: 'desc',
      company: 'Acme',
      contentLicense: 'CC-BY',
      footerExtra: '',
      pageExtensions: ['md'],
      allowedUrlSchemes: ['discord'],
      discoverable: false,
      defaults: { tocDepth: { min: 1, max: 2 } },
      features: { browse: true },
      uploads: { conflictBehavior: 'overwrite' },
      logoText: true,
      sitemap: true,
      pathDisplayCase: 'off',
      robots: { index: true, follow: true },
      security: { embedAllowedOrigins: ['https://intranet.example.com'] },
      auth: { autoLogin: false },
      authStrategies: [],
      locales: { primary: 'en', active: ['en'] },
      assets: { logo: false },
      editors: { markdown: { isActive: true, config: {} } },
      theme: { dark: false },
      analytics: { providers: {} },
      // -> Deliberately present in the input, exactly as `models/sites.ts` seeds it, to prove it does
      //    not survive to the output. This is the exclusion the file-header comment above is about.
      search: {
        engine: 'algolia',
        config: {
          engines: { algolia: { apiKey: 'super-secret-algolia-key' } }
        }
      }
    }
  })

  assert.deepEqual(Object.keys(payload).sort(), [
    'allowedUrlSchemes',
    'analytics',
    'assets',
    'auth',
    'authStrategies',
    'blocksConfig',
    'blocksIndex',
    'company',
    'contentLicense',
    'defaults',
    'description',
    'discoverable',
    'docsBase',
    'editors',
    'features',
    'footerExtra',
    'hostname',
    'id',
    'isEnabled',
    'isReplicationEnabled',
    'locales',
    'logoText',
    'navigationId',
    'pageExtensions',
    'pathDisplayCase',
    'pdfExportAvailable',
    'robots',
    'security',
    'sitemap',
    'theme',
    'title',
    'uploads'
  ])
  assert.ok(!('search' in payload), '`search` must never reach the public site payload')
  assert.equal(
    payload.isReplicationEnabled,
    true,
    'isReplicationEnabled should reflect WIKI.config.replication.isEnabled'
  )
  assert.deepEqual(payload.security, { embedAllowedOrigins: ['https://intranet.example.com'] })

  wikiHandle.restore()
})

/**
 * Task 2851: `isReplicationEnabled` is a strict boolean derived off `WIKI.config.replication?.isEnabled
 * === true`, not a bare truthy passthrough -- a missing `replication` config block (an older/minimal
 * config shape) must answer `false`, not `undefined`, since the field is declared `type: 'boolean'` on
 * the `Site` schema.
 */
test('buildSitePayload reports isReplicationEnabled: false when replication config is absent', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' }
    }
  })

  const payload = await buildSitePayload({
    id: 'site-id',
    hostname: 'example.test',
    isEnabled: true,
    config: {}
  })

  assert.equal(payload.isReplicationEnabled, false)

  wikiHandle.restore()
})

/**
 * Task #3103: `features.semanticSearch` on the site-info response is true only when BOTH the
 * instance-wide boot-time capability flag (`WIKI.capabilities.semanticSearch`, Task #3095) and this
 * site's own `search.config.semanticEnabled` admin setting (Task #3104) are true -- all four
 * combinations, per the work package's own acceptance criteria.
 *
 * `semanticEnabled` is nested inside `search.config` here to match exactly where `api/search.ts`'s
 * PATCH handler actually saves it (`{ config: { search: { config: { semanticEnabled } } } }`) and
 * where `models/search.ts#getConfig()` reads it back from -- OpenProject #3137: `semanticSearchAvailable()`
 * used to read one level shallower (`search.semanticEnabled`) and so never matched the real saved
 * shape, always reporting `false` regardless of either input.
 */
const semanticSearchCombinations: Array<{
  capability: boolean | undefined
  siteSetting: boolean | undefined
  expected: boolean
}> = [
  { capability: true, siteSetting: true, expected: true },
  { capability: true, siteSetting: false, expected: false },
  { capability: false, siteSetting: true, expected: false },
  { capability: false, siteSetting: false, expected: false }
]

for (const { capability, siteSetting, expected } of semanticSearchCombinations) {
  test(`buildSitePayload reports features.semanticSearch: ${expected} for capability=${capability}, search.config.semanticEnabled=${siteSetting}`, async () => {
    const wikiHandle = installTestWiki({
      config: { docsBase: '' },
      capabilities: { semanticSearch: capability },
      models: {
        renderQueue: { isAvailable: async () => false },
        blocks: { getSiteBlocks: async () => [] },
        navigation: { ensureSiteNav: async () => 'nav-id' }
      }
    })

    const payload = await buildSitePayload({
      id: 'site-id',
      hostname: 'example.test',
      isEnabled: true,
      config: {
        features: { browse: true },
        search: { engine: 'db', config: { semanticEnabled: siteSetting } }
      }
    })

    assert.equal(payload.features.semanticSearch, expected)
    // -> `browse` (an ordinary, directly-stored features.* key) must survive the merge unchanged --
    //    computing `semanticSearch` must not replace the rest of `features`.
    assert.equal(payload.features.browse, true)
    assert.ok(!('search' in payload), '`search` must never reach the public site payload')

    wikiHandle.restore()
  })
}

/**
 * The capability flag is absent entirely on a `WIKI` that hasn't gone through the Task #3095 boot
 * step (the default test stub, and any real instance that hasn't been rebuilt with that change yet)
 * -- must read as unavailable, not throw.
 */
test('buildSitePayload reports features.semanticSearch: false when WIKI.capabilities is entirely absent', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' }
    }
  })

  const payload = await buildSitePayload({
    id: 'site-id',
    hostname: 'example.test',
    isEnabled: true,
    config: { search: { engine: 'db', config: { semanticEnabled: true } } }
  })

  assert.equal(payload.features.semanticSearch, false)

  wikiHandle.restore()
})

/**
 * OpenProject #3137: reproduces the exact stale shape the read side used before the fix --
 * `semanticEnabled` sitting directly under `search` rather than under `search.config` -- to prove
 * `buildSitePayload` no longer reads it from there. A real saved site never has this shape (see the
 * nested-shape tests above), but this pins the read path against silently reverting.
 */
test('buildSitePayload reports features.semanticSearch: false when the setting is only present at the old, un-nested search.semanticEnabled shape', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    capabilities: { semanticSearch: true },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' }
    }
  })

  const payload = await buildSitePayload({
    id: 'site-id',
    hostname: 'example.test',
    isEnabled: true,
    config: { search: { engine: 'db', config: {}, semanticEnabled: true } }
  })

  assert.equal(payload.features.semanticSearch, false)

  wikiHandle.restore()
})
