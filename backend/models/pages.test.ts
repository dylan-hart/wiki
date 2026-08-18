import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
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

  test('createPage stores the code editor content as html, matching EDITOR_CONTENT_TYPES', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/code-page',
        title: 'Code Page',
        editor: 'code',
        content: '<p>Raw HTML</p>'
      }),
      actor
    )

    assert.equal(page.contentType, 'html')
  })

  /**
   * Task 491: locks the `pages.ts` side of the asciidoc contentType agreement -- `base.test.ts`'s
   * "base.yml declares the asciidoc editor with asciidoc as its content type" locks the `base.yml`
   * side. Before this task the two disagreed (`base.yml` said `html`, `EDITOR_CONTENT_TYPES.asciidoc`
   * said `asciidoc`); this is what a real save actually produces.
   */
  test('createPage stores the asciidoc editor content as asciidoc, matching EDITOR_CONTENT_TYPES', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/asciidoc-page',
        title: 'AsciiDoc Page',
        editor: 'asciidoc',
        content: '= Title\n\nSome asciidoc content.'
      }),
      actor
    )

    assert.equal(page.contentType, 'asciidoc')
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

  describe('listPagesForSitemap', () => {
    /**
     * `fixtures.groupId` stands in for the guests group here: `WIKI.data.systemIds.guestsGroupId` is
     * only ever a fixed UUID looked up at runtime, not something `setupTestDb()` seeds meaning into,
     * so pointing it at the fixture group and writing rules onto that group exercises the exact same
     * `rulesForGroups` / `helpers/pageRules.ts` path a real anonymous request would go through.
     */
    async function setGuestRules(rules: any[]): Promise<void> {
      WIKI.data = { systemIds: { guestsGroupId: fixtures.groupId } }
      await fixtures.db
        .update(groupsTable)
        .set({ rules })
        .where(eq(groupsTable.id, fixtures.groupId))
      await WIKI.models.groups.reloadCache()
    }

    test('lists published, browsable pages the guests group may read, and nothing else', async () => {
      await setGuestRules([
        {
          id: 'allow-all',
          name: 'Allow',
          roles: ['read:pages'],
          match: 'START',
          mode: 'ALLOW',
          path: '',
          locales: [],
          sites: []
        }
      ])

      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'sitemap/visible', title: 'Visible' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'sitemap/draft', title: 'Draft', publishState: 'draft' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'sitemap/unbrowsable', title: 'Hidden', isBrowsable: false }),
        actor
      )

      const listed = await pagesModel.listPagesForSitemap(fixtures.siteId)
      const paths = listed.map((p) => p.path)

      assert.ok(paths.includes('sitemap/visible'))
      assert.ok(!paths.includes('sitemap/draft'))
      assert.ok(!paths.includes('sitemap/unbrowsable'))

      const visible = listed.find((p) => p.path === 'sitemap/visible')
      assert.equal(visible!.locale, 'en')
      assert.ok(visible!.updatedAt instanceof Date)
    })

    test('excludes a page the guests group is denied, even when published and browsable', async () => {
      await setGuestRules([
        {
          id: 'allow-all',
          name: 'Allow',
          roles: ['read:pages'],
          match: 'START',
          mode: 'ALLOW',
          path: '',
          locales: [],
          sites: []
        },
        {
          id: 'deny-private',
          name: 'Deny private',
          roles: ['read:pages'],
          match: 'START',
          mode: 'DENY',
          path: 'sitemap/private',
          locales: [],
          sites: []
        }
      ])

      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'sitemap/private', title: 'Private' }),
        actor
      )

      const listed = await pagesModel.listPagesForSitemap(fixtures.siteId)
      assert.ok(!listed.some((p) => p.path === 'sitemap/private'))
    })

    test('lists nothing when the guests group has no rules at all', async () => {
      await setGuestRules([])

      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'sitemap/no-rules', title: 'No Rules' }),
        actor
      )

      const listed = await pagesModel.listPagesForSitemap(fixtures.siteId)
      assert.ok(!listed.some((p) => p.path === 'sitemap/no-rules'))
    })
  })
})
