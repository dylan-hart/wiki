import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { detectImageMime, svgMimeType } from '../helpers/images.ts'
import {
  apiKeys as apiKeysTable,
  approvalRules as approvalRulesTable,
  assets as assetsTable,
  blockCredentials as blockCredentialsTable,
  blocks as blocksTable,
  commentProviders as commentProvidersTable,
  glossaryTerms as glossaryTermsTable,
  glossaryVersions as glossaryVersionsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pageviews as pageviewsTable,
  pageWatchEvents as pageWatchEventsTable,
  siteAssets as siteAssetsTable,
  sites as sitesTable,
  storage as storageTable,
  tags as tagsTable
} from '../db/schema.ts'
import { sites, siteAssetKinds, DEFAULT_THEME_COLORS } from './sites.ts'
import type { SiteAssetKind } from './sites.ts'
import { pages as pagesModel } from './pages.ts'
import type { PageActor } from './pages.ts'

/**
 * Task 1682: `DEFAULT_THEME_COLORS` -- what `createSite()` and `init()` both seed -- must agree with
 * the CSS defaults at `frontend/src/css/tailwind.css`'s `:root` block and `AdminTheme.vue`'s
 * `resetColors()`/`defaultConfig()`. They are the Cardinal accent (`#c14a52`) and its positive
 * (`#3f7a66`) as of the re-skin, and the chrome is Cardinal's white header band over its cooler
 * tint, both of which `HeaderNav.vue`/`NavSidebar.vue` draw in ink. Pure/no-DB: `DEFAULT_THEME_COLORS` is a plain exported constant,
 * so this runs on every `npm run test`, not just when `DATABASE_URL` is set. The frontend half of
 * this pin -- that the CSS/AdminTheme values themselves clear WCAG AA -- lives in
 * `frontend/src/helpers/accessibility.test.js`.
 */
describe('sites.DEFAULT_THEME_COLORS', () => {
  test('matches the CSS defaults (frontend/src/css/tailwind.css) exactly', () => {
    assert.deepEqual(DEFAULT_THEME_COLORS, {
      colorPrimary: '#c14a52',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })
  })
})

/**
 * Regression coverage for Task 588: `createSite()`'s default config used to carry a dead
 * `logoUrl: ''` field that `init()`'s default site config never had (confirmed by diffing the two
 * blocks — see CLAUDE.md's note on not writing fallbacks for cases that cannot occur). Logo is
 * fully handled by the `assets.logo` binary upload flow served at `/_site/:siteId/logo`; `logoUrl`
 * was never read anywhere in `frontend/`, nor accepted by the `PUT /_api/sites/:siteId` body. This
 * suite asserts the stored config a fresh site gets from `createSite()` no longer contains it, and
 * that the fields still genuinely needed continue to round-trip through the insert unchanged.
 */
describe('sites.createSite (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sitesModel: typeof import('./sites.ts').sites

  before(async () => {
    fixtures = await setupTestDb()
    ;({ sites: sitesModel } = await import('./sites.ts'))
    // -> `createSite()` reads `WIKI.data.systemIds.localAuthId` to seed the default auth strategy —
    //    real values come from `base.yml` via `core/config.ts`, neither of which the minimal test
    //    `WIKI` global in `test/db.ts` populates.
    WIKI.data.systemIds = { localAuthId: '5a528c4c-0a82-4ad2-96a5-2b23811e6588' }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('stored config has no logoUrl field, and still carries the fields the admin UI round-trips', async () => {
    const site = await sitesModel.createSite('sites-test.localhost')
    const [row] = await fixtures.db.select().from(sitesTable).where(eq(sitesTable.id, site.id))

    assert.equal(
      Object.prototype.hasOwnProperty.call(row!.config as object, 'logoUrl'),
      false,
      'createSite() default config should no longer contain the dead logoUrl field'
    )

    const config = row!.config as Record<string, any>
    assert.equal(config.title, 'My Wiki Site')
    assert.equal(config.description, '')
    assert.equal(config.company, '')
    assert.equal(config.contentLicense, '')
    assert.equal(config.footerExtra, '')
    assert.deepEqual(config.pageExtensions, ['md', 'html', 'txt'])
    assert.deepEqual(
      config.allowedUrlSchemes,
      [],
      'a fresh site should permit no additional URL schemes beyond the hardcoded defaults'
    )
    assert.equal(config.logoText, true)
    assert.equal(config.discoverable, false)
    assert.equal(config.sitemap, true)
    assert.deepEqual(config.robots, { index: true, follow: true })
    assert.deepEqual(config.uploads, { conflictBehavior: 'overwrite' })
    assert.deepEqual(config.analytics, { providers: {} })
    assert.deepEqual(config.defaults, { tocDepth: { min: 1, max: 2 } })
    assert.deepEqual(config.features, {
      browse: true,
      collaborativeEditing: true,
      comments: false,
      profile: true,
      reasonForChange: 'optional',
      search: true,
      showOtherGroups: false
    })
  })
})

/**
 * Coverage for Task 592: both `createSite()` and `init()` seed the same
 * `analytics: { providers: {} }` default — no provider is enabled out of the box, since discovery
 * (`GET /_api/analytics/modules`) is what tells the admin area which providers exist to turn on, the
 * same way a fresh site starts with `assets: { logo: false, ... }` rather than any image uploaded.
 */
describe(
  'sites default config carries analytics.providers (DB-backed)',
  {
    skip: !hasTestDatabase()
  },
  () => {
    let fixtures: TestFixtures
    let sitesModel: typeof import('./sites.ts').sites

    before(async () => {
      fixtures = await setupTestDb()
      ;({ sites: sitesModel } = await import('./sites.ts'))
      WIKI.data.systemIds = { localAuthId: '5a528c4c-0a82-4ad2-96a5-2b23811e6588' }
    })

    after(async () => {
      await teardownTestDb()
    })

    test('createSite() defaults config.analytics to an empty providers map', async () => {
      const site = await sitesModel.createSite('sites-analytics-test.localhost')
      const [row] = await fixtures.db.select().from(sitesTable).where(eq(sitesTable.id, site.id))
      assert.deepEqual((row!.config as Record<string, any>).analytics, { providers: {} })
    })

    test('createSite() defaults config.allowedUrlSchemes to an empty array', async () => {
      const site = await sitesModel.createSite('sites-allowed-url-schemes-test.localhost')
      const [row] = await fixtures.db.select().from(sitesTable).where(eq(sitesTable.id, site.id))
      assert.deepEqual((row!.config as Record<string, any>).allowedUrlSchemes, [])
    })

    test('init() seeds the same analytics and allowedUrlSchemes defaults as createSite()', async () => {
      // -> `init()` always inserts the catch-all `*` hostname, which is unique -- so this describe
      //    gets exactly one `init()` call across its tests, not one per assertion.
      const seededSiteId = randomUUID()
      await sitesModel.init({
        groupAdminId: randomUUID(),
        groupUserId: randomUUID(),
        groupGuestId: randomUUID(),
        siteId: seededSiteId,
        authModuleId: randomUUID(),
        userAdminId: randomUUID(),
        userGuestId: randomUUID(),
        classificationPublicId: randomUUID(),
        classificationInternalId: randomUUID(),
        classificationRestrictedId: randomUUID()
      })
      const [row] = await fixtures.db
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.id, seededSiteId))
      assert.deepEqual((row!.config as Record<string, any>).analytics, { providers: {} })
      assert.deepEqual((row!.config as Record<string, any>).allowedUrlSchemes, [])
    })
  }
)

/**
 * `setAsset`/`getAsset` coordinate an insert-or-update plus `updateSite`'s own
 * read-merge-update-and-reload-cache, so — per CLAUDE.md's DB-backed guidance — this runs the real
 * methods against a migrated database rather than re-describing that SQL with a query-builder mock.
 *
 * What's being verified is the no-Sharp fallback path: `helpers/images.ts#normalizeImage` returns
 * null when the Sharp extension isn't usable, and `Sites.setAsset` falls back to storing the raw
 * uploaded bytes (`?? data`) in that case. `WIKI.models.extensions.isInstalled` is stubbed to force
 * that branch on every call, so the suite is deterministic regardless of whether Sharp happens to be
 * present on the machine actually running it.
 */
describe(
  'sites setAsset/getAsset — no-Sharp fallback (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let sitesModel: typeof import('./sites.ts').sites

    before(async () => {
      fixtures = await setupTestDb()
      ;({ sites: sitesModel } = await import('./sites.ts'))
      mock.method(WIKI.models.extensions, 'isInstalled', async () => false)
    })

    after(async () => {
      mock.restoreAll()
      await teardownTestDb()
    })

    /**
     * An 8-byte PNG signature padded to `size` bytes. Sharp is forced unusable for this whole suite,
     * so `normalizeImage` bails before ever asking it to actually decode these bytes — only the
     * signature needs to be real.
     */
    function pngBuffer(size: number): Buffer {
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      return Buffer.concat([signature, Buffer.alloc(size - signature.length, 0xab)])
    }

    const svgBuffer = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    )

    /**
     * A polyglot: a valid PNG signature followed by literal `<svg>...<script>` text later in the
     * buffer. `getAsset` resolves the mime with `detectImageMime(data) ?? (detectSvg(data) ? ... :
     * ...)` — the PNG signature is checked first, so this must come back as `image/png`, never
     * `svgMimeType`. That precedence is what keeps `SVG_CSP` from being skippable by disguising an
     * SVG payload behind a raster magic number: served as `image/png` with `X-Content-Type-Options:
     * nosniff` (`controllers/site.ts`), a browser opening the URL directly trusts the declared type
     * rather than sniffing the trailing markup, so it never gets treated — or executed — as SVG.
     */
    const pngSvgPolyglot = Buffer.concat([
      pngBuffer(64),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    ])

    test('getAsset returns null for a kind that has never been uploaded', async () => {
      const asset = await sitesModel.getAsset(fixtures.siteId, 'logo')
      assert.equal(asset, null)
    })

    test('a PNG-signature/embedded-SVG polyglot round-trips as image/png, not svgMimeType', async () => {
      await sitesModel.setAsset(fixtures.siteId, 'logo', pngSvgPolyglot)
      const asset = await sitesModel.getAsset(fixtures.siteId, 'logo')

      assert.ok(asset)
      assert.equal(asset!.mime, 'image/png')
      assert.notEqual(asset!.mime, svgMimeType)
    })

    for (const kind of siteAssetKinds as readonly SiteAssetKind[]) {
      test(`${kind}: a raw PNG upload up to the 10 MB upload limit is stored and served back byte-for-byte`, async () => {
        // -> One byte under the API route's 10 MB `imageUploadLimit` (`api/sites.ts`) — `setAsset`
        //    itself enforces no size limit of its own, the ceiling is entirely the content-type
        //    parser's `bodyLimit` upstream of it.
        const upload = pngBuffer(10 * 1024 * 1024 - 1)

        await sitesModel.setAsset(fixtures.siteId, kind, upload)
        const asset = await sitesModel.getAsset(fixtures.siteId, kind)

        assert.ok(asset)
        assert.equal(asset!.mime, 'image/png')
        assert.equal(detectImageMime(asset!.data), 'image/png')
        assert.equal(asset!.data.length, upload.length)
        assert.ok(asset!.data.equals(upload), 'stored bytes must match the upload exactly')
      })

      test(`${kind}: an SVG upload is stored and served back byte-for-byte regardless of Sharp`, async () => {
        await sitesModel.setAsset(fixtures.siteId, kind, svgBuffer)
        const asset = await sitesModel.getAsset(fixtures.siteId, kind)

        assert.ok(asset)
        assert.equal(asset!.mime, svgMimeType)
        assert.ok(asset!.data.equals(svgBuffer), 'stored bytes must match the upload exactly')
      })

      test(`${kind}: clearAsset removes the row and flips config.assets.${kind} back off, so getAsset returns null again`, async () => {
        await sitesModel.setAsset(fixtures.siteId, kind, svgBuffer)
        assert.ok(await sitesModel.getAsset(fixtures.siteId, kind), 'sanity: upload landed first')

        const uploadedSite = await sitesModel.getSiteById({
          id: fixtures.siteId,
          forceReload: true
        })
        assert.equal(
          uploadedSite.config.assets?.[kind],
          true,
          'setAsset must flip the cached config flag on'
        )

        await sitesModel.clearAsset(fixtures.siteId, kind)

        const asset = await sitesModel.getAsset(fixtures.siteId, kind)
        assert.equal(asset, null, 'the row must actually be gone, not just unflagged')

        const clearedSite = await sitesModel.getSiteById({ id: fixtures.siteId, forceReload: true })
        assert.equal(
          clearedSite.config.assets?.[kind],
          false,
          'clearAsset must flip the cached config flag back off'
        )
      })
    }
  }
)

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Regression test for the dead `kroki`/`plantuml`/`latexEngine` config surface on the per-site
 * markdown editor default: diagram rendering moved to `block-kroki`/`block-plantuml`, which take
 * their server/language settings as block props on the page rather than from site-wide config, and
 * math rendering is `block-katex`/`block-mathjax`'s own per-site `isEnabled` toggles -- so none of
 * the three ever had a reader. Locks the keys gone so they cannot silently reappear.
 *
 * Since OpenProject #1991, the editors default (asciidoc/code/markdown/wysiwyg) is a single
 * `DEFAULT_SITE_EDITORS` object shared by `createSite()` and `init()` rather than duplicated
 * verbatim in both, so this asserts there is exactly one such literal in the source.
 */

const rootPath = path.resolve(import.meta.dirname, '../..')

test('models/sites.ts default markdown editor config still omits kroki, plantuml and latexEngine', async () => {
  const raw = await readFile(path.join(rootPath, 'backend/models/sites.ts'), 'utf8')

  // -> The single shared default-config literal writes `markdown: { isActive: true, config: {
  // ...primitives... } }` with no nested object inside `config`, so the text up to the first `}`
  // after `config: {` is exactly that block.
  const markdownConfigBlocks = [
    ...raw.matchAll(/markdown:\s*{\s*isActive:\s*true,\s*config:\s*{([^}]*)}/g)
  ]

  assert.equal(
    markdownConfigBlocks.length,
    1,
    'expected exactly one markdown default-config literal in sites.ts (shared DEFAULT_SITE_EDITORS)'
  )

  for (const [, body] of markdownConfigBlocks) {
    const keys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
    assert.equal(keys.includes('kroki'), false, 'sites.ts markdown config must not define kroki')
    assert.equal(
      keys.includes('plantuml'),
      false,
      'sites.ts markdown config must not define plantuml'
    )
    assert.equal(
      keys.includes('latexEngine'),
      false,
      'sites.ts markdown config must not define latexEngine'
    )
  }
})

/**
 * `models/sites.ts`'s `createSite()` and `init()` per-site default config, task #563: search
 * configuration moved from the instance-wide `WIKI.config.search` to a `search: { engine, config }`
 * block seeded alongside the other per-site defaults (`authStrategies`, `uploads`, `defaults`, ...)
 * this suite otherwise leaves untested — the seeded shape is what `models/search.ts`'s `getConfig()`
 * and `engineFor()` read back, so a wrong default here is a silent fallback everywhere else.
 */
describe('sites default config (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let sitesModel: typeof import('./sites.ts').sites

  before(async () => {
    await setupTestDb()
    ;({ sites: sitesModel } = await import('./sites.ts'))
    // -> `createSite()` reads this directly for the default `authStrategies` entry, same as the real
    //    boot sequence does through `core/config.ts`'s `initDbValues()`
    ;(globalThis as any).WIKI.data.systemIds = { localAuthId: randomUUID() }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('createSite() seeds a default db search engine with no dictionary overrides', async () => {
    const created = await sitesModel.createSite('sites-test-create.localhost')

    const site = await sitesModel.getSiteById({ id: created.id })

    assert.deepEqual(site!.config.search, {
      engine: 'db',
      config: { dictOverrides: {} }
    })
  })

  test('createSite() config argument can override the seeded search default', async () => {
    const created = await sitesModel.createSite('sites-test-create-override.localhost', {
      search: { engine: 'db', config: { dictOverrides: { en: 'english' } } }
    })

    const site = await sitesModel.getSiteById({ id: created.id })

    assert.deepEqual(site!.config.search, {
      engine: 'db',
      config: { dictOverrides: { en: 'english' } }
    })
  })

  test('init() seeds the same default search block for the first-run site', async () => {
    const siteId = randomUUID()
    await sitesModel.init({
      groupAdminId: randomUUID(),
      groupUserId: randomUUID(),
      groupGuestId: randomUUID(),
      siteId,
      authModuleId: randomUUID(),
      userAdminId: randomUUID(),
      userGuestId: randomUUID(),
      classificationPublicId: randomUUID(),
      classificationInternalId: randomUUID(),
      classificationRestrictedId: randomUUID()
    })

    const site = await sitesModel.getSiteById({ id: siteId, forceReload: true })

    assert.deepEqual(site!.config.search, {
      engine: 'db',
      config: { dictOverrides: {} }
    })
  })
})

/**
 * Regression test for task 702: `getSiteByHostname`'s precedence -- an exact hostname match beats the
 * `*` catch-all, and `strict: true` excludes the catch-all fallback entirely -- is what the
 * `api/sites.test.ts` "strict=true does not fall back" tests exercise end-to-end through a stubbed
 * copy of this same logic. This describe exercises the real model method directly instead, against a
 * fake `WIKI.sites` / `WIKI.sitesMappings` (exactly what `reloadCache` populates), with no database:
 * `getSiteByHostname` with `forceReload: false` (the default) touches nothing but those two in-memory
 * maps. Scoped to its own describe with a local before/after (rather than top-level hooks) so its fake
 * WIKI stub cannot race the DB-backed describes above, which set up their own real WIKI via
 * `setupTestDb()`.
 */
describe('sites.getSiteByHostname (in-memory cache, no DB)', () => {
  const EXACT_SITE_ID = 'exact-site-id'
  const WILDCARD_SITE_ID = 'wildcard-site-id'

  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      sites: {
        [EXACT_SITE_ID]: { id: EXACT_SITE_ID, hostname: 'wiki.example.com', isEnabled: true },
        [WILDCARD_SITE_ID]: { id: WILDCARD_SITE_ID, hostname: '*', isEnabled: true }
      },
      sitesMappings: {
        'wiki.example.com': EXACT_SITE_ID,
        '*': WILDCARD_SITE_ID
      }
    }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('an exact hostname match beats the catch-all', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'wiki.example.com' })
    assert.equal(site?.id, EXACT_SITE_ID)
  })

  test('an unmapped hostname falls back to the catch-all when not strict', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'unmapped.example.com', strict: false })
    assert.equal(site?.id, WILDCARD_SITE_ID)
  })

  test('strict: true excludes the catch-all fallback for an unmapped hostname', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'unmapped.example.com', strict: true })
    assert.equal(site, null)
  })

  test('strict: true still returns an exact match', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'wiki.example.com', strict: true })
    assert.equal(site?.id, EXACT_SITE_ID)
  })

  /**
   * OpenProject #2127: `sitesMappings` is keyed lowercase, but the hostname a lookup was given
   * used to be indexed as-is -- so `Host: Wiki.Example.Com` matched nothing here, even though a
   * DNS name is case-insensitive and the site really is stored as `wiki.example.com`.
   */
  test('a mixed-case hostname resolves to the same site as its lowercase form', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'Wiki.Example.Com' })
    assert.equal(site?.id, EXACT_SITE_ID)
  })

  test('strict: true also folds case', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'WIKI.EXAMPLE.COM', strict: true })
    assert.equal(site?.id, EXACT_SITE_ID)
  })
})

/**
 * OpenProject #2127, write-side belt and braces: the site create/update schemas already constrain
 * a stored `hostname` to lowercase, so this cannot happen through the normal API -- but
 * `reloadCache()` lowercases the key regardless of what is actually in the row, so even a
 * mixed-case hostname that somehow reached the table (a direct DB edit, a future write path that
 * forgets the schema constraint) still resolves through `getSiteByHostname`.
 */
describe(
  'sites.reloadCache hostname case-folding (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('a mixed-case hostname row is still resolvable by its lowercase form after reloadCache', async () => {
      const mixedCaseHostname = `Mixed-Case-${randomBytes(6).toString('hex')}.Example.Com`
      const [site] = await fixtures.db
        .insert(sitesTable)
        .values({ hostname: mixedCaseHostname, isEnabled: true, config: {} })
        .returning({ id: sitesTable.id })

      await sites.reloadCache()

      const resolved = await sites.getSiteByHostname({ hostname: mixedCaseHostname.toLowerCase() })
      assert.equal(resolved?.id, site!.id)

      await fixtures.db.delete(sitesTable).where(eq(sitesTable.id, site!.id))
    })
  }
)

/**
 * Regression coverage for OpenProject #1733 ("Make site deletion transactional and pre-checked, and
 * clean every non-content RESTRICT FK") and its predecessor, task 686.
 *
 * `makeSite()` goes through the real `createSite()` rather than inserting the `sites` row directly —
 * that used to be this suite's own shape (before #1737), and it hid the bug: `createSite()` calls
 * `commentProviders.syncSite()`, which seeds one row per discovered comment module, and that FK is
 * the very first one a real `deleteSite()` call hits, unconditionally, on a site with nothing else on
 * it. A raw `db.insert(sitesTable)` fixture never runs that seeding, so a suite built on one can pass
 * with `deleteSite()` still broken. `commentProviders.refreshFromDisk()` / `storage.refreshFromDisk()`
 * in `before()` load the real module definitions off disk — the same ones a real boot would — since
 * `setupTestDb()`'s minimal `WIKI` global otherwise leaves both empty.
 *
 * Since #990 (locale-scoped site menus), `ensureSiteNav`'s row is addressed by its own
 * `defaultRandom()` `id` and by the `siteId` column the FK constraint actually checks — `id` is
 * never `= siteId`. Every assertion below is against `siteId`, not `id`, for exactly that reason
 * (OpenProject #1046): querying `eq(navigationTable.id, siteId)` would return zero rows whether or
 * not `deleteSite` ever ran, since a random nav-row id practically never collides with a site id —
 * that query would pass even if `deleteSite` had never been fixed at all.
 *
 * OpenProject #1741: `deleteSite` used to issue six unconditional deletes (blocks, block credentials,
 * storage, site assets, glossary terms, navigation) with nothing wrapping them, before ever finding
 * out whether the site's final delete would even succeed — so a refusal (a page, asset, pageview or
 * tag still referencing the site) left every one of those six torn down anyway, autocommitted one
 * statement at a time, while the site itself survived. The "still holds a page" case below is the
 * regression test for the fix: it seeds one row in every one of those six non-content tables, asserts
 * the refusal is now a precheck (a `siteHasContent` error, not a raw `23503`) rather than a
 * partially-destructive FK failure, and then asserts all six rows are still there afterwards.
 */
describe('sites.deleteSite (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    // -> `createSite()` reads `WIKI.data.systemIds.localAuthId` to seed the default auth strategy —
    //    real values come from `base.yml` via `core/config.ts`, neither of which the minimal test
    //    `WIKI` global in `test/db.ts` populates. Only the cases below that call `createSite()` need
    //    this; `makeSite()`'s direct insert doesn't.
    WIKI.data.systemIds = { localAuthId: randomUUID() }
    await WIKI.models.commentProviders.refreshFromDisk()
    await WIKI.models.storage.refreshFromDisk()
  })

  after(async () => {
    await teardownTestDb()
  })

  async function makeSite(): Promise<string> {
    const hostname = `test-${randomBytes(6).toString('hex')}.localhost`
    const site = await sites.createSite(hostname)
    return site.id
  }

  /** Row counts for every non-content table `deleteSite()`'s transaction is responsible for, keyed
   *  by `siteId` — used both to prove a refused delete destroyed nothing and that a successful one
   *  left nothing behind. */
  async function nonContentRowCounts(siteId: string) {
    const [
      blocksRows,
      blockCredentialsRows,
      storageRows,
      glossaryTermsRows,
      navigationRows,
      commentProvidersRows,
      pageHistoryRows,
      pageWatchEventsRows,
      glossaryVersionsRows,
      approvalRulesRows,
      apiKeysRows,
      tagsRows
    ] = await Promise.all([
      fixtures.db.select().from(blocksTable).where(eq(blocksTable.siteId, siteId)),
      fixtures.db
        .select()
        .from(blockCredentialsTable)
        .where(eq(blockCredentialsTable.siteId, siteId)),
      fixtures.db.select().from(storageTable).where(eq(storageTable.siteId, siteId)),
      fixtures.db.select().from(glossaryTermsTable).where(eq(glossaryTermsTable.siteId, siteId)),
      fixtures.db.select().from(navigationTable).where(eq(navigationTable.siteId, siteId)),
      fixtures.db
        .select()
        .from(commentProvidersTable)
        .where(eq(commentProvidersTable.siteId, siteId)),
      fixtures.db.select().from(pageHistoryTable).where(eq(pageHistoryTable.siteId, siteId)),
      fixtures.db
        .select()
        .from(pageWatchEventsTable)
        .where(eq(pageWatchEventsTable.siteId, siteId)),
      fixtures.db
        .select()
        .from(glossaryVersionsTable)
        .where(eq(glossaryVersionsTable.siteId, siteId)),
      fixtures.db.select().from(approvalRulesTable).where(eq(approvalRulesTable.siteId, siteId)),
      fixtures.db.select().from(apiKeysTable).where(eq(apiKeysTable.siteId, siteId)),
      fixtures.db.select().from(tagsTable).where(eq(tagsTable.siteId, siteId))
    ])
    return {
      blocks: blocksRows.length,
      blockCredentials: blockCredentialsRows.length,
      storage: storageRows.length,
      glossaryTerms: glossaryTermsRows.length,
      navigation: navigationRows.length,
      commentProviders: commentProvidersRows.length,
      pageHistory: pageHistoryRows.length,
      pageWatchEvents: pageWatchEventsRows.length,
      glossaryVersions: glossaryVersionsRows.length,
      approvalRules: approvalRulesRows.length,
      apiKeys: apiKeysRows.length,
      tags: tagsRows.length
    }
  }

  test('a freshly created site with no pages deletes cleanly, cleaning up every non-content row', async () => {
    const siteId = await makeSite()

    // -> Sanity: createSite() really did seed rows that need cleaning up — otherwise every assertion
    //    below would pass vacuously, exactly the #1737 failure mode this suite exists to avoid.
    const seeded = await nonContentRowCounts(siteId)
    assert.ok(seeded.commentProviders > 0, 'sanity: createSite() should seed commentProviders rows')
    assert.ok(seeded.storage > 0, 'sanity: createSite() should seed storage rows')
    assert.ok(seeded.navigation > 0, 'sanity: createSite() should seed a root navigation row')

    // -> Rows nothing seeds automatically, standing in for the non-content tables that have no
    //    delete call site at all (see `deleteSite()`'s own doc comment) — planted directly, matching
    //    this suite's existing convention for setup that has no dedicated model method.
    await fixtures.db.insert(glossaryVersionsTable).values({ siteId, snapshot: {}, termCount: 0 })
    await fixtures.db.insert(approvalRulesTable).values({ siteId })
    await fixtures.db.insert(pageWatchEventsTable).values({
      siteId,
      action: 'edited',
      pageId: randomUUID(),
      pageTitle: 'Test',
      pagePath: 'test',
      userId: fixtures.userId,
      notifyMode: 'immediate'
    })
    await fixtures.db
      .insert(apiKeysTable)
      .values({ name: 'site key', keyShort: 'abcd1234', siteId })
    // -> A tag left over from a page that's since been removed: `tags` carries no `pageId` FK, so
    //    nothing about deleting a page ever cleans this up on its own (OpenProject #1749).
    await fixtures.db.insert(tagsTable).values({ siteId, tag: 'orphaned' })

    const deleted = await sites.deleteSite(siteId)
    assert.equal(deleted, true)

    const remaining = await nonContentRowCounts(siteId)
    for (const [table, count] of Object.entries(remaining)) {
      assert.equal(count, 0, `expected no remaining ${table} rows after deleteSite`)
    }
  })

  test('create page, delete page, then delete the site succeeds (pageHistory no longer blocks it)', async () => {
    const siteId = await makeSite()
    const page = await pagesModel.createPage(
      siteId,
      { path: 'home', title: 'Home', editor: 'markdown', content: '# Hello' },
      actor
    )
    await pagesModel.deletePage(siteId, page.id, actor)

    const historyBefore = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, siteId))
    assert.ok(
      historyBefore.length > 0,
      'sanity: deletePage() should have written a deleted pageHistory row'
    )

    const deleted = await sites.deleteSite(siteId)
    assert.equal(deleted, true)

    const historyAfter = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, siteId))
    assert.equal(historyAfter.length, 0)
  })

  /**
   * `pageviews.pageId` already cascades from `pages.id` (`db/schema.ts`), so a pageview row is
   * always gone by the time its own page is — the `pageviews.siteId` cascade #1749 added is defense
   * in depth for the schema's own shape, not something a leftover row can be observed through here.
   * What this proves end to end is the realistic sequence: a page gets viewed, then deleted, then the
   * now-empty site deletes cleanly with nothing left pinning it.
   */
  test('a page view recorded against a page does not survive that page, or block deleting the site', async () => {
    const siteId = await makeSite()
    const page = await pagesModel.createPage(
      siteId,
      { path: 'viewed', title: 'Viewed', editor: 'markdown', content: '# Hi' },
      actor
    )
    await fixtures.db.insert(pageviewsTable).values({
      siteId,
      pageId: page.id,
      clientType: 'browser',
      visitorHash: 'test-visitor-hash'
    })
    await pagesModel.deletePage(siteId, page.id, actor)

    const deleted = await sites.deleteSite(siteId)
    assert.equal(deleted, true)
  })

  test('a site holding a page is refused up front, and its non-content rows survive', async () => {
    const siteId = await makeSite()
    await pagesModel.createPage(
      siteId,
      { path: 'home', title: 'Home', editor: 'markdown', content: '# Hello' },
      actor
    )

    // -> One row in every table `deleteSite` unconditionally tears down, so a refusal that still let
    //    them through would be caught here.
    await fixtures.db.insert(blocksTable).values({
      block: 'markdown',
      name: 'Test Block',
      description: '',
      icon: 'mdi:cube',
      siteId
    })
    await fixtures.db.insert(blockCredentialsTable).values({
      siteId,
      name: 'Test Credential',
      secret: 'shh'
    })
    // -> No manual insert here: `makeSite()` -> `createSite()` -> `storage.syncSite()` already seeded
    //    one row per discovered storage module (`refreshFromDisk()` in `before()` above), so a fixed
    //    row count below asserts `> 0`, not a specific number that depends on how many modules exist.
    await fixtures.db
      .insert(siteAssetsTable)
      .values({ siteId, kind: 'logo', data: Buffer.from('fake-logo'), hash: 'fake-hash' })
    await fixtures.db.insert(glossaryTermsTable).values({
      term: 'Test Term',
      definition: 'A term used only by this test.',
      siteId
    })

    await assert.rejects(sites.deleteSite(siteId), (err: any) => {
      assert.equal(err.name, 'siteHasContent')
      assert.equal(err.statusCode, 409)
      return true
    })

    const [blocksLeft, credsLeft, storageLeft, assetsLeft, glossaryLeft, navLeft] =
      await Promise.all([
        fixtures.db.select().from(blocksTable).where(eq(blocksTable.siteId, siteId)),
        fixtures.db
          .select()
          .from(blockCredentialsTable)
          .where(eq(blockCredentialsTable.siteId, siteId)),
        fixtures.db.select().from(storageTable).where(eq(storageTable.siteId, siteId)),
        fixtures.db.select().from(siteAssetsTable).where(eq(siteAssetsTable.siteId, siteId)),
        fixtures.db.select().from(glossaryTermsTable).where(eq(glossaryTermsTable.siteId, siteId)),
        fixtures.db.select().from(navigationTable).where(eq(navigationTable.siteId, siteId))
      ])
    assert.equal(blocksLeft.length, 1, 'blocks row should survive a refused delete')
    assert.equal(credsLeft.length, 1, 'blockCredentials row should survive a refused delete')
    assert.ok(storageLeft.length > 0, 'storage rows should survive a refused delete')
    assert.equal(assetsLeft.length, 1, 'siteAssets row should survive a refused delete')
    assert.equal(glossaryLeft.length, 1, 'glossaryTerms row should survive a refused delete')
    assert.equal(navLeft.length, 1, 'navigation row should survive a refused delete')
  })

  test('a site holding only an asset (no pages) is also refused', async () => {
    const siteId = await makeSite()
    await fixtures.db.insert(assetsTable).values({
      fileName: 'file',
      fileExt: 'png',
      authorId: fixtures.userId,
      siteId
    })

    await assert.rejects(sites.deleteSite(siteId), (err: any) => {
      assert.equal(err.name, 'siteHasContent')
      assert.equal(err.statusCode, 409)
      return true
    })

    const remainingAssets = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.siteId, siteId))
    assert.equal(remainingAssets.length, 1, 'the asset must survive a refused delete')
  })

  /**
   * OpenProject #1744: `deleteSite()` used to clean only six site-owned tables, on the theory that
   * everything else left standing was content the route deliberately blocks on. That theory failed
   * for six non-content tables whose rows outlive the content they describe (`commentProviders`,
   * seeded per site by `createSite()`'s `commentProviders.syncSite()`, being the most immediate —
   * it blocked even a brand-new, otherwise-empty site) or that content routes were never meant to
   * guard at all (`glossaryVersions`, `pageWatchEvents`, `approvalRules`).
   * `tags` is deliberately NOT among them: OpenProject #1741's precheck already treats it as content
   * (alongside pages, assets and pageviews) and refuses the delete up front while a tag still
   * references the site, so a leftover tag row is covered by the "refused up front" test above, not
   * this one. Going through `sites.createSite()` rather than the `makeSite()` helper above is
   * deliberate: only `createSite()` seeds the `commentProviders` rows that made the delete fail
   * unconditionally.
   */
  test('a site created via createSite(), with a page created and deleted, deletes cleanly with every extended-cleanup table left empty', async () => {
    const hostname = `full-cleanup-${randomBytes(6).toString('hex')}.localhost`
    const site = await sites.createSite(hostname)
    const siteId = site.id

    const page = await pagesModel.createPage(
      siteId,
      {
        path: 'home',
        title: 'Home',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    await pagesModel.deletePage(siteId, page.id, actor)

    // -> `commentProviders` (seeded above by `createSite()`) and `pageHistory` (written above by
    //    `deletePage()`) are populated through the real app flow; the other four have no such call
    //    site under test, so they're seeded directly to prove the cleanup covers them too.
    await fixtures.db.insert(glossaryVersionsTable).values({ siteId, snapshot: {}, termCount: 0 })
    await fixtures.db.insert(approvalRulesTable).values({ siteId })
    await fixtures.db.insert(pageWatchEventsTable).values({
      action: 'updated',
      pageId: randomUUID(),
      pageTitle: 'Home',
      pagePath: 'home',
      siteId,
      userId: fixtures.userId,
      notifyMode: 'immediate'
    })

    const deleted = await sites.deleteSite(siteId)
    assert.equal(deleted, true)

    const remainingCommentProviders = await fixtures.db
      .select({ id: commentProvidersTable.id })
      .from(commentProvidersTable)
      .where(eq(commentProvidersTable.siteId, siteId))
    assert.equal(remainingCommentProviders.length, 0)

    const remainingPageHistory = await fixtures.db
      .select({ id: pageHistoryTable.id })
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, siteId))
    assert.equal(remainingPageHistory.length, 0)

    const remainingGlossaryVersions = await fixtures.db
      .select({ id: glossaryVersionsTable.id })
      .from(glossaryVersionsTable)
      .where(eq(glossaryVersionsTable.siteId, siteId))
    assert.equal(remainingGlossaryVersions.length, 0)

    const remainingPageWatchEvents = await fixtures.db
      .select({ id: pageWatchEventsTable.id })
      .from(pageWatchEventsTable)
      .where(eq(pageWatchEventsTable.siteId, siteId))
    assert.equal(remainingPageWatchEvents.length, 0)

    const remainingApprovalRules = await fixtures.db
      .select({ id: approvalRulesTable.id })
      .from(approvalRulesTable)
      .where(eq(approvalRulesTable.siteId, siteId))
    assert.equal(remainingApprovalRules.length, 0)
  })
})

/**
 * OpenProject #966: same fix, and the same reasoning, as `models/groups.ts`'s
 * `groups.broadcastReload` suite — `createSite`/`updateSite`/`deleteSite` used to call
 * `reloadCache()` directly, refreshing only this instance's own cache. See that suite's doc comment
 * for the full writeup; this one just re-proves the wiring for the sites model.
 */
describe('sites.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
    WIKI.data.systemIds = { localAuthId: '5a528c4c-0a82-4ad2-96a5-2b23811e6588' }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('createSite broadcasts reloadSites after refreshing this instance', async () => {
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await sites.createSite(`broadcast-create-${randomBytes(6).toString('hex')}.localhost`)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadSites'))
  })

  test('updateSite broadcasts reloadSites after refreshing this instance', async () => {
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await sites.updateSite(fixtures.siteId, { isEnabled: false })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadSites'))
  })

  test('deleteSite broadcasts reloadSites after refreshing this instance', async () => {
    // -> Inserted directly rather than through `createSite()` (which also seeds a root navigation
    //    row, comment providers, storage, ...) — `deleteSite()` cleans all of that up fine now
    //    (OpenProject #1733), this is just kept minimal so the test isolates exactly what it's meant
    //    to check: the broadcast, not the cleanup that `sites.deleteSite (DB-backed)` above already
    //    covers.
    const hostname = `broadcast-delete-${randomBytes(6).toString('hex')}.localhost`
    const [created] = await fixtures.db
      .insert(sitesTable)
      .values({ hostname, isEnabled: true, config: { locales: { primary: 'en' } } })
      .returning({ id: sitesTable.id })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await sites.deleteSite(created!.id)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadSites'))
  })

  test('subscribeToEvents wires the inbound reloadSites event to reloadCache', async () => {
    let reloaded = false
    const originalReloadCache = sites.reloadCache.bind(sites)
    sites.reloadCache = async () => {
      reloaded = true
      await originalReloadCache()
    }
    try {
      sites.subscribeToEvents()
      const onCalls = (WIKI.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadSites')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadSites handler')
      await handler()
      assert.equal(reloaded, true)
    } finally {
      sites.reloadCache = originalReloadCache
    }
  })
})

/**
 * OpenProject #2140: `reloadCache()` used to key `WIKI.sitesMappings` exactly as `hostname` was
 * stored, and every lookup indexed it with `req.hostname` exactly as received — so a client or proxy
 * that preserved `Host` case (`Wiki.Example.Com`) missed a site stored as `wiki.example.com` and fell
 * through to the catch-all, or to not-found with none configured. Both sides now go through
 * `normalizeHostname()` (`helpers/siteResolution.ts`). No `WIKI.db`/database needed for any of this: each
 * test installs its own minimal `WIKI` stub, restored afterward.
 */
describe('sites hostname normalization (pure unit)', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('reloadCache lowercases sitesMappings keys', async () => {
    ;(globalThis as any).WIKI = {
      db: {
        select: () => ({
          from: () => ({
            orderBy: async () => [
              { id: 'site-1', hostname: 'Wiki.Example.Com', isEnabled: true },
              { id: 'site-2', hostname: 'other.example.com', isEnabled: false }
            ]
          })
        })
      },
      logger: { info: () => {}, debug: () => {} },
      sites: {},
      sitesMappings: {}
    }

    await sites.reloadCache()

    assert.deepEqual(Object.keys((globalThis as any).WIKI.sitesMappings).sort(), [
      'other.example.com',
      'wiki.example.com'
    ])
    assert.equal((globalThis as any).WIKI.sitesMappings['wiki.example.com'], 'site-1')
    assert.equal((globalThis as any).WIKI.sitesMappings['other.example.com'], 'site-2')
  })

  test('a mixed-case hostname resolves to the same site as its lowercase form, including a disabled site', async () => {
    ;(globalThis as any).WIKI = {
      sitesMappings: {
        'wiki.example.com': 'site-1',
        'disabled.example.com': 'site-2',
        '*': 'catch-all-site'
      },
      sites: {
        'site-1': { id: 'site-1', isEnabled: true },
        'site-2': { id: 'site-2', isEnabled: false },
        'catch-all-site': { id: 'catch-all-site', isEnabled: true }
      }
    }

    const lower = await sites.getSiteByHostname({ hostname: 'wiki.example.com' })
    const mixed = await sites.getSiteByHostname({ hostname: 'Wiki.Example.Com' })
    assert.deepEqual(mixed, lower)
    assert.equal(mixed!.id, 'site-1')

    // -> The disabled branch: a mixed-case hostname for a disabled site must resolve to that site
    //    itself (so the caller can answer "disabled"), not fall through to the catch-all.
    const disabledLower = await sites.getSiteByHostname({ hostname: 'disabled.example.com' })
    const disabledMixed = await sites.getSiteByHostname({ hostname: 'Disabled.Example.Com' })
    assert.deepEqual(disabledMixed, disabledLower)
    assert.equal(disabledMixed!.id, 'site-2')
    assert.equal(disabledMixed!.isEnabled, false)
  })

  test('an unknown hostname still falls through to the catch-all site, case notwithstanding', async () => {
    ;(globalThis as any).WIKI = {
      sitesMappings: {
        'wiki.example.com': 'site-1',
        '*': 'catch-all-site'
      },
      sites: {
        'site-1': { id: 'site-1', isEnabled: true },
        'catch-all-site': { id: 'catch-all-site', isEnabled: true }
      }
    }

    const result = await sites.getSiteByHostname({ hostname: 'Unknown.Example.Com' })
    assert.equal(result!.id, 'catch-all-site')
  })

  test('an unknown hostname with no catch-all resolves to null', async () => {
    ;(globalThis as any).WIKI = {
      sitesMappings: {
        'wiki.example.com': 'site-1'
      },
      sites: {
        'site-1': { id: 'site-1', isEnabled: true }
      }
    }

    const result = await sites.getSiteByHostname({ hostname: 'Unknown.Example.Com' })
    assert.equal(result, null)
  })
})

/**
 * OpenProject #1849: `setAsset` writes the sha1 of the exact (normalized-or-raw) bytes it stores, and
 * `getAssetHash` reads it back without touching `data`. This round-trips the real write path against
 * a migrated database rather than re-describing its SQL.
 */
describe('sites.setAsset / getAssetHash (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sitesModel: typeof import('./sites.ts').sites

  before(async () => {
    fixtures = await setupTestDb()
    ;({ sites: sitesModel } = await import('./sites.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('getAssetHash returns null for a kind that has never been uploaded', async () => {
    assert.equal(await sitesModel.getAssetHash(fixtures.siteId, 'logo'), null)
  })

  test('setAsset stores a hash equal to the sha1 of the bytes getAsset later returns', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    )
    await sitesModel.setAsset(fixtures.siteId, 'logo', svg)

    const asset = await sitesModel.getAsset(fixtures.siteId, 'logo')
    const hash = await sitesModel.getAssetHash(fixtures.siteId, 'logo')

    assert.ok(asset)
    const expected = createHash('sha1').update(asset!.data).digest('hex')
    assert.equal(hash, expected)
  })

  test('re-uploading different bytes changes the hash', async () => {
    const svgOne = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    )
    const svgTwo = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="10"/></svg>'
    )
    await sitesModel.setAsset(fixtures.siteId, 'favicon', svgOne)
    const firstHash = await sitesModel.getAssetHash(fixtures.siteId, 'favicon')

    await sitesModel.setAsset(fixtures.siteId, 'favicon', svgTwo)
    const secondHash = await sitesModel.getAssetHash(fixtures.siteId, 'favicon')

    assert.notEqual(firstHash, secondHash)
    const asset = await sitesModel.getAsset(fixtures.siteId, 'favicon')
    assert.equal(secondHash, createHash('sha1').update(asset!.data).digest('hex'))
  })

  test('clearAsset leaves getAssetHash returning null again', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    )
    await sitesModel.setAsset(fixtures.siteId, 'loginBg', svg)
    assert.ok(
      await sitesModel.getAssetHash(fixtures.siteId, 'loginBg'),
      'sanity: upload landed first'
    )

    await sitesModel.clearAsset(fixtures.siteId, 'loginBg')

    assert.equal(await sitesModel.getAssetHash(fixtures.siteId, 'loginBg'), null)
  })
})

/**
 * OpenProject #1849: `getAssetHash` exists specifically so a conditional site-asset request never
 * pulls the blob out of the database. A real Postgres round trip only proves the returned value is
 * correct, not that the column list sent to it actually shrank — so this spies on `WIKI.db.select`
 * instead, following the precedent set by `models/pages.test.ts`'s `getPage selection (pure unit,
 * OpenProject #1834)` describe block.
 */
describe('getAssetHash selection (pure unit, OpenProject #1849)', () => {
  let previousWiki: typeof globalThis.WIKI

  function stubSelect(row?: Record<string, unknown>) {
    const calls: Record<string, unknown>[] = []
    const chain: any = {}
    chain.from = mock.fn(() => chain)
    chain.where = mock.fn(() => chain)
    chain.limit = mock.fn(async () => (row ? [row] : []))
    const select = mock.fn((config: Record<string, unknown>) => {
      calls.push(config)
      return chain
    })
    return { select, calls }
  }

  beforeEach(() => {
    previousWiki = globalThis.WIKI
  })

  afterEach(() => {
    globalThis.WIKI = previousWiki
  })

  test('the emitted selection asks only for hash, never data', async () => {
    const { select, calls } = stubSelect({ hash: 'deadbeef' })
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { sites: sitesModel } = await import('./sites.ts')

    const hash = await sitesModel.getAssetHash('site-1', 'logo')

    assert.equal(hash, 'deadbeef')
    assert.equal(calls.length, 1)
    const selectedKeys = Object.keys(calls[0]!)
    assert.deepEqual(selectedKeys, ['hash'])
  })

  test('returns null rather than throwing when no row matches', async () => {
    const { select } = stubSelect(undefined)
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { sites: sitesModel } = await import('./sites.ts')

    assert.equal(await sitesModel.getAssetHash('site-1', 'logo'), null)
  })
})
