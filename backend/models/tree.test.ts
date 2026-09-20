import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
import {
  navigation as navigationTable,
  pages as pagesTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * `tree.getById()` is private — the model's one lookup that takes no `siteId` — so a test reads the
 * row off the table itself rather than reaching through the model.
 */
async function readTreeRow(id: string) {
  const rows = await CARDINAL.db.select().from(treeTable).where(eq(treeTable.id, id)).limit(1)
  return rows[0] ?? null
}

describe('tree cascades (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let treeModel: typeof import('./tree.ts').tree
  let pagesModel: typeof import('./pages.ts').pages
  let assetsModel: typeof import('./assets.ts').assets
  let actor: PageActor
  let TREE_UPDATE_CHUNK_SIZE: number

  before(async () => {
    fixtures = await setupTestDb()
    // -> Seeded before any model call, so the very first `getLocales()` cache fill already sees them.
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    ;({ tree: treeModel, TREE_UPDATE_CHUNK_SIZE } = await import('./tree.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ assets: assetsModel } = await import('./assets.ts'))
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
    // -> The fr PAGE's own tree row is the real cascade-scope claim: checking the fr FOLDER row is
    //   vacuous, since `renameFolder` was only ever given `en.id`.
    const frPageTreeRow = await readTreeRow(frPage!.id)
    assert.equal(frPageTreeRow!.folderPath, 'docs')
  })

  /**
   * Descendant rows and their `pages` counterparts are seeded with two bulk `INSERT`s rather than
   * `createPage()` in a loop, so the fixture stays fast regardless of row count, and
   * `refreshDescendantPaths` is called directly so the `db.execute` spy counts only the write-back
   * `UPDATE`s, not the query-builder calls the rest of `renameFolder` also makes.
   */
  test('refreshDescendantPaths rewrites more descendants than one chunk via batched VALUES joins, not one UPDATE per row (OpenProject #1865)', async () => {
    // -> One row over a single chunk: the smallest fixture that proves batching happened rather
    //    than merely fitting in one call by coincidence.
    const rowCount = TREE_UPDATE_CHUNK_SIZE + 1
    const ids = Array.from({ length: rowCount }, () => randomUUID())

    await fixtures.db.insert(treeTable).values(
      ids.map((id, i) => ({
        id,
        siteId: fixtures.siteId,
        folderPath: 'bulk',
        fileName: `page-${i}`,
        type: 'page' as const,
        locale: 'en',
        title: `Page ${i}`
      }))
    )
    await fixtures.db.insert(pagesTable).values(
      ids.map((id, i) => ({
        id,
        siteId: fixtures.siteId,
        locale: 'en',
        path: `stale-path-${i}`,
        hash: 'stale-hash',
        title: `Page ${i}`,
        editor: 'markdown',
        contentType: 'markdown',
        authorId: fixtures.userId,
        creatorId: fixtures.userId,
        ownerId: fixtures.userId,
        classification: fixtures.classificationId
      }))
    )

    const executeSpy = mock.method(fixtures.db, 'execute')
    await (treeModel as any).refreshDescendantPaths(fixtures.siteId, 'en', 'bulk', fixtures.db)

    const expectedChunkCalls = Math.ceil(rowCount / TREE_UPDATE_CHUNK_SIZE)
    assert.equal(executeSpy.mock.callCount(), expectedChunkCalls)
    assert.ok(
      executeSpy.mock.callCount() < rowCount,
      'must not issue one UPDATE statement per descendant row'
    )

    const updatedPages = await fixtures.db
      .select({ id: pagesTable.id, path: pagesTable.path, hash: pagesTable.hash })
      .from(pagesTable)
      .where(inArray(pagesTable.id, ids))
    assert.equal(updatedPages.length, rowCount)
    const pageById = new Map(updatedPages.map((row) => [row.id, row]))

    for (const [i, id] of ids.entries()) {
      const expectedPath = `bulk/page-${i}`
      const page = pageById.get(id)
      assert.ok(page, `page ${i} must still exist`)
      assert.equal(page!.path, expectedPath)
      assert.equal(page!.hash, generatePathHash(expectedPath))
    }
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
   * `getTree` requires `locale` and filters unconditionally because the API handler's post-filter
   * (`visibleTreeItems`) always judges a single resolved locale: an unfiltered listing would carry
   * every locale's rows but be filtered as if it were one.
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

    // -> Membership checks, not an exact-set `deepEqual`: `includeAncestors` widens its match to
    //    every folder AT each level rather than the one ancestor node, so other tests' root folders
    //    in this shared-DB file legitimately show up too. The claim here is that no `fr` row leaks
    //    in.
    assert.ok(items.length > 0, 'expected at least the en folder/page to come back')
    for (const item of items) {
      assert.notEqual(item.title, 'Shared FR', 'an fr folder must not appear in an en-only listing')
      assert.notEqual(item.title, 'Intro FR', 'an fr page must not appear in an en-only listing')
    }
    const titles = items.map((item) => item.title)
    assert.ok(titles.includes('Intro EN'), 'the en page under the listed folder must be present')
    assert.ok(titles.includes('Shared EN'), 'the en folder itself must be present')
  })

  /**
   * `includeRootFolders` adds its own OR-branch to `getTree`'s location filter, separate from the
   * one a `parentPath`/`parentId`/`includeAncestors` listing builds, so it is worth pinning down
   * directly that the outer `eq(treeTable.locale, locale)` still ANDs over it.
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

  test('getTree with includeAncestors also returns sibling folders at every intermediate level (#3132)', async () => {
    const a = await treeModel.createFolder({
      pathName: 'branch-a',
      title: 'Branch A',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const aSibling = await treeModel.createFolder({
      pathName: 'branch-a-sibling',
      title: 'Branch A Sibling',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const b = await treeModel.createFolder({
      pathName: 'branch-b',
      title: 'Branch B',
      locale: 'en',
      siteId: fixtures.siteId,
      parentId: a.id
    })
    // -> A nested folder's locale is always its parent's (`createFolder`'s `effectiveLocale`), so a
    //    cross-locale sibling cannot be constructed at an intermediate level at all -- locale
    //    coverage for the widened branch lives in the root-level tests above.
    const bSibling = await treeModel.createFolder({
      pathName: 'branch-b-sibling',
      title: 'Branch B Sibling',
      locale: 'en',
      siteId: fixtures.siteId,
      parentId: a.id
    })
    await treeModel.createFolder({
      pathName: 'branch-c',
      title: 'Branch C',
      locale: 'en',
      siteId: fixtures.siteId,
      parentId: b.id
    })

    const items = await treeModel.getTree({
      siteId: fixtures.siteId,
      locale: 'en',
      parentPath: 'branch-a/branch-b/branch-c',
      includeAncestors: true,
      depth: 1
    })

    const ids = items.map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, 'no folder should appear twice')

    // -> Membership checks, not an exact-set assertion: this suite shares one DB/site across every
    //    test in the file, so other tests' own root-level folders legitimately show up too.
    const byId = new Map(items.map((item) => [item.id, item]))
    const bSiblingItem = byId.get(bSibling.id)
    assert.ok(bSiblingItem, 'the sibling at the intermediate level must be present')
    assert.equal(
      bSiblingItem!.isAncestor,
      true,
      'a same-level sibling of an ancestor is itself shallower than the listed folder, so it is flagged isAncestor'
    )

    const aSiblingItem = byId.get(aSibling.id)
    assert.ok(aSiblingItem, 'the sibling at the shallower ancestor level must also be present')
    assert.equal(aSiblingItem!.isAncestor, true)
  })

  /**
   * A root-level folder named after an installed locale code is unreachable — shadowed by the URL
   * locale prefix exactly as a page at that path would be. Only the first path segment shadows, so
   * a folder nested under something else is unaffected.
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
   * `createFolder` derives the new folder's ltree path and locale from the parent row, so a foreign
   * `parentId` resolving at all would leak another site's path and locale. It is refused with the
   * same `treeInvalidParent` a genuinely missing id gets, carrying no trace of the real row.
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
   * Spies on `CARDINAL.models.search`/`storage`/`glossary` by shadowing the real singleton's method
   * as an own property and `delete`-ing it in `finally`, so the next test in this file sees the
   * real implementation again.
   */
  describe('renameFolder fires descendant page move side effects (OpenProject #1692)', () => {
    test('fires search.renamed + storage.dispatch per descendant page, and glossary.invalidateCache once', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'movable',
        title: 'Movable',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const pageOne = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'movable/one', title: 'One', locale: 'en' }),
        actor
      )
      const pageTwo = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'movable/two', title: 'Two', locale: 'en' }),
        actor
      )

      const searchModel = (globalThis as any).CARDINAL.models.search
      const storageModel = (globalThis as any).CARDINAL.models.storage
      const glossaryModel = (globalThis as any).CARDINAL.models.glossary
      const searchCalls: any[] = []
      const storageCalls: any[] = []
      const glossaryCalls: string[] = []
      searchModel.renamed = async (
        siteId: string,
        page: any,
        previousPath: string,
        previousLocale: string
      ) => {
        searchCalls.push({ siteId, id: page.id, path: page.path, previousPath, previousLocale })
      }
      storageModel.dispatch = async (event: string, data: any) => {
        storageCalls.push({ event, ...data })
        return 0
      }
      glossaryModel.invalidateCache = (siteId: string) => {
        glossaryCalls.push(siteId)
      }

      try {
        await treeModel.renameFolder({
          folderId: folder.id,
          siteId: fixtures.siteId,
          pathName: 'moved',
          title: 'Movable'
        })

        assert.deepEqual(new Set(searchCalls.map((c) => c.id)), new Set([pageOne.id, pageTwo.id]))
        for (const call of searchCalls) {
          assert.equal(call.siteId, fixtures.siteId)
          assert.equal(call.previousLocale, 'en')
        }
        const oneRenamed = searchCalls.find((c) => c.id === pageOne.id)!
        assert.equal(oneRenamed.previousPath, 'movable/one')
        assert.equal(oneRenamed.path, 'moved/one')
        const twoRenamed = searchCalls.find((c) => c.id === pageTwo.id)!
        assert.equal(twoRenamed.previousPath, 'movable/two')
        assert.equal(twoRenamed.path, 'moved/two')

        assert.equal(storageCalls.length, 2)
        assert.deepEqual(new Set(storageCalls.map((c) => c.id)), new Set([pageOne.id, pageTwo.id]))
        for (const call of storageCalls) {
          assert.equal(call.event, 'page:rename')
          assert.equal(call.siteId, fixtures.siteId)
          assert.equal(call.locale, 'en')
          assert.equal(call.previousLocale, 'en')
        }
        const oneDispatched = storageCalls.find((c) => c.id === pageOne.id)!
        assert.equal(oneDispatched.previousPath, 'movable/one')
        assert.equal(oneDispatched.path, 'moved/one')

        assert.deepEqual(glossaryCalls, [fixtures.siteId])
      } finally {
        delete searchModel.renamed
        delete storageModel.dispatch
        delete glossaryModel.invalidateCache
      }
    })

    test('fires none of the move side effects for a title-only rename', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'untouched',
        title: 'Untouched',
        locale: 'en',
        siteId: fixtures.siteId
      })
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'untouched/inside', title: 'Inside', locale: 'en' }),
        actor
      )

      const searchModel = (globalThis as any).CARDINAL.models.search
      const storageModel = (globalThis as any).CARDINAL.models.storage
      const glossaryModel = (globalThis as any).CARDINAL.models.glossary
      let searchCalled = false
      let storageCalled = false
      let glossaryCalled = false
      searchModel.renamed = async () => {
        searchCalled = true
      }
      storageModel.dispatch = async () => {
        storageCalled = true
        return 0
      }
      glossaryModel.invalidateCache = () => {
        glossaryCalled = true
      }

      try {
        await treeModel.renameFolder({
          folderId: folder.id,
          siteId: fixtures.siteId,
          pathName: 'untouched',
          title: 'Renamed Title Only'
        })

        assert.equal(searchCalled, false)
        assert.equal(storageCalled, false)
        assert.equal(glossaryCalled, false)
      } finally {
        delete searchModel.renamed
        delete storageModel.dispatch
        delete glossaryModel.invalidateCache
      }
    })
  })

  /**
   * The ltree cascade relocates a descendant asset's `folderPath` on its own; without the dispatch,
   * a storage target with direct-access URLs enabled keeps signing the asset's old key.
   */
  describe('renameFolder fires descendant asset move side effects (OpenProject #3384)', () => {
    test('fires storage.dispatch(asset:move) per descendant asset, with old/new folderPath and kind/fileSize', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'gallery-movable',
        title: 'Movable Gallery',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const assetOne = await assetsModel.upload({
        siteId: fixtures.siteId,
        locale: 'en',
        folderId: folder.id,
        fileName: 'one.png',
        mimeType: 'image/png',
        data: Buffer.from('one'),
        authorId: fixtures.userId
      })
      const assetTwo = await assetsModel.upload({
        siteId: fixtures.siteId,
        locale: 'en',
        folderId: folder.id,
        fileName: 'two.png',
        mimeType: 'image/png',
        data: Buffer.from('two'),
        authorId: fixtures.userId
      })

      const storageModel = (globalThis as any).CARDINAL.models.storage
      const storageCalls: any[] = []
      storageModel.dispatch = async (event: string, data: any) => {
        storageCalls.push({ event, ...data })
        return 0
      }

      try {
        await treeModel.renameFolder({
          folderId: folder.id,
          siteId: fixtures.siteId,
          pathName: 'gallery-moved',
          title: 'Movable Gallery'
        })

        const assetMoveCalls = storageCalls.filter((c) => c.event === 'asset:move')
        assert.equal(assetMoveCalls.length, 2)
        assert.deepEqual(
          new Set(assetMoveCalls.map((c) => c.id)),
          new Set([assetOne.id, assetTwo.id])
        )
        for (const call of assetMoveCalls) {
          assert.equal(call.siteId, fixtures.siteId)
          assert.equal(call.previousFolderPath, 'gallery-movable')
          assert.equal(call.folderPath, 'gallery-moved')
        }
        const oneMoved = assetMoveCalls.find((c) => c.id === assetOne.id)!
        assert.equal(oneMoved.fileName, 'one.png')
        assert.equal(oneMoved.kind, 'image')
        assert.equal(oneMoved.fileSize, 3)
      } finally {
        delete storageModel.dispatch
      }
    })

    test('fires no asset:move dispatch for a title-only rename', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'gallery-untouched',
        title: 'Untouched Gallery',
        locale: 'en',
        siteId: fixtures.siteId
      })
      await assetsModel.upload({
        siteId: fixtures.siteId,
        locale: 'en',
        folderId: folder.id,
        fileName: 'inside.png',
        mimeType: 'image/png',
        data: Buffer.from('inside'),
        authorId: fixtures.userId
      })

      const storageModel = (globalThis as any).CARDINAL.models.storage
      const storageCalls: any[] = []
      storageModel.dispatch = async (event: string, data: any) => {
        storageCalls.push({ event, ...data })
        return 0
      }

      try {
        await treeModel.renameFolder({
          folderId: folder.id,
          siteId: fixtures.siteId,
          pathName: 'gallery-untouched',
          title: 'Renamed Title Only'
        })

        assert.equal(storageCalls.filter((c) => c.event === 'asset:move').length, 0)
      } finally {
        delete storageModel.dispatch
      }
    })
  })

  /**
   * `deleteFolder` does no per-page I/O of its own — `pages.deleteOrphaned`, which the route always
   * calls straight after it, is what fires the side effects — so this drives both calls together,
   * exactly as the route does.
   */
  describe('deleteFolder + deleteOrphaned fire descendant page delete side effects (OpenProject #1693)', () => {
    test('fires search.deleted + storage.dispatch per descendant page, and glossary.invalidateCache once', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'removable',
        title: 'Removable',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const pageOne = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'removable/one', title: 'One', locale: 'en' }),
        actor
      )
      const pageTwo = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'removable/two', title: 'Two', locale: 'en' }),
        actor
      )

      const searchModel = (globalThis as any).CARDINAL.models.search
      const storageModel = (globalThis as any).CARDINAL.models.storage
      const glossaryModel = (globalThis as any).CARDINAL.models.glossary
      const searchCalls: any[] = []
      const storageCalls: any[] = []
      const glossaryCalls: string[] = []
      searchModel.deleted = async (siteId: string, pageId: string) => {
        searchCalls.push({ siteId, id: pageId })
      }
      storageModel.dispatch = async (event: string, data: any) => {
        storageCalls.push({ event, ...data })
        return 0
      }
      glossaryModel.invalidateCache = (siteId: string) => {
        glossaryCalls.push(siteId)
      }

      try {
        const removed = await treeModel.deleteFolder(folder.id, fixtures.siteId)
        await pagesModel.deleteOrphaned(fixtures.siteId, removed.pages, actor)

        assert.deepEqual(new Set(searchCalls.map((c) => c.id)), new Set([pageOne.id, pageTwo.id]))
        for (const call of searchCalls) {
          assert.equal(call.siteId, fixtures.siteId)
        }

        assert.equal(storageCalls.length, 2)
        assert.deepEqual(new Set(storageCalls.map((c) => c.id)), new Set([pageOne.id, pageTwo.id]))
        for (const call of storageCalls) {
          assert.equal(call.event, 'page:delete')
          assert.equal(call.siteId, fixtures.siteId)
          assert.equal(call.locale, 'en')
        }
        const oneDispatched = storageCalls.find((c) => c.id === pageOne.id)!
        assert.equal(oneDispatched.path, 'removable/one')
        const twoDispatched = storageCalls.find((c) => c.id === pageTwo.id)!
        assert.equal(twoDispatched.path, 'removable/two')

        assert.deepEqual(glossaryCalls, [fixtures.siteId])
      } finally {
        delete searchModel.deleted
        delete storageModel.dispatch
        delete glossaryModel.invalidateCache
      }
    })
  })

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
      // -> browse() drops a folder that holds no visible page under it, so this folder needs one to
      //    appear in the listing at all.
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

  describe('tags carried through for the permission filter (OpenProject #3409)', () => {
    test('browse() carries a page’s real tags, empty for a folder-only entry', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'tagged-browse-folder',
        title: 'Has A Page Inside',
        locale: 'en',
        siteId: fixtures.siteId
      })
      // -> browse() drops a folder that holds no visible page under it, so this folder needs one to
      //    appear in the listing at all.
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'tagged-browse-folder/inside', title: 'Inside', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'tagged-browse-page',
          title: 'Page Only',
          locale: 'en',
          tags: ['alpha', 'beta']
        }),
        actor
      )

      const level = await treeModel.browse({
        siteId: fixtures.siteId,
        locale: 'en',
        publicOnly: false
      })

      const pageItem = level!.items.find((item) => item.path === 'tagged-browse-page')!
      const folderItem = level!.items.find((item) => item.path === folder.fileName)!
      assert.deepEqual(pageItem.tags, ['alpha', 'beta'])
      assert.deepEqual(folderItem.tags, [])
    })

    test('listPages() carries each page’s real tags', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'tagged-list/page',
          title: 'Listed',
          locale: 'en',
          tags: ['gamma']
        }),
        actor
      )

      const pages = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'tagged-list',
        depth: 1,
        publicOnly: false
      })

      assert.equal(pages.length, 1)
      assert.deepEqual(pages[0]!.tags, ['gamma'])
    })
  })

  /**
   * `hasChildren` is a per-row correlated EXISTS over the same `pageIsVisible` gate the listing
   * itself uses, which is why it answers differently for an anonymous caller.
   */
  describe('listPages() hasChildren (OpenProject #2460)', () => {
    test('false for a leaf page with no page nested under its own path', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'has-children-leaf-folder/only', title: 'Leaf', locale: 'en' }),
        actor
      )

      const pages = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'has-children-leaf-folder',
        publicOnly: false
      })

      assert.equal(pages.length, 1)
      assert.equal(pages[0]!.hasChildren, false)
    })

    test('true for a page with a page nested under its own path, at any depth', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'has-children-book-folder/toc', title: 'Book', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'has-children-book-folder/toc/section',
          title: 'Nested Section',
          locale: 'en'
        }),
        actor
      )

      const pages = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'has-children-book-folder',
        publicOnly: false
      })

      assert.equal(pages.length, 1)
      assert.equal(pages[0]!.hasChildren, true)
    })

    test('false for an anonymous (publicOnly) caller when the only nested page is a draft', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'has-children-draft-folder/toc', title: 'Draft Parent', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'has-children-draft-folder/toc/draft-section',
          title: 'Draft Child',
          locale: 'en',
          publishState: 'draft'
        }),
        actor
      )

      const anonymous = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'has-children-draft-folder',
        publicOnly: true
      })
      const authenticated = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'has-children-draft-folder',
        publicOnly: false
      })

      assert.equal(anonymous.length, 1)
      assert.equal(anonymous[0]!.hasChildren, false)
      assert.equal(authenticated.length, 1)
      assert.equal(authenticated[0]!.hasChildren, true)
    })
  })

  /**
   * `depth` is relative to the queried `path` (0 = directly inside the listed folder), the same way
   * the `depth` query param it is built from is — never counted from the site root.
   */
  describe('listPages() depth (OpenProject #2461)', () => {
    test('reports 0 for a page directly in the listed folder, and deeper values below it', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'nested-depth/direct', title: 'Direct', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'nested-depth/child/deep/leaf', title: 'Leaf', locale: 'en' }),
        actor
      )

      const pages = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'nested-depth',
        depth: 2,
        publicOnly: false
      })

      const direct = pages.find((p) => p.path === 'nested-depth/direct')!
      const leaf = pages.find((p) => p.path === 'nested-depth/child/deep/leaf')!
      assert.equal(direct.depth, 0)
      assert.equal(leaf.depth, 2)
    })

    test('reports depth relative to the query, not the site root, when listing a nested path', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'depth-root/branch/leaf', title: 'Leaf', locale: 'en' }),
        actor
      )

      const pages = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'depth-root/branch',
        depth: 1,
        publicOnly: false
      })

      assert.equal(pages.length, 1)
      assert.equal(pages[0]!.depth, 0)
    })

    test('reports 0 for every page when listing the site root', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'root-depth-page', title: 'Root Page', locale: 'en' }),
        actor
      )

      const pages = await treeModel.listPages({
        siteId: fixtures.siteId,
        locale: 'en',
        path: '',
        depth: 0,
        publicOnly: false
      })

      const page = pages.find((p) => p.path === 'root-depth-page')!
      assert.equal(page.depth, 0)
    })
  })

  /**
   * `deleteFolder`/`renameFolder`'s callers have to authorize every descendant before committing to
   * the cascade, which is what `listDescendants` resolves — without mutating anything.
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

      const ids = [...result.pages, ...result.assets].map((e) => e.id)
      assert.equal(ids.includes(root.id), false)
      assert.equal(ids.includes(nested.id), false)

      const rootAfter = await treeModel.getFolderById(root.id, fixtures.siteId)
      const nestedAfter = await treeModel.getFolderById(nested.id, fixtures.siteId)
      const topPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: topPage.id })
      const deepPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: deepPage.id })
      const assetAfter = await readTreeRow(asset.id)
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

    test('an empty folder answers with empty arrays rather than throwing', async () => {
      const empty = await treeModel.createFolder({
        pathName: 'empty-desc',
        title: 'Empty',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const descendants = await treeModel.listDescendants(empty.id, fixtures.siteId)
      assert.deepEqual(descendants, { pages: [], assets: [] })
    })

    test('throws for a folder id that does not exist', async () => {
      await assert.rejects(
        treeModel.listDescendants('00000000-0000-0000-0000-000000000000', fixtures.siteId),
        (err: any) => err.name === 'treeInvalidFolder'
      )
    })

    test('throws for a folder id belonging to a different site', async () => {
      const [otherSite] = await CARDINAL.db
        .insert(sitesTable)
        .values({ hostname: `listdescendants-other-${Date.now()}.example.com`, config: {} })
        .returning({ id: sitesTable.id })
      const otherFolder = await treeModel.createFolder({
        pathName: 'other-site-desc',
        title: 'Other',
        locale: 'en',
        siteId: otherSite!.id
      })
      await assert.rejects(
        treeModel.listDescendants(otherFolder.id, fixtures.siteId),
        (err: any) => err.name === 'treeInvalidFolder'
      )
      // -> The extra site is left behind: its tree row still references it (a bare site delete
      //    would 23503 on the FK), and teardownTestDb() drops the whole schema regardless.
    })
  })

  describe('getFolderById siteId scoping (OpenProject #2127)', () => {
    test('does not resolve a folder belonging to a different site', async () => {
      const [otherSite] = await CARDINAL.db
        .insert(sitesTable)
        .values({ hostname: `getfolderbyid-other-${Date.now()}.example.com`, config: {} })
        .returning({ id: sitesTable.id })

      const folder = await treeModel.createFolder({
        pathName: 'other-site-folder',
        title: 'Other Site Folder',
        locale: 'en',
        siteId: otherSite!.id
      })

      const resolved = await treeModel.getFolderById(folder.id, otherSite!.id)
      assert.ok(resolved, 'expected the folder to resolve for its own site')

      const foreign = await treeModel.getFolderById(folder.id, fixtures.siteId)
      assert.equal(foreign, null)

      // -> The extra site is left behind: its tree row still references it (a bare site delete
      //    would 23503 on the FK), and teardownTestDb() drops the whole schema regardless.
    })
  })

  /**
   * `moveEntry` reparents a leaf tree row — in practice an asset, since a page goes through the
   * path-aware `movePage`, which also keeps the `pages` table's own copy of the path in step.
   */
  describe('moveEntry (OpenProject #2447)', () => {
    test("moves an asset into another folder, updating both folders' children counts", async () => {
      const source = await treeModel.createFolder({
        pathName: 'move-source',
        title: 'Source',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const destination = await treeModel.createFolder({
        pathName: 'move-destination',
        title: 'Destination',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const asset = await treeModel.addAsset({
        parentId: source.id,
        fileName: 'diagram.png',
        title: 'diagram.png',
        locale: 'en',
        siteId: fixtures.siteId
      })

      const moved = await treeModel.moveEntry({
        id: asset.id,
        siteId: fixtures.siteId,
        folderId: destination.id
      })

      assert.ok(moved)
      assert.equal(moved!.folderPath, 'move-destination')
      // -> `getFolderById`, not `readTreeRow`: its return types `meta` as `Record<string, any>`,
      //    where a bare `.select()` off a `jsonb()` column with no generic infers `unknown`.
      const sourceAfter = await treeModel.getFolderById(source.id, fixtures.siteId)
      const destinationAfter = await treeModel.getFolderById(destination.id, fixtures.siteId)
      assert.equal(sourceAfter!.meta.children, 0, "the source folder's count must drop")
      assert.equal(destinationAfter!.meta.children, 1, "the destination folder's count must rise")
    })

    test('moving into the site root (no folderId, no parentPath) clears folderPath and decrements the old folder', async () => {
      const source = await treeModel.createFolder({
        pathName: 'move-to-root',
        title: 'Source',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const asset = await treeModel.addAsset({
        parentId: source.id,
        fileName: 'root-bound.png',
        title: 'root-bound.png',
        locale: 'en',
        siteId: fixtures.siteId
      })

      const moved = await treeModel.moveEntry({ id: asset.id, siteId: fixtures.siteId })

      assert.ok(moved)
      assert.equal(moved!.folderPath, '')
      const sourceAfter = await treeModel.getFolderById(source.id, fixtures.siteId)
      assert.equal(sourceAfter!.meta.children, 0)
    })

    test('parentPath resolves-or-creates the destination folder, the same as an upload', async () => {
      const asset = await treeModel.addAsset({
        fileName: 'via-path.png',
        title: 'via-path.png',
        locale: 'en',
        siteId: fixtures.siteId
      })

      const moved = await treeModel.moveEntry({
        id: asset.id,
        siteId: fixtures.siteId,
        parentPath: 'brand-new/nested'
      })

      assert.ok(moved)
      assert.equal(moved!.folderPath, 'brand-new.nested')
      const createdFolder = await treeModel.getFolder({
        path: 'brand-new/nested',
        locale: 'en',
        siteId: fixtures.siteId
      })
      assert.ok(createdFolder, 'the missing ancestor folder must have been created')
    })

    test('moving into the folder it already sits in is a no-op: unchanged row, folder count untouched', async () => {
      const source = await treeModel.createFolder({
        pathName: 'move-noop',
        title: 'Source',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const asset = await treeModel.addAsset({
        parentId: source.id,
        fileName: 'stays-put.png',
        title: 'stays-put.png',
        locale: 'en',
        siteId: fixtures.siteId
      })

      const moved = await treeModel.moveEntry({
        id: asset.id,
        siteId: fixtures.siteId,
        folderId: source.id
      })

      assert.ok(moved)
      assert.equal(moved!.folderPath, 'move-noop')
      const sourceAfter = await treeModel.getFolderById(source.id, fixtures.siteId)
      assert.equal(
        sourceAfter!.meta.children,
        1,
        'the count must not have been decremented then re-incremented'
      )
    })

    test('refuses a destination that already holds the name (treeEntryDuplicate, 409)', async () => {
      const destination = await treeModel.createFolder({
        pathName: 'move-collision',
        title: 'Destination',
        locale: 'en',
        siteId: fixtures.siteId
      })
      await treeModel.addAsset({
        parentId: destination.id,
        fileName: 'taken.png',
        title: 'taken.png',
        locale: 'en',
        siteId: fixtures.siteId
      })
      const asset = await treeModel.addAsset({
        fileName: 'taken.png',
        title: 'taken.png',
        locale: 'en',
        siteId: fixtures.siteId
      })

      await assert.rejects(
        treeModel.moveEntry({ id: asset.id, siteId: fixtures.siteId, folderId: destination.id }),
        (err: any) => err.name === 'treeEntryDuplicate' && err.statusCode === 409
      )
    })

    test('returns null for an entry that does not exist on this site', async () => {
      const result = await treeModel.moveEntry({
        id: '00000000-0000-0000-0000-000000000000',
        siteId: fixtures.siteId
      })
      assert.equal(result, null)
    })

    test('returns null for an entry belonging to a different site', async () => {
      const [otherSite] = await CARDINAL.db
        .insert(sitesTable)
        .values({ hostname: `moveentry-other-${Date.now()}.example.com`, config: {} })
        .returning({ id: sitesTable.id })
      const asset = await treeModel.addAsset({
        fileName: 'foreign.png',
        title: 'foreign.png',
        locale: 'en',
        siteId: otherSite!.id
      })

      const result = await treeModel.moveEntry({ id: asset.id, siteId: fixtures.siteId })
      assert.equal(result, null)
      // -> The extra site is left behind: its tree row still references it, and teardownTestDb()
      //    drops the whole schema regardless.
    })

    test('throws for a folderId belonging to a different site (treeInvalidFolder, 404)', async () => {
      const [otherSite] = await CARDINAL.db
        .insert(sitesTable)
        .values({ hostname: `moveentry-foreignfolder-${Date.now()}.example.com`, config: {} })
        .returning({ id: sitesTable.id })
      const foreignFolder = await treeModel.createFolder({
        pathName: 'foreign-dest',
        title: 'Foreign',
        locale: 'en',
        siteId: otherSite!.id
      })
      const asset = await treeModel.addAsset({
        fileName: 'wants-to-move.png',
        title: 'wants-to-move.png',
        locale: 'en',
        siteId: fixtures.siteId
      })

      await assert.rejects(
        treeModel.moveEntry({ id: asset.id, siteId: fixtures.siteId, folderId: foreignFolder.id }),
        (err: any) => err.name === 'treeInvalidFolder'
      )
    })
  })

  /**
   * The API's own post-filter (`visibleTreeItems`) checks page RULES, never publication state, so
   * `getTree` threads `pageIsVisible` into the query itself -- applied only when `publicOnly`,
   * since the file manager's authenticated use of this same method must keep seeing drafts and
   * non-browsable pages. The predicate is scoped to `type = 'page'` rows, so a folder or asset
   * entry is never affected either way.
   */
  describe('getTree publicOnly (OpenProject #1587 §2)', () => {
    test('publicOnly hides a draft, a scheduled page, and a non-browsable page from a page-type entry, but not a folder', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'visibility',
        title: 'Visibility',
        locale: 'en',
        siteId: fixtures.siteId
      })
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'visibility/published',
          title: 'Published',
          locale: 'en',
          publishState: 'published'
        }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'visibility/draft',
          title: 'Draft',
          locale: 'en',
          publishState: 'draft'
        }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'visibility/scheduled',
          title: 'Scheduled',
          locale: 'en',
          publishState: 'scheduled',
          publishStartDate: new Date(Date.now() + 86400000).toISOString()
        }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'visibility/hidden',
          title: 'Hidden',
          locale: 'en',
          publishState: 'published',
          isBrowsable: false
        }),
        actor
      )

      const publicItems = await treeModel.getTree({
        siteId: fixtures.siteId,
        locale: 'en',
        parentId: folder.id,
        publicOnly: true
      })
      const publicTitles = publicItems.map((item) => item.title).sort()
      assert.deepEqual(publicTitles, ['Published'])

      const privateItems = await treeModel.getTree({
        siteId: fixtures.siteId,
        locale: 'en',
        parentId: folder.id,
        publicOnly: false
      })
      const privateTitles = privateItems.map((item) => item.title).sort()
      assert.deepEqual(privateTitles, ['Draft', 'Hidden', 'Published', 'Scheduled'])
    })

    test('publicOnly still lists a folder that holds only invisible pages', async () => {
      await treeModel.createFolder({
        pathName: 'only-drafts',
        title: 'Only Drafts',
        locale: 'en',
        siteId: fixtures.siteId
      })
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'only-drafts/inside',
          title: 'Inside Draft',
          locale: 'en',
          publishState: 'draft'
        }),
        actor
      )

      const items = await treeModel.getTree({
        siteId: fixtures.siteId,
        locale: 'en',
        includeRootFolders: true,
        publicOnly: true
      })
      assert.ok(
        items.some((item) => item.type === 'folder' && item.title === 'Only Drafts'),
        'the folder itself is not a page and must not be filtered out by publicOnly'
      )
    })

    test('publicOnly defaults to false — an existing caller with no opinion keeps every entry', async () => {
      const folder = await treeModel.createFolder({
        pathName: 'default-visibility',
        title: 'Default Visibility',
        locale: 'en',
        siteId: fixtures.siteId
      })
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'default-visibility/draft',
          title: 'Draft By Default',
          locale: 'en',
          publishState: 'draft'
        }),
        actor
      )

      const items = await treeModel.getTree({
        siteId: fixtures.siteId,
        locale: 'en',
        parentId: folder.id
      })
      assert.ok(items.some((item) => item.title === 'Draft By Default'))
    })
  })

  describe('purgeEmptyFolders (OpenProject #3633)', () => {
    async function freshSite(): Promise<string> {
      const [site] = await CARDINAL.db
        .insert(sitesTable)
        .values({
          hostname: `purge-${randomUUID()}.example.com`,
          config: { locales: { primary: 'en', active: ['en', 'fr'] } }
        })
        .returning({ id: sitesTable.id })
      return site!.id
    }

    async function folder(
      siteId: string,
      pathName: string,
      opts: { parentId?: string; locale?: string } = {}
    ) {
      return treeModel.createFolder({
        pathName,
        title: pathName,
        locale: opts.locale ?? 'en',
        siteId,
        parentId: opts.parentId
      })
    }

    async function childCount(id: string): Promise<unknown> {
      return ((await readTreeRow(id))!.meta as { children?: number }).children
    }

    async function exists(id: string): Promise<boolean> {
      return (await readTreeRow(id)) !== null
    }

    test('a dry run reports the empty folders and deletes nothing', async () => {
      const siteId = await freshSite()
      const empty = await folder(siteId, 'empty')
      const kept = await folder(siteId, 'kept')
      await seedTreeEntry(CARDINAL.db, { siteId, path: 'kept/note', type: 'page' })

      const result = await treeModel.purgeEmptyFolders(siteId, { dryRun: true })

      assert.equal(result.dryRun, true)
      assert.equal(result.count, 1)
      assert.deepEqual(result.folders, [{ id: empty.id, path: 'empty', locale: 'en' }])
      assert.ok(await exists(empty.id))
      assert.ok(await exists(kept.id))
    })

    test('nested empty folders are all purged in one run, deepest first, and the parent counter follows', async () => {
      const siteId = await freshSite()
      const keeper = await folder(siteId, 'keeper')
      await seedTreeEntry(CARDINAL.db, { siteId, path: 'keeper/page', type: 'page' })
      const a = await folder(siteId, 'a', { parentId: keeper.id })
      const b = await folder(siteId, 'b', { parentId: a.id })
      const c = await folder(siteId, 'c', { parentId: b.id })
      const sibling = await folder(siteId, 'sibling', { parentId: keeper.id })
      assert.equal(await childCount(keeper.id), 2)

      const result = await treeModel.purgeEmptyFolders(siteId)

      assert.equal(result.dryRun, false)
      assert.equal(result.count, 4)
      assert.deepEqual(result.folders[0], { id: c.id, path: 'keeper/a/b/c', locale: 'en' })
      assert.deepEqual(
        new Set(result.folders.map((f) => f.id)),
        new Set([a.id, b.id, c.id, sibling.id])
      )
      for (const gone of [a, b, c, sibling]) {
        assert.equal(await exists(gone.id), false)
      }
      assert.ok(await exists(keeper.id))
      assert.equal(await childCount(keeper.id), 0)

      const again = await treeModel.purgeEmptyFolders(siteId)
      assert.equal(again.count, 0)
    })

    test('a folder with a page or an asset anywhere under it survives, along with every ancestor', async () => {
      const siteId = await freshSite()
      const top = await folder(siteId, 'top')
      const mid = await folder(siteId, 'mid', { parentId: top.id })
      const deep = await folder(siteId, 'deep', { parentId: mid.id })
      await seedTreeEntry(CARDINAL.db, { siteId, path: 'top/mid/deep/readme', type: 'page' })
      const assetTop = await folder(siteId, 'assets-top')
      const assetLeaf = await folder(siteId, 'leaf', { parentId: assetTop.id })
      await seedTreeEntry(CARDINAL.db, { siteId, path: 'assets-top/leaf/logo.png', type: 'asset' })

      const result = await treeModel.purgeEmptyFolders(siteId)

      assert.equal(result.count, 0)
      for (const kept of [top, mid, deep, assetTop, assetLeaf]) {
        assert.ok(await exists(kept.id))
      }
    })

    test('meta.children drift does not matter: an emptied folder reporting children is still purged, a populated one reporting none survives', async () => {
      const siteId = await freshSite()
      const stale = await folder(siteId, 'stale')
      await CARDINAL.db
        .update(treeTable)
        .set({ meta: { children: 5 } })
        .where(eq(treeTable.id, stale.id))
      const populated = await folder(siteId, 'populated')
      await seedTreeEntry(CARDINAL.db, { siteId, path: 'populated/page', type: 'page' })
      await CARDINAL.db
        .update(treeTable)
        .set({ meta: { children: 0 } })
        .where(eq(treeTable.id, populated.id))

      const result = await treeModel.purgeEmptyFolders(siteId)

      assert.deepEqual(
        result.folders.map((f) => f.id),
        [stale.id]
      )
      assert.ok(await exists(populated.id))
    })

    test('a folder with a navigation override survives, and so does its ancestor; an empty folder inside it is purged', async () => {
      const siteId = await freshSite()
      const outer = await folder(siteId, 'outer')
      const overriding = await folder(siteId, 'overriding', { parentId: outer.id })
      const inner = await folder(siteId, 'inner', { parentId: overriding.id })
      await CARDINAL.db
        .update(treeTable)
        .set({ navigationMode: 'override' })
        .where(eq(treeTable.id, overriding.id))
      const hidden = await folder(siteId, 'hidden')
      await CARDINAL.db
        .update(treeTable)
        .set({ navigationMode: 'hideExact' })
        .where(eq(treeTable.id, hidden.id))

      const result = await treeModel.purgeEmptyFolders(siteId)

      assert.deepEqual(
        result.folders.map((f) => f.id),
        [inner.id]
      )
      for (const kept of [outer, overriding, hidden]) {
        assert.ok(await exists(kept.id))
      }
      assert.equal(await childCount(overriding.id), 0)
    })

    test('a folder that owns a navigation row survives even in inherit mode', async () => {
      const siteId = await freshSite()
      const owner = await folder(siteId, 'owns-menu')
      const plain = await folder(siteId, 'plain')
      await CARDINAL.db.insert(navigationTable).values({ id: owner.id, siteId, items: [] })

      const result = await treeModel.purgeEmptyFolders(siteId)

      assert.deepEqual(
        result.folders.map((f) => f.id),
        [plain.id]
      )
      assert.ok(await exists(owner.id))
    })

    test('a folder referenced by a stored navigation item survives, by bare path, locale-prefixed path or folderId', async () => {
      const siteId = await freshSite()
      const bare = await folder(siteId, 'bare')
      const prefixed = await folder(siteId, 'prefixed', { locale: 'fr' })
      const byId = await folder(siteId, 'by-id')
      const nested = await folder(siteId, 'nested', { parentId: byId.id })
      const unreferenced = await folder(siteId, 'unreferenced')
      await CARDINAL.db.insert(navigationTable).values({
        siteId,
        locale: 'en',
        items: [
          { id: '1', type: 'link', label: 'Bare', target: '/bare/?tab=1#top' },
          {
            id: '2',
            type: 'header',
            label: 'Group',
            children: [{ id: '3', type: 'link', label: 'FR', target: '/fr/prefixed' }]
          },
          { id: '4', type: 'link', label: 'Id', folderId: byId.id },
          { id: '5', type: 'link', label: 'External', target: 'https://example.com/unreferenced' }
        ]
      })

      const result = await treeModel.purgeEmptyFolders(siteId)

      assert.deepEqual(
        result.folders.map((f) => f.id),
        [nested.id, unreferenced.id].toSorted()
      )
      for (const kept of [bare, prefixed, byId]) {
        assert.ok(await exists(kept.id))
      }
    })

    test('a same-named folder in another locale or another site is untouched', async () => {
      const siteId = await freshSite()
      const otherSiteId = await freshSite()
      const en = await folder(siteId, 'shared')
      const fr = await folder(siteId, 'shared', { locale: 'fr' })
      await seedTreeEntry(CARDINAL.db, { siteId, path: 'shared/page', type: 'page', locale: 'fr' })
      const elsewhere = await folder(otherSiteId, 'shared')

      const dry = await treeModel.purgeEmptyFolders(siteId, { dryRun: true })
      assert.deepEqual(dry.folders, [{ id: en.id, path: 'shared', locale: 'en' }])

      await treeModel.purgeEmptyFolders(siteId)

      assert.equal(await exists(en.id), false)
      assert.ok(await exists(fr.id))
      assert.ok(await exists(elsewhere.id))
    })
  })

  describe('moveFolder (OpenProject #3665)', () => {
    async function makeFolder(pathName: string, parentId?: string, locale = 'en') {
      return treeModel.createFolder({
        pathName,
        title: pathName,
        locale,
        siteId: fixtures.siteId,
        parentId
      })
    }

    async function childrenOf(id: string): Promise<number> {
      const row = await readTreeRow(id)
      return (row!.meta as any)?.children ?? 0
    }

    function spyOnSideEffects() {
      const searchModel = (globalThis as any).CARDINAL.models.search
      const storageModel = (globalThis as any).CARDINAL.models.storage
      const searchCalls: any[] = []
      const storageCalls: any[] = []
      searchModel.renamed = async (
        siteId: string,
        page: any,
        previousPath: string,
        previousLocale: string
      ) => {
        searchCalls.push({ siteId, id: page.id, path: page.path, previousPath, previousLocale })
      }
      storageModel.dispatch = async (event: string, data: any) => {
        storageCalls.push({ event, ...data })
        return 0
      }
      return {
        searchCalls,
        storageCalls,
        restore() {
          delete searchModel.renamed
          delete storageModel.dispatch
        }
      }
    }

    test('moves a folder with nested folders, pages and assets, and every descendant follows', async () => {
      const source = await makeFolder('mv-src')
      const inner = await makeFolder('inner', source.id)
      const dest = await makeFolder('mv-dest')
      const topPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'mv-src/top', title: 'Top', locale: 'en' }),
        actor
      )
      const deepPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'mv-src/inner/deep', title: 'Deep', locale: 'en' }),
        actor
      )
      const topAsset = await assetsModel.upload({
        siteId: fixtures.siteId,
        locale: 'en',
        folderId: source.id,
        fileName: 'top.png',
        mimeType: 'image/png',
        data: Buffer.from('top'),
        authorId: fixtures.userId
      })
      const deepAsset = await assetsModel.upload({
        siteId: fixtures.siteId,
        locale: 'en',
        folderId: inner.id,
        fileName: 'deep.png',
        mimeType: 'image/png',
        data: Buffer.from('deep'),
        authorId: fixtures.userId
      })
      const destBefore = await childrenOf(dest.id)

      const spies = spyOnSideEffects()
      try {
        const moved = await treeModel.moveFolder({
          folderId: source.id,
          siteId: fixtures.siteId,
          destinationId: dest.id
        })
        assert.equal(moved.folderPath, 'mv-dest')
        assert.equal(moved.fileName, 'mv-src')

        const top = await pagesModel.getPage({
          siteId: fixtures.siteId,
          hash: generatePathHash('mv-dest/mv-src/top'),
          locale: 'en'
        })
        assert.equal(top?.id, topPage.id)
        const deep = await pagesModel.getPage({
          siteId: fixtures.siteId,
          hash: generatePathHash('mv-dest/mv-src/inner/deep'),
          locale: 'en'
        })
        assert.equal(deep?.id, deepPage.id)
        assert.equal(
          await pagesModel.getPage({
            siteId: fixtures.siteId,
            hash: generatePathHash('mv-src/top'),
            locale: 'en'
          }),
          null,
          'the old path must no longer resolve'
        )

        assert.equal((await readTreeRow(inner.id))!.folderPath, 'mv-dest.mv-src')
        assert.equal((await readTreeRow(topPage.id))!.folderPath, 'mv-dest.mv-src')
        assert.equal((await readTreeRow(deepPage.id))!.folderPath, 'mv-dest.mv-src.inner')
        assert.equal((await readTreeRow(topAsset.id))!.folderPath, 'mv-dest.mv-src')
        assert.equal((await readTreeRow(deepAsset.id))!.folderPath, 'mv-dest.mv-src.inner')

        assert.equal(await childrenOf(dest.id), destBefore + 1)

        assert.deepEqual(
          new Set(spies.searchCalls.map((c) => c.id)),
          new Set([topPage.id, deepPage.id])
        )
        const deepSearch = spies.searchCalls.find((c) => c.id === deepPage.id)!
        assert.equal(deepSearch.previousPath, 'mv-src/inner/deep')
        assert.equal(deepSearch.path, 'mv-dest/mv-src/inner/deep')
        assert.equal(spies.storageCalls.filter((c) => c.event === 'page:rename').length, 2)
        const assetCalls = spies.storageCalls.filter((c) => c.event === 'asset:move')
        assert.equal(assetCalls.length, 2)
        const deepAssetCall = assetCalls.find((c) => c.id === deepAsset.id)!
        assert.equal(deepAssetCall.previousFolderPath, 'mv-src/inner')
        assert.equal(deepAssetCall.folderPath, 'mv-dest/mv-src/inner')
        const topAssetCall = assetCalls.find((c) => c.id === topAsset.id)!
        assert.equal(topAssetCall.previousFolderPath, 'mv-src')
        assert.equal(topAssetCall.folderPath, 'mv-dest/mv-src')
      } finally {
        spies.restore()
      }
    })

    test('moves a nested folder to the site root and keeps the parents counts straight', async () => {
      const parent = await makeFolder('mv-root-parent')
      const child = await makeFolder('mv-root-child', parent.id)
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'mv-root-parent/mv-root-child/leaf', title: 'Leaf', locale: 'en' }),
        actor
      )
      const parentBefore = await childrenOf(parent.id)

      const moved = await treeModel.moveFolder({ folderId: child.id, siteId: fixtures.siteId })
      assert.equal(moved.folderPath, '')
      assert.ok(
        await pagesModel.getPage({
          siteId: fixtures.siteId,
          hash: generatePathHash('mv-root-child/leaf'),
          locale: 'en'
        })
      )
      assert.equal(await childrenOf(parent.id), parentBefore - 1)
    })

    test('resolves a parentPath destination, creating it when missing', async () => {
      const folder = await makeFolder('mv-by-path')
      const moved = await treeModel.moveFolder({
        folderId: folder.id,
        siteId: fixtures.siteId,
        parentPath: 'mv-made/on-the-fly'
      })
      assert.equal(moved.folderPath, 'mv-made.on-the-fly')
      const made = await treeModel.getFolder({
        path: 'mv-made/on-the-fly',
        locale: 'en',
        siteId: fixtures.siteId
      })
      assert.equal(made.fileName, 'on-the-fly')
    })

    test('refuses a move into itself or its own descendants, and changes nothing', async () => {
      const outer = await makeFolder('mv-self')
      const inner = await makeFolder('inner', outer.id)
      const deeper = await makeFolder('deeper', inner.id)

      for (const attempt of [
        { destinationId: outer.id },
        { destinationId: inner.id },
        { destinationId: deeper.id },
        { parentPath: 'mv-self' },
        { parentPath: 'mv-self/inner/deeper/not-yet-made' }
      ]) {
        await assert.rejects(
          treeModel.moveFolder({ folderId: outer.id, siteId: fixtures.siteId, ...attempt }),
          (err: any) => err.name === 'treeMoveIntoSelf' && err.statusCode === 400,
          JSON.stringify(attempt)
        )
      }
      assert.equal((await readTreeRow(outer.id))!.folderPath, '')
      assert.equal((await readTreeRow(deeper.id))!.folderPath, 'mv-self.inner')
      await assert.rejects(
        treeModel.getFolder({
          path: 'mv-self/inner/deeper/not-yet-made',
          locale: 'en',
          siteId: fixtures.siteId
        }),
        (err: any) => err.name === 'treeInvalidFolder'
      )
    })

    test('a sibling whose name merely starts with the folder name is not its subtree', async () => {
      const docs = await makeFolder('mv-docs')
      const archive = await makeFolder('mv-docs-archive')
      const moved = await treeModel.moveFolder({
        folderId: docs.id,
        siteId: fixtures.siteId,
        destinationId: archive.id
      })
      assert.equal(moved.folderPath, 'mv-docs-archive')
    })

    test('answers 409 on a name collision at the destination, and moves nothing', async () => {
      const dest = await makeFolder('mv-collide-dest')
      await makeFolder('twin', dest.id)
      const mover = await makeFolder('twin')
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'twin/kept', title: 'Kept', locale: 'en' }),
        actor
      )

      await assert.rejects(
        treeModel.moveFolder({
          folderId: mover.id,
          siteId: fixtures.siteId,
          destinationId: dest.id
        }),
        (err: any) => err.name === 'treeFolderDuplicate' && err.statusCode === 409
      )
      assert.equal((await readTreeRow(mover.id))!.folderPath, '')
      assert.ok(
        await pagesModel.getPage({
          siteId: fixtures.siteId,
          hash: generatePathHash('twin/kept'),
          locale: 'en'
        })
      )
    })

    test('a page holding the name at the destination does not block the move', async () => {
      const dest = await makeFolder('mv-page-dest')
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'mv-page-dest/mv-shared', title: 'Shared', locale: 'en' }),
        actor
      )
      const mover = await makeFolder('mv-shared')
      const moved = await treeModel.moveFolder({
        folderId: mover.id,
        siteId: fixtures.siteId,
        destinationId: dest.id
      })
      assert.equal(moved.folderPath, 'mv-page-dest')
    })

    test('refuses moving a folder named for an installed locale to the site root', async () => {
      const parent = await makeFolder('mv-locale-parent')
      const nested = await makeFolder('fr', parent.id)
      await assert.rejects(
        treeModel.moveFolder({ folderId: nested.id, siteId: fixtures.siteId }),
        (err: any) => err.name === 'treeReservedLocaleSegment'
      )
      assert.equal((await readTreeRow(nested.id))!.folderPath, 'mv-locale-parent')
    })

    test('moving to the folder it is already in is a no-op that fires nothing', async () => {
      const parent = await makeFolder('mv-noop-parent')
      const child = await makeFolder('mv-noop-child', parent.id)
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'mv-noop-parent/mv-noop-child/p', title: 'P', locale: 'en' }),
        actor
      )
      const spies = spyOnSideEffects()
      try {
        const result = await treeModel.moveFolder({
          folderId: child.id,
          siteId: fixtures.siteId,
          destinationId: parent.id
        })
        assert.equal(result.id, child.id)
        assert.equal(result.folderPath, 'mv-noop-parent')
        assert.equal(spies.searchCalls.length, 0)
        assert.equal(spies.storageCalls.length, 0)
      } finally {
        spies.restore()
      }
    })

    test('refuses a foreign-site folder, a foreign-site destination and a destination in another locale', async () => {
      const [otherSite] = await fixtures.db
        .insert(sitesTable)
        .values({
          hostname: 'move-foreign.localhost',
          isEnabled: true,
          config: { locales: { primary: 'en', active: ['en'] } }
        })
        .returning({ id: sitesTable.id })
      const foreignFolder = await treeModel.createFolder({
        pathName: 'mv-foreign',
        title: 'Foreign',
        locale: 'en',
        siteId: otherSite.id
      })
      const mine = await makeFolder('mv-mine')
      const frDest = await makeFolder('mv-fr-dest', undefined, 'fr')

      await assert.rejects(
        treeModel.moveFolder({ folderId: foreignFolder.id, siteId: fixtures.siteId }),
        (err: any) => err.name === 'treeInvalidFolder'
      )
      await assert.rejects(
        treeModel.moveFolder({
          folderId: mine.id,
          siteId: fixtures.siteId,
          destinationId: foreignFolder.id
        }),
        (err: any) => err.name === 'treeInvalidParent' && err.statusCode === 404
      )
      await assert.rejects(
        treeModel.moveFolder({
          folderId: mine.id,
          siteId: fixtures.siteId,
          destinationId: frDest.id
        }),
        (err: any) => err.name === 'treeLocaleMismatch'
      )
      assert.equal((await readTreeRow(mine.id))!.folderPath, '')
    })

    test('only its own locale moves: a same-named folder in another locale stays put', async () => {
      const en = await makeFolder('mv-locale-twin')
      const fr = await makeFolder('mv-locale-twin', undefined, 'fr')
      const enDest = await makeFolder('mv-locale-twin-dest')
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'mv-locale-twin/page', locale: 'fr', title: 'Page FR' }),
        actor
      )

      await treeModel.moveFolder({
        folderId: en.id,
        siteId: fixtures.siteId,
        destinationId: enDest.id
      })

      assert.equal((await readTreeRow(fr.id))!.folderPath, '')
      assert.ok(
        await pagesModel.getPage({
          siteId: fixtures.siteId,
          hash: generatePathHash('mv-locale-twin/page'),
          locale: 'fr'
        })
      )
    })
  })
})
