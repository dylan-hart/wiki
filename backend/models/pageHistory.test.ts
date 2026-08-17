import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * `listRecoverable` and `recoverDeletedPage` are SQL orchestration (a `DISTINCT ON` + `NOT EXISTS`
 * query, and a reconstruct-then-`createPage` write path) rather than pure logic, so — like
 * `models/pages.test.ts` — this suite runs the real methods against a migrated, per-run-fresh
 * database (see `test/db.ts`) rather than mocking the query builder.
 */
describe(
  'pageHistory listRecoverable/recoverDeletedPage (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let pageHistoryModel: typeof import('./pageHistory.ts').pageHistory
    let actor: PageActor

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ pageHistory: pageHistoryModel } = await import('./pageHistory.ts'))
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
        description: 'A test page',
        icon: 'mdi:file',
        tags: ['alpha', 'beta'],
        ...overrides
      }
    }

    test('list() and getVersion() carry the locale of each row', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/locale-carried', locale: 'en' }),
        actor
      )

      const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.locale, 'en')

      const version = await pageHistoryModel.getVersion(fixtures.siteId, page.id, entries[0]!.id)
      assert.ok(version)
      assert.equal(version!.locale, 'en')
    })

    test('listRecoverable lists the newest deleted version for a path with no live page', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/recoverable-one', title: 'First Title' }),
        actor
      )
      await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Second Title' }, actor)
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const recoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = recoverable.find((row) => row.path === 'docs/recoverable-one')
      assert.ok(entry, 'the deleted page should be listed as recoverable')
      assert.equal(entry!.action, 'deleted')
      assert.equal(entry!.title, 'Second Title')
      assert.equal(entry!.locale, 'en')
    })

    test('listRecoverable omits a path that was deleted and then reused', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/reused-path' }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/reused-path', title: 'Reused' }),
        actor
      )

      const recoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      assert.equal(
        recoverable.some((row) => row.path === 'docs/reused-path'),
        false
      )
    })

    test('listRecoverable omits a path with no deletions at all', async () => {
      await pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/never-deleted' }), actor)

      const recoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      assert.equal(
        recoverable.some((row) => row.path === 'docs/never-deleted'),
        false
      )
    })

    test('recoverDeletedPage recreates the page from its deleted version', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/recover-me',
          title: 'Recover Me',
          content: '# Recover Me\n\nOriginal content.',
          tags: ['keep-me']
        }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const recoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = recoverable.find((row) => row.path === 'docs/recover-me')
      assert.ok(entry)

      const recovered = await pageHistoryModel.recoverDeletedPage(fixtures.siteId, entry!.id, actor)

      assert.equal(recovered.path, 'docs/recover-me')
      assert.equal(recovered.locale, 'en')
      assert.equal(recovered.title, 'Recover Me')
      assert.deepEqual(recovered.tags, ['keep-me'])
      assert.equal(recovered.description, 'A test page')
      assert.equal(recovered.icon, 'mdi:file')

      const fetched = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: recovered.id,
        withContent: true
      })
      assert.ok(fetched)
      assert.equal(fetched!.content, '# Recover Me\n\nOriginal content.')

      // -> Recovered, so it is no longer a candidate for recovery again
      const stillRecoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      assert.equal(
        stillRecoverable.some((row) => row.path === 'docs/recover-me'),
        false
      )
    })

    test('recoverDeletedPage applies a path/locale override', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/recover-with-override' }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const recoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = recoverable.find((row) => row.path === 'docs/recover-with-override')
      assert.ok(entry)

      const recovered = await pageHistoryModel.recoverDeletedPage(
        fixtures.siteId,
        entry!.id,
        actor,
        {
          path: 'docs/recover-with-override-2'
        }
      )

      assert.equal(recovered.path, 'docs/recover-with-override-2')
    })

    test('recoverDeletedPage refuses an unknown or non-deleted version id', async () => {
      await assert.rejects(
        pageHistoryModel.recoverDeletedPage(
          fixtures.siteId,
          '00000000-0000-4000-8000-000000000000',
          actor
        )
      )

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/still-alive' }),
        actor
      )
      const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
      // -> The only version so far is the `created` row, not a `deleted` one
      await assert.rejects(
        pageHistoryModel.recoverDeletedPage(fixtures.siteId, entries[0]!.id, actor)
      )
    })
  }
)
