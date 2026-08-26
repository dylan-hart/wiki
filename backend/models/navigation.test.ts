import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
import {
  navigation as navigationTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'
import { NAVIGATION_MODES, type NavigationItem, type NavigationMode } from './navigation.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * `listOverrides` is a flat, indexed scan against `tree` — no ltree ancestry logic to mock, so this
 * runs the real method against a migrated, per-run-fresh database (see `test/db.ts`), the same
 * approach `models/pages.test.ts` takes for its own SQL-orchestration-heavy paths.
 */
describe('navigation listOverrides (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  test('an entry left on inherit does not show up', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'still-inheriting', title: 'Still Inheriting' }),
      actor
    )

    const overrides = await navigationModel.listOverrides(fixtures.siteId)
    assert.deepEqual(
      overrides.filter((o) => o.title === 'Still Inheriting'),
      []
    )
  })

  test('overriding a page via updateNavigation makes it show up, ordered by folderPath/fileName', async () => {
    const zebra = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'zebra', title: 'Zebra' }),
      actor
    )
    const alpha = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'alpha', title: 'Alpha' }),
      actor
    )

    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: zebra.id,
      mode: 'override'
    })
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: alpha.id,
      mode: 'hide'
    })

    const overrides = await navigationModel.listOverrides(fixtures.siteId)
    const relevant = overrides.filter((o) => ['Alpha', 'Zebra'].includes(o.title))

    // -> Both at the site root (empty folderPath), so ordering falls through to fileName: alpha before
    //    zebra
    assert.deepEqual(
      relevant.map((o) => o.title),
      ['Alpha', 'Zebra']
    )

    const alphaRow = relevant.find((o) => o.title === 'Alpha')!
    assert.equal(alphaRow.type, 'page')
    assert.equal(alphaRow.folderPath, '')
    assert.equal(alphaRow.fileName, 'alpha')
    assert.equal(alphaRow.locale, 'en')
    assert.equal(alphaRow.navigationMode, 'hide')
    assert.equal(alphaRow.navigationId, null)

    const zebraRow = relevant.find((o) => o.title === 'Zebra')!
    assert.equal(zebraRow.navigationMode, 'override')
    assert.equal(zebraRow.navigationId, zebra.id)
  })

  test('a folder entry overriding navigation shows up too', async () => {
    const folderId = crypto.randomUUID()
    await WIKI.db.insert(treeTable).values({
      id: folderId,
      folderPath: '',
      fileName: 'reference-folder',
      hash: generatePathHash('reference-folder'),
      type: 'folder',
      locale: 'en',
      title: 'Reference Folder',
      navigationMode: 'overrideExact',
      siteId: fixtures.siteId
    })

    const overrides = await navigationModel.listOverrides(fixtures.siteId)
    const folderRow = overrides.find((o) => o.id === folderId)
    assert.ok(folderRow)
    assert.equal(folderRow!.type, 'folder')
    assert.equal(folderRow!.navigationMode, 'overrideExact')
  })

  test('locale filters the list to one locale', async () => {
    const frPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'locale-page', title: 'Locale Page', locale: 'fr' }),
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: frPage.id,
      mode: 'override'
    })

    const frOnly = await navigationModel.listOverrides(fixtures.siteId, { locale: 'fr' })
    assert.ok(frOnly.some((o) => o.id === frPage.id))

    const enOnly = await navigationModel.listOverrides(fixtures.siteId, { locale: 'en' })
    assert.ok(!enOnly.some((o) => o.id === frPage.id))
  })
})

/**
 * `setNavItems` is what the admin-launched editor (Task 433) saves against: unlike
 * `updateNavigation`, it writes straight to a navigation row by id, with no page/mode resolution --
 * the caller (AdminNavigation.vue) already knows which row it means, either a site-wide default's own
 * row id (from `ensureSiteNav`) or an override's own `navigationId` from `listOverrides`.
 */
describe('navigation setNavItems (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('writes to the site-wide default menu, addressed by its own row id', async () => {
    const items = [{ id: 'a', type: 'link' as const, label: 'Home', target: '/' }]

    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    // -> The row is a real, freshly-generated id -- not the site id it belongs to
    assert.notEqual(siteNavId, fixtures.siteId)

    await navigationModel.setNavItems(fixtures.siteId, siteNavId, items)

    const stored = await navigationModel.getNav(fixtures.siteId, siteNavId, { unfiltered: true })
    assert.deepEqual(stored, items)
  })

  test("writes to an override tree entry's own navigation row", async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'set-nav-items-page',
        title: 'Set Nav Items Page',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override'
    })

    const items = [{ id: 'b', type: 'header' as const, label: 'Section' }]
    await navigationModel.setNavItems(fixtures.siteId, page.id, items)

    const stored = await navigationModel.getNav(fixtures.siteId, page.id, { unfiltered: true })
    assert.deepEqual(stored, items)
  })

  test('rejects a navId that names neither an existing menu row of this site nor a tree entry in it', async () => {
    await assert.rejects(
      () => navigationModel.setNavItems(fixtures.siteId, crypto.randomUUID(), []),
      /does not exist/
    )
  })
})

/**
 * `copyNav` is what a "copy from locale"/cross-site copy button saves against: unlike `setNavItems`,
 * it reads a whole source menu and writes cloned items onto a target, rather than items the caller
 * already assembled itself.
 */
describe('navigation copyNav (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('replace overwrites the target items with clones of the source, each with a fresh id', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')

    const sourceItems = [
      {
        id: 'source-parent',
        type: 'link' as const,
        label: 'Parent',
        target: '/parent',
        visibilityGroups: [fixtures.groupId],
        children: [{ id: 'source-child', type: 'link' as const, label: 'Child', target: '/child' }]
      }
    ]
    await navigationModel.setNavItems(fixtures.siteId, sourceId, sourceItems)
    await navigationModel.setNavItems(fixtures.siteId, targetId, [
      { id: 'target-existing', type: 'header' as const, label: 'Existing' }
    ])

    await navigationModel.copyNav({
      sourceSiteId: fixtures.siteId,
      sourceId,
      targetSiteId: fixtures.siteId,
      targetId,
      mode: 'replace'
    })

    const targetItems = await navigationModel.getNav(fixtures.siteId, targetId, {
      unfiltered: true
    })
    assert.equal(targetItems.length, 1)
    const [copied] = targetItems
    assert.notEqual(copied!.id, 'source-parent')
    assert.equal(copied!.label, 'Parent')
    assert.deepEqual(copied!.visibilityGroups, [fixtures.groupId])
    assert.equal(copied!.children!.length, 1)
    assert.notEqual(copied!.children![0]!.id, 'source-child')
    assert.equal(copied!.children![0]!.label, 'Child')

    // -> The source is left untouched
    const sourceStillIntact = await navigationModel.getNav(fixtures.siteId, sourceId, {
      unfiltered: true
    })
    assert.equal(sourceStillIntact[0]!.id, 'source-parent')
  })

  test('append pushes clones onto the target existing items rather than replacing them', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'de')
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'es')

    await navigationModel.setNavItems(fixtures.siteId, sourceId, [
      { id: 'append-source', type: 'link' as const, label: 'From Source', target: '/x' }
    ])
    await navigationModel.setNavItems(fixtures.siteId, targetId, [
      { id: 'append-target', type: 'link' as const, label: 'Already There', target: '/y' }
    ])

    await navigationModel.copyNav({
      sourceSiteId: fixtures.siteId,
      sourceId,
      targetSiteId: fixtures.siteId,
      targetId,
      mode: 'append'
    })

    const targetItems = await navigationModel.getNav(fixtures.siteId, targetId, {
      unfiltered: true
    })
    assert.deepEqual(
      targetItems.map((i) => i.label),
      ['Already There', 'From Source']
    )
    assert.equal(targetItems[0]!.id, 'append-target')
    assert.notEqual(targetItems[1]!.id, 'append-source')
  })

  /**
   * OpenProject #2217: `copyNav` used to copy `target` unrewritten, so a source menu poisoned before
   * this check existed (or written straight to the database) could reintroduce a `javascript:` item
   * into a fresh menu via a plain "copy from locale". A safe target still travels over unchanged.
   */
  test('drops an unsafe target instead of duplicating it onto the target menu', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'ja')
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'ko')

    await navigationModel.setNavItems(fixtures.siteId, sourceId, [
      { id: 'safe-path', type: 'link' as const, label: 'Safe Path', target: '/safe' },
      { id: 'safe-url', type: 'link' as const, label: 'Safe URL', target: 'https://example.com' },
      { id: 'unsafe', type: 'link' as const, label: 'Unsafe', target: 'javascript:alert(1)' }
    ])

    await navigationModel.copyNav({
      sourceSiteId: fixtures.siteId,
      sourceId,
      targetSiteId: fixtures.siteId,
      targetId,
      mode: 'replace'
    })

    const targetItems = await navigationModel.getNav(fixtures.siteId, targetId, {
      unfiltered: true
    })
    const byLabel = Object.fromEntries(targetItems.map((i) => [i.label, i.target]))
    assert.equal(byLabel['Safe Path'], '/safe')
    assert.equal(byLabel['Safe URL'], 'https://example.com')
    assert.equal(byLabel['Unsafe'], undefined)
  })

  test('rejects a sourceId that does not resolve to an existing menu row', async () => {
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'pt')
    await assert.rejects(
      () =>
        navigationModel.copyNav({
          sourceSiteId: fixtures.siteId,
          sourceId: crypto.randomUUID(),
          targetSiteId: fixtures.siteId,
          targetId,
          mode: 'replace'
        }),
      /source menu does not exist/
    )
  })

  test('rejects a targetId that does not resolve to an existing menu row', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'it')
    await assert.rejects(
      () =>
        navigationModel.copyNav({
          sourceSiteId: fixtures.siteId,
          sourceId,
          targetSiteId: fixtures.siteId,
          targetId: crypto.randomUUID(),
          mode: 'replace'
        }),
      /target menu does not exist/
    )
  })
})

/**
 * The site-wide default menu is identified by `(siteId, locale)`, not by `id === siteId`: a site with
 * more than one active locale needs a menu per locale, and each one's row id is a real, independently
 * generated uuid rather than something a caller can derive from the site id.
 */
describe(
  'navigation site-wide menu is locale-scoped (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let navigationModel: typeof import('./navigation.ts').navigation
    let pagesModel: typeof import('./pages.ts').pages
    let actor: PageActor

    before(async () => {
      fixtures = await setupTestDb()
      ;({ navigation: navigationModel } = await import('./navigation.ts'))
      ;({ pages: pagesModel } = await import('./pages.ts'))
      actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    })

    after(async () => {
      await teardownTestDb()
    })

    test('ensureSiteNav is idempotent for the same (siteId, locale) -- the single-locale case behaves as before', async () => {
      const first = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const second = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(first, second)
      assert.notEqual(first, fixtures.siteId)
    })

    test('ensureSiteNav returns a distinct row per locale of the same site', async () => {
      const enNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const frNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')
      assert.notEqual(enNavId, frNavId)
    })

    test("a newly created page's navigationId resolves to its own locale's site-wide row", async () => {
      const enPage = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'locale-scoped-en',
          title: 'Locale Scoped EN',
          editor: 'markdown',
          content: '# Hello',
          locale: 'en'
        },
        actor
      )
      const frPage = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'locale-scoped-fr',
          title: 'Locale Scoped FR',
          editor: 'markdown',
          content: '# Bonjour',
          locale: 'fr'
        },
        actor
      )

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const frSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')

      assert.equal(enPage.navigationId, enSiteNavId)
      assert.equal(frPage.navigationId, frSiteNavId)
      assert.notEqual(enPage.navigationId, frPage.navigationId)
    })

    test("the home page of each locale edits that locale's own site-wide menu", async () => {
      const enHome = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'home', title: 'Home', editor: 'markdown', content: '# Home', locale: 'en' },
        actor
      )
      const frHome = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'home', title: 'Accueil', editor: 'markdown', content: '# Bonjour', locale: 'fr' },
        actor
      )

      const enResult = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: enHome.id,
        mode: 'override',
        items: [{ id: 'en-item', type: 'link', label: 'EN', target: '/' }]
      })
      const frResult = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: frHome.id,
        mode: 'override',
        items: [{ id: 'fr-item', type: 'link', label: 'FR', target: '/' }]
      })

      assert.notEqual(enResult.navigationId, frResult.navigationId)

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const frSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')
      assert.equal(enResult.navigationId, enSiteNavId)
      assert.equal(frResult.navigationId, frSiteNavId)

      const enItems = await navigationModel.getNav(fixtures.siteId, enSiteNavId, {
        unfiltered: true
      })
      const frItems = await navigationModel.getNav(fixtures.siteId, frSiteNavId, {
        unfiltered: true
      })
      assert.equal(enItems[0]!.label, 'EN')
      assert.equal(frItems[0]!.label, 'FR')
    })
  }
)

/**
 * `siteRoots` is what a "copy from" picker (Feature 359) lists to let an admin choose a source menu
 * without knowing a raw navigation uuid: the site-wide default's own row id for each of the site's
 * active locales, the same locale-scoped lookup `ensureSiteNav` provides one locale at a time.
 */
describe('navigation siteRoots (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('returns one root per active locale, matching what ensureSiteNav resolves for each', async () => {
    WIKI.sites[fixtures.siteId]!.config.locales.active = ['en', 'fr']

    const roots = await navigationModel.siteRoots(fixtures.siteId)

    assert.equal(roots.length, 2)
    const enExpected = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    const frExpected = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')
    assert.deepEqual(
      roots.sort((a, b) => a.locale.localeCompare(b.locale)),
      [
        { locale: 'en', navigationId: enExpected },
        { locale: 'fr', navigationId: frExpected }
      ]
    )
  })

  test('creates the row on demand for a locale that has never been edited', async () => {
    WIKI.sites[fixtures.siteId]!.config.locales.active = ['pt']

    const roots = await navigationModel.siteRoots(fixtures.siteId)

    assert.equal(roots.length, 1)
    assert.equal(roots[0]!.locale, 'pt')
    assert.notEqual(roots[0]!.navigationId, fixtures.siteId)
    const items = await navigationModel.getNav(fixtures.siteId, roots[0]!.navigationId, {
      unfiltered: true
    })
    assert.deepEqual(items, [])
  })

  test('returns an empty array when the site has no active locales configured', async () => {
    WIKI.sites[fixtures.siteId]!.config.locales.active = undefined

    const roots = await navigationModel.siteRoots(fixtures.siteId)

    assert.deepEqual(roots, [])
  })
})

/**
 * `updateNavigation`'s `menuMode` param is a different axis from its `mode` param: `mode` is the
 * ENTRY's cascade setting (inherit/override/...), `menuMode` is the RESOLVED MENU ROW's own source
 * (static/auto/mixed). This is the wiring `NavEditMenu.vue`'s mode selector (Task 464) saves through.
 */
describe('navigation updateNavigation menuMode (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  test("sending menuMode sets the site-wide menu row's mode column and echoes it in the result", async () => {
    const home = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'home',
        title: 'Home',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    const result = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: home.id,
      mode: 'inherit',
      menuMode: 'auto'
    })

    assert.equal(result.mode, 'auto')
    assert.ok(result.navigationId)

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, result.navigationId!))
      .limit(1)
    assert.equal(rows[0]?.mode, 'auto')
  })

  test('sending menuMode without items leaves the stored items untouched', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'menu-mode-no-items-page',
        title: 'Menu Mode No Items Page',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    const items = [{ id: 'x', type: 'link' as const, label: 'Existing', target: '/' }]
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      items
    })

    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      menuMode: 'mixed'
    })

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode, items: navigationTable.items })
      .from(navigationTable)
      .where(eq(navigationTable.id, page.id))
      .limit(1)
    assert.equal(rows[0]?.mode, 'mixed')
    assert.deepEqual(rows[0]?.items, items)
  })

  test("leaving menuMode out does not change the row's existing mode", async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'menu-mode-untouched-page',
        title: 'Menu Mode Untouched Page',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      menuMode: 'auto'
    })

    const result = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'overrideExact',
      items: [{ id: 'y', type: 'link' as const, label: 'Later', target: '/' }]
    })

    assert.equal(result.mode, undefined)
    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, page.id))
      .limit(1)
    assert.equal(rows[0]?.mode, 'auto')
  })
})

/**
 * `mode` (static/auto/mixed) is a column landed ahead of the tree-walk resolver that will read it --
 * this task only checks the schema default holds and that the column round-trips, not any resolution
 * behavior.
 */
describe('navigation.mode column (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('ensureSiteNav creates a row defaulting to static', async () => {
    const navId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, navId))
      .limit(1)

    assert.equal(rows[0]?.mode, 'static')
  })

  test('mode accepts auto and mixed', async () => {
    const navId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')

    await WIKI.db.update(navigationTable).set({ mode: 'auto' }).where(eq(navigationTable.id, navId))
    let rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, navId))
      .limit(1)
    assert.equal(rows[0]?.mode, 'auto')

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'mixed' })
      .where(eq(navigationTable.id, navId))
    rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, navId))
      .limit(1)
    assert.equal(rows[0]?.mode, 'mixed')
  })

  test('getMode reads the same column back, and defaults to static for a menu with no row yet', async () => {
    assert.equal(await navigationModel.getMode(crypto.randomUUID()), 'static')

    const navId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'mixed' })
      .where(eq(navigationTable.id, navId))
    assert.equal(await navigationModel.getMode(navId), 'mixed')

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'static' })
      .where(eq(navigationTable.id, navId))
    assert.equal(await navigationModel.getMode(navId), 'static')
  })
})

/**
 * `generateFromTree` is SQL orchestration in the same shape as `tree.browse()` -- a join, an `EXISTS`
 * subquery and a comparator a mock of the query builder would mostly just be re-describing -- so this
 * runs the real method against a migrated, per-run-fresh database, same approach as the rest of this
 * file. Private on the class (it is not wired into `getNav` yet -- a later task in this feature does
 * that), so tests reach it through an `any` cast rather than TypeScript's own privacy, which is a
 * compile-time-only concept the test runtime does not enforce anyway.
 */
describe('navigation generateFromTree (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: any
  let pagesModel: typeof import('./pages.ts').pages
  let treeModel: typeof import('./tree.ts').tree
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ tree: treeModel } = await import('./tree.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  function generate(rootFolderPath = '', locale = 'en'): Promise<NavigationItem[]> {
    return navigationModel.generateFromTree(fixtures.siteId, rootFolderPath, locale)
  }

  test('an empty subtree produces no items', async () => {
    const items = await generate('empty-subtree-root')
    assert.deepEqual(items, [])
  })

  test('a folder holding only unpublished/non-browsable pages is dropped, not just emptied', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'unpublished-only/draft-page',
        title: 'Draft Page',
        publishState: 'draft'
      }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'unpublished-only/unbrowsable-page',
        title: 'Unbrowsable Page',
        isBrowsable: false
      }),
      actor
    )

    const items = await generate()
    assert.equal(
      items.some((item) => item.label === 'unpublished-only'),
      false
    )
  })

  test('a nested override boundary is included as a leaf but not recursed into', async () => {
    const boundaryFolder = await treeModel.createFolder({
      parentPath: '',
      pathName: 'boundary-section',
      title: 'Boundary Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'boundary-section/inside-boundary', title: 'Inside Boundary' }),
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: boundaryFolder.id,
      mode: 'override'
    })

    // -> A sibling, non-boundary folder recurses normally, so the boundary's lack of children is
    //    contrasted against a case that walks all the way down
    await treeModel.createFolder({
      parentPath: '',
      pathName: 'plain-section',
      title: 'Plain Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'plain-section/inside-plain', title: 'Inside Plain' }),
      actor
    )

    const items = await generate()

    const boundaryItem = items.find((item) => item.label === 'Boundary Section')
    assert.ok(boundaryItem)
    assert.equal(boundaryItem!.children, undefined)

    const plainItem = items.find((item) => item.label === 'Plain Section')
    assert.ok(plainItem)
    assert.equal(plainItem!.children?.length, 1)
    assert.equal(plainItem!.children![0].label, 'Inside Plain')
    assert.equal(plainItem!.children![0].target, '/plain-section/inside-plain')
  })

  test('a hide boundary drops the entry and everything below it', async () => {
    const hiddenFolder = await treeModel.createFolder({
      parentPath: '',
      pathName: 'hidden-section',
      title: 'Hidden Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'hidden-section/inside-hidden', title: 'Inside Hidden' }),
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: hiddenFolder.id,
      mode: 'hide'
    })

    const items = await generate()
    assert.equal(
      items.some((item) => item.label === 'Hidden Section'),
      false
    )
  })

  test("a page link is unprefixed at the site's primary locale, with forcePrefix off", async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'unprefixed-locale-page', title: 'Unprefixed Locale Page' }),
      actor
    )

    const items = await generate('', 'en')
    const item = items.find((i) => i.label === 'Unprefixed Locale Page')
    assert.ok(item)
    assert.equal(item!.target, '/unprefixed-locale-page')
  })

  test('a page link is locale-prefixed when generated for a non-primary active locale', async () => {
    await treeModel.createFolder({
      parentPath: '',
      pathName: 'french-section',
      title: 'French Section',
      locale: 'fr',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'french-section/page-fr', title: 'Page FR', locale: 'fr' }),
      actor
    )

    const items = await generate('', 'fr')
    const item = items.find((i) => i.label === 'French Section')
    assert.ok(item)
    assert.equal(item!.children?.length, 1)
    assert.equal(item!.children![0].target, '/fr/french-section/page-fr')
  })
})

/**
 * `getNav`'s mode branch: this is what wires `generateFromTree` in, so it runs against a real,
 * migrated database like the rest of this file's SQL-orchestration-heavy suites, rather than mocking
 * the query builder.
 */
describe('navigation getNav mode resolution (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  async function setMode(navId: string, mode: 'static' | 'auto' | 'mixed') {
    await WIKI.db.update(navigationTable).set({ mode }).where(eq(navigationTable.id, navId))
  }

  test('static mode returns the stored items unchanged, unaffected by mode wiring', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    const items: NavigationItem[] = [{ id: 'a', type: 'link', label: 'Hand-authored', target: '/' }]
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, items)
    await setMode(siteNavId, 'static')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId)
    assert.deepEqual(result, items)
  })

  test('auto mode ignores stored items and returns the tree walk from the site root', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'auto-mode-page',
        title: 'Auto Mode Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, [
      { id: 'stale', type: 'link', label: 'Should not appear', target: '/' }
    ])
    await setMode(siteNavId, 'auto')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId)
    assert.equal(
      result.some((item) => item.label === 'Should not appear'),
      false
    )
    const generated = result.find((item) => item.label === 'Auto Mode Page')
    assert.ok(generated)
    assert.equal(generated!.target, '/auto-mode-page')
  })

  test('auto mode still applies visibility-group filtering on top of generated items', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel
      .createPage(
        fixtures.siteId,
        {
          path: 'auto-mode-page',
          title: 'Auto Mode Page',
          editor: 'markdown',
          content: '# Hello'
        },
        { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
      )
      .catch(() => {}) // -> May already exist from the previous test in this describe; irrelevant here
    await setMode(siteNavId, 'auto')

    // -> Generated items never carry `visibilityGroups`, so they are always visible -- this just
    //    confirms the filtering pass runs at all (it would throw/behave differently on `unfiltered`
    //    input shaped unexpectedly) and that `unfiltered` still returns the same generated set
    const filtered = await navigationModel.getNav(fixtures.siteId, siteNavId, { userGroups: [] })
    const full = await navigationModel.getNav(fixtures.siteId, siteNavId, { unfiltered: true })
    assert.deepEqual(
      filtered.map((i) => i.id),
      full.map((i) => i.id)
    )
  })

  test('mixed mode merges generated items with pinned stored items, defaulting unpinned ones to after', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'mixed-mode-page',
        title: 'Mixed Mode Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, [
      { id: 'pinned-before', type: 'link', label: 'Pinned Before', target: '/', pinned: 'before' },
      { id: 'unpinned', type: 'link', label: 'Unpinned', target: '/' },
      { id: 'pinned-after', type: 'link', label: 'Pinned After', target: '/', pinned: 'after' }
    ])
    await setMode(siteNavId, 'mixed')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId)
    const ids = result.map((i) => i.id)
    const generatedIndex = result.findIndex((i) => i.label === 'Mixed Mode Page')

    assert.equal(ids[0], 'pinned-before')
    assert.ok(generatedIndex > 0, 'generated item comes after the pinned-before item')
    // -> Unpinned and explicitly-'after' stored items both land after every generated item
    assert.ok(ids.indexOf('unpinned') > generatedIndex)
    assert.equal(ids[ids.length - 1], 'pinned-after')
    assert.equal(ids[ids.length - 2], 'unpinned')
  })

  test("a tree-entry-owned auto menu generates from that entry's own folderPath (its siblings), not its own subtree", async () => {
    const overriddenPage = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'sibling-scope/override-target',
        title: 'Override Target',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'sibling-scope/sibling-page',
        title: 'Sibling Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: overriddenPage.id,
      mode: 'override',
      items: []
    })
    await setMode(overriddenPage.id, 'auto')

    const result = await navigationModel.getNav(fixtures.siteId, overriddenPage.id)
    const labels = result.map((i) => i.label)
    assert.ok(labels.includes('Override Target'))
    assert.ok(labels.includes('Sibling Page'))
  })

  test('a nonexistent menu id returns an empty list rather than throwing', async () => {
    const result = await navigationModel.getNav(fixtures.siteId, crypto.randomUUID())
    assert.deepEqual(result, [])
  })

  test('auto mode tags every generated item as generated, which static mode never does', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'generated-flag-page',
        title: 'Generated Flag Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await setMode(siteNavId, 'auto')
    const auto = await navigationModel.getNav(fixtures.siteId, siteNavId)
    assert.ok(auto.length > 0)
    assert.ok(auto.every((item) => item.generated === true))

    await setMode(siteNavId, 'static')
    const staticResult = await navigationModel.getNav(fixtures.siteId, siteNavId)
    assert.ok(staticResult.every((item) => item.generated === undefined))
  })

  test('mixed mode tags only the generated block, leaving stored items untagged', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel
      .createPage(
        fixtures.siteId,
        {
          path: 'generated-flag-page',
          title: 'Generated Flag Page',
          editor: 'markdown',
          content: '# Hello'
        },
        { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
      )
      .catch(() => {}) // -> May already exist from the previous test in this describe; irrelevant here
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, [
      { id: 'stored-before', type: 'link', label: 'Stored Before', target: '/', pinned: 'before' },
      { id: 'stored-after', type: 'link', label: 'Stored After', target: '/' }
    ])
    await setMode(siteNavId, 'mixed')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId)
    const stored = result.filter((i) => i.id === 'stored-before' || i.id === 'stored-after')
    const generated = result.filter((i) => i.label === 'Generated Flag Page')

    assert.ok(stored.length === 2)
    assert.ok(stored.every((item) => item.generated === undefined))
    assert.ok(generated.length > 0)
    assert.ok(generated.every((item) => item.generated === true))
  })
})

/** The mode/cascade combination `updateNavigation()` should produce for a top-level entry. */
function expectedTransition(
  mode: NavigationMode,
  wasCascading: boolean,
  ancestorId: string,
  ownNavId: string
): { navId: string | null; cascadeTo: string | null | undefined } {
  switch (mode) {
    case 'inherit':
      return { navId: ancestorId, cascadeTo: wasCascading ? ancestorId : undefined }
    case 'override':
      return { navId: ownNavId, cascadeTo: ownNavId }
    case 'overrideExact':
      return { navId: ownNavId, cascadeTo: wasCascading ? ancestorId : undefined }
    case 'hide':
      return { navId: null, cascadeTo: null }
    case 'hideExact':
      return { navId: null, cascadeTo: wasCascading ? ancestorId : undefined }
  }
}

/**
 * `models/navigation.ts` is almost entirely SQL — a menu lookup, an ancestor-cascade query written in
 * raw `ltree` operators, and a tree-entry update coordinated with it — so this runs the real methods
 * against a migrated, per-run-fresh database (see `test/db.ts`) rather than mocking the query builder.
 *
 * Doubles as the proof that the shared DB fixture is sufficient for `models/navigation.ts` to run:
 * standing that up is this task's actual deliverable (Feature 361, task 465), and `seedTreeEntry()` is
 * the fixture helper it adds for every later task in this Feature to build on.
 */
describe('navigation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  const items: NavigationItem[] = [
    { id: 'a', type: 'link', label: 'Everyone', target: '/everyone' },
    { id: 'b', type: 'link', label: 'Admins only', target: '/admins', visibilityGroups: ['admins'] }
  ]

  test('ensureSiteNav creates an empty menu once, idempotently', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    assert.deepEqual(
      await navigationModel.getNav(fixtures.siteId, siteNavId, { unfiltered: true }),
      []
    )

    // -> A page's menu is saved before ensureSiteNav would run again for the same locale (e.g. a
    //    second edit); onConflictDoNothing is what keeps that second call from wiping it back to
    //    empty.
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: (await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'home' })).id,
      mode: 'inherit',
      items
    })
    const sameSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    assert.equal(sameSiteNavId, siteNavId)
    assert.deepEqual(
      await navigationModel.getNav(fixtures.siteId, siteNavId, { unfiltered: true }),
      items
    )
  })

  test('getNav filters items and their children by visibility group', async () => {
    const page = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'filtered-page'
    })
    const { navigationId } = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      items
    })
    assert.equal(navigationId, page.id)

    const asGuest = await navigationModel.getNav(fixtures.siteId, navigationId!, { userGroups: [] })
    assert.deepEqual(
      asGuest.map((i) => i.id),
      ['a']
    )

    const asAdmin = await navigationModel.getNav(fixtures.siteId, navigationId!, {
      userGroups: ['admins']
    })
    assert.deepEqual(
      asAdmin.map((i) => i.id),
      ['a', 'b']
    )
  })

  test('getNav refuses a menu id that belongs to a different site (OpenProject #941)', async () => {
    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: `test-${randomUUID()}.localhost`,
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const otherSiteId = otherSite!.id
    const otherNavId = await navigationModel.ensureSiteNav(otherSiteId, 'en')
    const secretItems: NavigationItem[] = [
      { id: 'secret', type: 'link', label: 'Secret', target: '/secret' }
    ]
    await navigationModel.setNavItems(otherSiteId, otherNavId, secretItems)

    // -> The row is real and readable under its own site...
    assert.deepEqual(
      await navigationModel.getNav(otherSiteId, otherNavId, { unfiltered: true }),
      secretItems
    )
    // -> ...but a caller holding only `fixtures.siteId`'s id cannot read it by guessing/reusing the
    //    row id under the wrong site, the same way `setNavItems`/`copyNav`'s writes already refuse to.
    assert.deepEqual(
      await navigationModel.getNav(fixtures.siteId, otherNavId, { unfiltered: true }),
      []
    )
  })

  test('updateNavigation on a folder with mode=override cascades to inheriting descendants', async () => {
    const folder = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'docs',
      type: 'folder'
    })
    const child = await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'docs/child' })

    const { navigationId } = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: folder.id,
      mode: 'override',
      items
    })

    assert.equal(navigationId, folder.id)
    assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, child.id), folder.id)
  })

  test('updateNavigation rejects a page id that does not exist', async () => {
    await assert.rejects(
      navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: '00000000-0000-0000-0000-000000000000',
        mode: 'inherit'
      }),
      /does not exist/
    )
  })

  /**
   * `ancestorNavId()` (private) is the ltree cascade query at the heart of the model; it is only
   * reachable through its public wrapper `inheritedNavId()`, which just resolves the calling entry's
   * `folderPath` first. These seed a tree by hand (rather than going through `updateNavigation`, which
   * exercises the same query indirectly above) so each case isolates exactly one thing the raw SQL has
   * to get right.
   */
  describe('inheritedNavId / ancestorNavId resolution', () => {
    test('a root-level page (empty folderPath) resolves to the site menu without querying tree', async (t) => {
      const executeSpy = t.mock.method(fixtures.db, 'execute')
      const root = await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'root-page' })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, root.id)

      // -> The site's own nav row id for this entry's locale — never `siteId` itself, per
      //    `ensureSiteNav`'s own contract (locale-scoped site menus, #990).
      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(result, enSiteNavId)
      // -> `ancestorNavId` short-circuits on an empty folderPath before ever building the ltree query;
      //    `getEntry`'s own lookup goes through the query builder, not `db.execute`, so a call here
      //    would only come from the raw-SQL branch this case must not reach.
      assert.equal(executeSpy.mock.callCount(), 0)
    })

    test('a page with no overriding/hiding ancestor anywhere above it falls back to the site menu', async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'plain-branch',
        type: 'folder'
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'plain-branch/leaf'
      })
      // -> Sanity: the ancestor really is on the default mode, not incidentally excluded some other way
      assert.equal(folder.navigationMode, 'inherit')

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), enSiteNavId)
    })

    test("exactly one overriding ancestor: resolves to that ancestor's navigationId", async () => {
      const overrideNavId = randomUUID()
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-branch',
        type: 'folder',
        navigationMode: 'override',
        navigationId: overrideNavId
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-branch/leaf'
      })

      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), overrideNavId)
      assert.notEqual(overrideNavId, folder.id)
    })

    test("exactly one hiding ancestor: resolves to that ancestor's (null) navigationId, not the site menu", async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hide-branch',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hide-branch/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, page.id)

      // -> Must be exactly null (a hidden sidebar), not coerced to the site id the way "no match at
      //    all" is. `assert.equal` would let `undefined` slip through here just as easily as `null`.
      assert.strictEqual(result, null)
      assert.notEqual(result, fixtures.siteId)
      void folder
    })

    test('two overriding/hiding ancestors at different depths: the nearer one wins', async () => {
      const farNavId = randomUUID()
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels',
        type: 'folder',
        navigationMode: 'override',
        navigationId: farNavId
      })
      // -> The nearer ancestor hides rather than overrides, so a wrong answer here can't be mistaken
      //    for "picked some override" — it has to specifically be the deeper row's null, not the
      //    shallower row's navigationId, and ORDER BY nlevel(...) DESC is what makes that true instead
      //    of depending on whichever row postgres happens to scan first.
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels/nested',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const leaf = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels/nested/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, leaf.id)

      assert.strictEqual(result, null)
      assert.notEqual(result, farNavId)
    })

    test('a sibling subtree that overrides does not affect a page under a different branch', async () => {
      const siblingNavId = randomUUID()
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-a',
        type: 'folder',
        navigationMode: 'override',
        navigationId: siblingNavId
      })
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-b',
        type: 'folder'
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-b/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, page.id)

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(result, enSiteNavId)
      assert.notEqual(result, siblingNavId)
    })
  })

  /**
   * The mode-transition matrix (navigation.ts:220-284): every `NAVIGATION_MODES` value, arrived at
   * from a prior mode that cascaded (`override`) and one that didn't (`inherit`), checking the
   * persisted `navigationMode`/`navigationId` on the entry itself and, via a seeded `inherit` child,
   * whether a cascade `UPDATE` ran at all — not just what `cascadeTo` computes to internally.
   *
   * Every case seeds a fresh top-level folder (`folderPath === ''`), so `ancestorNavId` always
   * resolves to `fixtures.siteId` without depending on the ltree query already covered above, and
   * `ownNavId` is always the folder's own id (never the site-root special case, covered separately
   * below). The child starts on a random sentinel `navigationId` that matches neither candidate, so
   * "cascade did not touch it" and "cascade set it to X" are never ambiguous.
   */
  describe('updateNavigation mode-transition matrix', () => {
    const priorByCategory = { cascading: 'override', noncascading: 'inherit' } as const

    for (const mode of NAVIGATION_MODES) {
      for (const [category, priorMode] of Object.entries(priorByCategory) as [
        keyof typeof priorByCategory,
        NavigationMode
      ][]) {
        test(`${priorMode} (${category} prior) -> ${mode}`, async () => {
          const wasCascading = category === 'cascading'
          const slug = `matrix-${mode}-${category}`
          const folder = await seedTreeEntry(fixtures.db, {
            siteId: fixtures.siteId,
            path: slug,
            type: 'folder',
            navigationMode: priorMode,
            navigationId: priorMode === 'override' ? randomUUID() : null
          })
          const sentinelNavId = randomUUID()
          const child = await seedTreeEntry(fixtures.db, {
            siteId: fixtures.siteId,
            path: `${slug}/child`,
            navigationMode: 'inherit',
            navigationId: sentinelNavId
          })

          // -> The root folder has no overriding/hiding ancestor of its own, so it falls back to the
          //    site's locale-scoped nav row — never `fixtures.siteId` itself (`ensureSiteNav`'s
          //    contract, #990).
          const ancestorId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
          const ownNavId = folder.id
          const { navId: expectedNavId, cascadeTo: expectedCascadeTo } = expectedTransition(
            mode,
            wasCascading,
            ancestorId,
            ownNavId
          )

          const result = await navigationModel.updateNavigation({
            siteId: fixtures.siteId,
            pageId: folder.id,
            mode
          })

          assert.equal(result.navigationMode, mode)
          assert.equal(result.navigationId, expectedNavId)

          const [persistedFolder] = await fixtures.db
            .select()
            .from(treeTable)
            .where(eq(treeTable.id, folder.id))
          assert.equal(persistedFolder!.navigationMode, mode)
          assert.equal(persistedFolder!.navigationId, expectedNavId)

          const [persistedChild] = await fixtures.db
            .select()
            .from(treeTable)
            .where(eq(treeTable.id, child.id))
          if (expectedCascadeTo === undefined) {
            // -> No cascade UPDATE ran at all: the child's navigationId is exactly what it was
            //    seeded with, not merely "unchanged from some computed value".
            assert.equal(persistedChild!.navigationId, sentinelNavId)
          } else {
            assert.equal(persistedChild!.navigationId, expectedCascadeTo)
          }
          // -> Cascade never touches the mode column, only navigationId.
          assert.equal(persistedChild!.navigationMode, 'inherit')
        })
      }
    }
  })

  /**
   * The cascade `UPDATE` (navigation.ts:260-284) in isolation from the mode-decision logic already
   * covered above: each case builds its own multi-level tree (at least 3 levels deep, with a branch
   * and a sub-branch) and asserts directly against the persisted `tree` rows, since the cascade's
   * entire effect is on rows `updateNavigation()` never returns.
   */
  describe('cascade UPDATE across a multi-level tree', () => {
    test('(a) override cascades navigationId to every inherit-mode descendant beneath it, at every depth', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root',
        type: 'folder'
      })
      const branch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch',
        type: 'folder'
      })
      const subBranch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch/sub',
        type: 'folder'
      })
      const leaf = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch/sub/leaf'
      })
      const siblingLeaf = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch/sibling-leaf'
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      for (const entry of [branch, subBranch, leaf, siblingLeaf]) {
        const [row] = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, entry.id))
        assert.equal(
          row!.navigationId,
          navigationId,
          `${entry.fileName} should pick up the cascade`
        )
        assert.equal(row!.navigationMode, 'inherit')
      }
    })

    test('(b) a nearer override/hide several levels down blocks the cascade for itself and everything beneath it', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root',
        type: 'folder'
      })
      const branch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch',
        type: 'folder'
      })

      const nearerOverrideNavId = randomUUID()
      const nearerOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-override',
        type: 'folder',
        navigationMode: 'override',
        navigationId: nearerOverrideNavId
      })
      const belowOverrideSentinel = randomUUID()
      const belowOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-override/child',
        type: 'folder',
        navigationId: belowOverrideSentinel
      })
      const deeperBelowOverrideSentinel = randomUUID()
      const deeperBelowOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-override/child/grandchild',
        navigationId: deeperBelowOverrideSentinel
      })

      const nearerHide = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-hide',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const belowHideSentinel = randomUUID()
      const belowHide = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-hide/child',
        navigationId: belowHideSentinel
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      // -> branch itself has no nearer override/hide above it (other than root, the source of the
      //    cascade), so it picks up the cascade normally.
      const [branchRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, branch.id))
      assert.equal(branchRow!.navigationId, navigationId)

      // -> The nearer-override entry's own row: excluded outright by the WHERE clause's
      //    navigationMode = 'inherit' filter, since its mode is 'override', not touched by this
      //    ancestor's cascade.
      const [nearerOverrideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, nearerOverride.id))
      assert.equal(nearerOverrideRow!.navigationId, nearerOverrideNavId)
      assert.equal(nearerOverrideRow!.navigationMode, 'override')

      // -> Everything beneath the nearer override — the NOT EXISTS guard's actual job — stays
      //    exactly as seeded, at both depths.
      const [belowOverrideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, belowOverride.id))
      assert.equal(belowOverrideRow!.navigationId, belowOverrideSentinel)

      const [deeperRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, deeperBelowOverride.id))
      assert.equal(deeperRow!.navigationId, deeperBelowOverrideSentinel)

      // -> Same guard, but for a nearer 'hide' rather than 'override'.
      const [nearerHideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, nearerHide.id))
      assert.equal(nearerHideRow!.navigationMode, 'hide')
      assert.equal(nearerHideRow!.navigationId, null)

      const [belowHideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, belowHide.id))
      assert.equal(belowHideRow!.navigationId, belowHideSentinel)
    })

    test('(c) switching a cascading entry back to inherit hands its descendants to the next ancestor up, respecting nearer overrides beneath it', async () => {
      const rootNavId = randomUUID()
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root',
        type: 'folder',
        navigationMode: 'override',
        navigationId: rootNavId
      })
      const midNavId = randomUUID()
      // -> `mid` starts out cascading in its own right (mode 'override'); `child`/`grandchild` below
      //    it hold `midNavId` because a prior cascade from `mid` put it there.
      const mid = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid',
        type: 'folder',
        navigationMode: 'override',
        navigationId: midNavId
      })
      const child = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/child',
        type: 'folder',
        navigationId: midNavId
      })
      const grandchild = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/child/grandchild',
        navigationId: midNavId
      })
      const nearerOverrideNavId = randomUUID()
      const nearerOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/nearer-override',
        type: 'folder',
        navigationMode: 'override',
        navigationId: nearerOverrideNavId
      })
      const deepUnderNearer = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/nearer-override/deep',
        navigationId: nearerOverrideNavId
      })

      const { navigationMode, navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: mid.id,
        mode: 'inherit'
      })

      assert.equal(navigationMode, 'inherit')
      // -> The next ancestor up is `root`, still on 'override' — that's what `mid` and its
      //    still-inheriting descendants hand off to.
      assert.equal(navigationId, rootNavId)

      const [childRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, child.id))
      assert.equal(childRow!.navigationId, rootNavId)
      assert.equal(childRow!.navigationMode, 'inherit')

      const [grandchildRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, grandchild.id))
      assert.equal(grandchildRow!.navigationId, rootNavId)

      // -> The nearer override nested under `mid` is untouched by `mid`'s own transition (its mode
      //    isn't 'inherit')...
      const [nearerOverrideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, nearerOverride.id))
      assert.equal(nearerOverrideRow!.navigationId, nearerOverrideNavId)
      assert.equal(nearerOverrideRow!.navigationMode, 'override')

      // -> ...and it still shields what's beneath it: `mid` handing its subtree back to `root` does
      //    not reach past the nearer override in between.
      const [deepRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, deepUnderNearer.id))
      assert.equal(deepRow!.navigationId, nearerOverrideNavId)

      // -> `root` itself is above `mid`, outside `mid`'s cascade scope entirely — untouched.
      const [rootRow] = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, root.id))
      assert.equal(rootRow!.navigationId, rootNavId)
      assert.equal(rootRow!.navigationMode, 'override')
    })

    test('(d) a sibling branch outside the target subtree is never touched (folderPath <@ fullPath::ltree scoping)', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-d-root',
        type: 'folder'
      })
      const siblingSentinel = randomUUID()
      const sibling = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-d-sibling',
        type: 'folder',
        navigationId: siblingSentinel
      })
      const siblingChildSentinel = randomUUID()
      const siblingChild = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-d-sibling/leaf',
        navigationId: siblingChildSentinel
      })

      await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      const [siblingRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, sibling.id))
      assert.equal(siblingRow!.navigationId, siblingSentinel)
      assert.equal(siblingRow!.navigationMode, 'inherit')

      const [siblingChildRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, siblingChild.id))
      assert.equal(siblingChildRow!.navigationId, siblingChildSentinel)
    })

    test('(e) tree entries of type asset are excluded from the cascade even when otherwise eligible', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-e-root',
        type: 'folder'
      })
      const branch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-e-root/branch',
        type: 'folder'
      })
      const assetSentinel = randomUUID()
      const asset = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-e-root/branch/image',
        type: 'asset',
        navigationId: assetSentinel
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      const [branchRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, branch.id))
      assert.equal(branchRow!.navigationId, navigationId)

      const [assetRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, asset.id))
      assert.equal(assetRow!.navigationId, assetSentinel)
      assert.equal(assetRow!.navigationMode, 'inherit')
    })
  })

  /**
   * `items`-target routing (navigation.ts:199-218): which menu a page's saved items land in is the
   * *mode's* answer, not the entry's own id — except when that would mean nowhere at all.
   */
  describe('updateNavigation items-target routing', () => {
    const items: NavigationItem[] = [{ id: 'x', type: 'link', label: 'X', target: '/x' }]

    test('mode=inherit writes items to the resolved ancestor menu, not a menu of its own', async () => {
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'inherit-items'
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: page.id,
        mode: 'inherit',
        items
      })

      // -> Top-level page: the resolved ancestor is the site's own locale-scoped menu row, distinct
      //    from both the page's own id and the site id itself.
      assert.notEqual(navigationId, fixtures.siteId)
      assert.notEqual(navigationId, page.id)
      assert.equal(navigationId, await navigationModel.ensureSiteNav(fixtures.siteId, 'en'))
      assert.deepEqual(
        await navigationModel.getNav(fixtures.siteId, navigationId!, { unfiltered: true }),
        items
      )

      // -> No menu was ever created under the page's own id.
      const ownRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, page.id))
      assert.equal(ownRow.length, 0)
    })

    test("a non-inherit mode (override) writes items to the entry's own menu, not the ancestor's", async () => {
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-items'
      })
      const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const siteItemsBefore = await navigationModel.getNav(fixtures.siteId, siteNavId, {
        unfiltered: true
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: page.id,
        mode: 'override',
        items
      })

      assert.equal(navigationId, page.id)
      assert.deepEqual(
        await navigationModel.getNav(fixtures.siteId, page.id, { unfiltered: true }),
        items
      )
      // -> The site (ancestor) menu is untouched by a save that targeted the page's own menu.
      assert.deepEqual(
        await navigationModel.getNav(fixtures.siteId, siteNavId, { unfiltered: true }),
        siteItemsBefore
      )
    })

    test('mode=inherit under a hidden ancestor throws navNoInheritedMenu and writes nothing', async () => {
      const hiddenFolder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hidden-parent-items',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hidden-parent-items/child',
        navigationMode: 'inherit',
        navigationId: null
      })
      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), null)

      await assert.rejects(
        navigationModel.updateNavigation({
          siteId: fixtures.siteId,
          pageId: page.id,
          mode: 'inherit',
          items
        }),
        (err: any) => {
          assert.equal(err.name, 'navNoInheritedMenu')
          assert.equal(err.statusCode, 400)
          return true
        }
      )

      // -> No menu row was ever created for the page (the throw happens before that insert).
      const ownRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, page.id))
      assert.equal(ownRow.length, 0)

      // -> The tree update (navigationMode/navigationId, which runs after the items write) never
      //    ran either: the page is exactly as seeded.
      const [persistedPage] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, page.id))
      assert.equal(persistedPage!.navigationMode, 'inherit')
      assert.equal(persistedPage!.navigationId, null)
      void hiddenFolder
    })
  })

  /**
   * The site-root special case (navigation.ts:706-707): the home page (`folderPath === ''`,
   * `fileName === 'home'`) uses its locale's site-wide nav row (`ensureSiteNav`'s id, never `siteId`
   * itself — see #990) as its `ownNavId`, so editing its items writes to the site's own navigation
   * row rather than a page-owned one. Each case uses a brand-new site, seeded directly rather than
   * through `setupTestDb()`'s shared fixture, so the navigation row's prior state (absent vs.
   * already populated) is exactly what the case controls.
   */
  describe('updateNavigation site-root special case (home page)', () => {
    async function createSite(): Promise<string> {
      const [site] = await fixtures.db
        .insert(sitesTable)
        .values({
          hostname: `test-${randomUUID()}.localhost`,
          isEnabled: true,
          config: { locales: { primary: 'en' } }
        })
        .returning({ id: sitesTable.id })
      return site!.id
    }

    test("fresh site: saving the home page items exercises ensureSiteNav's onConflictDoNothing insert", async () => {
      const siteId = await createSite()
      // -> Nothing has ever called ensureSiteNav for this site — confirm no navigation row exists yet.
      const beforeRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.siteId, siteId))
      assert.equal(beforeRow.length, 0)

      const home = await seedTreeEntry(fixtures.db, { siteId, path: 'home' })
      const items: NavigationItem[] = [{ id: 'h', type: 'link', label: 'Home link', target: '/' }]

      const { navigationId } = await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items
      })

      // -> ownNavId resolved to the site's own (locale-scoped) nav row, not the home page's own tree
      //    entry id, and not the site id itself.
      const enSiteNavId = await navigationModel.ensureSiteNav(siteId, 'en')
      assert.equal(navigationId, enSiteNavId)
      assert.notEqual(navigationId, siteId)
      assert.notEqual(navigationId, home.id)
      assert.deepEqual(
        await navigationModel.getNav(siteId, enSiteNavId, { unfiltered: true }),
        items
      )
      // -> Exactly one navigation row for this site — the insert path, not a duplicate.
      const afterRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.siteId, siteId))
      assert.equal(afterRow.length, 1)
    })

    test('existing site nav row with prior items: saving home page items replaces rather than merges', async () => {
      const siteId = await createSite()
      const home = await seedTreeEntry(fixtures.db, { siteId, path: 'home' })
      const originalItems: NavigationItem[] = [
        { id: 'old-1', type: 'link', label: 'Old 1', target: '/old-1' },
        { id: 'old-2', type: 'link', label: 'Old 2', target: '/old-2' }
      ]
      await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items: originalItems
      })
      const enSiteNavId = await navigationModel.ensureSiteNav(siteId, 'en')
      assert.deepEqual(
        await navigationModel.getNav(siteId, enSiteNavId, { unfiltered: true }),
        originalItems
      )

      const replacementItems: NavigationItem[] = [
        { id: 'new-1', type: 'link', label: 'New 1', target: '/new-1' }
      ]
      const { navigationId } = await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items: replacementItems
      })

      assert.equal(navigationId, enSiteNavId)
      // -> onConflictDoUpdate's `set: { items }` replaces the array outright — the old items are
      //    gone, not merged alongside the new one.
      assert.deepEqual(
        await navigationModel.getNav(siteId, enSiteNavId, { unfiltered: true }),
        replacementItems
      )
    })
  })
})
