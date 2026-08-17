import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
import { navigation as navigationTable, tree as treeTable } from '../db/schema.ts'
import type { NavigationItem } from './navigation.ts'
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
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
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
 * the caller (AdminNavigation.vue) already knows which row it means, either the site-wide default
 * (id === siteId) or an override's own `navigationId` from `listOverrides`.
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
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('writes to the site-wide default menu when navId is the site id', async () => {
    const items = [{ id: 'a', type: 'link' as const, label: 'Home', target: '/' }]

    await navigationModel.setNavItems(fixtures.siteId, fixtures.siteId, items)

    const stored = await navigationModel.getNav(fixtures.siteId, { unfiltered: true })
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

    const stored = await navigationModel.getNav(page.id, { unfiltered: true })
    assert.deepEqual(stored, items)
  })

  test("rejects a navId that is not this site's own id and not a tree entry in this site", async () => {
    await assert.rejects(
      () => navigationModel.setNavItems(fixtures.siteId, crypto.randomUUID(), []),
      /does not exist/
    )
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
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
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

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, fixtures.siteId))
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
    await navigationModel.ensureSiteNav(fixtures.siteId)

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, fixtures.siteId))
      .limit(1)

    assert.equal(rows[0]?.mode, 'static')
  })

  test('mode accepts auto and mixed', async () => {
    await navigationModel.ensureSiteNav(fixtures.siteId)

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'auto' })
      .where(eq(navigationTable.id, fixtures.siteId))
    let rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, fixtures.siteId))
      .limit(1)
    assert.equal(rows[0]?.mode, 'auto')

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'mixed' })
      .where(eq(navigationTable.id, fixtures.siteId))
    rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, fixtures.siteId))
      .limit(1)
    assert.equal(rows[0]?.mode, 'mixed')
  })

  test('getMode reads the same column back, and defaults to static for a menu with no row yet', async () => {
    assert.equal(await navigationModel.getMode(crypto.randomUUID()), 'static')

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'mixed' })
      .where(eq(navigationTable.id, fixtures.siteId))
    assert.equal(await navigationModel.getMode(fixtures.siteId), 'mixed')

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'static' })
      .where(eq(navigationTable.id, fixtures.siteId))
    assert.equal(await navigationModel.getMode(fixtures.siteId), 'static')
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
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
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
    assert.equal(plainItem!.children![0].target, '/en/plain-section/inside-plain')
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
    const items: NavigationItem[] = [{ id: 'a', type: 'link', label: 'Hand-authored', target: '/' }]
    await navigationModel.setNavItems(fixtures.siteId, fixtures.siteId, items)
    await setMode(fixtures.siteId, 'static')

    const result = await navigationModel.getNav(fixtures.siteId)
    assert.deepEqual(result, items)
  })

  test('auto mode ignores stored items and returns the tree walk from the site root', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'auto-mode-page',
        title: 'Auto Mode Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    await navigationModel.setNavItems(fixtures.siteId, fixtures.siteId, [
      { id: 'stale', type: 'link', label: 'Should not appear', target: '/' }
    ])
    await setMode(fixtures.siteId, 'auto')

    const result = await navigationModel.getNav(fixtures.siteId)
    assert.equal(
      result.some((item) => item.label === 'Should not appear'),
      false
    )
    const generated = result.find((item) => item.label === 'Auto Mode Page')
    assert.ok(generated)
    assert.equal(generated!.target, '/en/auto-mode-page')
  })

  test('auto mode still applies visibility-group filtering on top of generated items', async () => {
    await pagesModel
      .createPage(
        fixtures.siteId,
        {
          path: 'auto-mode-page',
          title: 'Auto Mode Page',
          editor: 'markdown',
          content: '# Hello'
        },
        { id: fixtures.userId, permissions: ['manage:system'] }
      )
      .catch(() => {}) // -> May already exist from the previous test in this describe; irrelevant here
    await setMode(fixtures.siteId, 'auto')

    // -> Generated items never carry `visibilityGroups`, so they are always visible -- this just
    //    confirms the filtering pass runs at all (it would throw/behave differently on `unfiltered`
    //    input shaped unexpectedly) and that `unfiltered` still returns the same generated set
    const filtered = await navigationModel.getNav(fixtures.siteId, { userGroups: [] })
    const full = await navigationModel.getNav(fixtures.siteId, { unfiltered: true })
    assert.deepEqual(
      filtered.map((i) => i.id),
      full.map((i) => i.id)
    )
  })

  test('mixed mode merges generated items with pinned stored items, defaulting unpinned ones to after', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'mixed-mode-page',
        title: 'Mixed Mode Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    await navigationModel.setNavItems(fixtures.siteId, fixtures.siteId, [
      { id: 'pinned-before', type: 'link', label: 'Pinned Before', target: '/', pinned: 'before' },
      { id: 'unpinned', type: 'link', label: 'Unpinned', target: '/' },
      { id: 'pinned-after', type: 'link', label: 'Pinned After', target: '/', pinned: 'after' }
    ])
    await setMode(fixtures.siteId, 'mixed')

    const result = await navigationModel.getNav(fixtures.siteId)
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
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'sibling-scope/sibling-page',
        title: 'Sibling Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: overriddenPage.id,
      mode: 'override',
      items: []
    })
    await setMode(overriddenPage.id, 'auto')

    const result = await navigationModel.getNav(overriddenPage.id)
    const labels = result.map((i) => i.label)
    assert.ok(labels.includes('Override Target'))
    assert.ok(labels.includes('Sibling Page'))
  })

  test('a nonexistent menu id returns an empty list rather than throwing', async () => {
    const result = await navigationModel.getNav(crypto.randomUUID())
    assert.deepEqual(result, [])
  })

  test('auto mode tags every generated item as generated, which static mode never does', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'generated-flag-page',
        title: 'Generated Flag Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    await setMode(fixtures.siteId, 'auto')
    const auto = await navigationModel.getNav(fixtures.siteId)
    assert.ok(auto.length > 0)
    assert.ok(auto.every((item) => item.generated === true))

    await setMode(fixtures.siteId, 'static')
    const staticResult = await navigationModel.getNav(fixtures.siteId)
    assert.ok(staticResult.every((item) => item.generated === undefined))
  })

  test('mixed mode tags only the generated block, leaving stored items untagged', async () => {
    await pagesModel
      .createPage(
        fixtures.siteId,
        {
          path: 'generated-flag-page',
          title: 'Generated Flag Page',
          editor: 'markdown',
          content: '# Hello'
        },
        { id: fixtures.userId, permissions: ['manage:system'] }
      )
      .catch(() => {}) // -> May already exist from the previous test in this describe; irrelevant here
    await navigationModel.setNavItems(fixtures.siteId, fixtures.siteId, [
      { id: 'stored-before', type: 'link', label: 'Stored Before', target: '/', pinned: 'before' },
      { id: 'stored-after', type: 'link', label: 'Stored After', target: '/' }
    ])
    await setMode(fixtures.siteId, 'mixed')

    const result = await navigationModel.getNav(fixtures.siteId)
    const stored = result.filter((i) => i.id === 'stored-before' || i.id === 'stored-after')
    const generated = result.filter((i) => i.label === 'Generated Flag Page')

    assert.ok(stored.length === 2)
    assert.ok(stored.every((item) => item.generated === undefined))
    assert.ok(generated.length > 0)
    assert.ok(generated.every((item) => item.generated === true))
  })
})
