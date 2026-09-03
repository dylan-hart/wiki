import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
import { pages as pagesTable, sites as sitesTable, tree as treeTable } from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * A tree row by id, read straight off the table.
 *
 * `tree.getById()` is private (it is the model's one lookup that takes no `siteId`), so a test that
 * wants to see what a cascade left behind reads the row itself rather than reaching through the model.
 */
async function readTreeRow(id: string) {
  const rows = await WIKI.db.select().from(treeTable).where(eq(treeTable.id, id)).limit(1)
  return rows[0] ?? null
}

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
  let TREE_UPDATE_CHUNK_SIZE: number

  before(async () => {
    fixtures = await setupTestDb()
    // -> Seeded before any model call, so the very first `getLocales()` cache fill already sees them.
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    ;({ tree: treeModel, TREE_UPDATE_CHUNK_SIZE } = await import('./tree.ts'))
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
    const frPageTreeRow = await readTreeRow(frPage!.id)
    assert.equal(frPageTreeRow!.folderPath, 'docs')
  })

  /**
   * OpenProject #1865: `refreshDescendantPaths` used to write back one `UPDATE` per descendant page
   * (`pages.path`/`hash`). This locks in the chunked `VALUES`-join replacement — one
   * `UPDATE ... FROM (VALUES ...)` per `TREE_UPDATE_CHUNK_SIZE` rows instead. The `tree` table itself
   * carries no `hash` column of its own to rewrite here: the bulk ltree `UPDATE`s `renameFolder` runs
   * before ever calling this already rewrote every descendant's `folderPath`, so only each page's own
   * `path`/`hash` on `pages` is left for this to redo.
   *
   * Descendant rows and their `pages` counterparts are seeded directly (two bulk `INSERT`s, not
   * `pagesModel.createPage()` in a loop) so the fixture stays fast regardless of row count, and
   * `refreshDescendantPaths` itself is called directly (it is `renameFolder`'s only caller) so the
   * `db.execute` spy counts only the write-back `UPDATE`s this WP touches, not the query-builder
   * calls (`.select()`/`.update()`) the rest of `renameFolder` also makes.
   */
  test('refreshDescendantPaths rewrites more descendants than one chunk via batched VALUES joins, not one UPDATE per row (OpenProject #1865)', async () => {
    // -> Deliberately one row over a single chunk: the smallest fixture that still proves batching
    //    happened rather than merely fitting in one call by coincidence.
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

    // -> One `UPDATE ... FROM (VALUES ...)` per `TREE_UPDATE_CHUNK_SIZE` rows -- the real proof that
    //    the write-back batches rather than looping one `UPDATE` per row.
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
   * OpenProject #1692: `renameFolder`'s cascade (`refreshDescendantPaths`) used to rewrite
   * `pages.path`/`pages.hash` for every descendant page and stop there — unlike `pages.ts#movePage`,
   * which follows the same write with `recordMoveSideEffects` (search reindex, storage dispatch,
   * glossary cache invalidation). These lock the fix: renaming a folder now fires those side effects
   * for every descendant page, once each, with the correct old/new paths — and fires none of them for
   * a title-only rename, which changes no page's path (the early return at `tree.ts:960-966`).
   *
   * Spies on `WIKI.models.search`/`storage`/`glossary` directly, the same pattern
   * `models/pages.test.ts`'s search-dispatcher coverage uses: shadow the real singleton's method as an
   * own property, restore it (`delete`) in `finally` so the next test sees the real implementation
   * again.
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

      const searchModel = (globalThis as any).WIKI.models.search
      const storageModel = (globalThis as any).WIKI.models.storage
      const glossaryModel = (globalThis as any).WIKI.models.glossary
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

      const searchModel = (globalThis as any).WIKI.models.search
      const storageModel = (globalThis as any).WIKI.models.storage
      const glossaryModel = (globalThis as any).WIKI.models.glossary
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
   * OpenProject #1693: audit of `deleteFolder` for the same missing side-effect gap #1692 fixed on
   * `renameFolder`. Unlike `renameFolder`, `deleteFolder` itself does no per-page I/O at all — its
   * caller (`api/tree.ts`'s DELETE-folder route) always follows it with
   * `pages.deleteOrphaned(siteId, removed.pages, actor)`, and `deleteOrphaned` already fires the full
   * per-page side-effect set `deletePage` fires for a single page: `search.deleted` and
   * `storage.dispatch('page:delete')` once per descendant page, and `glossary.invalidateCache` once
   * for the whole batch. This is the investigation's evidence, locked down the same way #1692's test
   * locks down `renameFolder`: by driving the two calls together, exactly as the real route does, and
   * asserting each side effect fires for the correct descendant pages.
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

      const searchModel = (globalThis as any).WIKI.models.search
      const storageModel = (globalThis as any).WIKI.models.storage
      const glossaryModel = (globalThis as any).WIKI.models.glossary
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
   * OpenProject #2461: `listPages()` used to carry no depth at all -- `block-index` had no way to draw
   * anything but a flat list. `depth` is relative to the queried `path`, the same way the `depth`
   * query param it is built from already is (0 = directly inside the listed folder), not counted from
   * the site root.
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
      // -> `leaf`'s own folder ('nested-depth/child/deep') sits two levels below the listed folder
      //    ('nested-depth'), which is what `depth` reports -- not how deep `leaf` itself is from the
      //    site root.
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
      // -> Absolute site depth would be 2 (depth-root/branch/leaf); relative to `depth-root/branch`
      //    it is 0, since `leaf` sits directly inside the listed folder.
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

      // -> The folders themselves are never returned -- descendants only
      const ids = [...result.pages, ...result.assets].map((e) => e.id)
      assert.equal(ids.includes(root.id), false)
      assert.equal(ids.includes(nested.id), false)

      // -> Nothing was deleted or renamed by the call: every row this fixture created is still exactly
      //    where it was.
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
      const [otherSite] = await WIKI.db
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
      // -> No site cleanup here: `otherFolder`'s tree row still references it (a bare site delete
      //    would 23503 on the FK), and this test's whole schema is dropped by teardownTestDb()
      //    regardless.
    })
  })

  /**
   * OpenProject #2127: `getFolderById()` used to select on `id` alone, so a caller holding a
   * folder id from ANOTHER site (a real UUID, not a guess) got that folder's path/locale back —
   * `POST /sites/:siteId/tree/folders` fed a `parentId` straight through it with no site check at
   * all. `siteId` is now a required argument, filtered into the query, so a foreign id resolves to
   * null exactly like an unknown one.
   */
  describe('getFolderById siteId scoping (OpenProject #2127)', () => {
    test('does not resolve a folder belonging to a different site', async () => {
      const [otherSite] = await WIKI.db
        .insert(sitesTable)
        .values({ hostname: `getfolderbyid-other-${Date.now()}.example.com`, config: {} })
        .returning({ id: sitesTable.id })

      const folder = await treeModel.createFolder({
        pathName: 'other-site-folder',
        title: 'Other Site Folder',
        locale: 'en',
        siteId: otherSite!.id
      })

      // -> Resolves fine when asked for with its OWN site
      const resolved = await treeModel.getFolderById(folder.id, otherSite!.id)
      assert.ok(resolved, 'expected the folder to resolve for its own site')

      // -> Must not resolve when asked for with a DIFFERENT site, even though the id is real
      const foreign = await treeModel.getFolderById(folder.id, fixtures.siteId)
      assert.equal(foreign, null)

      // -> No site cleanup here: `folder`'s tree row still references it (a bare site delete would
      //    23503 on the FK), and this test's whole schema is dropped by teardownTestDb() regardless.
    })
  })

  /**
   * OpenProject #1587 §2 / task 1599: `getTree()` used to apply no visibility filter at all, unlike
   * `browse()`/`listPages()` -- so BROWSE THE TREE (`GET /sites/:siteId/tree`, the only caller) could
   * enumerate a draft, a scheduled-but-not-yet-live page, or an `isBrowsable: false` page to anyone
   * holding `read:pages` via a rule, guests included (`visibleTreeItems`'s own filter checks that
   * RULE, never publication state). `publicOnly` threads `pageIsVisible` into the query, but --
   * unlike `browse()`/`listPages()` -- only actually applies it when `publicOnly` is true: an
   * authenticated caller (the file manager's own use of this same method) must keep seeing every
   * page, drafts and non-browsable ones included, which is what `publicOnly: false` (the default)
   * preserves unchanged. A folder or asset entry is never affected either way -- the predicate is
   * scoped to `type = 'page'` rows only.
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
})
