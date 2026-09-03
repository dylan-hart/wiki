import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * End-to-end coverage of `movePage()`'s relink pass (OpenProject #2424/#2452/#2453): moving a page
 * updates every OTHER same-site page's stored link to it, with no dead link left behind. The pure
 * href-rewrite logic itself is covered without a database in `helpers/linkRewrite.test.ts` — this
 * suite is the SQL-orchestration half: `listBacklinks` actually finding the right candidates off a
 * real `pages.links` column, and the relink write actually landing through `updatePage()`.
 */
describe(
  'movePage relinks same-site referencing pages (DB-backed, OpenProject #2424/#2452/#2453)',
  {
    skip: !hasTestDatabase()
  },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let actor: PageActor

    before(async () => {
      fixtures = await setupTestDb()
      await seedLocale(fixtures.db, { code: 'en' })
      await seedLocale(fixtures.db, { code: 'fr' })
      ;({ pages: pagesModel } = await import('./pages.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    })

    after(async () => {
      mock.restoreAll()
      await teardownTestDb()
    })

    function pageInput(overrides: Partial<PageInput> = {}): PageInput {
      return {
        path: 'unset',
        title: 'Untitled',
        editor: 'markdown',
        content: 'placeholder',
        render: '<p>placeholder</p>',
        ...overrides
      }
    }

    test('rewrites a root-relative link on another page, in both render and content', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'relink/target-a', title: 'Target A' }),
        actor
      )
      const linker = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'relink/linker-a',
          title: 'Linker A',
          content: 'See [Target A](/relink/target-a).',
          render: '<p>See <a href="/relink/target-a">Target A</a>.</p>'
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'relink/target-a-moved' },
        actor
      )

      const relinked = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: linker.id,
        withContent: true
      })
      assert.equal(relinked!.render, '<p>See <a href="/relink/target-a-moved">Target A</a>.</p>')
      assert.equal(relinked!.content, 'See [Target A](/relink/target-a-moved).')
      // -> The rewritten render is re-derived through the normal `links` extraction, so it points the
      //    backlink index at the new path too -- a second move off the new path would still find it.
      const stillFindable = await pagesModel.listBacklinks(fixtures.siteId, 'relink/target-a-moved')
      assert.ok(stillFindable.some((row) => row.id === linker.id))
    })

    test('rewrites a folder-relative link, recomputed relative to the linking page', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'relink/sibling-b', title: 'Sibling B' }),
        actor
      )
      const linker = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'relink/linker-b',
          title: 'Linker B',
          content: '[Sibling B](sibling-b)',
          render: '<a href="sibling-b">Sibling B</a>'
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'relink/sibling-b-renamed' },
        actor
      )

      const relinked = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: linker.id,
        withContent: true
      })
      assert.equal(relinked!.render, '<a href="sibling-b-renamed">Sibling B</a>')
      assert.equal(relinked!.content, '[Sibling B](sibling-b-renamed)')
    })

    test('rewrites the moved page itself when its content links to itself', async () => {
      const selfLinking = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'relink/self-c',
          title: 'Self C',
          content: 'Back to [this page](/relink/self-c) anytime.',
          render: '<p>Back to <a href="/relink/self-c">this page</a> anytime.</p>'
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        selfLinking.id,
        { path: 'relink/self-c-moved' },
        actor
      )

      const moved = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: selfLinking.id,
        withContent: true
      })
      assert.equal(moved!.path, 'relink/self-c-moved')
      assert.equal(
        moved!.render,
        '<p>Back to <a href="/relink/self-c-moved">this page</a> anytime.</p>'
      )
      assert.equal(moved!.content, 'Back to [this page](/relink/self-c-moved) anytime.')
    })

    test('leaves a page with no reference to the moved page untouched', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'relink/target-d', title: 'Target D' }),
        actor
      )
      const unrelated = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'relink/unrelated-d',
          title: 'Unrelated D',
          content: 'Nothing to see here.',
          render: '<p>Nothing to see here.</p>'
        }),
        actor
      )
      const before = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: unrelated.id,
        withContent: true
      })

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'relink/target-d-moved' },
        actor
      )

      const after = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: unrelated.id,
        withContent: true
      })
      assert.equal(after!.render, before!.render)
      assert.equal(after!.content, before!.content)
      assert.deepEqual(after!.updatedAt, before!.updatedAt)
    })

    test('a locale-only move (path unchanged) triggers no relink', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'relink/locale-only-e', title: 'Locale Only E' }),
        actor
      )
      const linker = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'relink/linker-e',
          title: 'Linker E',
          content: '[Locale Only E](/relink/locale-only-e)',
          render: '<a href="/relink/locale-only-e">Locale Only E</a>'
        }),
        actor
      )
      const before = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: linker.id,
        withContent: true
      })

      // -> Title-only move: path stays put, so nothing references a stale path
      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'relink/locale-only-e', title: 'Retitled' },
        actor
      )

      const after = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: linker.id,
        withContent: true
      })
      assert.equal(after!.render, before!.render)
      assert.equal(after!.content, before!.content)
      assert.deepEqual(after!.updatedAt, before!.updatedAt)
    })

    test("includeTranslations cascade relinks off the primary's one shared old path, not once per twin", async () => {
      const en = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'relink/cascade-f', locale: 'en', title: 'Cascade F EN' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'relink/cascade-f', locale: 'fr', title: 'Cascade F FR' }),
        actor
      )
      const linker = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'relink/linker-f',
          title: 'Linker F',
          content: '[Cascade F](/relink/cascade-f)',
          render: '<a href="/relink/cascade-f">Cascade F</a>'
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        en.id,
        { path: 'relink/cascade-f-moved', includeTranslations: true },
        actor
      )

      const relinked = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: linker.id,
        withContent: true
      })
      assert.equal(relinked!.render, '<a href="/relink/cascade-f-moved">Cascade F</a>')
      assert.equal(relinked!.content, '[Cascade F](/relink/cascade-f-moved)')

      // -> Exactly one relink edit landed for the linking page, not one per twin in the cascade
      const history = await WIKI.models.pageHistory.list(fixtures.siteId, linker.id)
      const relinkEdits = history.items.filter(
        (row: { action: string }) => row.action === 'updated'
      )
      assert.equal(relinkEdits.length, 1)
    })

    test('does not rewrite an unrelated link that merely shares a path prefix', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'relink/target-g', title: 'Target G' }),
        actor
      )
      const linker = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'relink/linker-g',
          title: 'Linker G',
          content: '[Not it](/relink/target-g-extended)',
          render: '<a href="/relink/target-g-extended">Not it</a>'
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'relink/target-g-moved' },
        actor
      )

      const untouched = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: linker.id,
        withContent: true
      })
      assert.equal(untouched!.render, '<a href="/relink/target-g-extended">Not it</a>')
    })
  }
)
