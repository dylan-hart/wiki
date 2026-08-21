import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
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
    const fr = await treeModel.createFolder({
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

    await treeModel.renameFolder({ folderId: en.id, pathName: 'guides', title: 'Guides' })

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
    const frFolder = await treeModel.getFolderById(fr.id)
    assert.equal(frFolder!.fileName, 'docs')
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

    const removed = await treeModel.deleteFolder(en.id)
    await pagesModel.deleteOrphaned(fixtures.siteId, removed.pages, actor)

    const frPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: frPage.id })
    assert.ok(frPageAfter, 'the fr page must still exist')
    const frFolderAfter = await treeModel.getFolderById(fr.id)
    assert.ok(frFolderAfter, 'the fr folder row must still exist')

    const enPageAfter = await pagesModel.getPage({ siteId: fixtures.siteId, id: enPage.id })
    assert.equal(enPageAfter, null, 'the en page must be gone')
    const enFolderAfter = await treeModel.getFolderById(en.id)
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

    const enFolder = await treeModel.getFolderById(en.id)
    const frFolder = await treeModel.getFolderById(fr.id)
    assert.equal(enFolder!.meta.children, 1, "only the en folder's count should have moved")
    assert.equal(frFolder!.meta.children, 0, "the fr folder's count must be untouched")
  })
})
