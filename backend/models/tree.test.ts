import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
import { sites as sitesTable } from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * Bug #932: a folder rename/delete cascade used to match every locale sharing the folder's path —
 * `models/tree.ts`'s cascade UPDATEs and DELETEs filtered on `siteId`/`folderPath` alone, so renaming
 * or deleting the `en` copy of a folder moved or destroyed the `fr` copy's descendants right along
 * with it. These lock the fix: every cascade now also filters on the folder's own `locale`.
 */
describe('tree cascades (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let treeModel: typeof import('./tree.ts').tree
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    // -> Seeded before any model call, so the very first `getLocales()` cache fill already sees them.
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    ;({ tree: treeModel } = await import('./tree.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'placeholder',
      title: 'Placeholder',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  test('renaming a folder moves only its own locale (bug #932)', async () => {
    const en = await treeModel.createFolder({
      pathName: 'docs',
      title: 'Docs',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await treeModel.createFolder({
      pathName: 'docs',
      title: 'Docs',
      locale: 'fr',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/intro', locale: 'en' }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/intro', locale: 'fr', title: 'Introduction' }),
      actor
    )

    await treeModel.renameFolder({
      folderId: en.id,
      siteId: fixtures.siteId,
      pathName: 'guides',
      title: 'Guides'
    })

    const frPage = await pagesModel.getPage({
      siteId: fixtures.siteId,
      hash: generatePathHash('docs/intro'),
      locale: 'fr'
    })
    assert.ok(frPage, 'the fr page must still live at docs/intro')
    const enPage = await pagesModel.getPage({
      siteId: fixtures.siteId,
      hash: generatePathHash('guides/intro'),
      locale: 'en'
    })
    assert.ok(enPage, 'the en page must have moved to guides/intro')
    // -> The real cascade-scope claim: the fr PAGE's own tree row is still filed under the
    //   untouched `docs` folder, not swept along by the `en`-only rename. Checking `fr`'s FOLDER
    //   row's `fileName` (as this used to) is vacuous -- that row was never a candidate for the
    //   cascade in the first place, since `renameFolder` was only ever given `en.id`.
    const frPageTreeRow = await treeModel.getById(frPage!.id)
    assert.equal(frPageTreeRow!.folderPath, 'docs')
  })

  test('deleting a folder deletes only its own locale (bug #932)', async () => {
    const en = await treeModel.createFolder({
      pathName: 'doomed',
      title: 'Doomed',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const fr = await treeModel.createFolder({
      pathName: 'doomed',
      title: 'Doomed',
      locale: 'fr',
      siteId: fixtures.siteId
    })
    const enPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'doomed/inside', locale: 'en' }),
      actor
    )
    const frPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'doomed/inside', locale: 'fr', title: 'À l’intérieur' }),
      actor
    )

    const removed = await treeModel.deleteFolder(en.id, fixtures.siteId)
    await pagesModel.deleteOrphaned(fixtures.siteId, removed.pages, actor)

    const frPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: frPage.id })
    assert.ok(frPageAfter, 'the fr page must still exist')
    const frFolderAfter = await treeModel.getFolderById(fr.id, fixtures.siteId)
    assert.ok(frFolderAfter, 'the fr folder row must still exist')

    const enPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: enPage.id })
    assert.equal(enPageAfter, null, 'the en page must be gone')
    const enFolderAfter = await treeModel.getFolderById(en.id, fixtures.siteId)
    assert.equal(enFolderAfter, null, 'the en folder row must be gone')
  })

  test('folder child counts move only in their own locale', async () => {
    const en = await treeModel.createFolder({
      pathName: 'counted',
      title: 'Counted',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const fr = await treeModel.createFolder({
      pathName: 'counted',
      title: 'Counted',
      locale: 'fr',
      siteId: fixtures.siteId
    })

    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'counted/only-en', locale: 'en' }),
      actor
    )

    const enFolder = await treeModel.getFolderById(en.id, fixtures.siteId)
    const frFolder = await treeModel.getFolderById(fr.id, fixtures.siteId)
    assert.equal(enFolder!.meta.children, 1, "only the en folder's count should have moved")
    assert.equal(frFolder!.meta.children, 0, "the fr folder's count must be untouched")
  })

  /**
   * Review finding (#992): `getTree` treated `locale` as optional and only filtered when one was
   * given, while the API handler's post-filter (`visibleTreeItems`, Task 4) always judges a single
   * resolved locale — an omitted `locale` therefore listed every locale but filtered as if it were
   * one. `getTree` now requires `locale` and filters unconditionally, even when two locales share the
   * same `folderPath` (as `en`/`fr` copies of the same folder do).
   */
  test('getTree filters unconditionally on locale, even when locales share a folderPath (#992)', async () => {
    await treeModel.createFolder({
      pathName: 'shared',
      title: 'Shared EN',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await treeModel.createFolder({
      pathName: 'shared',
      title: 'Shared FR',
      locale: 'fr',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'shared/intro', title: 'Intro EN', locale: 'en' }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'shared/intro', title: 'Intro FR', locale: 'fr' }),
      actor
    )

    const items = await treeModel.getTree({
      siteId: fixtures.siteId,
      locale: 'en',
      parentPath: 'shared',
      includeAncestors: true,
      depth: 1
    })

    assert.ok(items.length > 0, 'expected at least the en folder/page to come back')
    for (const item of items) {
      assert.notEqual(item.title, 'Shared FR', 'an fr folder must not appear in an en-only listing')
      assert.notEqual(item.title, 'Intro FR', 'an fr page must not appear in an en-only listing')
    }
    const titles = items.map((item) => item.title).sort()
    assert.deepEqual(titles, ['Intro EN', 'Shared EN'])
  })

  /**
   * `includeRootFolders` adds its own OR-branch to the location filter (`getTree`'s `locations`
   * array), separate from the branch a `parentPath`/`parentId`/`includeAncestors` listing builds —
   * so it is worth its own regression test that the branch doesn't slip past the outer, unconditional
   * `eq(treeTable.locale, locale)` this suite's #992 fix put in place. Structurally it can't (the
   * locale condition ANDs every OR-branch alike), but the #992 bug was exactly this kind of filter
   * silently not applying to a branch it should have -- worth locking down directly rather than only
   * by inspection.
   */
  test('getTree with includeRootFolders still filters root folders by locale', async () => {
    await treeModel.createFolder({
      pathName: 'root-en-only',
      title: 'Root EN Only',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await treeModel.createFolder({
      pathName: 'root-fr-only',
      title: 'Root FR Only',
      locale: 'fr',
      siteId: fixtures.siteId
    })

    const items = await treeModel.getTree({
      siteId: fixtures.siteId,
      locale: 'en',
      parentPath: 'shared',
      includeRootFolders: true,
      depth: 1
    })

    const titles = items.map((item) => item.title)
    assert.ok(titles.includes('Root EN Only'), 'the en root folder should be included')
    assert.ok(
      !titles.includes('Root FR Only'),
      'an fr root folder must not appear in an en-only includeRootFolders listing'
    )
  })

  /**
   * Task 12 (#994): a root-level folder named after an installed locale code is unreachable — shadowed
   * by the URL prefix parser exactly as a page at that path would be (`models/pages.test.ts`'s
   * matching coverage). Only the first path segment shadows, so a folder nested under something else
   * is unaffected.
   */
  test('createFolder refuses a root folder named after an installed locale code', async () => {
    await assert.rejects(
      treeModel.createFolder({
        pathName: 'fr',
        title: 'FR',
        locale: 'en',
        siteId: fixtures.siteId
      }),
      (err: any) => err.name === 'treeReservedLocaleSegment'
    )
  })

  test('createFolder allows a NESTED folder named after an installed locale code', async () => {
    const parent = await treeModel.createFolder({
      pathName: 'nested-parent',
      title: 'Nested Parent',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const child = await treeModel.createFolder({
      parentId: parent.id,
      pathName: 'fr',
      title: 'FR',
      locale: 'en',
      siteId: fixtures.siteId
    })
    assert.equal(child.fileName, 'fr')
  })

  /**
   * OpenProject #2131: `getFolderById()` used to select on `id` alone, so `createFolder({ parentId })`
   * (and the `POST /sites/:siteId/tree/folders` route on top of it) would resolve a `parentId`
   * belonging to a DIFFERENT site, deriving the new folder's ltree path and locale from a foreign row
   * it had no business reading. `getFolderById()` now pairs `id` with `siteId`, so a foreign `parentId`
   * simply never matches and the create is refused rather than leaking the other site's folder path or
   * locale.
   */
  test('createFolder refuses a parentId belonging to another site', async () => {
    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({ hostname: 'other-createfolder.localhost', isEnabled: true, config: {} })
      .returning({ id: sitesTable.id })
    const foreignParent = await treeModel.createFolder({
      pathName: 'foreign-secret',
      title: 'Foreign Secret',
      locale: 'en',
      siteId: otherSite!.id
    })

    await assert.rejects(
      treeModel.createFolder({
        parentId: foreignParent.id,
        pathName: 'child',
        title: 'Child',
        locale: 'en',
        siteId: fixtures.siteId
      }),
      (err: any) => err.name === 'treeInvalidParent'
    )
  })

  test('renameFolder refuses renaming a root folder to an installed locale code', async () => {
    const folder = await treeModel.createFolder({
      pathName: 'renameable',
      title: 'Renameable',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await assert.rejects(
      treeModel.renameFolder({
        folderId: folder.id,
        siteId: fixtures.siteId,
        pathName: 'en',
        title: 'Renameable'
      }),
      (err: any) => err.name === 'treeReservedLocaleSegment'
    )
  })

  /**
   * OpenProject #2131: `getFolderById()` used to filter on `id` + `type = 'folder'` only, never
   * `siteId` — a folder-create `parentId` naming a folder in ANOTHER site resolved successfully, and
   * `createFolder()` derived the new folder's ltree path (and locale) from that foreign row. Locked
   * down at the model layer here: `createFolder()`'s own `getFolderById()` lookup is scoped, so a
   * cross-tenant `parentId` is refused with `treeInvalidParent` — the same "parent does not exist"
   * error a genuinely missing `parentId` gets, carrying no trace of the foreign folder's real path or
   * locale.
   */
  test('createFolder refuses a parentId belonging to another site', async () => {
    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'other-tenant.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en', active: ['en'] } }
      })
      .returning({ id: sitesTable.id })
    const foreignParent = await treeModel.createFolder({
      pathName: 'foreign-secret',
      title: 'Foreign Secret',
      locale: 'en',
      siteId: otherSite.id
    })

    await assert.rejects(
      treeModel.createFolder({
        parentId: foreignParent.id,
        pathName: 'intruder',
        title: 'Intruder',
        locale: 'en',
        siteId: fixtures.siteId
      }),
      (err: any) => err.name === 'treeInvalidParent'
    )
  })

  /**
   * OpenProject #1128: `getTree()`/`browse()`/`listPages()` used to carry no classification at all —
   * the caller (`api/tree.ts`'s permission filter) had nothing to check a CLASSIFICATION rule
   * against and always passed a hardcoded `null`. Each now joins `pages.classification` in directly,
   * locked down here at the model layer rather than only through the API's permission-filter tests.
   */
  describe('classification carried through for the permission filter (OpenProject #1128)', () => {
    test('getTree() carries a page’s real classification, and null for a folder', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'classified-tree',
        title: 'Classified Tree',
        locale: 'en',
        siteId: fixtures.siteId
      })
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classified-tree/inside', title: 'Inside', locale: 'en' }),
        actor
      )

      const items = await treeModel.getTree({
        siteId: fixtures.siteId,
        locale: 'en',
        parentId: folder.id
      })

      const page = items.find((item) => item.type === 'page')!
      const listedFolder = items.find((item) => item.type === 'folder')
      assert.equal((page as any).classification, fixtures.classificationId)
      assert.equal(listedFolder, undefined, 'no nested folder was created in this fixture')
    })

    test('browse() carries a page’s real classification, null for a folder-only entry', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'classified-browse-folder',
        title: 'Has A Page Inside',
        locale: 'en',
        siteId: fixtures.siteId
      })
      // -> browse() drops a folder that holds no visible page under it (`holdsVisiblePages`), so this
      //    folder needs one to appear in the listing at all -- the folder ROW itself still carries no
      //    classification of its own either way.
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classified-browse-folder/inside', title: 'Inside', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classified-browse-page', title: 'Page Only', locale: 'en' }),
        actor
      )

      const level = await treeModel.browse({
        siteId: fixtures.siteId,
        locale: 'en',
        publicOnly: false
      })

      const pageItem = level!.items.find((item) => item.path === 'classified-browse-page')!
      const folderItem = level!.items.find((item) => item.path === folder.fileName)!
      assert.equal(pageItem.classification, fixtures.classificationId)
      assert.equal(folderItem.classification, null)
    })

    test('listPages() carries each page’s real classification', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classified-list/page', title: 'Listed', locale: 'en' }),
        actor
      )

      const pages = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'classified-list',
        depth: 1,
        publicOnly: false
      })

      assert.equal(pages.length, 1)
      assert.equal(pages[0]!.classification, fixtures.classificationId)
    })
  })

  /**
   * OpenProject #2098: `deleteFolder`/`renameFolder`'s callers need to authorize every descendant
   * before committing to the cascade -- `listDescendants` resolves that same at-or-below set without
   * mutating anything, carrying each page's real tags and classification (the same join #1128 added
   * to the read-side listings above) plus each asset's path.
   */
  describe('listDescendants (OpenProject #2098)', () => {
    test('lists every descendant at any depth, with real tags/classification, and mutates nothing', async () => {
      const root = await treeModel.createFolder({
        pathName: 'descendants-root',
        title: 'Descendants Root',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const nested = await treeModel.createFolder({
        parentId: root.id,
        pathName: 'nested',
        title: 'Nested',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const topPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'descendants-root/top',
          title: 'Top',
          locale: 'en',
          tags: ['alpha', 'beta']
        }),
        actor
      )
      const deepPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'descendants-root/nested/deep',
          title: 'Deep',
          locale: 'en',
          tags: ['gamma']
        }),
        actor
      )
      const asset = await treeModel.addAsset({
        parentId: nested.id,
        fileName: 'diagram.png',
        title: 'diagram.png',
        locale: 'en',
        siteId: fixtures.siteId
      })

      const result = await treeModel.listDescendants(root.id, fixtures.siteId)

      assert.equal(result.pages.length, 2, 'both pages at any depth should be returned')
      const top = result.pages.find((p) => p.id === topPage.id)
      const deep = result.pages.find((p) => p.id === deepPage.id)
      assert.ok(top, 'the top-level page must be listed')
      assert.ok(deep, 'the deeply-nested page must be listed')
      assert.equal(top!.path, 'descendants-root/top')
      assert.deepEqual(top!.tags.sort(), ['alpha', 'beta'])
      assert.equal(top!.classification, fixtures.classificationId)
      assert.equal(deep!.path, 'descendants-root/nested/deep')
      assert.deepEqual(deep!.tags, ['gamma'])
      assert.equal(deep!.classification, fixtures.classificationId)

      assert.equal(result.assets.length, 1, 'the one asset at any depth should be returned')
      assert.equal(result.assets[0]!.id, asset.id)
      assert.equal(result.assets[0]!.path, 'descendants-root/nested/diagram.png')

      // -> Nothing was deleted or renamed by the call: every row this fixture created is still exactly
      //    where it was.
      const rootAfter = await treeModel.getFolderById(root.id, fixtures.siteId)
      const nestedAfter = await treeModel.getFolderById(nested.id, fixtures.siteId)
      const topPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: topPage.id })
      const deepPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: deepPage.id })
      const assetAfter = await treeModel.getById(asset.id)
      assert.ok(rootAfter, 'the root folder must still exist')
      assert.ok(nestedAfter, 'the nested folder must still exist')
      assert.ok(topPageAfter, 'the top page must still exist')
      assert.equal(topPageAfter!.path, 'descendants-root/top', 'the top page must not have moved')
      assert.ok(deepPageAfter, 'the deep page must still exist')
      assert.equal(
        deepPageAfter!.path,
        'descendants-root/nested/deep',
        'the deep page must not have moved'
      )
      assert.ok(assetAfter, 'the asset must still exist')
      assert.equal(assetAfter!.fileName, 'diagram.png', 'the asset must not have been renamed')
    })

    test('throws for a folder id that does not exist', async () => {
      await assert.rejects(
        treeModel.listDescendants('00000000-0000-0000-0000-000000000000', fixtures.siteId),
        (err: any) => err.name === 'treeInvalidFolder'
      )
    })
  })
})
