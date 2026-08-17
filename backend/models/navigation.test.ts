import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
import { tree as treeTable } from '../db/schema.ts'
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
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
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

    const stored = await navigationModel.getNav(siteNavId, { unfiltered: true })
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

    const targetItems = await navigationModel.getNav(targetId, { unfiltered: true })
    assert.equal(targetItems.length, 1)
    const [copied] = targetItems
    assert.notEqual(copied!.id, 'source-parent')
    assert.equal(copied!.label, 'Parent')
    assert.deepEqual(copied!.visibilityGroups, [fixtures.groupId])
    assert.equal(copied!.children!.length, 1)
    assert.notEqual(copied!.children![0]!.id, 'source-child')
    assert.equal(copied!.children![0]!.label, 'Child')

    // -> The source is left untouched
    const sourceStillIntact = await navigationModel.getNav(sourceId, { unfiltered: true })
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

    const targetItems = await navigationModel.getNav(targetId, { unfiltered: true })
    assert.deepEqual(
      targetItems.map((i) => i.label),
      ['Already There', 'From Source']
    )
    assert.equal(targetItems[0]!.id, 'append-target')
    assert.notEqual(targetItems[1]!.id, 'append-source')
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
      actor = { id: fixtures.userId, permissions: ['manage:system'] }
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
      const deHome = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'home', title: 'Startseite', editor: 'markdown', content: '# Start', locale: 'de' },
        actor
      )

      const enResult = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: enHome.id,
        mode: 'override',
        items: [{ id: 'en-item', type: 'link', label: 'EN', target: '/' }]
      })
      const deResult = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: deHome.id,
        mode: 'override',
        items: [{ id: 'de-item', type: 'link', label: 'DE', target: '/' }]
      })

      assert.notEqual(enResult.navigationId, deResult.navigationId)

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const deSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'de')
      assert.equal(enResult.navigationId, enSiteNavId)
      assert.equal(deResult.navigationId, deSiteNavId)

      const enItems = await navigationModel.getNav(enSiteNavId, { unfiltered: true })
      const deItems = await navigationModel.getNav(deSiteNavId, { unfiltered: true })
      assert.equal(enItems[0]!.label, 'EN')
      assert.equal(deItems[0]!.label, 'DE')
    })
  }
)
