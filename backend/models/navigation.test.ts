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
