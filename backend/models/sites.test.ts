import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
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
  migrationRecords as migrationRecordsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pageviews as pageviewsTable,
  pageWatchEvents as pageWatchEventsTable,
  sites as sitesTable,
  storage as storageTable,
  tags as tagsTable
} from '../db/schema.ts'
import { sites, siteAssetKinds } from './sites.ts'
import type { SiteAssetKind } from './sites.ts'
import { pages as pagesModel } from './pages.ts'
import type { PageActor } from './pages.ts'

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
      ratings: false,
      ratingsMode: 'off',
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

    test('init() seeds the same analytics default as createSite()', async () => {
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
import { load } from 'js-yaml'

/**
 * Regression test for the dead `kroki`/`plantuml` config surface: `base.yml`'s
 * `editors.markdown.config` carried `kroki: true` and `plantuml: true` even though nothing in the
 * codebase ever read either key — diagram rendering moved to `block-kroki`/`block-plantuml`, which
 * take their server/language settings as block props on the page, not from site-wide config. Locks
 * the keys gone so they cannot silently reappear.
 *
 * `latexEngine` was originally left alone here, out of scope for task 476's own kroki/plantuml
 * cleanup and deferred to whichever task actually owned its future (Feature 366, "Math Rendering
 * Parity & Engine Selection"). That task has since made its call -- see `base.test.ts`'s "base.yml
 * editors.markdown.config has no latexEngine key" and its own extensive `docs/variances.md` entry --
 * and removed it too, superseded by `block-katex`/`block-mathjax`'s own per-site `isEnabled` toggles.
 * Reflected here rather than left asserting the pre-Feature-366 boundary.
 */

const rootPath = path.resolve(import.meta.dirname, '../..')

test('base.yml no longer carries the dead kroki/plantuml/latexEngine markdown editor config keys', async () => {
  const raw = await readFile(path.join(rootPath, 'backend/base.yml'), 'utf8')
  const parsed = load(raw) as any
  const markdownConfig = parsed.editors.markdown.config

  assert.equal(
    'kroki' in markdownConfig,
    false,
    'base.yml should no longer define editors.markdown.config.kroki'
  )
  assert.equal(
    'plantuml' in markdownConfig,
    false,
    'base.yml should no longer define editors.markdown.config.plantuml'
  )
  assert.equal(
    'latexEngine' in markdownConfig,
    false,
    'latexEngine is dead too (superseded by block-katex/block-mathjax per-site isEnabled) -- see base.test.ts'
  )
})

test('models/sites.ts default markdown editor config still omits kroki, plantuml and latexEngine', async () => {
  const raw = await readFile(path.join(rootPath, 'backend/models/sites.ts'), 'utf8')

  // -> Both default-config object literals (site creation, and the existing-site default merge in
  // init()) write `markdown: { isActive: true, config: { ...primitives... } }` with no nested object
  // inside `config`, so the text up to the first `}` after `config: {` is exactly that block.
  const markdownConfigBlocks = [
    ...raw.matchAll(/markdown:\s*{\s*isActive:\s*true,\s*config:\s*{([^}]*)}/g)
  ]

  assert.equal(
    markdownConfigBlocks.length,
    2,
    'expected exactly two markdown default-config literals in sites.ts'
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
 */
describe('sites.deleteSite (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
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
      migrationRecordsRows,
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
      fixtures.db
        .select()
        .from(migrationRecordsTable)
        .where(eq(migrationRecordsTable.siteId, siteId)),
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
      migrationRecords: migrationRecordsRows.length,
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
    await fixtures.db.insert(migrationRecordsTable).values({
      siteId,
      sourceSystem: 'test',
      sourceTable: 'pages',
      sourceId: '1',
      destTable: 'pages',
      destId: randomUUID()
    })
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

  test('a site holding a page is refused with a 409 siteHasContent conflict, and destroys nothing', async () => {
    const siteId = await makeSite()
    await pagesModel.createPage(
      siteId,
      { path: 'home', title: 'Home', editor: 'markdown', content: '# Hello' },
      actor
    )

    await assert.rejects(sites.deleteSite(siteId), (err: any) => {
      assert.equal(err.name, 'siteHasContent')
      assert.equal(err.statusCode, 409)
      return true
    })

    const remaining = await nonContentRowCounts(siteId)
    assert.ok(remaining.storage > 0, 'storage rows must survive a refused delete')
    assert.ok(remaining.navigation > 0, 'navigation rows must survive a refused delete')
    assert.ok(remaining.commentProviders > 0, 'commentProviders rows must survive a refused delete')
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
