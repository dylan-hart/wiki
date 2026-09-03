import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, desc, eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  classificationLevels as classificationLevelsTable,
  pageHistory as pageHistoryTable,
  pageRenderQueue as pageRenderQueueTable,
  users as usersTable
} from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * `list`, `listRecoverable` and `recoverDeletedPage` are SQL orchestration (a keyset-paginated query,
 * a `DISTINCT ON` + `NOT EXISTS` query, and a reconstruct-then-`createPage` write path) rather than
 * pure logic, so — like `models/pages.test.ts` — this suite runs the real methods against a migrated,
 * per-run-fresh database (see `test/db.ts`) rather than mocking the query builder.
 */
describe(
  'pageHistory list/listRecoverable/recoverDeletedPage (DB-backed)',
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

      const { items: entries } = await pageHistoryModel.list(fixtures.siteId, page.id)
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
        pageInput({ path: 'docs/recoverable-one', title: 'First Title', tags: ['keep-me'] }),
        actor
      )
      await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Second Title' }, actor)
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const { items, nextCursor } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = items.find((row) => row.path === 'docs/recoverable-one')
      assert.ok(entry, 'the deleted page should be listed as recoverable')
      assert.equal(entry!.action, 'deleted')
      assert.equal(entry!.title, 'Second Title')
      assert.equal(entry!.locale, 'en')
      // -> OpenProject #2168: tags/classification are carried so a caller can run `mayOnPage()`
      //    against the deleted path with a TAG/TAGALL/CLASSIFICATION rule, and the author's email is
      //    left out of this row's shape entirely (unlike `list()`'s single-page history), since this
      //    listing spans every deleted path on the site in one sweep.
      assert.deepEqual(entry!.tags, ['keep-me'])
      assert.ok(entry!.classification, 'a page always has a classification')
      assert.ok(entry!.author.name, 'the author name is still carried, unlike the email')
      // -> Well under the default limit, so there is nothing left to page to
      assert.equal(nextCursor, null)
    })

    test('listRecoverable carries tags/classification and no author email (OpenProject #2168)', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/recoverable-tagged', tags: ['gamma'] }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const { items } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = items.find((row) => row.path === 'docs/recoverable-tagged')
      assert.ok(entry)
      // -> Lets the route narrow its `read:history` check with TAG/TAGALL/CLASSIFICATION rules, not
      //    just a bare path/locale match.
      assert.deepEqual(entry!.tags, ['gamma'])
      assert.equal(typeof entry!.classification, 'string')
      // -> No `email` anywhere on the row: this listing is reachable by a caller who does NOT hold
      //    `read:pages` at the deleted path, so it must not hand back the deleting/creating author's
      //    email address.
      assert.equal((entry!.author as any).email, undefined)
      assert.equal('email' in entry!.author, false)
    })

    test('getDeletedVersion carries tags/classification pulled out of meta (OpenProject #2168)', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/deleted-version-tags', tags: ['delta'] }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const { items } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = items.find((row) => row.path === 'docs/deleted-version-tags')
      assert.ok(entry)

      const version = await pageHistoryModel.getDeletedVersion(fixtures.siteId, entry!.id)
      assert.ok(version)
      assert.deepEqual(version!.tags, ['delta'])
      assert.equal(typeof version!.classification, 'string')
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

      const { items } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      assert.equal(
        items.some((row) => row.path === 'docs/reused-path'),
        false
      )
    })

    test('listRecoverable omits a path with no deletions at all', async () => {
      await pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/never-deleted' }), actor)

      const { items } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      assert.equal(
        items.some((row) => row.path === 'docs/never-deleted'),
        false
      )
    })

    /**
     * Deletes a page, then backdates its `deleted` history row to a fixed `versionDate` -- so a
     * pagination test can control ordering (and force ties) instead of depending on real wall-clock
     * gaps between calls in the same test run.
     */
    async function deletePageAt(pageId: string, versionDate: Date) {
      await pagesModel.deletePage(fixtures.siteId, pageId, actor)
      await fixtures.db
        .update(pageHistoryTable)
        .set({ versionDate })
        .where(and(eq(pageHistoryTable.pageId, pageId), eq(pageHistoryTable.action, 'deleted')))
    }

    test('listRecoverable pages through more deletions than the limit with no gaps or repeats', async () => {
      const base = new Date('2026-01-01T00:00:00.000Z')
      const paths = Array.from({ length: 6 }, (_, i) => `docs/paginate-${i}`)
      for (const [i, path] of paths.entries()) {
        const page = await pagesModel.createPage(fixtures.siteId, pageInput({ path }), actor)
        // -> Newest (index 0) gets the latest versionDate, so descending order is `paginate-0` first
        await deletePageAt(page.id, new Date(base.getTime() + (paths.length - i) * 60_000))
      }

      const seen: string[] = []
      let cursor: string | undefined
      let pageCount = 0
      for (;;) {
        const { items, nextCursor } = await pageHistoryModel.listRecoverable(fixtures.siteId, {
          limit: 2,
          cursor
        })
        pageCount++
        assert.ok(items.length <= 2, 'never returns more than the requested limit')
        seen.push(...items.filter((row) => paths.includes(row.path)).map((row) => row.path))
        if (!nextCursor) {
          break
        }
        cursor = nextCursor
        // -> Generous bound, not a tight one: earlier tests in this suite leave their own recoverable
        //    rows in the same site, so this loop also has to page past those. The point of the bound
        //    is only to fail loudly if a cursor never nulls out, rather than hang forever.
        assert.ok(
          pageCount <= paths.length + 20,
          'a cursor that never nulls out would loop forever'
        )
      }

      // -> Every seeded path appeared, in strictly descending versionDate order, none twice
      assert.deepEqual(seen, paths)
    })

    test('listRecoverable keeps a stable order across a versionDate tie via the id tiebreak', async () => {
      // -> Far in the future, deliberately: guarantees these two rows sort ahead of every other
      //    row this suite creates (real `now()` timestamps included), so `limit: 1` below is certain
      //    to land on one of the tied pair rather than something else deleted since.
      const tiedAt = new Date('2099-01-01T00:00:00.000Z')
      const pageA = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/tie-a' }),
        actor
      )
      const pageB = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/tie-b' }),
        actor
      )
      await deletePageAt(pageA.id, tiedAt)
      await deletePageAt(pageB.id, tiedAt)

      const first = await pageHistoryModel.listRecoverable(fixtures.siteId, { limit: 1 })
      const tiedPaths = ['docs/tie-a', 'docs/tie-b']
      assert.equal(first.items.length, 1)
      assert.ok(tiedPaths.includes(first.items[0]!.path))
      assert.ok(first.nextCursor, 'one of the tied pair remains for a second page')

      const second = await pageHistoryModel.listRecoverable(fixtures.siteId, {
        limit: 1,
        cursor: first.nextCursor!
      })
      assert.equal(second.items.length, 1)
      // -> The id tiebreak means the second page names the OTHER tied row, not the same one again
      assert.notEqual(second.items[0]!.path, first.items[0]!.path)
      assert.ok(tiedPaths.includes(second.items[0]!.path))
    })

    test('recoverDeletedPage recreates the page from its deleted version, preserving classification and queuing a re-render', async () => {
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

      const { items } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = items.find((row) => row.path === 'docs/recover-me')
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
      //    HTML -- see `EXCLUDED_FROM_META`). `createPage()` itself does the queuing now, with no
      //    separate call from `recoverDeletedPage` (OpenProject #1716/#1723), so this asserts the
      //    real `pageRenderQueue` row rather than mocking a `queueRerender` call.
      const queued = await fixtures.db
        .select({ id: pageRenderQueueTable.id })
        .from(pageRenderQueueTable)
        .where(eq(pageRenderQueueTable.pageId, recovered.id))
      assert.equal(queued.length, 1)

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
        stillRecoverable.items.some((row) => row.path === 'docs/recover-me'),
        false
      )
    })

    /**
     * OpenProject #2232: `meta.password`, copied verbatim off the deleted row, is already a `bcrypt`
     * verifier by the time it reaches `recoverDeletedPage` -- not a plaintext for `createPage()` to
     * hash again. Feeding it through as an ordinary `PageInput.password` would hash the hash, and the
     * original password would never unlock the recovered page again. This proves the real one still
     * works after a delete/recover round trip.
     */
    test('recoverDeletedPage preserves a working password, without re-hashing the stored verifier', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/recover-with-password', password: 'sw0rdfish' }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const { items: recoverable } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = recoverable.find((row) => row.path === 'docs/recover-with-password')
      assert.ok(entry)

      const recovered = await pageHistoryModel.recoverDeletedPage(fixtures.siteId, entry!.id, actor)

      const unlocked = await pagesModel.unlockPage({
        siteId: fixtures.siteId,
        id: recovered.id,
        password: 'sw0rdfish'
      })
      assert.ok(unlocked, 'the original password must still unlock the recovered page')

      const rejected = await pagesModel.unlockPage({
        siteId: fixtures.siteId,
        id: recovered.id,
        password: 'wrong-guess'
      })
      assert.equal(rejected, null)
    })

    test('recoverDeletedPage refuses up front when ensureCanRender fails, and leaves the page recoverable', async (t) => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/recover-rerender-fails' }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const { items: recoverable } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = recoverable.find((row) => row.path === 'docs/recover-rerender-fails')
      assert.ok(entry)

      // -> Applied only now, after the page to be recovered already exists -- `createPage()`'s own
      //    up-front `ensureCanRender()` check (OpenProject #1716) must not also block seeding the
      //    fixture above.
      t.mock.method(WIKI.models.renderQueue, 'ensureCanRender', async () => {
        throw new CustomError('renderPuppeteerMissing', 'Puppeteer is not installed.', 503)
      })

      // -> `createPage()` confirms `ensureCanRender()` *before* the write, and `recoverDeletedPage`
      //    has nothing of its own left to catch that with (OpenProject #1723) -- a recovery nothing
      //    here could ever render refuses outright rather than recreating a page that stays
      //    permanently blank.
      await assert.rejects(
        () => pageHistoryModel.recoverDeletedPage(fixtures.siteId, entry!.id, actor),
        /Puppeteer is not installed\./
      )

      const stillRecoverable = await pageHistoryModel.listRecoverable(fixtures.siteId)
      assert.ok(stillRecoverable.items.some((row) => row.path === 'docs/recover-rerender-fails'))
    })

    test('recoverDeletedPage applies a path/locale override', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/recover-with-override' }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const { items } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = items.find((row) => row.path === 'docs/recover-with-override')
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

    test('getDeletedVersion returns the tags and classification the page held when deleted', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/deleted-version-fields', tags: ['tagged'] }),
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const { items: recoverable } = await pageHistoryModel.listRecoverable(fixtures.siteId)
      const entry = recoverable.find((row) => row.path === 'docs/deleted-version-fields')
      assert.ok(entry)

      const version = await pageHistoryModel.getDeletedVersion(fixtures.siteId, entry!.id)
      assert.ok(version)
      assert.equal(version!.path, 'docs/deleted-version-fields')
      assert.deepEqual(version!.tags, ['tagged'])
      assert.ok(version!.classification, 'a page always has a classification')
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
      const { items: entries } = await pageHistoryModel.list(fixtures.siteId, page.id)
      // -> The only version so far is the `created` row, not a `deleted` one
      await assert.rejects(
        pageHistoryModel.recoverDeletedPage(fixtures.siteId, entries[0]!.id, actor)
      )
    })

    test('list() paginates by cursor: stable, non-overlapping pages across a history longer than the default limit', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/long-history' }),
        actor
      )
      // -> createPage's own `created` row is version 1; 59 more `updated` rows makes 60 total,
      //    comfortably past the default 50-row page size
      for (let i = 0; i < 59; i++) {
        await pageHistoryModel.record({
          siteId: fixtures.siteId,
          pageId: page.id,
          action: 'updated',
          authorId: fixtures.userId,
          changedFields: ['title']
        })
      }

      const firstPage = await pageHistoryModel.list(fixtures.siteId, page.id, { limit: 50 })
      assert.equal(firstPage.items.length, 50)
      assert.ok(firstPage.nextCursor, 'a 60-row history at a 50-row page size has a next page')

      const secondPage = await pageHistoryModel.list(fixtures.siteId, page.id, {
        limit: 50,
        cursor: firstPage.nextCursor
      })
      assert.equal(secondPage.items.length, 10)
      assert.equal(secondPage.nextCursor, null, 'the last page has nothing after it')

      // -> Non-overlapping: no id appears on both pages
      const firstIds = new Set(firstPage.items.map((row) => row.id))
      const overlap = secondPage.items.filter((row) => firstIds.has(row.id))
      assert.deepEqual(overlap, [])

      // -> Stable and newest-first across the boundary: every id from both pages together, in order,
      //    equals a single unpaginated fetch at the full size
      const whole = await pageHistoryModel.list(fixtures.siteId, page.id, { limit: 200 })
      assert.deepEqual(
        [...firstPage.items, ...secondPage.items].map((row) => row.id),
        whole.items.map((row) => row.id)
      )
    })

    test('list() never includes an author email in its projection', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/no-author-email' }),
        actor
      )
      const { items } = await pageHistoryModel.list(fixtures.siteId, page.id)
      assert.ok(items.length > 0)
      for (const item of items) {
        assert.equal('email' in item.author, false)
      }
    })

    test('list() rejects a malformed cursor', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/bad-cursor' }),
        actor
      )
      await assert.rejects(
        pageHistoryModel.list(fixtures.siteId, page.id, { cursor: 'not-a-real-cursor' })
      )
    })
  }
)
