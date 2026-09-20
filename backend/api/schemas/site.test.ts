import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastify from 'fastify'
import { registerSchemas } from './site.ts'
import { buildSitePayload } from '../sites.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * An editor missing from the `Site` schema's `editors` is silently dropped by Fastify's schema-based
 * serialization, so the admin UI could never see it turned on for a site.
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
 * A site's `config.search` holds the active search engine's credentials (Algolia's `apiKey`, Azure
 * AI Search's `adminApiKey`), and `buildSitePayload` is the body of `publicAccess: true` routes, so
 * it must never be echoed back whatever the `Site` schema declares. Asserts the full key set, not
 * just `search`'s absence, so the allow-list cannot drift silently out of step with the schema.
 */
test('buildSitePayload returns exactly the allow-listed keys and never `search`', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: 'https://test.docs.example/docs', replication: { isEnabled: true } },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' },
      commentProviders: { getActiveProvider: async () => null }
    }
  })

  const payload = await buildSitePayload(
    {
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
        search: {
          engine: 'algolia',
          config: {
            engines: { algolia: { apiKey: 'super-secret-algolia-key' } }
          }
        }
      }
    },
    { protocol: 'https', hostname: 'example.test' }
  )

  assert.deepEqual(Object.keys(payload).sort(), [
    'allowedUrlSchemes',
    'analytics',
    'assets',
    'auth',
    'authStrategies',
    'blocksConfig',
    'blocksIndex',
    'commentsProvider',
    'company',
    'contentLicense',
    'defaults',
    'description',
    'discoverable',
    'docsBase',
    'editors',
    'features',
    'footerExtra',
    'guestsMayViewProfiles',
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
    'isReplicationEnabled should reflect CARDINAL.config.replication.isEnabled'
  )
  assert.deepEqual(payload.security, { embedAllowedOrigins: ['https://intranet.example.com'] })
  assert.equal(
    payload.commentsProvider,
    null,
    'commentsProvider must be null when no active provider is a codeTemplate one'
  )

  wikiHandle.restore()
})

test('buildSitePayload populates commentsProvider from the active codeTemplate provider and the request origin', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' },
      commentProviders: {
        getActiveProvider: async () => ({
          module: 'disqus',
          title: 'Disqus',
          codeTemplate: true,
          config: { accountName: 'my-shortname' }
        })
      }
    }
  })

  const payload = await buildSitePayload(
    { id: 'site-id', hostname: 'example.test', isEnabled: true, config: {} },
    { protocol: 'https', hostname: 'wiki.example.org' }
  )

  assert.deepEqual(payload.commentsProvider, {
    module: 'disqus',
    title: 'Disqus',
    config: { accountName: 'my-shortname' },
    origin: 'https://wiki.example.org'
  })

  wikiHandle.restore()
})

test('buildSitePayload reports commentsProvider: null when the active provider is not a codeTemplate one', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' },
      commentProviders: {
        getActiveProvider: async () => ({
          module: 'default',
          title: 'Cardinal.js Native',
          codeTemplate: false,
          config: {}
        })
      }
    }
  })

  const payload = await buildSitePayload(
    { id: 'site-id', hostname: 'example.test', isEnabled: true, config: {} },
    { protocol: 'https', hostname: 'wiki.example.org' }
  )

  assert.equal(payload.commentsProvider, null)

  wikiHandle.restore()
})

test('buildSitePayload reports isReplicationEnabled: false when replication config is absent', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' },
      commentProviders: { getActiveProvider: async () => null }
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

test('buildSitePayload reports guestsMayViewProfiles from profileVisibility, false when absent', async () => {
  for (const [profileVisibility, expected] of [
    [{ forcedPublicFields: [], guestsMayView: true }, true],
    [{ forcedPublicFields: [], guestsMayView: false }, false],
    [undefined, false]
  ] as const) {
    const wikiHandle = installTestWiki({
      config: { docsBase: '', profileVisibility },
      models: {
        renderQueue: { isAvailable: async () => false },
        blocks: { getSiteBlocks: async () => [] },
        navigation: { ensureSiteNav: async () => 'nav-id' },
        commentProviders: { getActiveProvider: async () => null }
      }
    })

    const payload = await buildSitePayload({
      id: 'site-id',
      hostname: 'example.test',
      isEnabled: true,
      config: {}
    })

    assert.equal(payload.guestsMayViewProfiles, expected)

    wikiHandle.restore()
  }
})

/**
 * `semanticEnabled` sits under `search.config` because that is where `api/search.ts`'s PATCH handler
 * saves it and `models/search.ts#getConfig()` reads it back.
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
        navigation: { ensureSiteNav: async () => 'nav-id' },
        commentProviders: { getActiveProvider: async () => null }
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
    // -> Computing `semanticSearch` must not replace the rest of `features`.
    assert.equal(payload.features.browse, true)
    assert.ok(!('search' in payload), '`search` must never reach the public site payload')

    wikiHandle.restore()
  })
}

test('buildSitePayload reports features.semanticSearch: false when CARDINAL.capabilities is entirely absent', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' },
      commentProviders: { getActiveProvider: async () => null }
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

/** A real saved site never has this shape; this pins the read path against reverting to it. */
test('buildSitePayload reports features.semanticSearch: false when the setting is only present at the old, un-nested search.semanticEnabled shape', async () => {
  const wikiHandle = installTestWiki({
    config: { docsBase: '' },
    capabilities: { semanticSearch: true },
    models: {
      renderQueue: { isAvailable: async () => false },
      blocks: { getSiteBlocks: async () => [] },
      navigation: { ensureSiteNav: async () => 'nav-id' },
      commentProviders: { getActiveProvider: async () => null }
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
