import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { CustomError, generatePathHash } from '../helpers/common.ts'
import { groups as groupsTable } from '../db/schema.ts'
import {
  pageDrafts as pageDraftsTable,
  pageRenderQueue as pageRenderQueueTable,
  pages as pagesTable,
  pageWatchEvents as pageWatchEventsTable,
  sites as sitesTable,
  tree as treeTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'
import type { GroupRule } from './groups.ts'
import { mail } from './mail.ts'
import { task as notifyPageWatchers } from '../tasks/simple/notify-page-watchers.ts'

/**
 * A tree row by id, read straight off the table.
 *
 * `tree.getById()` is private (it is the model's one lookup that takes no `siteId`), so a test that
 * wants to see what a page write left in the tree reads the row itself rather than through the model.
 */
async function readTreeRow(id: string) {
  const rows = await WIKI.db.select().from(treeTable).where(eq(treeTable.id, id)).limit(1)
  return rows[0] ?? null
}

/**
 * `models/pages.ts`'s create/update/move/delete are almost entirely SQL — inserts, duplicate-path
 * checks, and coordination with the tree and history tables — so a mock of the query builder would
 * mostly be re-describing the code under test rather than verifying it. This suite runs the real
 * methods against a migrated, per-run-fresh database (see `test/db.ts`).
 */
describe('pages create/update/move/delete (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let pageClassificationModel: typeof import('./pageClassification.ts').pageClassification
  let actor: PageActor
  // -> A single wrap for the whole describe block, its implementation swapped per-test via
  //    `.mock.mockImplementation()` rather than re-mocking with `mock.method()` again: node:test's
  //    `mock.restoreAll()` unwinds nested `mock.method()` wraps back to whatever the PREVIOUS wrap's
  //    "original" was, not all the way to the true original, when a target is re-mocked more than
  //    once without an intermediate `.mock.restore()` -- one wrap kept alive for the whole block and
  //    reconfigured in place is what makes `after()`'s `restoreAll()` land back on the real thing.
  let ensureCanRenderMock: ReturnType<typeof mock.method>

  before(async () => {
    fixtures = await setupTestDb()
    // -> Seeded before any model call, so the very first `getLocales()` cache fill already sees them
    //    — `isReservedLocaleCode()`'s "installed, not per-site-active" reserved-segment checks need at
    //    least the site's own active codes to actually be installed.
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ pageClassification: pageClassificationModel } = await import('./pageClassification.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    // -> Puppeteer is never installed in this test environment, so a real `ensureCanRender()` would
    //    refuse every renderless create/update below -- and almost none of these SQL-orchestration
    //    tests supply a `render`. Stubbed to succeed here; the refusal itself, and the queued
    //    rerender it unlocks, get their own dedicated tests further down with a narrower override
    //    (OpenProject #1716).
    ensureCanRenderMock = mock.method(WIKI.models.renderQueue, 'ensureCanRender', async () => {})
  })

  after(async () => {
    mock.restoreAll()
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

  /**
   * Minimal `.values()` object satisfying every NOT NULL column, for a raw insert that bypasses
   * `createPage()`'s own duplicate-path probe entirely -- this is what proves the uniqueness is a
   * database constraint, not just an application-level check.
   */
  function rawPageRow(overrides: { path: string; locale: string; siteId: string }) {
    return {
      locale: overrides.locale,
      path: overrides.path,
      hash: `raw-hash-${overrides.path}-${overrides.locale}`,
      title: 'Raw Row',
      editor: 'markdown',
      contentType: 'markdown',
      authorId: fixtures.userId,
      creatorId: fixtures.userId,
      ownerId: fixtures.userId,
      siteId: overrides.siteId,
      classification: fixtures.classificationId
    }
  }

  test('the database itself rejects a duplicate (siteId, locale, path) even bypassing the model', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'unique/dupe-probe', locale: 'en' }),
      actor
    )
    await assert.rejects(
      fixtures.db
        .insert(pagesTable)
        .values(rawPageRow({ path: 'unique/dupe-probe', locale: 'en', siteId: fixtures.siteId })),
      (err: any) => (err.cause?.code ?? err.code) === '23505'
    )
  })

  /**
   * `pages.classification` carries no column default (OpenProject #1705) -- the one-time backfill
   * that justified defaulting to the fixed `classificationPublicId` system row has already run, and
   * a bare column default would otherwise keep naming that row even after an administrator deletes
   * it. An insert that omits it entirely must therefore fail loudly (a NOT NULL violation) rather
   * than silently default to a level that may no longer exist. `as any` bypasses the compile-time
   * protection the same change gives real callers (`.values()` now requires `classification`), since
   * this test's whole point is proving the database itself refuses a row without one.
   */
  test('an insert omitting classification is rejected, not silently defaulted', async () => {
    const { classification: _omitted, ...rowWithoutClassification } = rawPageRow({
      path: 'unique/no-classification',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await assert.rejects(
      fixtures.db.insert(pagesTable).values(rowWithoutClassification as any),
      (err: any) => (err.cause?.code ?? err.code) === '23502'
    )
  })

  test('the same path in two locales coexists', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'unique/two-locales', locale: 'en' }),
      actor
    )
    const fr = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'unique/two-locales', locale: 'fr', title: 'Deux Locales' }),
      actor
    )
    assert.equal(fr.locale, 'fr')
  })

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

  test('createPage() records the pageHistory row as via: editor when the actor names no via (OpenProject #1119)', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/via-default' }),
      actor
    )
    const { pageHistory: pageHistoryModel } = await import('./pageHistory.ts')
    const { items: entries } = await pageHistoryModel.list(fixtures.siteId, page.id)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.via, 'editor')
  })

  test('createPage()/updatePage() record the pageHistory row as via: mcp when the actor says so (OpenProject #1119)', async () => {
    const mcpActor: PageActor = { ...actor, via: 'mcp' }
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/via-mcp' }),
      mcpActor
    )
    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Updated via MCP' }, mcpActor)

    const { pageHistory: pageHistoryModel } = await import('./pageHistory.ts')
    const { items: entries } = await pageHistoryModel.list(fixtures.siteId, page.id)
    // -> Newest first: [0] is the update, [1] is the creation -- both attributed to the same actor.
    assert.equal(entries.length, 2)
    assert.equal(entries[0]!.via, 'mcp')
    assert.equal(entries[1]!.via, 'mcp')
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

  test('a create race on the same path surfaces as a 409 CustomError, not a raw 23505', async () => {
    // -> Both calls race the same probe-then-insert: either may lose at the probe (the ordinary
    //    duplicate-path check) or at the insert itself (the unique index Task 1 added). Exactly one
    //    of the two outcomes happens depending on interleaving, but the assertion holds either way --
    //    which is the point of this test.
    const input = () => pageInput({ path: 'unique/race-probe', locale: 'en' })
    const results = await Promise.allSettled([
      pagesModel.createPage(fixtures.siteId, input(), actor),
      pagesModel.createPage(fixtures.siteId, input(), actor)
    ])
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    assert.equal(results.length - rejected.length, 1)
    for (const r of rejected) {
      assert.equal((r.reason as any).statusCode, 409)
      assert.equal((r.reason as any).name, 'pageDuplicatePath')
    }
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
   * Task 491: locks `EDITOR_CONTENT_TYPES.asciidoc` mapping to `'asciidoc'`, not `'html'` -- this is
   * what a real save actually produces.
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

  test('createPage refuses a locale the site does not have enabled', async () => {
    await assert.rejects(
      pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/no-such-locale', locale: 'de' }),
        actor
      ),
      /pageInvalidLocale/
    )
  })

  test('a page path whose first segment is an installed locale code is rejected', async () => {
    await assert.rejects(
      pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'fr/shadowed', locale: 'en' }),
        actor
      ),
      (err: any) => err.name === 'pageReservedLocaleSegment'
    )
  })

  test('a NESTED segment matching an installed locale code is fine — only the first segment shadows', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/fr/nested-ok', locale: 'en' }),
      actor
    )
    assert.equal(page.path, 'docs/fr/nested-ok')
  })

  test('createPage() preserves PageInput.createdAt/updatedAt instead of stamping import time', async () => {
    // -> Regression test for OpenProject #835 / upstream requarks/wiki#4631 ("Importing from Local
    //    File System is ignoring dateCreated and date fields"): the migration importer's whole reason
    //    for supplying these fields is to carry a source page's real timestamps across rather than
    //    letting createPage()'s ordinary now() default silently overwrite them with import time.
    const sourceCreatedAt = '2019-03-14T08:00:00.000Z'
    const sourceUpdatedAt = '2021-11-02T17:30:00.000Z'

    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/backdated-page',
        createdAt: sourceCreatedAt,
        updatedAt: sourceUpdatedAt
      }),
      actor
    )

    assert.equal(page.createdAt.toISOString(), sourceCreatedAt)
    assert.equal(page.updatedAt.toISOString(), sourceUpdatedAt)

    // The pageHistory row createPage() writes for the page's initial state must be dated the same
    // real updatedAt, not the moment this test ran — otherwise a page imported with genuinely old
    // history would show a "created" entry timestamped today at the top of its timeline.
    const { pageHistory: pageHistoryModel } = await import('./pageHistory.ts')
    const { items: entries } = await pageHistoryModel.list(fixtures.siteId, page.id)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.versionDate.toISOString(), sourceUpdatedAt)
  })

  test('createPage() with no createdAt/updatedAt keeps the ordinary now() default', async () => {
    const before = Date.now()
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/ordinary-page' }),
      actor
    )
    const after = Date.now()

    assert.ok(page.createdAt.getTime() >= before && page.createdAt.getTime() <= after)
    assert.ok(page.updatedAt.getTime() >= before && page.updatedAt.getTime() <= after)
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

  test('updatePage syncs the tree row even when only the description changed (OpenProject #1709)', async () => {
    // -> Description is handled by a separate branch that never touches `treeTable`, so before this
    //    fix the tree write's guard (`treeTitle !== null || patch.tags !== undefined`) skipped
    //    entirely -- leaving `meta.description` (what the file manager reads) and `updatedAt` (what
    //    an `updatedAt`-ordered listing sorts by) stale on a description-only edit.
    //
    // -> `Temporal` is a Node 26 global needing no import (CLAUDE.md), but this sandbox's `node` is
    //    older and doesn't expose it (same environment gap `api/pages.test.ts`'s own
    //    `installFakeTemporal` documents). Installed only when genuinely missing, so a real Node 26
    //    run exercises the native API.
    const previousTemporal = (globalThis as any).Temporal
    const previousToTemporalInstant = (Date.prototype as any).toTemporalInstant
    if (typeof previousTemporal === 'undefined') {
      ;(globalThis as any).Temporal = {
        Instant: {
          compare: (a: { epochMilliseconds: number }, b: { epochMilliseconds: number }) =>
            Math.sign(a.epochMilliseconds - b.epochMilliseconds)
        }
      }
      ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
        return { epochMilliseconds: this.getTime() }
      }
    }

    try {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/description-only', description: 'original description' }),
        actor
      )
      const beforeTree = await readTreeRow(page.id)
      assert.equal((beforeTree!.meta as Record<string, any>).description, 'original description')

      // -> A later `updatedAt` than the create-time row requires actual elapsed time between the two
      //    writes; both use `sql\`now()\`` so a Node-side sleep is enough to force the difference.
      await new Promise((resolve) => setTimeout(resolve, 10))

      const updated = await pagesModel.updatePage(
        fixtures.siteId,
        page.id,
        { description: 'updated description' },
        actor
      )
      assert.equal(updated!.description, 'updated description')

      const afterTree = await readTreeRow(page.id)
      assert.equal((afterTree!.meta as Record<string, any>).description, 'updated description')
      assert.ok(
        Temporal.Instant.compare(
          afterTree!.updatedAt.toTemporalInstant(),
          beforeTree!.updatedAt.toTemporalInstant()
        ) > 0
      )
    } finally {
      if (typeof previousTemporal === 'undefined') {
        ;(globalThis as any).Temporal = previousTemporal
        ;(Date.prototype as any).toTemporalInstant = previousToTemporalInstant
      }
    }
  })

  test("updatePage keeps the page's original editor even if the patch names a different one", async () => {
    // -> The invariant `PageHistoryOverlay.vue`'s `restoreVersion`/`branchFrom` rely on: a page's
    //    editor is fixed at creation (see the comment on `updatePage`, "which editor authored a page
    //    is not something a save may change"), so every version ever recorded for a given page was
    //    written by the same editor the page still has today. That is what makes a same-page restore
    //    structurally unable to hit a genuine editor-type mismatch -- there is no format-conversion
    //    feature that could have made a version disagree with its own page.
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/editor-locked', editor: 'markdown' }),
      actor
    )

    const updated = await pagesModel.updatePage(fixtures.siteId, page.id, { editor: 'html' }, actor)

    assert.equal(updated!.editor, 'markdown')
  })

  test("updatePage's tree meta stays accurate after a retitle, with no creatorId/ownerId (OpenProject #1703)", async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/meta-retitle' }),
      actor
    )

    const createdMeta = (await readTreeRow(page.id))!.meta as Record<string, any>
    assert.equal(createdMeta.authorId, fixtures.userId)
    // -> Never recorded at all: nothing reads either field (OpenProject #1703's fix), so `treeMeta`
    //    no longer computes a value that would formerly have been wrong on this very path
    assert.equal('creatorId' in createdMeta, false)
    assert.equal('ownerId' in createdMeta, false)

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Retitled' }, actor)

    const retitledMeta = (await readTreeRow(page.id))!.meta as Record<string, any>
    // -> `updatePage` hands `treeMeta` the flattened `Page` shape (`toPage()`), not a raw row -- these
    //    fields must still match what they held right after creation
    assert.equal(retitledMeta.authorId, createdMeta.authorId)
    assert.equal(retitledMeta.contentType, createdMeta.contentType)
    assert.equal(retitledMeta.editor, createdMeta.editor)
    assert.equal(retitledMeta.isBrowsable, createdMeta.isBrowsable)
    assert.equal(retitledMeta.publishState, createdMeta.publishState)
    assert.equal('creatorId' in retitledMeta, false)
    assert.equal('ownerId' in retitledMeta, false)
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

  test('movePage refreshes the tree meta authorId to the mover, not the pre-move actor (OpenProject #1703)', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/move-meta-source' }),
      actor
    )
    const [mover] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'mover@example.com', name: 'Mover', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    const moverActor: PageActor = { id: mover!.id, groupIds: [], permissions: ['manage:system'] }

    await pagesModel.movePage(
      fixtures.siteId,
      page.id,
      { path: 'docs/move-meta-destination' },
      moverActor
    )

    const movedMeta = (await readTreeRow(page.id))!.meta as Record<string, any>
    assert.equal(movedMeta.authorId, mover!.id)
    assert.equal('creatorId' in movedMeta, false)
    assert.equal('ownerId' in movedMeta, false)
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

  test('movePage can re-home a page into another locale', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'move/xloc', locale: 'en' }),
      actor
    )
    const moved = await pagesModel.movePage(
      fixtures.siteId,
      page.id,
      { path: 'move/xloc', locale: 'fr' },
      actor
    )
    assert.equal(moved!.locale, 'fr')
    assert.equal(moved!.path, 'move/xloc')
    assert.ok(
      await pagesModel.getPage({
        siteId: fixtures.siteId,
        hash: generatePathHash('move/xloc'),
        locale: 'fr'
      })
    )
    assert.equal(
      await pagesModel.getPage({
        siteId: fixtures.siteId,
        hash: generatePathHash('move/xloc'),
        locale: 'en'
      }),
      null
    )
  })

  test('movePage rejects a destination-locale collision as 409', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'move/occupied', locale: 'fr' }),
      actor
    )
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'move/occupied', locale: 'en' }),
      actor
    )
    await assert.rejects(
      pagesModel.movePage(fixtures.siteId, en.id, { path: 'move/occupied', locale: 'fr' }, actor),
      (err: any) => err.statusCode === 409 && err.name === 'pageDuplicatePath'
    )
  })

  test('movePage rejects an inactive destination locale', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'move/badloc', locale: 'en' }),
      actor
    )
    await assert.rejects(
      pagesModel.movePage(fixtures.siteId, page.id, { path: 'move/badloc', locale: 'zz' }, actor),
      (err: any) => err.name === 'pageInvalidLocale'
    )
  })

  test('movePage refuses a destination path starting with an installed locale code', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'move/ok', locale: 'en' }),
      actor
    )
    await assert.rejects(
      pagesModel.movePage(fixtures.siteId, page.id, { path: 'en/shadowed' }, actor),
      (err: any) => err.name === 'pageReservedLocaleSegment'
    )
  })

  test('movePage accepts a title-only move on a grandfathered page whose path is not changing', async () => {
    // -> `createPage()` refuses this path outright since task 12/#994 -- reachable only by writing
    //    under the model layer, exactly the "grandfathered" row the reserved-segment check on
    //    `movePage` must not punish for an edit that leaves its shadowing first segment untouched.
    //    A real grandfathered page also has a real ancestor folder tree row (filled in by
    //    `tree.addPage` back when it was created, before `tree.createFolder` started refusing `fr`)
    //    -- seeded directly here so `movePage`'s unconditional tree delete+recreate doesn't have to
    //    re-materialize `fr` through the now-reserved `createFolder` path.
    const [rawPage] = await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'fr/legacy', locale: 'en', siteId: fixtures.siteId }))
      .returning()
    await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'fr',
      type: 'folder',
      locale: 'en'
    })

    const moved = await pagesModel.movePage(
      fixtures.siteId,
      rawPage!.id,
      { path: 'fr/legacy', title: 'Legacy, Renamed' },
      actor
    )
    assert.equal(moved!.path, 'fr/legacy')
    assert.equal(moved!.title, 'Legacy, Renamed')
  })

  test('movePage still refuses moving a grandfathered page to a NEW reserved-code path', async () => {
    const [rawPage] = await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'fr/legacy-relocate', locale: 'en', siteId: fixtures.siteId }))
      .returning()
    await assert.rejects(
      pagesModel.movePage(fixtures.siteId, rawPage!.id, { path: 'en/legacy-relocate' }, actor),
      (err: any) => err.name === 'pageReservedLocaleSegment'
    )
  })

  test('movePage rolls back the page row when the tree write fails partway through (OpenProject #1022)', async () => {
    const source = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/txn-source' }),
      actor
    )
    // -> An asset entry occupying the destination file name is invisible to the `pages`-table
    //    duplicate-path probe (assets aren't pages), so the update proceeds and only the tree write,
    //    a moment later inside the same transaction, hits the collision -- exactly the partial-failure
    //    shape #1022 asks to no longer be able to happen.
    await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'docs/txn-dest',
      type: 'asset'
    })

    await assert.rejects(
      pagesModel.movePage(fixtures.siteId, source.id, { path: 'docs/txn-dest' }, actor),
      (err: any) => err.name === 'treeEntryDuplicate'
    )

    const untouched = await pagesModel.getPage({ siteId: fixtures.siteId, id: source.id })
    assert.equal(untouched!.path, 'docs/txn-source')

    const treeEntry = await readTreeRow(source.id)
    assert.equal(treeEntry!.folderPath, 'docs')
    assert.equal(treeEntry!.fileName, 'txn-source')
  })

  test('movePage with includeTranslations moves every twin along with the primary (OpenProject #1026)', async () => {
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-a', locale: 'en', title: 'English' }),
      actor
    )
    const fr = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-a', locale: 'fr', title: 'Français' }),
      actor
    )

    const moved = await pagesModel.movePage(
      fixtures.siteId,
      en.id,
      { path: 'docs/cascade-b', title: 'English, Renamed', includeTranslations: true },
      actor
    )
    // -> The primary's own title change is its own -- the twin keeps its own title, only its path
    //    moves along
    assert.equal(moved!.path, 'docs/cascade-b')
    assert.equal(moved!.title, 'English, Renamed')

    const movedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(movedFr!.path, 'docs/cascade-b')
    assert.equal(movedFr!.locale, 'fr')
    assert.equal(movedFr!.title, 'Français')

    // -> Both tree entries actually moved, not just the pages rows
    const enTree = await readTreeRow(en.id)
    assert.equal(enTree!.fileName, 'cascade-b')
    const frTree = await readTreeRow(fr.id)
    assert.equal(frTree!.fileName, 'cascade-b')

    // -> The old path is free again in both locales
    const reoccupied = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-a', locale: 'en', title: 'Reoccupied' }),
      actor
    )
    assert.equal(reoccupied.path, 'docs/cascade-a')
  })

  test('movePage with includeTranslations leaves twins untouched when it does not exist', async () => {
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-solo', locale: 'en' }),
      actor
    )
    const moved = await pagesModel.movePage(
      fixtures.siteId,
      en.id,
      { path: 'docs/cascade-solo-moved', includeTranslations: true },
      actor
    )
    assert.equal(moved!.path, 'docs/cascade-solo-moved')
  })

  test('movePage with includeTranslations does not cascade a locale-only move', async () => {
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-locale-only', locale: 'en' }),
      actor
    )
    const fr = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-locale-only-fr', locale: 'fr' }),
      actor
    )
    await pagesModel.movePage(
      fixtures.siteId,
      fr.id,
      { path: 'docs/cascade-locale-only-fr', title: 'Retitled', includeTranslations: true },
      actor
    )
    const untouchedEn = await pagesModel.getPage({ siteId: fixtures.siteId, id: en.id })
    assert.equal(untouchedEn!.path, 'docs/cascade-locale-only')
  })

  test('movePage with includeTranslations: a third-locale occupant at the destination aborts the whole batch', async () => {
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-abort', locale: 'en' }),
      actor
    )
    const fr = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-abort', locale: 'fr' }),
      actor
    )
    // -> Sitting at the destination path, in the twin's own locale, occupied by neither the primary
    //    nor the twin -- exactly what should make the whole batch fail rather than only the twin
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-abort-taken', locale: 'fr', title: 'Already Here' }),
      actor
    )

    await assert.rejects(
      pagesModel.movePage(
        fixtures.siteId,
        en.id,
        { path: 'docs/cascade-abort-taken', includeTranslations: true },
        actor
      ),
      (err: any) =>
        err.statusCode === 409 && err.name === 'pageDuplicatePath' && /fr/.test(err.message)
    )

    // -> Neither the primary nor the untouched twin moved
    const untouchedEn = await pagesModel.getPage({ siteId: fixtures.siteId, id: en.id })
    assert.equal(untouchedEn!.path, 'docs/cascade-abort')
    const untouchedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(untouchedFr!.path, 'docs/cascade-abort')
  })

  test("movePage with includeTranslations: primary changing locale into a twin's own locale aborts the whole batch (OpenProject #1026)", async () => {
    // -> The pre-transaction probes only see the DB as it is right now, so this collision -- the
    //    primary landing in the SAME locale a twin is cascading into, at the SAME destination path --
    //    isn't caught by either probe. It has to be caught by the `pages_siteId_locale_path_idx`
    //    unique index firing mid-transaction and being translated to the same 409, the way a plain
    //    two-request race already is.
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-locale-swap', locale: 'en' }),
      actor
    )
    const fr = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cascade-locale-swap', locale: 'fr' }),
      actor
    )

    await assert.rejects(
      pagesModel.movePage(
        fixtures.siteId,
        en.id,
        { path: 'docs/cascade-locale-swap-b', locale: 'fr', includeTranslations: true },
        actor
      ),
      (err: any) => err.statusCode === 409 && err.name === 'pageDuplicatePath'
    )

    // -> Neither moved, and neither changed locale
    const untouchedEn = await pagesModel.getPage({ siteId: fixtures.siteId, id: en.id })
    assert.equal(untouchedEn!.path, 'docs/cascade-locale-swap')
    assert.equal(untouchedEn!.locale, 'en')
    const untouchedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(untouchedFr!.path, 'docs/cascade-locale-swap')
    assert.equal(untouchedFr!.locale, 'fr')
  })

  /**
   * OpenProject #870: `models/glossary.ts#getCachedTerms` caches which page a term points at.
   * Nothing about the glossary itself changes on a page move, so nothing would otherwise tell that
   * cache the page it already resolved is now at a different path -- `movePage` has to invalidate it
   * itself, the same way a term CRUD does.
   */
  test('movePage invalidates the glossary cache so a canonical page it renamed resolves to its new path', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-move-before' }),
      actor
    )
    const term = await WIKI.models.glossary.createTerm(fixtures.siteId, {
      term: 'MoveCacheTerm',
      definition: 'Points at a page that is about to move.',
      pageId: page.id
    })
    try {
      const before = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, actor)
      assert.equal(
        before.find((t: any) => t.term === 'MoveCacheTerm')?.link,
        '/docs/glossary-move-before'
      )

      await pagesModel.movePage(
        fixtures.siteId,
        page.id,
        { path: 'docs/glossary-move-after' },
        actor
      )

      const after = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, actor)
      assert.equal(
        after.find((t: any) => t.term === 'MoveCacheTerm')?.link,
        '/docs/glossary-move-after'
      )
    } finally {
      await WIKI.models.glossary.deleteTerm(fixtures.siteId, term.id)
    }
  })

  /**
   * OpenProject #2452: a move rewrites same-site, same-locale references to the page's old path in
   * place, reusing the `links`/`relations` tracking `models/rendering.ts#extractInternalLinks`
   * already writes on every save rather than re-parsing content from scratch.
   */
  describe('movePage relinks same-site referencing pages (OpenProject #2452)', () => {
    test("rewrites a referencing page's content, render and links to the new path", async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-target', locale: 'en' }),
        actor
      )
      const referrer = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-referrer',
          locale: 'en',
          content: 'See the [target](/docs/relink-target) for more.',
          render: '<p>See the <a href="/docs/relink-target">target</a> for more.</p>'
        }),
        actor
      )
      const [before] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, referrer.id))
      assert.deepEqual(before!.links, ['docs/relink-target'])

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'docs/relink-target-new' },
        actor
      )

      const [after] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, referrer.id))
      assert.equal(after!.content, 'See the [target](/docs/relink-target-new) for more.')
      assert.equal(
        after!.render,
        '<p>See the <a href="/docs/relink-target-new">target</a> for more.</p>'
      )
      assert.deepEqual(after!.links, ['docs/relink-target-new'])
    })

    test('rewrites an authored relation target to the new path', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-relation-target', locale: 'en' }),
        actor
      )
      const referrer = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-relation-referrer',
          locale: 'en',
          relations: [
            {
              pos: 'left',
              label: 'See also',
              caption: '',
              icon: '',
              target: 'docs/relink-relation-target'
            }
          ]
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'docs/relink-relation-target-new' },
        actor
      )

      const [after] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, referrer.id))
      assert.equal((after!.relations as any[])[0].target, 'docs/relink-relation-target-new')
      assert.equal((after!.relations as any[])[0].label, 'See also')
    })

    test('rewrites a redirect page whose target points at the moved page', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-redirect-target', locale: 'en' }),
        actor
      )
      const redirect = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-redirect',
          locale: 'en',
          editor: 'redirect',
          content: JSON.stringify({
            kind: 'page',
            target: '/docs/relink-redirect-target',
            showInterstitial: false
          })
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'docs/relink-redirect-target-new' },
        actor
      )

      const [after] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, redirect.id))
      assert.deepEqual(JSON.parse(after!.content!), {
        kind: 'page',
        target: '/docs/relink-redirect-target-new',
        showInterstitial: false
      })
    })

    test("does not touch a same-path translation's own unrelated link in a different locale", async () => {
      const enTarget = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-locale-target', locale: 'en' }),
        actor
      )
      // -> Same bare path, but the FR locale's own page -- a same-locale reference to it must not be
      //    touched by the EN page's move (`nodeId(row.locale, target)`, `api/graph.ts`).
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-locale-target', locale: 'fr' }),
        actor
      )
      const frReferrer = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-locale-referrer',
          locale: 'fr',
          content: 'Voir la [cible](/docs/relink-locale-target).',
          render: '<p>Voir la <a href="/docs/relink-locale-target">cible</a>.</p>'
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        enTarget.id,
        { path: 'docs/relink-locale-target-new' },
        actor
      )

      const [after] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, frReferrer.id))
      assert.equal(after!.content, 'Voir la [cible](/docs/relink-locale-target).')
      assert.deepEqual(after!.links, ['docs/relink-locale-target'])
    })

    test('rewrites a self-link when a page links to its own pre-move path', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-self',
          locale: 'en',
          content: 'Back to [top](/docs/relink-self).',
          render: '<p>Back to <a href="/docs/relink-self">top</a>.</p>'
        }),
        actor
      )

      await pagesModel.movePage(fixtures.siteId, page.id, { path: 'docs/relink-self-new' }, actor)

      const [after] = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, page.id))
      assert.equal(after!.content, 'Back to [top](/docs/relink-self-new).')
      assert.deepEqual(after!.links, ['docs/relink-self-new'])
    })

    test("clears a referencing page's stale recovery draft once relinking rewrites its content (OpenProject #2506)", async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-draft-target', locale: 'en' }),
        actor
      )
      const referrer = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-draft-referrer',
          locale: 'en',
          content: 'See the [target](/docs/relink-draft-target) for more.',
          render: '<p>See the <a href="/docs/relink-draft-target">target</a> for more.</p>'
        }),
        actor
      )
      // -> A stale recovery draft, as collab's debounced autosave would leave behind for a
      //    referrer opened for editing and abandoned before this move -- the actual repro this
      //    bug describes. The state's content is irrelevant here; only its presence/absence is.
      await fixtures.db.insert(pageDraftsTable).values({
        pageId: referrer.id,
        siteId: fixtures.siteId,
        state: Buffer.from('stale-draft-state')
      })
      const untouched = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-draft-unrelated', locale: 'en' }),
        actor
      )
      await fixtures.db.insert(pageDraftsTable).values({
        pageId: untouched.id,
        siteId: fixtures.siteId,
        state: Buffer.from('unrelated-draft-state')
      })

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'docs/relink-draft-target-new' },
        actor
      )

      const [referrerDraft] = await fixtures.db
        .select()
        .from(pageDraftsTable)
        .where(eq(pageDraftsTable.pageId, referrer.id))
      assert.equal(referrerDraft, undefined)
      // -> A page relinking never touched keeps its own draft -- this isn't a blanket sweep, only
      //    the pages the move actually rewrote.
      const [untouchedDraft] = await fixtures.db
        .select()
        .from(pageDraftsTable)
        .where(eq(pageDraftsTable.pageId, untouched.id))
      assert.ok(untouchedDraft)
    })

    test("clears the moved page's own stale draft when it self-links (OpenProject #2506)", async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-self-draft',
          locale: 'en',
          content: 'Back to [top](/docs/relink-self-draft).',
          render: '<p>Back to <a href="/docs/relink-self-draft">top</a>.</p>'
        }),
        actor
      )
      await fixtures.db.insert(pageDraftsTable).values({
        pageId: page.id,
        siteId: fixtures.siteId,
        state: Buffer.from('stale-self-draft-state')
      })

      await pagesModel.movePage(
        fixtures.siteId,
        page.id,
        { path: 'docs/relink-self-draft-new' },
        actor
      )

      const [draftAfter] = await fixtures.db
        .select()
        .from(pageDraftsTable)
        .where(eq(pageDraftsTable.pageId, page.id))
      assert.equal(draftAfter, undefined)
    })

    // -> OpenProject #2519: a move that changes BOTH path and locale in the same call must leave
    //    every same-old-locale referencing page untouched -- its own bare-path link can never resolve
    //    to a page that now lives in a different locale, so rewriting it to `newPath` would only
    //    point it at whatever (or nothing) happens to occupy that path in the OLD locale afterward.
    test('does not rewrite a same-old-locale reference when the move changes locale as well as path', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-xlocale-target', locale: 'en' }),
        actor
      )
      const referrer = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-xlocale-referrer',
          locale: 'en',
          content: 'See the [target](/docs/relink-xlocale-target) for more.',
          render: '<p>See the <a href="/docs/relink-xlocale-target">target</a> for more.</p>'
        }),
        actor
      )

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'docs/relink-xlocale-target-new', locale: 'fr' },
        actor
      )

      const [after] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, referrer.id))
      assert.equal(after!.content, 'See the [target](/docs/relink-xlocale-target) for more.')
      assert.equal(
        after!.render,
        '<p>See the <a href="/docs/relink-xlocale-target">target</a> for more.</p>'
      )
      assert.deepEqual(after!.links, ['docs/relink-xlocale-target'])
    })
  })

  /**
   * OpenProject #1688: `recordPageMoveSideEffects` was extracted out of `recordMoveSideEffects` as a
   * per-page helper (for a future bulk mover -- OpenProject #1683 -- to call once per page while still
   * batching the glossary invalidation). This is the regression case the extraction's own "Done when"
   * calls for: the full side-effect set a single-page `movePage` fires -- history, search, hooks,
   * storage, glossary -- must still fire exactly as before. Search/storage/hooks/glossary are stubbed
   * with `mock.fn()` (`backend/test/mocks.ts`'s convention) so each call's exact arguments can be
   * asserted directly, the same way `WIKI.cache`/`WIKI.events`'s stubs let a test read `.mock.calls`.
   */
  test('movePage fires the full side-effect set for a single-page move', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/side-effects-before' }),
      actor
    )

    const searchModel = (globalThis as any).WIKI.models.search
    const hooksModel = (globalThis as any).WIKI.models.hooks
    const storageModel = (globalThis as any).WIKI.models.storage
    const glossaryModel = (globalThis as any).WIKI.models.glossary
    searchModel.renamed = mock.fn(async () => {})
    hooksModel.emit = mock.fn(async () => {})
    storageModel.dispatch = mock.fn(async () => {})
    glossaryModel.invalidateCache = mock.fn(() => {})

    try {
      const moved = await pagesModel.movePage(
        fixtures.siteId,
        page.id,
        { path: 'docs/side-effects-after' },
        actor
      )
      assert.equal(moved!.path, 'docs/side-effects-after')

      // -> History: a "moved" entry was recorded for this page
      const { pageHistory: pageHistoryModel } = await import('./pageHistory.ts')
      const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
      assert.equal(entries.items[0]!.action, 'moved')

      // -> Search
      assert.equal(searchModel.renamed.mock.calls.length, 1)
      const [searchSiteId, searchRawMoved, searchPreviousPath, searchPreviousLocale] =
        searchModel.renamed.mock.calls[0]!.arguments
      assert.equal(searchSiteId, fixtures.siteId)
      assert.equal(searchRawMoved.id, page.id)
      assert.equal(searchPreviousPath, 'docs/side-effects-before')
      assert.equal(searchPreviousLocale, 'en')

      // -> Hooks
      assert.equal(hooksModel.emit.mock.calls.length, 1)
      const [hookEvent, hookSiteId, hookPayload] = hooksModel.emit.mock.calls[0]!.arguments
      assert.equal(hookEvent, 'page:rename')
      assert.equal(hookSiteId, fixtures.siteId)
      assert.equal(hookPayload.id, page.id)
      assert.equal(hookPayload.path, 'docs/side-effects-after')
      assert.equal(hookPayload.previousPath, 'docs/side-effects-before')

      // -> Storage
      assert.equal(storageModel.dispatch.mock.calls.length, 1)
      const [storageEvent, storagePayload] = storageModel.dispatch.mock.calls[0]!.arguments
      assert.equal(storageEvent, 'page:rename')
      assert.equal(storagePayload.id, page.id)
      assert.equal(storagePayload.path, 'docs/side-effects-after')
      assert.equal(storagePayload.previousPath, 'docs/side-effects-before')

      // -> Glossary: invalidated exactly once for this single-page move
      assert.equal(glossaryModel.invalidateCache.mock.calls.length, 1)
      assert.equal(glossaryModel.invalidateCache.mock.calls[0]!.arguments[0], fixtures.siteId)
    } finally {
      delete searchModel.renamed
      delete hooksModel.emit
      delete storageModel.dispatch
      delete glossaryModel.invalidateCache
    }
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

  /**
   * OpenProject #1739: `deletePage` used to run the `pages` delete and `tree.deleteEntry` as two
   * separate statements, with nothing at the db level tying them together (`tree.id` carries no FK
   * back to `pages.id`). A failure in the second left an orphaned tree row -- still rendered by
   * `getTree`'s left join, 404ing when opened, and permanently blocking re-creation at the same path
   * via `tree_composite_page_idx`. Wrapped in one transaction, forcing `tree.deleteEntry` to throw
   * must roll the `pages` delete back too, leaving both rows exactly as they were.
   */
  test('deletePage rolls back the page row when tree.deleteEntry fails, leaving the path reusable', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'atomic-delete/page-one', title: 'Atomic Delete Me' }),
      actor
    )
    const treeEntryBefore = await readTreeRow(page.id)
    assert.ok(treeEntryBefore)
    const folderBefore = await WIKI.models.tree.getFolder({
      path: 'atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const childrenBefore = folderBefore.meta?.children ?? 0

    const deleteEntry = mock.method(WIKI.models.tree, 'deleteEntry', async () => {
      throw new Error('simulated tree.deleteEntry failure')
    })
    try {
      await assert.rejects(pagesModel.deletePage(fixtures.siteId, page.id, actor))
    } finally {
      deleteEntry.mock.restore()
    }

    // -> Both rows survive together, exactly as before the failed attempt -- not "the page is gone
    //    but the tree row remains" (the pre-fix orphan)
    const pageAfterFailure = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.ok(pageAfterFailure)
    const treeEntryAfterFailure = await readTreeRow(page.id)
    assert.ok(treeEntryAfterFailure)
    const folderAfterFailure = await WIKI.models.tree.getFolder({
      path: 'atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    assert.equal(folderAfterFailure.meta?.children ?? 0, childrenBefore)

    // -> The real deletePage, unmocked, must still be able to finish the job
    const deleted = await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    assert.equal(deleted, true)
    assert.equal(await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id }), null)
    assert.equal(await readTreeRow(page.id), null)

    // -> And the path is free to reuse -- `tree_composite_page_idx` would refuse this insert if the
    //    old tree row had survived
    const recreated = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'atomic-delete/page-one', title: 'Recreated After Rollback' }),
      actor
    )
    assert.equal(recreated.path, 'atomic-delete/page-one')
  })

  test('getPathFromAlias resolves an alias to its path and locale', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/alias-target', locale: 'fr', alias: 'aliased-page', title: 'Cible' }),
      actor
    )

    const target = await pagesModel.getPathFromAlias(fixtures.siteId, 'aliased-page')

    assert.ok(target)
    assert.equal(target!.id, page.id)
    assert.equal(target!.path, 'docs/alias-target')
    assert.equal(target!.locale, 'fr')
  })

  test('getPathFromAlias returns null for an alias nothing claims', async () => {
    const target = await pagesModel.getPathFromAlias(fixtures.siteId, 'no-such-alias')
    assert.equal(target, null)
  })

  /**
   * OpenProject #1739 (part of #1730): `deletePage` used to delete the `pages` row and then call
   * `tree.deleteEntry` as two separate statements on the default connection -- there is no FK from
   * `tree.id` to `pages.id`, so nothing at the database level removed the tree row if the second
   * statement failed. That left a tree entry pointing at a page that no longer existed, permanently
   * blocking a future page at the same path via `tree_composite_page_idx`. `deletePage` now wraps both
   * in one transaction, so a failure partway through rolls back everything -- including the `pages`
   * delete that already ran -- rather than leaving an orphan.
   */
  test('a failure inside tree.deleteEntry rolls back the whole deletePage, leaving the path recreatable', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/atomic-delete/leaf' }),
      actor
    )
    const parentFolder = await WIKI.models.tree.getFolder({
      path: 'docs/atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const childrenBefore = (parentFolder as any).meta?.children ?? 0

    const deleteEntry = mock.method(WIKI.models.tree, 'deleteEntry', async () => {
      throw new Error('simulated tree.deleteEntry failure')
    })
    try {
      await assert.rejects(() => pagesModel.deletePage(fixtures.siteId, page.id, actor))
    } finally {
      deleteEntry.mock.restore()
    }

    // -> Rolled back atomically: the `pages` delete that ran first inside the same transaction did not
    //    survive the later failure, so nothing is orphaned on either side.
    const stillThere = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.ok(stillThere, 'the page row was not left deleted by the failed transaction')

    const parentFolderAfterFailure = await WIKI.models.tree.getFolder({
      path: 'docs/atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    assert.equal(
      (parentFolderAfterFailure as any).meta?.children ?? 0,
      childrenBefore,
      "the folder's child count is unchanged by the failed attempt"
    )

    // -> A real (unmocked) delete now succeeds, and the path it freed can be reused -- proof the
    //    earlier failure left nothing behind that `tree_composite_page_idx` would have blocked on.
    const deleted = await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    assert.equal(deleted, true)

    const recreated = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/atomic-delete/leaf', title: 'Recreated After Rollback' }),
      actor
    )
    assert.equal(recreated.path, 'docs/atomic-delete/leaf')
  })

  test('deletePage returns false for a page that does not exist', async () => {
    const deleted = await pagesModel.deletePage(
      fixtures.siteId,
      '00000000-0000-4000-8000-000000000000',
      actor
    )
    assert.equal(deleted, false)
  })

  /**
   * OpenProject #870: the FK from `glossaryTerms.pageId` is `set null` (see `db/schema.ts`), so a term
   * canonically linked to a deleted page is unlinked at the db level -- but the cached, resolved copy
   * of that link (`models/glossary.ts#getCachedTerms`) would keep serving the old one forever
   * (`WIKI.cache` carries no TTL) unless `deletePage` drops it too.
   */
  test('deletePage invalidates the glossary cache so a term linked to it resolves to no link', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-delete-me' }),
      actor
    )
    const term = await WIKI.models.glossary.createTerm(fixtures.siteId, {
      term: 'DeleteCacheTerm',
      definition: 'Points at a page that is about to be deleted.',
      pageId: page.id
    })
    try {
      const before = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, actor)
      assert.equal(
        before.find((t: any) => t.term === 'DeleteCacheTerm')?.link,
        '/docs/glossary-delete-me'
      )

      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const after = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, actor)
      assert.equal(after.find((t: any) => t.term === 'DeleteCacheTerm')?.link, null)
    } finally {
      await WIKI.models.glossary.deleteTerm(fixtures.siteId, term.id)
    }
  })

  /**
   * OpenProject #1706: `getRawCachedTerms` caches a term's canonical page classification and tags
   * alongside its path/locale, and `getCachedTerms` runs the actor's `read:pages` check against that
   * cached copy -- but only `movePage`/`deletePage`/`deleteOrphaned` invalidated it, not `updatePage`,
   * the one path that actually changes `classification`/`tags`. These two cases set up a group rule
   * whose ALLOW/DENY outcome for a non-`manage:system` actor depends on the page's classification (or
   * tags), so a stale cache is provable by that actor's `link` flipping the wrong way rather than by
   * spying on the invalidation call itself.
   */
  describe('updatePage invalidates the glossary cache (OpenProject #1706)', () => {
    let restrictedId: string
    let publicId: string
    let restrictedActor: PageActor

    before(async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const levels = classificationLevels.list()
      publicId = levels.find((l) => l.name === 'Public')!.id
      restrictedId = levels.find((l) => l.name === 'Restricted')!.id
      restrictedActor = { id: fixtures.userId, permissions: [], groupIds: [fixtures.groupId] }
    })

    async function setRules(rules: any[]): Promise<void> {
      await fixtures.db
        .update(groupsTable)
        .set({ rules })
        .where(eq(groupsTable.id, fixtures.groupId))
      await WIKI.models.groups.reloadCache()
    }

    test('a classification-only patch drops the cache so a newly-restricted term stops resolving', async () => {
      await setRules([
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
          id: 'deny-restricted',
          name: 'Deny restricted',
          roles: ['read:pages'],
          match: 'CLASSIFICATION',
          mode: 'DENY',
          path: '',
          classifications: [restrictedId],
          locales: [],
          sites: []
        }
      ])

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/glossary-classification-cache', classification: publicId }),
        actor
      )
      const term = await WIKI.models.glossary.createTerm(fixtures.siteId, {
        term: 'ClassificationCacheTerm',
        definition: 'Points at a page about to be restricted.',
        pageId: page.id
      })
      try {
        const before = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, restrictedActor)
        assert.equal(
          before.find((t: any) => t.term === 'ClassificationCacheTerm')?.link,
          '/docs/glossary-classification-cache'
        )

        await pagesModel.updatePage(
          fixtures.siteId,
          page.id,
          { classification: restrictedId },
          actor
        )

        const after = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, restrictedActor)
        assert.equal(after.find((t: any) => t.term === 'ClassificationCacheTerm')?.link, null)
      } finally {
        await WIKI.models.glossary.deleteTerm(fixtures.siteId, term.id)
      }
    })

    test('a tags-only patch drops the cache so a term loses its access-granting tag and stops resolving', async () => {
      // -> Deliberately no competing path rule: `helpers/pageRules.ts` treats every TAG rule as
      //    specificity 0, so a `path: ''` ALLOW would out-rank it on the match-priority tier and the
      //    tag would never be what decides access, defeating the point of this test. A lone
      //    ALLOW-by-tag rule, with the page starting with the tag and the patch removing it, isolates
      //    tags as the only thing that can flip `read:pages` here.
      await setRules([
        {
          id: 'allow-tagged',
          name: 'Allow tagged',
          roles: ['read:pages'],
          match: 'TAG',
          mode: 'ALLOW',
          path: 'allowed',
          locales: [],
          sites: []
        }
      ])

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/glossary-tags-cache', tags: ['allowed'] }),
        actor
      )
      const term = await WIKI.models.glossary.createTerm(fixtures.siteId, {
        term: 'TagsCacheTerm',
        definition: 'Points at a page about to lose its access-granting tag.',
        pageId: page.id
      })
      try {
        const before = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, restrictedActor)
        assert.equal(
          before.find((t: any) => t.term === 'TagsCacheTerm')?.link,
          '/docs/glossary-tags-cache'
        )

        await pagesModel.updatePage(fixtures.siteId, page.id, { tags: [] }, actor)

        const after = await WIKI.models.glossary.getCachedTerms(fixtures.siteId, restrictedActor)
        assert.equal(after.find((t: any) => t.term === 'TagsCacheTerm')?.link, null)
      } finally {
        await WIKI.models.glossary.deleteTerm(fixtures.siteId, term.id)
      }
    })
  })

  /**
   * Task #561's dispatcher wiring: `createPage`/`updatePage` already called `WIKI.models.search`
   * (as `indexPage`, previously), but `movePage`/`deletePage` called nothing at all — "silent no-ops
   * that only work by accident under Postgres" per the task. This spies on the dispatcher itself
   * (`WIKI.models.search`, the same singleton `models/search.ts` exports) rather than asserting on
   * search results, so it catches a hook that stops being called regardless of what the `db` engine
   * does or does not need to do about it.
   */
  test('createPage/updatePage/movePage/deletePage each call the search dispatcher', async () => {
    const calls: string[] = []
    const searchModel = (globalThis as any).WIKI.models.search
    searchModel.created = async (page: any) => {
      calls.push(`created:${page.path}`)
    }
    searchModel.updated = async (page: any) => {
      calls.push(`updated:${page.path}`)
    }
    searchModel.renamed = async (_siteId: string, page: any, previousPath: string) => {
      calls.push(`renamed:${previousPath}->${page.path}`)
    }
    searchModel.deleted = async (_siteId: string, pageId: string) => {
      calls.push(`deleted:${pageId}`)
    }

    try {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/search-hooks' }),
        actor
      )
      await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Updated Title' }, actor)
      const moved = await pagesModel.movePage(
        fixtures.siteId,
        page.id,
        { path: 'docs/search-hooks-moved' },
        actor
      )
      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      assert.equal(moved!.path, 'docs/search-hooks-moved')
      assert.deepEqual(calls, [
        'created:docs/search-hooks',
        'updated:docs/search-hooks',
        'renamed:docs/search-hooks->docs/search-hooks-moved',
        `deleted:${page.id}`
      ])
    } finally {
      // -> Restores the real prototype methods rather than reassigning them: these spies shadow them
      //    as own properties, so deleting those is enough for lookup to fall back through
      delete searchModel.created
      delete searchModel.updated
      delete searchModel.renamed
      delete searchModel.deleted
    }
  })

  /**
   * `deleteOrphaned` is the other page-deletion path — pages left behind by a deleted folder
   * (`api/tree.ts`'s `deleteFolder` route) — and unlike `deletePage` it called nothing on the search
   * dispatcher at all: postgres's own index disappears for free with the row, but an external engine
   * (Elasticsearch, Algolia, ...) keeps a stale entry forever unless told to drop it. Task #554.
   */
  test('deleteOrphaned calls the search dispatcher for every page it removes', async () => {
    const calls: string[] = []
    const searchModel = (globalThis as any).WIKI.models.search
    searchModel.deleted = async (_siteId: string, pageId: string) => {
      calls.push(pageId)
    }

    try {
      const pageA = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/orphan-folder/one' }),
        actor
      )
      const pageB = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/orphan-folder/two', title: 'Two' }),
        actor
      )

      await pagesModel.deleteOrphaned(
        fixtures.siteId,
        [
          { id: pageA.id, folderPath: 'docs/orphan-folder', fileName: 'one', locale: 'en' },
          { id: pageB.id, folderPath: 'docs/orphan-folder', fileName: 'two', locale: 'en' }
        ],
        actor
      )

      assert.deepEqual(new Set(calls), new Set([pageA.id, pageB.id]))

      const fetchedA = await pagesModel.getPage({ siteId: fixtures.siteId, id: pageA.id })
      const fetchedB = await pagesModel.getPage({ siteId: fixtures.siteId, id: pageB.id })
      assert.equal(fetchedA, null)
      assert.equal(fetchedB, null)
    } finally {
      delete searchModel.deleted
    }
  })

  /**
   * OpenProject #2232: `pages.password` used to store the page's password in cleartext, and
   * `unlockPage()` compared a guess against it with a timing-safe string comparison. Anyone with read
   * access to Postgres or a backup could recover every page password with no work factor. This suite
   * covers the fix: the column now holds a `bcrypt` verifier, `createPage`/`updatePage` hash whatever
   * plaintext they are given before it touches the database, and `unlockPage()` checks a guess against
   * the hash with `bcrypt.compare` instead.
   */
  describe('page passwords (OpenProject #2232)', () => {
    test('createPage() stores a bcrypt verifier, not the submitted password', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-create', password: 'correct horse battery staple' }),
        actor
      )

      const stored = await fixtures.db
        .select({ password: pagesTable.password })
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)

      const hash = stored[0]!.password
      assert.ok(hash)
      assert.notEqual(hash, 'correct horse battery staple')
      // -> bcrypt's own encoded format ($<algorithm version>$<cost>$<salt+hash>), not just "some other
      //    string" -- proof this went through `bcrypt.hash`, not some other transform.
      assert.match(hash!, /^\$2[aby]?\$\d{2}\$/)
    })

    test('createPage() with no password leaves the column null', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-none' }),
        actor
      )

      const stored = await fixtures.db
        .select({ password: pagesTable.password })
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)

      assert.equal(stored[0]!.password, null)
    })

    test('updatePage() replaces the stored hash when the patch sets a new password', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-update', password: 'first-password' }),
        actor
      )
      const before = await fixtures.db
        .select({ password: pagesTable.password })
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)

      await pagesModel.updatePage(fixtures.siteId, page.id, { password: 'second-password' }, actor)
      const after = await fixtures.db
        .select({ password: pagesTable.password })
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)

      assert.notEqual(after[0]!.password, before[0]!.password)
      assert.notEqual(after[0]!.password, 'second-password')
      assert.match(after[0]!.password!, /^\$2[aby]?\$\d{2}\$/)
    })

    test('updatePage() with an empty string patch removes the password', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-clear', password: 'take-me-off' }),
        actor
      )

      await pagesModel.updatePage(fixtures.siteId, page.id, { password: '' }, actor)

      const stored = await fixtures.db
        .select({ password: pagesTable.password })
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)
      assert.equal(stored[0]!.password, null)
    })

    test('getPage() with withPassword never returns the password itself, only hasPassword', async () => {
      const protectedPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-haspassword', password: 'sup3r-secret' }),
        actor
      )
      const openPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-nopassword' }),
        actor
      )

      const fetchedProtected = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: protectedPage.id,
        withPassword: true
      })
      const fetchedOpen = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: openPage.id,
        withPassword: true
      })

      assert.equal((fetchedProtected as any).hasPassword, true)
      assert.equal((fetchedOpen as any).hasPassword, false)
      assert.equal('password' in (fetchedProtected as any), false)
      assert.equal('password' in (fetchedOpen as any), false)
    })

    test('unlockPage() accepts the correct password and hands back the body', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/pwd-unlock-correct',
          content: '# Secret content',
          password: 'sw0rdfish'
        }),
        actor
      )

      const unlocked = await pagesModel.unlockPage({
        siteId: fixtures.siteId,
        id: page.id,
        password: 'sw0rdfish'
      })

      assert.ok(unlocked)
      assert.equal(unlocked!.id, page.id)
      assert.equal(unlocked!.isLocked, false)
    })

    test('unlockPage() rejects a wrong password', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-unlock-wrong', password: 'sw0rdfish' }),
        actor
      )

      const result = await pagesModel.unlockPage({
        siteId: fixtures.siteId,
        id: page.id,
        password: 'wrong-guess'
      })

      assert.equal(result, null)
    })

    test('unlockPage() returns null for a page with no password at all', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/pwd-unlock-none' }),
        actor
      )

      const result = await pagesModel.unlockPage({
        siteId: fixtures.siteId,
        id: page.id,
        password: 'anything'
      })

      assert.equal(result, null)
    })
  })

  /**
   * OpenProject #1716: `createPage()`/`updatePage()` used to leave `render`/`toc`/`searchContent`/
   * `links` untouched (update) or blank forever (create) for a write that carried `content` with no
   * `render` — no refusal, and no path back to a correct render short of a human re-saving the page
   * in the browser. This locks down the fold-in: `ensureCanRender()` consulted, and refused up front
   * rather than after, when it fails; a queued rerender job left behind when it succeeds, with
   * `render`/`toc`/`searchContent`/`links` blanked in the meantime rather than left pointing at
   * content that no longer exists.
   */
  describe('render-less create/update leave a queued rerender job (OpenProject #1716)', () => {
    afterEach(() => {
      // -> Restore the describe-wide success stub (installed in `before()` above) after a test below
      //    narrows or replaces it -- must not leak into the next test, same discipline the
      //    watch-notification describe block's own `beforeEach` documents for `mail`. Reconfigures the
      //    single shared wrap in place (see its own declaration comment) rather than re-mocking.
      ensureCanRenderMock.mock.mockImplementation(async () => {})
    })

    test('createPage() with no render consults ensureCanRender (before the write) and leaves a queued rerender job', async () => {
      const calls: string[] = []
      ensureCanRenderMock.mock.mockImplementation(async (editor: string) => {
        calls.push(editor)
      })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/render-less-create' }),
        actor
      )

      assert.deepEqual(calls, ['markdown'])

      const queued = await fixtures.db
        .select()
        .from(pageRenderQueueTable)
        .where(eq(pageRenderQueueTable.pageId, page.id))
      assert.equal(queued.length, 1)
    })

    test('createPage() refuses up front when ensureCanRender fails, and writes no page row', async () => {
      ensureCanRenderMock.mock.mockImplementation(async () => {
        throw new CustomError('renderPuppeteerMissing', 'Rendering needs Puppeteer.', 503)
      })

      await assert.rejects(
        pagesModel.createPage(
          fixtures.siteId,
          pageInput({ path: 'docs/render-less-create-refused' }),
          actor
        ),
        /renderPuppeteerMissing/
      )

      const rows = await fixtures.db
        .select({ id: pagesTable.id })
        .from(pagesTable)
        .where(
          and(
            eq(pagesTable.siteId, fixtures.siteId),
            eq(pagesTable.locale, 'en'),
            eq(pagesTable.path, 'docs/render-less-create-refused')
          )
        )
      assert.equal(rows.length, 0)
    })

    test('createPage() with an explicit render, even an empty one, does not consult ensureCanRender', async () => {
      const calls: string[] = []
      ensureCanRenderMock.mock.mockImplementation(async (editor: string) => {
        calls.push(editor)
      })

      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/render-supplied-create', render: '' }),
        actor
      )

      assert.deepEqual(calls, [])
    })

    test('updatePage() with content and no render consults ensureCanRender, blanks render/toc/searchContent/links instead of leaving the previous revision behind, and leaves a queued rerender job', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/render-less-update',
          content: '# Old\n\nSee the [old target](/docs/old-target).',
          render: '<h1 id="old">Old</h1><p>See the <a href="/docs/old-target">old target</a>.</p>'
        }),
        actor
      )
      const [before] = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, page.id))
      assert.match(before!.searchContent ?? '', /Old/)
      assert.deepEqual(before!.links, ['docs/old-target'])

      const calls: string[] = []
      ensureCanRenderMock.mock.mockImplementation(async (editor: string) => {
        calls.push(editor)
      })

      await pagesModel.updatePage(
        fixtures.siteId,
        page.id,
        { content: '# New\n\nSee the [new target](/docs/new-target).' },
        actor
      )

      assert.deepEqual(calls, ['markdown'])

      const [after] = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, page.id))
      assert.equal(after!.content, '# New\n\nSee the [new target](/docs/new-target).')
      // -> Blanked, not left holding the previous revision's render/searchContent/links: the queued
      //    job (below) is what fills these back in from the content just written.
      assert.equal(after!.render, '')
      assert.equal(after!.searchContent, '')
      assert.deepEqual(after!.links, [])

      const queued = await fixtures.db
        .select()
        .from(pageRenderQueueTable)
        .where(eq(pageRenderQueueTable.pageId, page.id))
      assert.equal(queued.length, 1)
    })

    test('updatePage() refuses up front when ensureCanRender fails, and leaves the page unmodified', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/render-less-update-refused',
          content: '# Original',
          render: '<h1 id="original">Original</h1>'
        }),
        actor
      )

      ensureCanRenderMock.mock.mockImplementation(async () => {
        throw new CustomError('renderPuppeteerMissing', 'Rendering needs Puppeteer.', 503)
      })

      await assert.rejects(
        pagesModel.updatePage(fixtures.siteId, page.id, { content: '# Changed' }, actor),
        /renderPuppeteerMissing/
      )

      const [row] = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, page.id))
      assert.equal(row!.content, '# Original')
      assert.match(row!.render ?? '', /Original/)
    })

    test('updatePage() with an explicit render does not consult ensureCanRender and does not queue a rerender', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/render-supplied-update', render: '<p>ok</p>' }),
        actor
      )

      const calls: string[] = []
      ensureCanRenderMock.mock.mockImplementation(async (editor: string) => {
        calls.push(editor)
      })

      await pagesModel.updatePage(
        fixtures.siteId,
        page.id,
        { content: '# Changed', render: '<h1>Changed</h1>' },
        actor
      )

      assert.deepEqual(calls, [])

      const queued = await fixtures.db
        .select()
        .from(pageRenderQueueTable)
        .where(eq(pageRenderQueueTable.pageId, page.id))
      assert.equal(queued.length, 0)
    })
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

  /**
   * The join half of translation staleness/missing detection (OpenProject #2476) --
   * `helpers/translationStatus.test.ts` covers the pure compare over rows shaped like these.
   */
  describe('getTranslationRows', () => {
    test('returns one row per locale that actually has a page at the given path', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'translations/both', title: 'English', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'translations/both', title: 'French', locale: 'fr' }),
        actor
      )

      const rows = await pagesModel.getTranslationRows(fixtures.siteId, ['translations/both'])

      assert.equal(rows.length, 2)
      const locales = rows.map((r) => r.path === 'translations/both' && r.locale).sort()
      assert.deepEqual(locales, ['en', 'fr'])
      for (const row of rows) {
        assert.ok(row.updatedAt instanceof Date)
      }
    })

    test('a path with only one locale returns just that one row', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'translations/en-only', title: 'English only', locale: 'en' }),
        actor
      )

      const rows = await pagesModel.getTranslationRows(fixtures.siteId, ['translations/en-only'])

      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.locale, 'en')
    })

    test('batches several paths in one call, each path only carrying its own rows', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'translations/batch-a', title: 'A', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'translations/batch-b', title: 'B', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'translations/batch-b', title: 'B (fr)', locale: 'fr' }),
        actor
      )

      const rows = await pagesModel.getTranslationRows(fixtures.siteId, [
        'translations/batch-a',
        'translations/batch-b'
      ])

      const byPath = new Map<string, string[]>()
      for (const row of rows) {
        byPath.set(row.path, [...(byPath.get(row.path) ?? []), row.locale])
      }
      assert.deepEqual(byPath.get('translations/batch-a')?.sort(), ['en'])
      assert.deepEqual(byPath.get('translations/batch-b')?.sort(), ['en', 'fr'])
    })

    test('an empty path list is answered with no query and no rows', async () => {
      const rows = await pagesModel.getTranslationRows(fixtures.siteId, [])
      assert.deepEqual(rows, [])
    })

    test('never returns a row from another site, even at the identical path', async () => {
      const [otherSite] = await fixtures.db
        .insert(sitesTable)
        .values({
          hostname: `translations-other-${fixtures.siteId}`,
          isEnabled: true,
          config: {}
        })
        .returning()
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'translations/scoped', title: 'This site', locale: 'en' }),
        actor
      )
      // -> A raw insert, not `createPage()`: `createPage` refuses any siteId absent from the
      //    in-memory `WIKI.sites` cache, which a site row inserted straight into the DB (rather than
      //    through `models/sites.ts`) never populates. Only the WHERE clause's site scoping is under
      //    test here, so a hand-built row bypassing that whole cache/business-rule layer is enough.
      await fixtures.db.insert(pagesTable).values({
        locale: 'en',
        path: 'translations/scoped',
        hash: generatePathHash('translations/scoped'),
        title: 'Other site',
        editor: 'markdown',
        contentType: 'markdown',
        authorId: fixtures.userId,
        creatorId: fixtures.userId,
        ownerId: fixtures.userId,
        siteId: otherSite!.id,
        classification: fixtures.classificationId
      })

      const rows = await pagesModel.getTranslationRows(fixtures.siteId, ['translations/scoped'])

      assert.equal(rows.length, 1)
    })
  })

  /*
    Feature 357, task 446: `getPathFromAlias` used to select only `{ id, path }`, so the
    alias-resolution route's `mayOnPage(req, 'read:pages', { path: target.path })` never saw a
    locale or any tags — a locale- or tag-scoped page rule could never be evaluated for a page
    reached through its alias, only a path-based one, silently. This proves the select now carries
    both fields through, which is what api/pages/read.ts's alias route threads into `mayOnPage`.
  */
  test('getPathFromAlias resolves locale and tags along with id and path', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/alias-target',
        alias: 'alias-target',
        locale: 'en',
        tags: ['confidential', 'roadmap']
      }),
      actor
    )

    const resolved = await pagesModel.getPathFromAlias(fixtures.siteId, 'alias-target')

    assert.ok(resolved)
    assert.equal(resolved!.id, page.id)
    assert.equal(resolved!.path, 'docs/alias-target')
    assert.equal(resolved!.locale, 'en')
    assert.deepEqual(resolved!.tags, ['confidential', 'roadmap'])
  })

  test('getPathFromAlias returns null for an alias nobody uses', async () => {
    const resolved = await pagesModel.getPathFromAlias(fixtures.siteId, 'no-such-alias')
    assert.equal(resolved, null)
  })

  /**
   * OpenProject #1897/#1902: the batched reads the classification-conflicts resolve route uses
   * instead of a per-id `getPage`/`parentClassification` loop -- `api/pages.classification.test.ts`
   * stubs the model entirely, so this is what proves each one actually resolves the right rows.
   */
  describe('getPagesByIds / parentClassifications (OpenProject #1902)', () => {
    let internalId: string
    let restrictedId: string

    before(async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const levels = classificationLevels.list()
      internalId = levels.find((l) => l.name === 'Internal')!.id
      restrictedId = levels.find((l) => l.name === 'Restricted')!.id
    })

    test('getPagesByIds returns the permission-relevant columns for exactly the requested ids', async () => {
      const one = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch/one', classification: internalId, tags: ['a'] }),
        actor
      )
      const two = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch/two', classification: restrictedId }),
        actor
      )
      const map = await pagesModel.getPagesByIds(fixtures.siteId, [one.id, two.id])
      assert.equal(map.size, 2)
      assert.deepEqual(map.get(one.id), {
        id: one.id,
        path: one.path,
        locale: one.locale,
        tags: ['a'],
        classification: internalId
      })
      assert.equal(map.get(two.id)?.classification, restrictedId)
    })

    test('getPagesByIds omits an id that does not exist, without erroring', async () => {
      const one = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch/exists-only' }),
        actor
      )
      const map = await pagesModel.getPagesByIds(fixtures.siteId, [
        one.id,
        '99999999-9999-4999-8999-999999999999'
      ])
      assert.equal(map.size, 1)
      assert.ok(map.has(one.id))
    })

    test('getPagesByIds returns an empty map for an empty id list, with no query issued', async () => {
      const map = await pagesModel.getPagesByIds(fixtures.siteId, [])
      assert.equal(map.size, 0)
    })

    test('parentClassifications resolves each path to the SAME floor the per-call method would, for a mixed set of paths', async () => {
      const strictParent = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch-floor/strict-parent', classification: restrictedId }),
        actor
      )
      const strictChild = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: `${strictParent.path}/child`, classification: restrictedId }),
        actor
      )
      const rootLevel = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch-floor/root-level' }),
        actor
      )
      // -> No page actually published at this parent path -- an empty-folder case.
      const emptyFolderChild = {
        locale: rootLevel.locale,
        path: 'batch-floor/no-such-parent/child'
      }

      const [expectedChild, expectedRoot, expectedEmptyFolder] = await Promise.all([
        pageClassificationModel.parentClassification(
          fixtures.siteId,
          strictChild.locale,
          strictChild.path
        ),
        pageClassificationModel.parentClassification(
          fixtures.siteId,
          rootLevel.locale,
          rootLevel.path
        ),
        pageClassificationModel.parentClassification(
          fixtures.siteId,
          emptyFolderChild.locale,
          emptyFolderChild.path
        )
      ])

      const map = await pageClassificationModel.parentClassifications(fixtures.siteId, [
        { locale: strictChild.locale, path: strictChild.path },
        { locale: rootLevel.locale, path: rootLevel.path },
        emptyFolderChild
      ])

      assert.equal(map.get(`${strictChild.locale}\0${strictChild.path}`), expectedChild)
      assert.equal(map.get(`${rootLevel.locale}\0${rootLevel.path}`), expectedRoot)
      assert.equal(
        map.get(`${emptyFolderChild.locale}\0${emptyFolderChild.path}`),
        expectedEmptyFolder
      )
      assert.equal(expectedChild, restrictedId)
      assert.equal(expectedRoot, null)
      assert.equal(expectedEmptyFolder, null)
    })

    test('the query is scoped per locale, not just per path -- a same-named parent path in another locale never leaks in', async () => {
      // -> Same parent path in two locales with two DIFFERENT classifications, so a query that
      //    matched `locale IN (...)` and `path IN (...)` independently (rather than as a real pair)
      //    would risk picking up the wrong locale's row.
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch-locale/parent', locale: 'en', classification: restrictedId }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch-locale/parent', locale: 'fr', classification: internalId }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch-locale/parent/child', locale: 'en' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'batch-locale/parent/child', locale: 'fr' }),
        actor
      )

      // -> Each locale queried on its own, against the single-page method, so a distinct map key
      //    per locale never masks a cross-locale mismatch the way batching both together under one
      //    path-only key could.
      const enBatched = await pageClassificationModel.parentClassifications(fixtures.siteId, [
        { locale: 'en', path: 'batch-locale/parent/child' }
      ])
      const enSingle = await pageClassificationModel.parentClassification(
        fixtures.siteId,
        'en',
        'batch-locale/parent/child'
      )
      assert.equal(enBatched.get('en\0batch-locale/parent/child'), restrictedId)
      assert.equal(enBatched.get('en\0batch-locale/parent/child'), enSingle)

      const frBatched = await pageClassificationModel.parentClassifications(fixtures.siteId, [
        { locale: 'fr', path: 'batch-locale/parent/child' }
      ])
      const frSingle = await pageClassificationModel.parentClassification(
        fixtures.siteId,
        'fr',
        'batch-locale/parent/child'
      )
      assert.equal(frBatched.get('fr\0batch-locale/parent/child'), internalId)
      assert.equal(frBatched.get('fr\0batch-locale/parent/child'), frSingle)
    })
  })

  /**
   * OpenProject #1587 §2 / task 1612: `listAllForGraph` used to apply no visibility filter at all,
   * and its only consumer (`assembleGraph`'s `canRead`, in `api/graph.ts`) checks a page-rule
   * PERMISSION, never publication state — so `GET /sites/:siteId/graph` could hand an unauthenticated
   * caller a draft or `isBrowsable: false` page's title, classification and link graph whenever
   * guests hold `read:pages` via a rule. `publicOnly` threads straight into `pageIsVisible`
   * (`tree.ts`), the same helper `tree.getTree()`/`tree.browse()` use: `isBrowsable` applies either
   * way, authenticated or not — per that function's own doc comment, it is the author saying "not in
   * the tree", not an access rule — while `publishState` is gated by `publicOnly` alone, so only an
   * unauthenticated caller is denied a draft.
   */
  describe('listAllForGraph publicOnly (OpenProject #1587 §2)', () => {
    test('publicOnly hides a draft; a non-browsable page stays hidden either way', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'graph-visibility/published', publishState: 'published' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'graph-visibility/draft', publishState: 'draft' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'graph-visibility/hidden',
          publishState: 'published',
          isBrowsable: false
        }),
        actor
      )

      const publicRows = await pagesModel.listAllForGraph(fixtures.siteId, true)
      const publicPaths = publicRows.map((r) => r.path)
      assert.ok(publicPaths.includes('graph-visibility/published'))
      assert.ok(!publicPaths.includes('graph-visibility/draft'))
      assert.ok(!publicPaths.includes('graph-visibility/hidden'))

      const privateRows = await pagesModel.listAllForGraph(fixtures.siteId, false)
      const privatePaths = privateRows.map((r) => r.path)
      assert.ok(privatePaths.includes('graph-visibility/published'))
      assert.ok(privatePaths.includes('graph-visibility/draft'))
      assert.ok(!privatePaths.includes('graph-visibility/hidden'))
    })

    test('publicOnly defaults to false — an existing caller with no opinion keeps every page', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'graph-visibility-default/draft', publishState: 'draft' }),
        actor
      )
      const rows = await pagesModel.listAllForGraph(fixtures.siteId)
      assert.ok(rows.map((r) => r.path).includes('graph-visibility-default/draft'))
    })
  })

  /**
   * `helpers/translationStaleness.test.ts` covers the comparison logic itself as a pure function;
   * this proves `getTranslationStaleness` wires it to a real `(siteId, path)` join off the actual
   * `pages` table -- `test/db.ts#setupTestDb()` already seeds this site's locale config with
   * `active: ['en', 'fr']`, matching `docs/decisions/locale-translation-linking.md`'s convention.
   */
  describe('getTranslationStaleness (OpenProject #2477)', () => {
    test('flags a translation older than the primary page as stale', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'staleness/stale-case',
          locale: 'en',
          title: 'Primary',
          updatedAt: '2026-06-01T00:00:00Z'
        }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'staleness/stale-case',
          locale: 'fr',
          title: 'Traduction',
          updatedAt: '2026-01-01T00:00:00Z'
        }),
        actor
      )

      const entries = await pagesModel.getTranslationStaleness(fixtures.siteId, [
        'staleness/stale-case'
      ])

      assert.deepEqual(
        entries.map((e) => ({ locale: e.locale, status: e.status })),
        [{ locale: 'fr', status: 'stale' }]
      )
    })

    test('marks a translation at least as new as the primary page as current', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'staleness/current-case',
          locale: 'en',
          title: 'Primary',
          updatedAt: '2026-01-01T00:00:00Z'
        }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'staleness/current-case',
          locale: 'fr',
          title: 'Traduction',
          updatedAt: '2026-06-01T00:00:00Z'
        }),
        actor
      )

      const entries = await pagesModel.getTranslationStaleness(fixtures.siteId, [
        'staleness/current-case'
      ])

      assert.deepEqual(
        entries.map((e) => ({ locale: e.locale, status: e.status })),
        [{ locale: 'fr', status: 'current' }]
      )
    })

    test('reports missing when an active locale has no translation page at all', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'staleness/missing-case', locale: 'en', title: 'Primary Only' }),
        actor
      )

      const entries = await pagesModel.getTranslationStaleness(fixtures.siteId, [
        'staleness/missing-case'
      ])

      assert.deepEqual(entries, [
        { path: 'staleness/missing-case', locale: 'fr', status: 'missing', updatedAt: null }
      ])
    })

    test('a `paths` filter excludes every other path in the site', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'staleness/scoped-a', locale: 'en', title: 'A' }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'staleness/scoped-b', locale: 'en', title: 'B' }),
        actor
      )

      const entries = await pagesModel.getTranslationStaleness(fixtures.siteId, [
        'staleness/scoped-a'
      ])

      assert.ok(entries.length > 0)
      assert.ok(entries.every((e) => e.path === 'staleness/scoped-a'))
    })

    test('with no `paths` given, covers the whole site rather than just an explicitly scoped page', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'staleness/whole-site',
          locale: 'en',
          title: 'Whole',
          updatedAt: '2026-06-01T00:00:00Z'
        }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'staleness/whole-site',
          locale: 'fr',
          title: 'Toute',
          updatedAt: '2026-01-01T00:00:00Z'
        }),
        actor
      )

      const entries = await pagesModel.getTranslationStaleness(fixtures.siteId)
      const forThisPath = entries.filter((e) => e.path === 'staleness/whole-site')

      assert.deepEqual(
        forThisPath.map((e) => ({ locale: e.locale, status: e.status })),
        [{ locale: 'fr', status: 'stale' }]
      )
    })

    test('a site with only its primary locale active short-circuits to an empty list', async () => {
      const originalLocales = WIKI.sites[fixtures.siteId]!.config.locales
      WIKI.sites[fixtures.siteId]!.config.locales = { primary: 'en', active: ['en'] }
      try {
        await pagesModel.createPage(
          fixtures.siteId,
          pageInput({ path: 'staleness/single-locale', locale: 'en', title: 'Solo' }),
          actor
        )

        const entries = await pagesModel.getTranslationStaleness(fixtures.siteId, [
          'staleness/single-locale'
        ])

        assert.deepEqual(entries, [])
      } finally {
        WIKI.sites[fixtures.siteId]!.config.locales = originalLocales
      }
    })
  })
})

/**
 * The change-event trigger `updatePage`/`movePage`/`deletePage`/`deleteOrphaned` queue after
 * `pageHistory.record()` (`models/pages.ts#notifyWatchers`). `WIKI.scheduler` is a stub here (see
 * `test/db.ts`) that records `addJob` calls instead of actually running a worker pool, so each test
 * drives the queued `notifyPageWatchers` task itself against the payload the trigger produced — which
 * exercises the real pipeline end to end without needing a live scheduler.
 */
describe('pages watch-notification trigger (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor
  let watcherId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    const [watcher] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'watcher@example.com', name: 'Watcher', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    watcherId = watcher!.id

    // -> The watcher is an ordinary reader, not an admin: OpenProject #2173's read:pages re-check in
    //    `pageWatching.listWatchers` needs them to actually hold it, the same way a real watcher
    //    would need to in order to be notified at all.
    await fixtures.db
      .insert(userGroupsTable)
      .values({ userId: watcherId, groupId: fixtures.groupId })
    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'watch-trigger-read-everywhere',
            name: 'Read everywhere',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          } satisfies GroupRule
        ]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await WIKI.models.groups.reloadCache()
    // -> Same reasoning as the describe block above: none of these tests supply a `render`, and
    //    Puppeteer is never installed here (OpenProject #1716).
    mock.method(WIKI.models.renderQueue, 'ensureCanRender', async () => {})
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
  })

  const originalSendPageWatchNotification = mail.sendPageWatchNotification.bind(mail)

  beforeEach(() => {
    // -> Each test starts from the real sender; a stub installed by one test must not leak into the
    //    next. WIKI.config here (see `test/db.ts`) has no `mail` key at all, so the real sender would
    //    throw ERR_MAIL_NOT_CONFIGURED on its own — exactly the behavior the "leaves it pending, does
    //    not throw the job" tests below rely on without any extra setup.
    mail.sendPageWatchNotification = originalSendPageWatchNotification
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'watched-page',
      title: 'Watched Page',
      editor: 'markdown',
      content: '# Hello',
      ...overrides
    }
  }

  /** Runs every `notifyPageWatchers` job the stub scheduler was handed since the last call. */
  async function drainQueuedNotifications(): Promise<void> {
    const addJob = WIKI.scheduler.addJob as unknown as {
      mock: {
        calls: { arguments: [{ task: string; payload: any }]; result: any }[]
        resetCalls: () => void
      }
    }
    const calls = addJob.mock.calls.filter(
      (call) => call.arguments[0].task === 'notifyPageWatchers'
    )
    for (const call of calls) {
      await notifyPageWatchers(call.arguments[0].payload)
    }
    addJob.mock.resetCalls()
  }

  async function pendingEventsFor(
    pageId: string
  ): Promise<(typeof pageWatchEventsTable.$inferSelect)[]> {
    return fixtures.db
      .select()
      .from(pageWatchEventsTable)
      .where(eq(pageWatchEventsTable.pageId, pageId))
  }

  test('createPage queues nothing: nobody can be watching a page before it exists', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/create-me' }),
      actor
    )
    const events = await pendingEventsFor(page.id)
    assert.deepEqual(events, [])
  })

  test('updatePage queues a pending notification for a watcher, excluding the actor themselves', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/update-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })
    // -> The actor also watches their own page -- they must not be notified about their own edit
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: actor.id
    })

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Updated' }, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.userId, watcherId)
    assert.equal(events[0]!.action, 'updated')
    assert.equal(events[0]!.deliveredAt, null)
  })

  test('updatePage queues nothing when the page has no watchers', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/no-watchers' }),
      actor
    )
    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Still unwatched' }, actor)
    await drainQueuedNotifications()

    assert.deepEqual(await pendingEventsFor(page.id), [])
  })

  test('movePage queues a "moved" notification for a watcher', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/move-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.movePage(fixtures.siteId, page.id, { path: 'watch/moved-to' }, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.action, 'moved')
  })

  test('deletePage queues a "deleted" notification, surviving the cascade that removes the watch itself', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/delete-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.userId, watcherId)
    assert.equal(events[0]!.action, 'deleted')

    // -> The watch row itself is gone with the page (FK cascade) -- only the pending event survives it
    assert.equal(await WIKI.models.pageWatching.isWatching(page.id, watcherId), false)
  })

  test('an immediate-mode watcher gets mail sent right away and their event marked delivered', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/immediate-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId,
      notifyMode: 'immediate'
    })
    const sendCalls: any[] = []
    mail.sendPageWatchNotification = (async (args: any) => {
      sendCalls.push(args)
    }) as any

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Immediately Updated' }, actor)
    await drainQueuedNotifications()

    assert.equal(sendCalls.length, 1)
    assert.equal(sendCalls[0].to, 'watcher@example.com')
    assert.equal(sendCalls[0].siteId, fixtures.siteId)
    assert.equal(sendCalls[0].page.title, 'Immediately Updated')
    assert.equal(sendCalls[0].page.locale, 'en')
    assert.deepEqual(sendCalls[0].changedFields, ['title'])

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.notEqual(events[0]!.deliveredAt, null)
  })

  test('a digest-mode watcher (the default) gets no mail attempt, only a pending event', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/digest-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })
    const send = mock.fn(async () => {})
    mail.sendPageWatchNotification = send as any

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Digest Update' }, actor)
    await drainQueuedNotifications()

    assert.equal(send.mock.calls.length, 0)
    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.deliveredAt, null)
  })

  test('an immediate-mode watcher whose mail send fails keeps their event pending and does not throw', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/immediate-fails' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId,
      notifyMode: 'immediate'
    })
    // -> `WIKI.config.mail` has no `host` in this test fixture (see `test/db.ts`), so the real
    //    sender throws `ERR_MAIL_NOT_CONFIGURED` -- exactly the "unconfigured mail" case this task
    //    has to fail loud on, not silently drop.
    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Will Not Send' }, actor)

    // -> Must not reject: a mail failure must not surface as a failed job (see this file's own
    //    `notify-page-watchers.ts` doc comment on why that would also double-insert `recordMany`).
    await assert.doesNotReject(() => drainQueuedNotifications())

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.deliveredAt, null)
  })

  test('a watcher who opted out of "edited" notifications gets no event at all for an edit', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/opted-out' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId,
      notifyOnEdited: false
    })

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Nobody Cares' }, actor)
    await drainQueuedNotifications()

    assert.deepEqual(await pendingEventsFor(page.id), [])
  })

  test('recorded events capture the actor and changed fields for the future digest job to use', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/captured-fields' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.updatePage(
      fixtures.siteId,
      page.id,
      { title: 'Captured Title', content: '# New content' },
      actor
    )
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.actorId, actor.id)
    assert.deepEqual([...events[0]!.changedFields].sort(), ['content', 'title'])
  })

  test('recorded events capture the page locale as of the change, not the site default', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/captured-locale', locale: 'fr' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Mis À Jour' }, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.pageLocale, 'fr')
  })

  test('a move that changes the page locale records the new locale, with "locale" among the changed fields', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/move-locale', locale: 'en' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.movePage(
      fixtures.siteId,
      page.id,
      { path: 'watch/move-locale', locale: 'fr' },
      actor
    )
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.action, 'moved')
    assert.equal(events[0]!.pageLocale, 'fr')
    assert.ok(events[0]!.changedFields.includes('locale'))
  })
})
