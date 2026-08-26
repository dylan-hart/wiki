import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { generatePathHash } from '../helpers/common.ts'
import { groups as groupsTable } from '../db/schema.ts'
import {
  pages as pagesTable,
  pageWatchEvents as pageWatchEventsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'
import { mail } from './mail.ts'
import { task as notifyPageWatchers } from '../tasks/simple/notify-page-watchers.ts'

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
    // -> Seeded before any model call, so the very first `getLocales()` cache fill already sees them
    //    — `isReservedLocaleCode()`'s "installed, not per-site-active" reserved-segment checks need at
    //    least the site's own active codes to actually be installed.
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
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
    const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
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
    const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
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
    const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
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

    const treeEntry = await WIKI.models.tree.getById(source.id)
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
    const enTree = await WIKI.models.tree.getById(en.id)
    assert.equal(enTree!.fileName, 'cascade-b')
    const frTree = await WIKI.models.tree.getById(fr.id)
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

  /*
    Feature 357, task 446: `getPathFromAlias` used to select only `{ id, path }`, so the
    alias-resolution route's `mayOnPage(req, 'read:pages', { path: target.path })` never saw a
    locale or any tags — a locale- or tag-scoped page rule could never be evaluated for a page
    reached through its alias, only a path-based one, silently. This proves the select now carries
    both fields through, which is what api/pages.ts's alias route threads into `mayOnPage`.
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
   * OpenProject #1080: the floor invariant itself, exercised through `createPage`/`updatePage`/
   * `movePage` against a real parent/child hierarchy -- `models/classificationLevels.test.ts` only
   * covers the pure `meetsFloor`/`stricterOf` math, and `api/pages.classification.test.ts` stubs the
   * model entirely, so nothing else proves `resolveCreateClassification`'s parent lookup or
   * `moveOnePageInTx`'s auto-bump actually run against real rows.
   */
  describe('classification floor invariant (OpenProject #1080)', () => {
    let internalId: string
    let restrictedId: string

    before(async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const levels = classificationLevels.list()
      internalId = levels.find((l) => l.name === 'Internal')!.id
      restrictedId = levels.find((l) => l.name === 'Restricted')!.id
    })

    test('a root-level page with no explicit classification defaults to the most-open level', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/root-default' }),
        actor
      )
      assert.equal(page.classification, fixtures.classificationId)
    })

    test('a child page with no explicit classification inherits its immediate parent', async () => {
      const parent = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/inherit-parent', classification: restrictedId }),
        actor
      )
      const child = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: `${parent.path}/child` }),
        actor
      )
      assert.equal(child.classification, restrictedId)
    })

    test('an explicit classification more open than the parent is rejected', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/reject-parent', classification: restrictedId }),
        actor
      )
      await assert.rejects(
        pagesModel.createPage(
          fixtures.siteId,
          pageInput({
            path: 'floor/reject-parent/child',
            classification: fixtures.classificationId
          }),
          actor
        ),
        /classificationBelowFloor/
      )
    })

    test('an explicit classification at or above the parent floor succeeds', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/accept-parent', classification: internalId }),
        actor
      )
      const child = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/accept-parent/child', classification: restrictedId }),
        actor
      )
      assert.equal(child.classification, restrictedId)
    })

    test('updatePage rejects lowering below the immediate parent floor', async () => {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/update-parent', classification: restrictedId }),
        actor
      )
      const child = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/update-parent/child', classification: restrictedId }),
        actor
      )
      await assert.rejects(
        pagesModel.updatePage(
          fixtures.siteId,
          child.id,
          { classification: fixtures.classificationId },
          actor
        ),
        /classificationBelowFloor/
      )
    })

    test('movePage auto-bumps a page onto a new, stricter parent floor', async () => {
      const strictParent = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/move-strict-parent', classification: restrictedId }),
        actor
      )
      const openPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'floor/move-open-page',
          classification: fixtures.classificationId
        }),
        actor
      )
      const moved = await pagesModel.movePage(
        fixtures.siteId,
        openPage.id,
        { path: `${strictParent.path}/moved-in` },
        actor
      )
      assert.equal(moved!.classification, restrictedId)
    })

    test('movePage never lowers a page already at or above the new floor', async () => {
      const openParent = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'floor/move-open-parent',
          classification: fixtures.classificationId
        }),
        actor
      )
      const strictPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'floor/move-strict-page', classification: restrictedId }),
        actor
      )
      const moved = await pagesModel.movePage(
        fixtures.siteId,
        strictPage.id,
        { path: `${openParent.path}/moved-in` },
        actor
      )
      assert.equal(moved!.classification, restrictedId)
    })
  })

  /**
   * OpenProject #1081: "everything currently classified as X" -- `classificationReport()`'s per-level
   * counts and `listByClassification()`'s drill-down, both instance-wide by default and narrowable to
   * one site.
   */
  describe('classificationReport / listByClassification (OpenProject #1081)', () => {
    test('every configured level is included, even at zero, in level order', async () => {
      const report = await pagesModel.classificationReport()
      assert.equal(report.length, 3)
      assert.deepEqual(
        report.map((r) => r.sortOrder),
        [0, 1, 2]
      )
      assert.ok(report.every((r) => typeof r.count === 'number'))
    })

    test('counts and drill-down entries reflect what was actually created', async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const levels = classificationLevels.list()
      const restricted = levels[levels.length - 1]!

      const before = await pagesModel.classificationReport(fixtures.siteId)
      const beforeCount = before.find((r) => r.levelId === restricted.id)!.count

      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classification-report/one', classification: restricted.id }),
        actor
      )
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'classification-report/two', classification: restricted.id }),
        actor
      )

      const after = await pagesModel.classificationReport(fixtures.siteId)
      assert.equal(after.find((r) => r.levelId === restricted.id)!.count, beforeCount + 2)

      const drillDown = await pagesModel.listByClassification(restricted.id, {
        siteId: fixtures.siteId
      })
      assert.equal(drillDown.total, beforeCount + 2)
      const paths = drillDown.entries.map((e) => e.path)
      assert.ok(paths.includes('classification-report/one'))
      assert.ok(paths.includes('classification-report/two'))
    })

    test('listByClassification paginates with limit/offset', async () => {
      const { classificationLevels } = await import('./classificationLevels.ts')
      const publicLevel = classificationLevels.defaultLevel()

      for (let i = 0; i < 3; i++) {
        await pagesModel.createPage(
          fixtures.siteId,
          pageInput({ path: `classification-page/${i}`, classification: publicLevel.id }),
          actor
        )
      }

      const firstPage = await pagesModel.listByClassification(publicLevel.id, {
        siteId: fixtures.siteId,
        limit: 2,
        offset: 0
      })
      assert.equal(firstPage.entries.length, 2)
      assert.ok(firstPage.total >= 3)
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

    // -> OpenProject #2173: `notifyWatchers` now re-checks `read:pages` per watcher before queueing
    //    (`pageWatching.listWatchers`), so the fixture watcher needs a real grant — checkAccess denies
    //    by default (see `helpers/pageRules.ts`) — or every test below would find them excluded.
    const [readerGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Watch Notification Reader',
        permissions: [],
        rules: [
          {
            id: 'allow-read',
            name: 'Allow read',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          }
        ]
      })
      .returning({ id: groupsTable.id })
    await fixtures.db
      .insert(userGroupsTable)
      .values({ userId: watcherId, groupId: readerGroup!.id })
    await WIKI.models.groups.reloadCache()
  })

  after(async () => {
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
