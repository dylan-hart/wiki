import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * `models/pages.ts`'s create/update/move/delete are almost entirely SQL — inserts, duplicate-path
 * checks, and coordination with the tree and history tables — so a mock of the query builder would
 * mostly be re-describing the code under test rather than verifying it. This suite runs the real
 * methods against a migrated, per-run-fresh database (see `test/db.ts`).
 */
describe('pages create/update/move/delete (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
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

  test('createPage inserts a page and gives it a place in the tree', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/create-me', title: 'Create Me' }),
      actor
    )

    assert.equal(page.path, 'docs/create-me')
    assert.equal(page.title, 'Create Me')
    assert.equal(page.locale, 'en')
    assert.equal(page.authorId, fixtures.userId)

    const fetched = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.ok(fetched)
    assert.equal(fetched!.path, 'docs/create-me')
  })

  test('createPage refuses an empty title', async () => {
    await assert.rejects(
      pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/no-title', title: '  ' }),
        actor
      ),
      /pageTitleMissing/
    )
  })

  test('createPage refuses a path already taken in the same locale', async () => {
    await pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/collide' }), actor)

    await assert.rejects(
      pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/collide' }), actor),
      /pageDuplicatePath/
    )
  })

  test('the same path is free again in a different locale', async () => {
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/locale-variant', locale: 'en' }),
      actor
    )
    const fr = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/locale-variant', locale: 'fr', title: 'Bien démarrer' }),
      actor
    )

    assert.notEqual(en.id, fr.id)
    assert.equal(en.locale, 'en')
    assert.equal(fr.locale, 'fr')
    assert.equal(fr.path, 'docs/locale-variant')

    const fetchedEn = await pagesModel.getPage({ siteId: fixtures.siteId, id: en.id })
    const fetchedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(fetchedEn!.title, 'Getting Started')
    assert.equal(fetchedFr!.title, 'Bien démarrer')
  })

  test('updatePage changes only the fields present in the patch', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/update-me', description: 'original description' }),
      actor
    )

    const updated = await pagesModel.updatePage(
      fixtures.siteId,
      page.id,
      { title: 'Updated Title' },
      actor
    )

    assert.equal(updated!.title, 'Updated Title')
    // -> Untouched: not part of the patch
    assert.equal(updated!.description, 'original description')
  })

  test('updatePage returns null for a page that does not exist', async () => {
    const updated = await pagesModel.updatePage(
      fixtures.siteId,
      '00000000-0000-4000-8000-000000000000',
      { title: 'Anything' },
      actor
    )
    assert.equal(updated, null)
  })

  test('movePage relocates the page and its tree entry, and rejects a colliding destination', async () => {
    const source = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/move-source' }),
      actor
    )
    await pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/move-taken' }), actor)

    await assert.rejects(
      pagesModel.movePage(fixtures.siteId, source.id, { path: 'docs/move-taken' }, actor),
      /pageDuplicatePath/
    )

    const moved = await pagesModel.movePage(
      fixtures.siteId,
      source.id,
      { path: 'docs/move-destination', title: 'Moved' },
      actor
    )

    assert.equal(moved!.path, 'docs/move-destination')
    assert.equal(moved!.title, 'Moved')

    // -> The old path is free again, since the page that held it moved rather than staying to block it
    const reoccupied = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/move-source', title: 'Reoccupied' }),
      actor
    )
    assert.equal(reoccupied.path, 'docs/move-source')
  })

  test('movePage moving to its own current path is a no-op that still succeeds', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/stay-put' }),
      actor
    )
    const result = await pagesModel.movePage(
      fixtures.siteId,
      page.id,
      { path: 'docs/stay-put' },
      actor
    )
    assert.equal(result!.id, page.id)
    assert.equal(result!.path, 'docs/stay-put')
  })

  test('deletePage removes the page and frees its path for reuse', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/delete-me' }),
      actor
    )

    const deleted = await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    assert.equal(deleted, true)

    const fetched = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.equal(fetched, null)

    const recreated = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/delete-me', title: 'Recreated' }),
      actor
    )
    assert.equal(recreated.path, 'docs/delete-me')
  })

  test('deletePage returns false for a page that does not exist', async () => {
    const deleted = await pagesModel.deletePage(
      fixtures.siteId,
      '00000000-0000-4000-8000-000000000000',
      actor
    )
    assert.equal(deleted, false)
  })
})
