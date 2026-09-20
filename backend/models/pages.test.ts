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
  pageHistory as pageHistoryTable,
  pageRenderQueue as pageRenderQueueTable,
  pages as pagesTable,
  pageWatchEvents as pageWatchEventsTable,
  sites as sitesTable,
  tree as treeTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'
import { getEditorForContentType } from './pages.ts'
import type { GroupRule } from './groups.ts'
import { mail } from './mail.ts'
import { task as notifyPageWatchers } from '../tasks/simple/notify-page-watchers.ts'

/** `tree.getById()` is private, so a test reads the row itself rather than through the model. */
async function readTreeRow(id: string) {
  const rows = await CARDINAL.db.select().from(treeTable).where(eq(treeTable.id, id)).limit(1)
  return rows[0] ?? null
}

/**
 * `wysiwyg` and the plain `markdown` editor both produce `contentType: 'markdown'`
 * (`EDITOR_CONTENT_TYPES`), so the inverse is ambiguous: a naive `Object.fromEntries` of it (last
 * entry wins) attributes every `'markdown'` page to whichever editor it happens to list last.
 */
describe('getEditorForContentType', () => {
  test('a plain markdown content type still resolves back to the markdown editor, not wysiwyg', () => {
    assert.equal(getEditorForContentType('markdown'), 'markdown')
  })

  test('html still resolves to the code editor, its sole producer now that wysiwyg emits markdown', () => {
    assert.equal(getEditorForContentType('html'), 'code')
  })

  test('asciidoc and redirect resolve back to their own single-producer editor', () => {
    assert.equal(getEditorForContentType('asciidoc'), 'asciidoc')
    assert.equal(getEditorForContentType('redirect'), 'redirect')
  })

  test('an unrecognized content type falls back to markdown', () => {
    assert.equal(getEditorForContentType('nonsense'), 'markdown')
  })
})

/**
 * These methods are almost entirely SQL — inserts, duplicate-path checks, and coordination with the
 * tree and history tables — so a mock of the query builder would mostly re-describe the code under
 * test rather than verify it. Run against a real, per-run-fresh database instead.
 */
describe('pages create/update/move/delete (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let pageClassificationModel: typeof import('./pageClassification.ts').pageClassification
  let actor: PageActor
  // -> One wrap for the whole block, reconfigured per test via `.mock.mockImplementation()`: a
  //    target re-mocked with `mock.method()` more than once unwinds on `restoreAll()` only to the
  //    previous wrap's "original", never back to the real method.
  let ensureCanRenderMock: ReturnType<typeof mock.method>

  before(async () => {
    fixtures = await setupTestDb()
    // -> Seeded before any model call, so the first `getLocales()` cache fill already sees them —
    //    `isReservedLocaleCode()` asks which codes are installed, not which are per-site active.
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ pageClassification: pageClassificationModel } = await import('./pageClassification.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    // -> Puppeteer is never installed in this test environment, so a real `ensureCanRender()` would
    //    refuse every render-less create/update below, and almost none of these tests supply a
    //    `render`. The refusal itself gets its own tests further down, with a narrower override.
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

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  /** A raw insert bypassing `createPage()`'s own probes, defaults and refusals entirely. */
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
   * `pages.classification` deliberately carries no column default: one would keep naming the
   * `classificationPublicId` system row even after an administrator deletes it, so an omitted
   * classification has to fail loudly instead. `as any` is what bypasses the compile-time
   * requirement `.values()` puts on real callers, since the database's own refusal is the point.
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
    // -> Newest first: [0] is the update, [1] is the creation.
    assert.equal(entries.length, 2)
    assert.equal(entries[0]!.via, 'mcp')
    assert.equal(entries[1]!.via, 'mcp')
  })

  /**
   * `scriptJsLoad`/`scriptJsUnload`/`scriptCss` are flattened on and off the single `scripts` jsonb
   * column, the way `config`'s fields are. Enforcing `write:scripts`/`write:styles` is a
   * route-level concern; this model layer trusts whatever it is given.
   */
  describe('per-page scripts (OpenProject #3389/#3402)', () => {
    test('createPage() stores scriptJsLoad/scriptJsUnload/scriptCss, and getPage() reads them back', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/scripts-create',
          scriptJsLoad: 'console.log("load")',
          scriptJsUnload: 'console.log("unload")',
          scriptCss: 'body { color: red }'
        }),
        actor
      )
      assert.equal(page.scriptJsLoad, 'console.log("load")')
      assert.equal(page.scriptJsUnload, 'console.log("unload")')
      assert.equal(page.scriptCss, 'body { color: red }')

      const fetched = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
      assert.equal(fetched!.scriptJsLoad, 'console.log("load")')
      assert.equal(fetched!.scriptJsUnload, 'console.log("unload")')
      assert.equal(fetched!.scriptCss, 'body { color: red }')
    })

    test('a page created without any script fields reads them back as empty strings, not undefined', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/scripts-absent' }),
        actor
      )
      assert.equal(page.scriptJsLoad, '')
      assert.equal(page.scriptJsUnload, '')
      assert.equal(page.scriptCss, '')
    })

    test('updatePage() replaces one script field and leaves the other two untouched', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/scripts-update',
          scriptJsLoad: 'console.log("original load")',
          scriptCss: 'body { color: blue }'
        }),
        actor
      )
      const updated = await pagesModel.updatePage(
        fixtures.siteId,
        page.id,
        { scriptJsLoad: 'console.log("new load")' },
        actor
      )
      assert.equal(updated!.scriptJsLoad, 'console.log("new load")')
      assert.equal(updated!.scriptCss, 'body { color: blue }')
    })

    test('updatePage() with no script fields in the patch leaves scripts entirely unchanged', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/scripts-untouched', scriptJsLoad: 'console.log("stays")' }),
        actor
      )
      const updated = await pagesModel.updatePage(
        fixtures.siteId,
        page.id,
        { title: 'Retitled' },
        actor
      )
      assert.equal(updated!.scriptJsLoad, 'console.log("stays")')
    })

    test('a save that changes scriptCss records "scripts" as a changed field, and its history version snapshots it in meta', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/scripts-history' }),
        actor
      )
      await pagesModel.updatePage(
        fixtures.siteId,
        page.id,
        { scriptCss: 'body { color: green }' },
        actor
      )

      const { pageHistory: pageHistoryModel } = await import('./pageHistory.ts')
      const { items: entries } = await pageHistoryModel.list(fixtures.siteId, page.id)
      // -> Newest first: [0] is the update.
      assert.ok(entries[0]!.changedFields.includes('scripts'))

      const version = await pageHistoryModel.getVersion(fixtures.siteId, page.id, entries[0]!.id)
      assert.deepEqual(version!.meta.scripts, {
        jsLoad: '',
        jsUnload: '',
        css: 'body { color: green }'
      })
    })

    /**
     * "A locked page injects nothing" is a server-side guarantee, not something the frontend
     * enforces on data it was never sent: `toPage()` blanks these off the same `unlocked` flag it
     * blanks `render`/`toc` off.
     */
    test('getPage() blanks scriptJsLoad/scriptJsUnload/scriptCss for a locked page, and restores them once unlocked', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/scripts-locked',
          password: 'sw0rdfish',
          scriptJsLoad: 'console.log("load")',
          scriptJsUnload: 'console.log("unload")',
          scriptCss: 'body { color: red }'
        }),
        actor
      )

      const locked = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        unlocked: false
      })
      assert.equal(locked!.isLocked, true)
      assert.equal(locked!.scriptJsLoad, '')
      assert.equal(locked!.scriptJsUnload, '')
      assert.equal(locked!.scriptCss, '')

      const unlocked = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        unlocked: true
      })
      assert.equal(unlocked!.isLocked, false)
      assert.equal(unlocked!.scriptJsLoad, 'console.log("load")')
      assert.equal(unlocked!.scriptJsUnload, 'console.log("unload")')
      assert.equal(unlocked!.scriptCss, 'body { color: red }')
    })
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
    // -> Whichever call loses may lose at the duplicate-path probe or at the unique index itself,
    //    depending on interleaving; the assertion is shaped to hold for both outcomes.
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

  /** The WYSIWYG editor's save path serializes through `@tiptap/markdown`, not `editor.getJSON()`. */
  test('createPage stores the wysiwyg editor content as markdown, matching EDITOR_CONTENT_TYPES', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'docs/wysiwyg-page',
        title: 'WYSIWYG Page',
        editor: 'wysiwyg',
        content: '# Heading\n\nSome **wysiwyg** content.'
      }),
      actor
    )

    assert.equal(page.contentType, 'markdown')
  })

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
    // -> The migration importer supplies these to carry a source page's real timestamps across,
    //    rather than letting `createPage()`'s `now()` default stamp import time over them
    //    (upstream requarks/wiki#4631).
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

    // The initial pageHistory row has to carry that same real updatedAt, or a page imported with
    // genuinely old history shows a "created" entry timestamped today atop its timeline.
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
    assert.equal(updated!.description, 'original description')
  })

  test('updatePage syncs the tree row even when only the description changed (OpenProject #1709)', async () => {
    // -> `Temporal` is a global on every official Node 26 build, but absent on one whose V8 was
    //    compiled without Temporal support. Faked only when genuinely missing, so an official build
    //    still exercises the native API.
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

      // -> Both writes stamp `sql\`now()\``, so real elapsed time between them is what makes the
      //    second `updatedAt` later at all.
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
    // -> An ordinary save may not change which editor authored a page; only `convertEditor()` can.
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
    // -> Never recorded: nothing reads either field, so `treeMeta` computes neither.
    assert.equal('creatorId' in createdMeta, false)
    assert.equal('ownerId' in createdMeta, false)

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Retitled' }, actor)

    const retitledMeta = (await readTreeRow(page.id))!.meta as Record<string, any>
    // -> `updatePage` hands `treeMeta` the flattened `Page` shape (`toPage()`), not a raw row.
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
    // -> `createPage()` refuses this path outright, so a grandfathered row is reachable only by
    //    writing under the model layer. Its ancestor folder row is seeded the same way: `movePage`'s
    //    unconditional tree delete+recreate would otherwise have to re-materialize `fr` through
    //    `createFolder`, which refuses a reserved segment too.
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
    // -> An asset at the destination is invisible to the `pages`-table duplicate-path probe, so the
    //    update proceeds and only the tree write, later in the same transaction, hits the collision
    //    -- the partial-failure shape this test exists for.
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
    assert.equal(moved!.path, 'docs/cascade-b')
    assert.equal(moved!.title, 'English, Renamed')

    const movedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(movedFr!.path, 'docs/cascade-b')
    assert.equal(movedFr!.locale, 'fr')
    assert.equal(movedFr!.title, 'Français')

    const enTree = await readTreeRow(en.id)
    assert.equal(enTree!.fileName, 'cascade-b')
    const frTree = await readTreeRow(fr.id)
    assert.equal(frTree!.fileName, 'cascade-b')

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
    // -> Occupies the destination path in the twin's own locale, held by neither the primary nor
    //    the twin.
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

    const untouchedEn = await pagesModel.getPage({ siteId: fixtures.siteId, id: en.id })
    assert.equal(untouchedEn!.path, 'docs/cascade-abort')
    const untouchedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(untouchedFr!.path, 'docs/cascade-abort')
  })

  test("movePage with includeTranslations: primary changing locale into a twin's own locale aborts the whole batch (OpenProject #1026)", async () => {
    // -> Neither pre-transaction probe can see this collision -- the primary landing in the SAME
    //    locale a twin is cascading into, at the SAME destination path. Only the
    //    `pages_siteId_locale_path_idx` unique index catches it, mid-transaction, translated to 409.
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

    const untouchedEn = await pagesModel.getPage({ siteId: fixtures.siteId, id: en.id })
    assert.equal(untouchedEn!.path, 'docs/cascade-locale-swap')
    assert.equal(untouchedEn!.locale, 'en')
    const untouchedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(untouchedFr!.path, 'docs/cascade-locale-swap')
    assert.equal(untouchedFr!.locale, 'fr')
  })

  /**
   * `glossary.getCachedTerms` caches which page a term points at, and a move changes nothing about
   * the glossary itself -- so `movePage` has to invalidate that cache.
   */
  test('movePage invalidates the glossary cache so a canonical page it renamed resolves to its new path', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-move-before' }),
      actor
    )
    const term = await CARDINAL.models.glossary.createTerm(fixtures.siteId, {
      term: 'MoveCacheTerm',
      definition: 'Points at a page that is about to move.',
      pageId: page.id
    })
    try {
      const before = await CARDINAL.models.glossary.getCachedTerms(fixtures.siteId, actor)
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

      const after = await CARDINAL.models.glossary.getCachedTerms(fixtures.siteId, actor)
      assert.equal(
        after.find((t: any) => t.term === 'MoveCacheTerm')?.link,
        '/docs/glossary-move-after'
      )
    } finally {
      await CARDINAL.models.glossary.deleteTerm(fixtures.siteId, term.id)
    }
  })

  /**
   * A move rewrites same-site, same-locale references in place, driven by the `links`/`relations`
   * tracking `extractInternalLinks` already writes on every save rather than by re-parsing content.
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
      // -> Same bare path, but the FR locale's own page: a link identity is the locale and the path
      //    together, so the EN page's move must leave a reference to this one alone.
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
      // -> A stale recovery draft, as collab's debounced autosave leaves behind for an abandoned
      //    edit; only its presence matters here, not what it holds.
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
      // -> Not a blanket sweep: a page relinking never rewrote keeps its own draft.
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

    // -> A bare-path link in the old locale can never resolve to a page that now lives in a
    //    different one, so rewriting it to `newPath` would only point it at whatever (or nothing)
    //    happens to occupy that path in the OLD locale afterward.
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

    /**
     * A locale-prefixed href (`/fr/guide`) is stripped by `extractInternalLinks` before storage, so
     * `links` holds the bare path `oldPath`/`newPath` are spelled in -- but the prefixed text
     * itself is still sitting in `content`/`render`, and has to be rewritten there too.
     */
    test('rewrites a locale-prefixed href, preserving the locale segment', async () => {
      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/relink-locale-prefixed-target', locale: 'en' }),
        actor
      )
      const referrer = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/relink-locale-prefixed-referrer',
          locale: 'en',
          content: 'See the [target](/fr/docs/relink-locale-prefixed-target) for more.',
          render:
            '<p>See the <a href="/fr/docs/relink-locale-prefixed-target">target</a> for more.</p>'
        }),
        actor
      )
      const [before] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, referrer.id))
      assert.deepEqual(before!.links, ['docs/relink-locale-prefixed-target'])

      await pagesModel.movePage(
        fixtures.siteId,
        target.id,
        { path: 'docs/relink-locale-prefixed-target-new' },
        actor
      )

      const [after] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, referrer.id))
      // -> The markdown `](` form is a knowingly accepted gap: only the `render`'s `href="`
      //    occurrence and `links` are rewritten.
      assert.equal(
        after!.content,
        'See the [target](/fr/docs/relink-locale-prefixed-target) for more.'
      )
      assert.equal(
        after!.render,
        '<p>See the <a href="/fr/docs/relink-locale-prefixed-target-new">target</a> for more.</p>'
      )
      assert.deepEqual(after!.links, ['docs/relink-locale-prefixed-target-new'])
    })
  })

  test('movePage fires the full side-effect set for a single-page move', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/side-effects-before' }),
      actor
    )

    const searchModel = (globalThis as any).CARDINAL.models.search
    const hooksModel = (globalThis as any).CARDINAL.models.hooks
    const storageModel = (globalThis as any).CARDINAL.models.storage
    const glossaryModel = (globalThis as any).CARDINAL.models.glossary
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

      const { pageHistory: pageHistoryModel } = await import('./pageHistory.ts')
      const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
      assert.equal(entries.items[0]!.action, 'moved')

      assert.equal(searchModel.renamed.mock.calls.length, 1)
      const [searchSiteId, searchRawMoved, searchPreviousPath, searchPreviousLocale] =
        searchModel.renamed.mock.calls[0]!.arguments
      assert.equal(searchSiteId, fixtures.siteId)
      assert.equal(searchRawMoved.id, page.id)
      assert.equal(searchPreviousPath, 'docs/side-effects-before')
      assert.equal(searchPreviousLocale, 'en')

      assert.equal(hooksModel.emit.mock.calls.length, 1)
      const [hookEvent, hookSiteId, hookPayload] = hooksModel.emit.mock.calls[0]!.arguments
      assert.equal(hookEvent, 'page:rename')
      assert.equal(hookSiteId, fixtures.siteId)
      assert.equal(hookPayload.id, page.id)
      assert.equal(hookPayload.path, 'docs/side-effects-after')
      assert.equal(hookPayload.previousPath, 'docs/side-effects-before')

      assert.equal(storageModel.dispatch.mock.calls.length, 1)
      const [storageEvent, storagePayload] = storageModel.dispatch.mock.calls[0]!.arguments
      assert.equal(storageEvent, 'page:rename')
      assert.equal(storagePayload.id, page.id)
      assert.equal(storagePayload.path, 'docs/side-effects-after')
      assert.equal(storagePayload.previousPath, 'docs/side-effects-before')

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
   * `tree.id` carries no FK back to `pages.id`, so only `deletePage`'s transaction ties the two
   * deletes together. A surviving orphan tree row would still be rendered by `getTree`'s left join,
   * 404 when opened, and permanently block re-creation at that path via `tree_composite_page_idx`.
   */
  test('deletePage rolls back the page row when tree.deleteEntry fails, leaving the path reusable', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'atomic-delete/page-one', title: 'Atomic Delete Me' }),
      actor
    )
    const treeEntryBefore = await readTreeRow(page.id)
    assert.ok(treeEntryBefore)
    const folderBefore = await CARDINAL.models.tree.getFolder({
      path: 'atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const childrenBefore = folderBefore.meta?.children ?? 0

    const deleteEntry = mock.method(CARDINAL.models.tree, 'deleteEntry', async () => {
      throw new Error('simulated tree.deleteEntry failure')
    })
    try {
      await assert.rejects(pagesModel.deletePage(fixtures.siteId, page.id, actor))
    } finally {
      deleteEntry.mock.restore()
    }

    const pageAfterFailure = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.ok(pageAfterFailure)
    const treeEntryAfterFailure = await readTreeRow(page.id)
    assert.ok(treeEntryAfterFailure)
    const folderAfterFailure = await CARDINAL.models.tree.getFolder({
      path: 'atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    assert.equal(folderAfterFailure.meta?.children ?? 0, childrenBefore)

    const deleted = await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    assert.equal(deleted, true)
    assert.equal(await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id }), null)
    assert.equal(await readTreeRow(page.id), null)

    // -> `tree_composite_page_idx` would refuse this insert if the old tree row had survived.
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

  test('a failure inside tree.deleteEntry rolls back the whole deletePage, leaving the path recreatable', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/atomic-delete/leaf' }),
      actor
    )
    const parentFolder = await CARDINAL.models.tree.getFolder({
      path: 'docs/atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    const childrenBefore = (parentFolder as any).meta?.children ?? 0

    const deleteEntry = mock.method(CARDINAL.models.tree, 'deleteEntry', async () => {
      throw new Error('simulated tree.deleteEntry failure')
    })
    try {
      await assert.rejects(() => pagesModel.deletePage(fixtures.siteId, page.id, actor))
    } finally {
      deleteEntry.mock.restore()
    }

    const stillThere = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.ok(stillThere, 'the page row was not left deleted by the failed transaction')

    const parentFolderAfterFailure = await CARDINAL.models.tree.getFolder({
      path: 'docs/atomic-delete',
      locale: 'en',
      siteId: fixtures.siteId
    })
    assert.equal(
      (parentFolderAfterFailure as any).meta?.children ?? 0,
      childrenBefore,
      "the folder's child count is unchanged by the failed attempt"
    )

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
   * The FK from `glossaryTerms.pageId` is `set null`, so the db unlinks the term itself -- but the
   * cached, resolved copy of that link would keep serving the old path forever (`CARDINAL.cache`
   * carries no TTL) unless `deletePage` drops it too.
   */
  test('deletePage invalidates the glossary cache so a term linked to it resolves to no link', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-delete-me' }),
      actor
    )
    const term = await CARDINAL.models.glossary.createTerm(fixtures.siteId, {
      term: 'DeleteCacheTerm',
      definition: 'Points at a page that is about to be deleted.',
      pageId: page.id
    })
    try {
      const before = await CARDINAL.models.glossary.getCachedTerms(fixtures.siteId, actor)
      assert.equal(
        before.find((t: any) => t.term === 'DeleteCacheTerm')?.link,
        '/docs/glossary-delete-me'
      )

      await pagesModel.deletePage(fixtures.siteId, page.id, actor)

      const after = await CARDINAL.models.glossary.getCachedTerms(fixtures.siteId, actor)
      assert.equal(after.find((t: any) => t.term === 'DeleteCacheTerm')?.link, null)
    } finally {
      await CARDINAL.models.glossary.deleteTerm(fixtures.siteId, term.id)
    }
  })

  /**
   * `getCachedTerms` runs the actor's `read:pages` check against a cached copy of each term's
   * classification and tags. Both cases hang a group rule's ALLOW/DENY off exactly those, so a
   * stale cache shows up as a non-`manage:system` actor's `link` flipping the wrong way -- rather
   * than as a missing call to a spy.
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
      await CARDINAL.models.groups.reloadCache()
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
      const term = await CARDINAL.models.glossary.createTerm(fixtures.siteId, {
        term: 'ClassificationCacheTerm',
        definition: 'Points at a page about to be restricted.',
        pageId: page.id
      })
      try {
        const before = await CARDINAL.models.glossary.getCachedTerms(
          fixtures.siteId,
          restrictedActor
        )
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

        const after = await CARDINAL.models.glossary.getCachedTerms(
          fixtures.siteId,
          restrictedActor
        )
        assert.equal(after.find((t: any) => t.term === 'ClassificationCacheTerm')?.link, null)
      } finally {
        await CARDINAL.models.glossary.deleteTerm(fixtures.siteId, term.id)
      }
    })

    test('a tags-only patch drops the cache so a term loses its access-granting tag and stops resolving', async () => {
      // -> Deliberately no competing path rule: `helpers/pageRules.ts` gives every TAG rule
      //    specificity 0, so a `path: ''` ALLOW would out-rank it and the tag would never be what
      //    decides access.
      await setRules([
        {
          id: 'allow-tagged',
          name: 'Allow tagged',
          roles: ['read:pages'],
          match: 'TAG',
          mode: 'ALLOW',
          path: '',
          tags: ['allowed'],
          locales: [],
          sites: []
        }
      ])

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/glossary-tags-cache', tags: ['allowed'] }),
        actor
      )
      const term = await CARDINAL.models.glossary.createTerm(fixtures.siteId, {
        term: 'TagsCacheTerm',
        definition: 'Points at a page about to lose its access-granting tag.',
        pageId: page.id
      })
      try {
        const before = await CARDINAL.models.glossary.getCachedTerms(
          fixtures.siteId,
          restrictedActor
        )
        assert.equal(
          before.find((t: any) => t.term === 'TagsCacheTerm')?.link,
          '/docs/glossary-tags-cache'
        )

        await pagesModel.updatePage(fixtures.siteId, page.id, { tags: [] }, actor)

        const after = await CARDINAL.models.glossary.getCachedTerms(
          fixtures.siteId,
          restrictedActor
        )
        assert.equal(after.find((t: any) => t.term === 'TagsCacheTerm')?.link, null)
      } finally {
        await CARDINAL.models.glossary.deleteTerm(fixtures.siteId, term.id)
      }
    })
  })

  /**
   * Spies the dispatcher itself rather than asserting on search results: under the `db` engine a
   * hook that is never called still looks correct, so only the call proves an external engine
   * (Elasticsearch, Algolia, ...) would be kept in step.
   */
  test('createPage/updatePage/movePage/deletePage each call the search dispatcher', async () => {
    const calls: string[] = []
    const searchModel = (globalThis as any).CARDINAL.models.search
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
      // -> The spies shadow the prototype methods as own properties, so deleting them is all it
      //    takes for lookup to fall back through to the real ones.
      delete searchModel.created
      delete searchModel.updated
      delete searchModel.renamed
      delete searchModel.deleted
    }
  })

  /**
   * `deleteOrphaned` is the other page-deletion path — pages left behind by a deleted folder.
   * Postgres's own index disappears with the row, but an external engine keeps a stale entry
   * forever unless told to drop it.
   */
  test('deleteOrphaned calls the search dispatcher for every page it removes', async () => {
    const calls: string[] = []
    const searchModel = (globalThis as any).CARDINAL.models.search
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
   * `pages.password` holds a `bcrypt` verifier, never the plaintext: read access to Postgres or to
   * a backup must not hand over every page password.
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
      // -> bcrypt's own encoded format ($<version>$<cost>$<salt+hash>): proof this went through
      //    `bcrypt.hash` and not some other transform.
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
   * The raw inserts stand in for a legacy row `createPage()` can no longer produce, the wysiwyg
   * editor writing `contentType: 'markdown'` (`EDITOR_CONTENT_TYPES`).
   */
  describe('legacy WYSIWYG JSON conversion (OpenProject #3400)', () => {
    const legacyJsonContent = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
    })

    async function insertLegacyRow(path: string, content: string = legacyJsonContent) {
      const inserted = await fixtures.db
        .insert(pagesTable)
        .values({
          ...rawPageRow({ path, locale: 'en', siteId: fixtures.siteId }),
          editor: 'wysiwyg',
          contentType: 'html',
          content
        })
        .returning({ id: pagesTable.id })
      return inserted[0]!.id
    }

    test('convertLegacyWysiwygRow() writes the markdown, flips contentType, and records one history version', async () => {
      const id = await insertLegacyRow('docs/legacy-convert-ok')

      const ok = await pagesModel.convertLegacyWysiwygRow(
        fixtures.siteId,
        id,
        '# Hello',
        fixtures.userId
      )
      assert.equal(ok, true)

      const rows = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, id)).limit(1)
      assert.equal(rows[0]!.content, '# Hello')
      assert.equal(rows[0]!.contentType, 'markdown')

      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, id))
      assert.equal(history.length, 1)
      assert.equal(history[0]!.action, 'updated')
      assert.deepEqual(history[0]!.changedFields, ['content', 'contentType'])
    })

    test('convertLegacyWysiwygRow() returns false and touches nothing for a row already converted', async () => {
      const id = await insertLegacyRow('docs/legacy-convert-already-done')
      const first = await pagesModel.convertLegacyWysiwygRow(
        fixtures.siteId,
        id,
        '# Hello',
        fixtures.userId
      )
      assert.equal(first, true)

      const second = await pagesModel.convertLegacyWysiwygRow(
        fixtures.siteId,
        id,
        '# Something else entirely',
        fixtures.userId
      )
      assert.equal(second, false)

      const rows = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, id)).limit(1)
      assert.equal(rows[0]!.content, '# Hello')

      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, id))
      assert.equal(history.length, 1)
    })

    test('convertLegacyWysiwygRow() returns false for an id that does not exist', async () => {
      const ok = await pagesModel.convertLegacyWysiwygRow(
        fixtures.siteId,
        '00000000-0000-0000-0000-000000000000',
        '# Hello',
        fixtures.userId
      )
      assert.equal(ok, false)
    })

    test("updatePage() on an unconverted legacy row flips contentType once the save's content no longer looks like the legacy JSON (the lazy on-open fallback)", async () => {
      const id = await insertLegacyRow('docs/legacy-lazy-fallback')

      const updated = await pagesModel.updatePage(
        fixtures.siteId,
        id,
        { content: '# Hello, edited in the WYSIWYG editor' },
        actor
      )

      assert.equal(updated!.contentType, 'markdown')

      const rows = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, id)).limit(1)
      assert.equal(rows[0]!.contentType, 'markdown')
      assert.equal(rows[0]!.content, '# Hello, edited in the WYSIWYG editor')

      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, id))
        .orderBy(pageHistoryTable.versionDate)
      const last = history.at(-1)!
      assert.ok(last.changedFields.includes('contentType'))
      assert.ok(last.changedFields.includes('content'))
    })

    test('updatePage() never flips contentType for an ordinary markdown page (not the legacy scenario)', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/ordinary-markdown-save',
          editor: 'wysiwyg',
          content: '# Original'
        }),
        actor
      )

      const updated = await pagesModel.updatePage(
        fixtures.siteId,
        page.id,
        { content: '# Edited again' },
        actor
      )

      assert.equal(updated!.contentType, 'markdown')
      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, page.id))
        .orderBy(pageHistoryTable.versionDate)
      const last = history.at(-1)!
      assert.ok(!last.changedFields.includes('contentType'))
    })
  })

  /**
   * The render-equality guard that decides a conversion is safe to offer at all is client-side
   * (`PageConvertDialog.vue`), so this covers only the write, the refusals, and the one history
   * version.
   */
  describe('convertEditor() (OpenProject #3399)', () => {
    test('flips editor from markdown to wysiwyg and records one history version, leaving content untouched', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/convert-md-to-wysiwyg', editor: 'markdown', content: '# Hello' }),
        actor
      )

      const updated = await pagesModel.convertEditor(fixtures.siteId, page.id, 'wysiwyg', actor)

      assert.equal(updated!.editor, 'wysiwyg')
      const rows = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)
      assert.equal(rows[0]!.editor, 'wysiwyg')
      assert.equal(rows[0]!.content, '# Hello')

      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, page.id))
        .orderBy(pageHistoryTable.versionDate)
      // -> [0] creation, [1] the conversion
      assert.equal(history.length, 2)
      assert.equal(history[1]!.action, 'updated')
      assert.deepEqual(history[1]!.changedFields, ['editor'])
    })

    test('flips editor from wysiwyg back to markdown, same as the other direction', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/convert-wysiwyg-to-md', editor: 'wysiwyg', content: '# Hello' }),
        actor
      )

      const updated = await pagesModel.convertEditor(fixtures.siteId, page.id, 'markdown', actor)

      assert.equal(updated!.editor, 'markdown')
      const rows = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)
      assert.equal(rows[0]!.content, '# Hello')
    })

    test('records the pageHistory row as via: mcp when the actor says so (OpenProject #1119)', async () => {
      const mcpActor: PageActor = { ...actor, via: 'mcp' }
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/convert-via-mcp', editor: 'markdown' }),
        mcpActor
      )

      await pagesModel.convertEditor(fixtures.siteId, page.id, 'wysiwyg', mcpActor)

      const { pageHistory: pageHistoryModel } = await import('./pageHistory.ts')
      const { items: entries } = await pageHistoryModel.list(fixtures.siteId, page.id)
      assert.equal(entries[0]!.via, 'mcp')
    })

    test('refuses a page already using the target editor, and touches nothing', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/convert-unchanged', editor: 'markdown' }),
        actor
      )

      await assert.rejects(
        pagesModel.convertEditor(fixtures.siteId, page.id, 'markdown', actor),
        (err: any) => err.name === 'pageEditorConvertUnchanged' && err.statusCode === 400
      )

      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, page.id))
      assert.equal(history.length, 1)
    })

    test('refuses converting a page whose editor is neither markdown nor wysiwyg', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/convert-unsupported-source', editor: 'code', content: '<p></p>' }),
        actor
      )

      await assert.rejects(
        pagesModel.convertEditor(fixtures.siteId, page.id, 'wysiwyg', actor),
        (err: any) => err.name === 'pageEditorConvertUnsupported' && err.statusCode === 400
      )
    })

    test('refuses converting TO an editor that is neither markdown nor wysiwyg', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/convert-unsupported-target', editor: 'markdown' }),
        actor
      )

      await assert.rejects(
        pagesModel.convertEditor(fixtures.siteId, page.id, 'code', actor),
        (err: any) => err.name === 'pageEditorConvertUnsupported' && err.statusCode === 400
      )
    })

    test('refuses a wysiwyg row still holding legacy Tiptap JSON, not yet migrated by #3400', async () => {
      const inserted = await fixtures.db
        .insert(pagesTable)
        .values({
          ...rawPageRow({
            path: 'docs/convert-legacy-json',
            locale: 'en',
            siteId: fixtures.siteId
          }),
          editor: 'wysiwyg',
          contentType: 'html',
          content: JSON.stringify({ type: 'doc', content: [] })
        })
        .returning({ id: pagesTable.id })
      const id = inserted[0]!.id

      await assert.rejects(
        pagesModel.convertEditor(fixtures.siteId, id, 'markdown', actor),
        (err: any) => err.name === 'pageEditorConvertNotMarkdown' && err.statusCode === 400
      )
    })

    test('returns null for an id that does not exist', async () => {
      const updated = await pagesModel.convertEditor(
        fixtures.siteId,
        '00000000-0000-0000-0000-000000000000',
        'wysiwyg',
        actor
      )
      assert.equal(updated, null)
    })
  })

  describe('render-less create/update leave a queued rerender job (OpenProject #1716)', () => {
    afterEach(() => {
      // -> Every test below narrows or replaces the describe-wide success stub; restoring it here is
      //    what keeps one test's version from leaking into the next.
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

    test('createPage() with a wysiwyg editor and no render consults ensureCanRender with "wysiwyg", not "markdown", and leaves a queued rerender job', async () => {
      const calls: string[] = []
      ensureCanRenderMock.mock.mockImplementation(async (editor: string) => {
        calls.push(editor)
      })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/wysiwyg-render-less-create',
          editor: 'wysiwyg',
          content: '# Hello\n\nSome **wysiwyg** content, stored as markdown.'
        }),
        actor
      )

      assert.deepEqual(calls, ['wysiwyg'])

      const [row] = await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, page.id))
      assert.equal(row!.editor, 'wysiwyg')
      assert.equal(row!.contentType, 'markdown')

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
     * `guestsGroupId` is only ever a uuid looked up at runtime, so pointing it at the fixture group
     * exercises the same `rulesForGroups` path a real anonymous request goes through.
     */
    async function setGuestRules(rules: any[]): Promise<void> {
      CARDINAL.data = { systemIds: { guestsGroupId: fixtures.groupId } }
      await fixtures.db
        .update(groupsTable)
        .set({ rules })
        .where(eq(groupsTable.id, fixtures.groupId))
      await CARDINAL.models.groups.reloadCache()
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

  /** The join half of translation staleness detection; `helpers/translationStatus.ts` compares. */
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
      // -> A raw insert: `createPage()` refuses any siteId absent from the in-memory `CARDINAL.sites`
      //    cache, which a site row inserted straight into the DB never populates. Only the WHERE
      //    clause's site scoping is under test here.
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
    The alias-resolution route threads `locale` and `tags` straight into `mayOnPage`, so a select
    missing either silently narrows a page reached through its alias to path-based rules alone.
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
      // -> Two locales, one parent path, DIFFERENT classifications: a query matching `locale IN
      //    (...)` and `path IN (...)` independently rather than as a pair picks the wrong row.
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

      // -> Each locale batched on its own and compared against the single-page method: batching
      //    both at once would let the per-locale map key mask a cross-locale mismatch.
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
   * The graph route's own `canRead` checks a page-rule permission and never publication state, so
   * `publicOnly` is what keeps a draft away from an unauthenticated caller. It threads into
   * `pageIsVisible` (`tree.ts`), where the two halves differ: `isBrowsable` is the author saying
   * "not in the tree" rather than an access rule, so it applies either way.
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
   * `setupTestDb()` seeds this site with `locales.active: ['en', 'fr']`, which is what makes `fr`
   * the locale these cases expect to come back stale or missing.
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
      const originalLocales = CARDINAL.sites[fixtures.siteId]!.config.locales
      CARDINAL.sites[fixtures.siteId]!.config.locales = { primary: 'en', active: ['en'] }
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
        CARDINAL.sites[fixtures.siteId]!.config.locales = originalLocales
      }
    })
  })
})

/**
 * `CARDINAL.scheduler` is a stub that records `addJob` calls instead of running a worker pool, so
 * each test drives the queued `notifyPageWatchers` task itself against the payload the trigger
 * produced — the whole pipeline, with no live scheduler.
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

    // -> An ordinary reader, not an admin: `pageWatching.listWatchers` re-checks `read:pages`, so a
    //    watcher who does not actually hold it is never notified.
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
    await CARDINAL.models.groups.reloadCache()
    // -> No test here supplies a `render`, and Puppeteer is never installed in this environment.
    mock.method(CARDINAL.models.renderQueue, 'ensureCanRender', async () => {})
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
  })

  const originalSendPageWatchNotification = mail.sendPageWatchNotification.bind(mail)

  beforeEach(() => {
    // -> Each test starts from the real sender, so no stub leaks into the next. That sender throws
    //    ERR_MAIL_NOT_CONFIGURED here — this fixture's config carries no `mail` key — which is what
    //    the "leaves it pending, does not throw the job" tests below rely on.
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

  async function drainQueuedNotifications(): Promise<void> {
    const addJob = CARDINAL.scheduler.addJob as unknown as {
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

  /**
   * The lookup to use for a page that has been deleted: `pageId` is a foreign key, `set null` on
   * the very delete that made the row worth looking up.
   */
  async function pendingEventsForPath(
    pagePath: string
  ): Promise<(typeof pageWatchEventsTable.$inferSelect)[]> {
    return fixtures.db
      .select()
      .from(pageWatchEventsTable)
      .where(eq(pageWatchEventsTable.pagePath, pagePath))
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
    await CARDINAL.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })
    await CARDINAL.models.pageWatching.watch({
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
    await CARDINAL.models.pageWatching.watch({
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
    await CARDINAL.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsForPath('watch/delete-me')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.userId, watcherId)
    assert.equal(events[0]!.action, 'deleted')
    assert.equal(events[0]!.pageId, null)

    assert.equal(await CARDINAL.models.pageWatching.isWatching(page.id, watcherId), false)
  })

  test('deletePage records the "deleted" pageWatchEvents row synchronously, before the async job ever runs', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/delete-synchronously' }),
      actor
    )
    await CARDINAL.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)

    // -> No `drainQueuedNotifications()` here on purpose: `notifyWatchers` records the row itself,
    //    while the `pages` row its FK depends on still exists. Left to the deferred job, the INSERT
    //    would name a page id that is gone by the time it runs.
    const events = await pendingEventsForPath('watch/delete-synchronously')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.action, 'deleted')

    await drainQueuedNotifications()
    assert.equal((await pendingEventsForPath('watch/delete-synchronously')).length, 1)
  })

  test('an immediate-mode watcher gets mail sent right away and their event marked delivered', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/immediate-me' }),
      actor
    )
    await CARDINAL.models.pageWatching.watch({
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
    await CARDINAL.models.pageWatching.watch({
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
    await CARDINAL.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId,
      notifyMode: 'immediate'
    })
    // -> Left unstubbed on purpose: the real sender throws `ERR_MAIL_NOT_CONFIGURED` in this
    //    fixture, which is the unconfigured-mail case being exercised.
    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Will Not Send' }, actor)

    // -> A failed job is retried, and the retry would double-insert through `recordMany`, so a mail
    //    failure must not surface as one.
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
    await CARDINAL.models.pageWatching.watch({
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
    await CARDINAL.models.pageWatching.watch({
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
    await CARDINAL.models.pageWatching.watch({
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
    await CARDINAL.models.pageWatching.watch({
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

/**
 * Asserted on the scope and the fields a call passed, never on a rendered string, and collected by
 * swapping `CARDINAL.logger.info` rather than reading `logger.backlog()` — the rendering and the
 * backlog's frame shape both belong to the logger, not to the code under test.
 */
describe('page content lifecycle log lines (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let pageHistoryModel: typeof import('./pageHistory.ts').pageHistory
  let actor: PageActor
  let originalInfo: any
  let infoCalls: { scope: string; message: string; fields: Record<string, any> }[]

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ pageHistory: pageHistoryModel } = await import('./pageHistory.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    // -> No test here supplies a `render`, and Puppeteer is never installed in this environment.
    mock.method(CARDINAL.models.renderQueue, 'ensureCanRender', async () => {})
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
  })

  beforeEach(() => {
    infoCalls = []
    originalInfo = CARDINAL.logger.info
    CARDINAL.logger.info = ((scope: string, message: string, fields: Record<string, any> = {}) => {
      infoCalls.push({ scope, message, fields })
    }) as any
  })

  afterEach(() => {
    CARDINAL.logger.info = originalInfo
  })

  function pagesLines(message?: string) {
    return infoCalls.filter(
      (call) => call.scope === 'pages' && (message === undefined || call.message === message)
    )
  }

  function lifecycleInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'lifecycle/base',
      title: 'Lifecycle',
      editor: 'markdown',
      content: '# Hello',
      ...overrides
    }
  }

  test('createPage logs one "created" line naming the site, page, path, locale and user', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/created' }),
      actor
    )

    const lines = pagesLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.message, 'created')
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      page: page.id,
      path: 'lifecycle/created',
      locale: 'en',
      user: fixtures.userId
    })
  })

  test('an actor carrying a `via` (an MCP tool call) puts it on the line', async () => {
    await pagesModel.createPage(fixtures.siteId, lifecycleInput({ path: 'lifecycle/via-mcp' }), {
      ...actor,
      via: 'mcp'
    })

    assert.equal(pagesLines('created')[0]!.fields.via, 'mcp')
  })

  test('an ordinary content update logs nothing at info', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/edited' }),
      actor
    )
    infoCalls = []

    await pagesModel.updatePage(
      fixtures.siteId,
      page.id,
      { content: '# Edited', title: 'Edited' },
      actor
    )

    assert.deepEqual(pagesLines(), [])
  })

  test('a publishState change across the published boundary logs "published" then "unpublished"', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/publishing', publishState: 'draft' }),
      actor
    )
    infoCalls = []

    await pagesModel.updatePage(fixtures.siteId, page.id, { publishState: 'published' }, actor)
    const published = pagesLines()
    assert.equal(published.length, 1)
    assert.equal(published[0]!.message, 'published')
    assert.deepEqual(published[0]!.fields, {
      site: fixtures.siteId,
      page: page.id,
      path: 'lifecycle/publishing',
      locale: 'en',
      state: 'published',
      user: fixtures.userId
    })

    infoCalls = []
    await pagesModel.updatePage(fixtures.siteId, page.id, { publishState: 'draft' }, actor)
    const unpublished = pagesLines()
    assert.equal(unpublished.length, 1)
    assert.equal(unpublished[0]!.message, 'unpublished')
    assert.equal(unpublished[0]!.fields.state, 'draft')
  })

  test('a publishState write that does not actually change it logs nothing', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/still-published', publishState: 'published' }),
      actor
    )
    infoCalls = []

    await pagesModel.updatePage(fixtures.siteId, page.id, { publishState: 'published' }, actor)

    assert.deepEqual(pagesLines(), [])
  })

  test('movePage logs one "moved" line carrying where the page came from and went', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/move-from' }),
      actor
    )
    infoCalls = []

    await pagesModel.movePage(fixtures.siteId, page.id, { path: 'lifecycle/move-to' }, actor)

    const lines = pagesLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.message, 'moved')
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      page: page.id,
      from: 'lifecycle/move-from',
      to: 'lifecycle/move-to',
      locale: 'en',
      user: fixtures.userId
    })
  })

  test('a re-homing move adds fromLocale, since from and to can otherwise be the same path', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/rehome' }),
      actor
    )
    infoCalls = []

    await pagesModel.movePage(
      fixtures.siteId,
      page.id,
      { path: 'lifecycle/rehome', locale: 'fr' },
      actor
    )

    const fields = pagesLines('moved')[0]!.fields
    assert.equal(fields.fromLocale, 'en')
    assert.equal(fields.locale, 'fr')
  })

  test('a no-op move logs nothing', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/no-op-move' }),
      actor
    )
    infoCalls = []

    await pagesModel.movePage(fixtures.siteId, page.id, { path: 'lifecycle/no-op-move' }, actor)

    assert.deepEqual(pagesLines(), [])
  })

  test('a translations cascade logs one line per page actually moved, not one for the batch', async () => {
    const primary = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/twins', locale: 'en' }),
      actor
    )
    const twin = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/twins', locale: 'fr' }),
      actor
    )
    infoCalls = []

    await pagesModel.movePage(
      fixtures.siteId,
      primary.id,
      { path: 'lifecycle/twins-moved', includeTranslations: true },
      actor
    )

    const moved = pagesLines('moved')
    assert.equal(moved.length, 2)
    assert.deepEqual(
      moved.map((line) => line.fields.page).sort(),
      [primary.id, twin.id].sort(),
      'both the primary and its twin are moves in their own right'
    )
    for (const line of moved) {
      assert.equal(line.fields.from, 'lifecycle/twins')
      assert.equal(line.fields.to, 'lifecycle/twins-moved')
    }
  })

  test('deletePage logs one "deleted" line', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/delete-me' }),
      actor
    )
    infoCalls = []

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)

    const lines = pagesLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.message, 'deleted')
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      page: page.id,
      path: 'lifecycle/delete-me',
      locale: 'en',
      user: fixtures.userId
    })
  })

  test('deletePage on a page that does not exist logs nothing', async () => {
    await pagesModel.deletePage(fixtures.siteId, '00000000-0000-4000-8000-00000000f00d', actor)

    assert.deepEqual(pagesLines(), [])
  })

  test('deleteOrphaned logs one line per page, marked as a folder cascade', async () => {
    const first = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/orphans/one' }),
      actor
    )
    const second = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/orphans/two' }),
      actor
    )
    infoCalls = []

    await pagesModel.deleteOrphaned(
      fixtures.siteId,
      [
        { id: first.id, fileName: 'one', folderPath: 'lifecycle/orphans', locale: 'en' },
        { id: second.id, fileName: 'two', folderPath: 'lifecycle/orphans', locale: 'en' }
      ],
      actor
    )

    const lines = pagesLines('deleted')
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.map((line) => line.fields.path).sort(), [
      'lifecycle/orphans/one',
      'lifecycle/orphans/two'
    ])
    for (const line of lines) {
      assert.equal(line.fields.cascade, 'folder')
      assert.equal(line.fields.user, fixtures.userId)
    }
  })

  test('recovering a deleted version reads as "restored", not as a second "created"', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      lifecycleInput({ path: 'lifecycle/recover-me' }),
      actor
    )
    await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    const [version] = await fixtures.db
      .select({ id: pageHistoryTable.id })
      .from(pageHistoryTable)
      .where(and(eq(pageHistoryTable.pageId, page.id), eq(pageHistoryTable.action, 'deleted')))
      .limit(1)
    infoCalls = []

    const recovered = await pageHistoryModel.recoverDeletedPage(fixtures.siteId, version!.id, actor)

    const lines = pagesLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.message, 'restored')
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      page: recovered.id,
      path: 'lifecycle/recover-me',
      locale: 'en',
      user: fixtures.userId
    })
  })
})
