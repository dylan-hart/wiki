import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { desc, eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  classificationLevels as classificationLevelsTable,
  users as usersTable
} from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
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
    /** The strictest configured level (highest `sortOrder`) -- distinct from `fixtures.classificationId`
     *  (the most-open one, which is also what a fallback to `defaultLevel()` would silently produce), so
     *  a recovery test that checks this round-trips proves the original level was actually preserved. */
    let restrictedLevelId: string

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ pageHistory: pageHistoryModel } = await import('./pageHistory.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

      const [strictest] = await fixtures.db
        .select({ id: classificationLevelsTable.id })
        .from(classificationLevelsTable)
        .orderBy(desc(classificationLevelsTable.sortOrder))
        .limit(1)
      restrictedLevelId = strictest!.id
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
      // -> OpenProject #1119: undefined `actor.via` defaults to 'editor', carried by both list() and
      //    getVersion() -- see `pageHistoryVia`'s doc comment for what this column is for.
      assert.equal(entries[0]!.via, 'editor')

      const version = await pageHistoryModel.getVersion(fixtures.siteId, page.id, entries[0]!.id)
      assert.ok(version)
      assert.equal(version!.locale, 'en')
      assert.equal(version!.via, 'editor')
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

    test('recoverDeletedPage recreates the page from its deleted version, preserving classification and queuing a re-render', async (t) => {
      const queueRerenderCalls: unknown[][] = []
      t.mock.method(pagesModel, 'queueRerender', async (...args: unknown[]) => {
        queueRerenderCalls.push(args)
        return true
      })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/recover-me',
          title: 'Recover Me',
          content: '# Recover Me\n\nOriginal content.',
          tags: ['keep-me'],
          classification: restrictedLevelId
        }),
        actor
      )
      assert.equal(page.classification, restrictedLevelId)
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
      // -> OpenProject #1672: not `fixtures.classificationId` (the most-open level, and what a silent
      //    fallback to `resolveCreateClassification`'s default branch would have produced instead).
      assert.equal(recovered.classification, restrictedLevelId)

      // -> A re-render is queued for the recovered page rather than left with the empty
      //    render/toc/searchContent `createPage` wrote (deleted versions never stored the rendered
      //    HTML -- see `EXCLUDED_FROM_META`).
      assert.equal(queueRerenderCalls.length, 1)
      assert.deepEqual(queueRerenderCalls[0], [fixtures.siteId, recovered.id, actor])

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

    test('recoverDeletedPage still succeeds when queueRerender throws', async (t) => {
      t.mock.method(pagesModel, 'queueRerender', async () => {
        throw new CustomError('renderPuppeteerMissing', 'Puppeteer is not installed.', 503)
      })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/recover-rerender-fails' }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const recoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = recoverable.find((row) => row.path === 'docs/recover-rerender-fails')
      assert.ok(entry)

      // -> Must not reject or leave the page uncreated: queueRerender is best-effort, caught and
      //    logged, not a hard dependency of a successful recovery.
      const recovered = await pageHistoryModel.recoverDeletedPage(fixtures.siteId, entry!.id, actor)
      assert.equal(recovered.path, 'docs/recover-rerender-fails')

      const fetched = await pagesModel.getPage({ siteId: fixtures.siteId, id: recovered.id })
      assert.ok(fetched)
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

    test('contributorCountsForGraph counts unique contributors per page, split by via', async () => {
      const [second] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'second@example.com',
          name: 'Second User',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      const [third] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'third@example.com',
          name: 'Third User',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/contributor-counts' }),
        actor
      )
      // -> createPage's own `created` record already counts `actor.id` (fixtures.userId) once via
      //    'editor'. Layer on: the same author again (no new unique contributor), a second
      //    editor-via author, and an mcp-via author -- so `editor` should land at 2, `mcp` at 1,
      //    `all` at 3.
      await pageHistoryModel.record({
        siteId: fixtures.siteId,
        pageId: page.id,
        action: 'updated',
        authorId: fixtures.userId,
        via: 'editor'
      })
      await pageHistoryModel.record({
        siteId: fixtures.siteId,
        pageId: page.id,
        action: 'updated',
        authorId: second!.id,
        via: 'editor'
      })
      await pageHistoryModel.record({
        siteId: fixtures.siteId,
        pageId: page.id,
        action: 'updated',
        authorId: third!.id,
        via: 'mcp'
      })

      const counts = await pageHistoryModel.contributorCountsForGraph(fixtures.siteId)
      // -> `total` is raw row counts, not distinct authors: 3 editor-via rows (createPage's own
      //    `created` row plus the two `record()` calls above) and 1 mcp-via row.
      assert.deepEqual(counts.get(page.id), {
        editor: 2,
        mcp: 1,
        all: 3,
        total: { editor: 3, mcp: 1, all: 4 }
      })
    })

    test('contributorCountsForGraph excludes edits by since-deleted authors from every count', async () => {
      const [ephemeral] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'ephemeral@example.com',
          name: 'Ephemeral User',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/deleted-author' }),
        actor
      )
      await pageHistoryModel.record({
        siteId: fixtures.siteId,
        pageId: page.id,
        action: 'updated',
        authorId: ephemeral!.id,
        via: 'editor'
      })
      await fixtures.db.delete(usersTable).where(eq(usersTable.id, ephemeral!.id))

      const counts = await pageHistoryModel.contributorCountsForGraph(fixtures.siteId)
      // -> `actor` (fixtures.userId) is still the sole surviving contributor from createPage's own
      //    `created` row; the deleted author's `updated` row's authorId went to null on cascade and
      //    is excluded, not counted as a synthetic contributor. `total`, unlike the unique fields,
      //    is NOT filtered to surviving authors -- both rows (the `created` row and the
      //    since-deleted author's `updated` row) still count as real edit-volume rows.
      assert.deepEqual(counts.get(page.id), {
        editor: 1,
        mcp: 0,
        all: 1,
        total: { editor: 2, mcp: 0, all: 2 }
      })
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
