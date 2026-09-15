import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { CustomError } from '../helpers/common.ts'
import { pageRenderQueue as pageRenderQueueTable } from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * `pages.queueRerenderAllPages()` (OpenProject #3181) -- the model half of the Glossary admin
 * screen's "rerender all pages" bulk action: a loop over the same `renderQueue.queuePage()` every
 * ordinary save and the single-page Rerender action already use, not a new rendering mechanism.
 * DB-backed because what is under test IS the SQL selection (every markdown page of the site, and
 * only markdown pages) plus the resulting `pageRenderQueue` rows, not something a mock of the query
 * builder would meaningfully verify.
 */
describe(
  'pages.queueRerenderAllPages (DB-backed, OpenProject #3181)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let actor: PageActor
    let ensureCanRenderMock: ReturnType<typeof mock.method>

    before(async () => {
      fixtures = await setupTestDb()
      await seedLocale(fixtures.db, { code: 'en' })
      ;({ pages: pagesModel } = await import('./pages.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
      // -> Puppeteer is never installed in this test environment. Stubbed to succeed by default; the
      //    refusal itself gets its own narrower override below (mirrors `pages.test.ts`'s own
      //    OpenProject #1716 describe block).
      ensureCanRenderMock = mock.method(
        CARDINAL.models.renderQueue,
        'ensureCanRender',
        async () => {}
      )
    })

    after(async () => {
      mock.restoreAll()
      await teardownTestDb()
    })

    // -> Every test below creates its own pages, but `pageRenderQueue` rows a previous test left
    //    behind (there is nothing in these tests that ever drains the queue) would otherwise leak
    //    into the next test's `queuedPageIds()` read -- cleared so each test starts from an empty
    //    queue.
    beforeEach(async () => {
      await fixtures.db.delete(pageRenderQueueTable)
    })

    /**
     * `render: ''` on every create below is deliberate: it skips `createPage()`'s own up-front
     * `ensureCanRender()`/queue-on-create path (OpenProject #1716), so the only `pageRenderQueue`
     * rows each test sees are the ones `queueRerenderAllPages()` itself produces.
     */
    function pageInput(overrides: Partial<PageInput> = {}): PageInput {
      return {
        path: 'rerender-all/default',
        title: 'Default',
        editor: 'markdown',
        content: '# Hello',
        render: '',
        ...overrides
      }
    }

    async function queuedPageIds(): Promise<string[]> {
      const rows = await fixtures.db
        .select({ pageId: pageRenderQueueTable.pageId })
        .from(pageRenderQueueTable)
        .where(eq(pageRenderQueueTable.siteId, fixtures.siteId))
      return rows.map((r) => r.pageId)
    }

    // -> Assertions below check that the pages THIS test created are queued (and, for the
    //    non-markdown case, that the redirect page is not), rather than asserting the queue's exact
    //    contents -- `pages` rows earlier tests in this file created are never deleted (only
    //    `pageRenderQueue` is cleared per test), so a markdown page from an earlier test is a real,
    //    correctly-queued row here too, not test pollution to assert away.
    test('queues every markdown page on the site, including the count in its return value', async () => {
      const a = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'rerender-all/a' }),
        actor
      )
      const b = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'rerender-all/b' }),
        actor
      )

      const queued = await pagesModel.queueRerenderAllPages(fixtures.siteId, actor)
      const ids = await queuedPageIds()

      assert.equal(queued, ids.length)
      assert.ok(ids.includes(a.id))
      assert.ok(ids.includes(b.id))
    })

    test('skips a page whose editor is not markdown', async () => {
      const redirectPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'rerender-all/redirect',
          editor: 'redirect',
          content: JSON.stringify({
            kind: 'url',
            target: 'https://example.com',
            showInterstitial: false
          })
        }),
        actor
      )
      const markdownPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'rerender-all/markdown-only' }),
        actor
      )

      await pagesModel.queueRerenderAllPages(fixtures.siteId, actor)
      const ids = await queuedPageIds()

      assert.ok(ids.includes(markdownPage.id))
      assert.ok(!ids.includes(redirectPage.id))
    })

    test('refuses up front, queuing nothing, when this instance cannot render at all', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'rerender-all/refused' }),
        actor
      )
      ensureCanRenderMock.mock.mockImplementation(async () => {
        throw new CustomError('renderPuppeteerMissing', 'Rendering needs Puppeteer.', 503)
      })

      try {
        await assert.rejects(
          pagesModel.queueRerenderAllPages(fixtures.siteId, actor),
          /renderPuppeteerMissing/
        )
        assert.deepEqual(await queuedPageIds(), [])
      } finally {
        ensureCanRenderMock.mock.mockImplementation(async () => {})
      }
    })
  }
)
