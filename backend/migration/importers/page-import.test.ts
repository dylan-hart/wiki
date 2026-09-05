import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { StagedPage } from '../content-staging.ts'
import type { PageHistoryImportResult } from './page-history-import.ts'
import type { Page, PageActor, PageInput } from '../../models/pages.ts'
import {
  createPageImporter,
  derivePublishState,
  describePrivacyWarning,
  mapEditor,
  type ImportPagesDeps,
  type ImportPagesOptions,
  type PageImportFailureReason,
  type PageImportSuccess,
  type PagesWriteModel
} from './page-import.ts'
import { makeStagedPage } from '../../test/migrationFixtures.ts'

const buildStagedPage = makeStagedPage

/** In-memory fake standing in for `WIKI.models.pages` — records every call so tests can assert on
 * what the importer actually sent it, without touching a database. */
class FakePagesModel implements PagesWriteModel {
  created: { siteId: string; input: PageInput; actor: PageActor }[] = []
  queued: { siteId: string; id: string; actor: PageActor }[] = []
  private nextId = 1
  /** Set to make the next createPage() call throw, simulating e.g. pageEmptyContent. */
  failNextCreate: string | null = null

  async createPage(siteId: string, input: PageInput, actor: PageActor): Promise<Page> {
    if (this.failNextCreate) {
      const message = this.failNextCreate
      this.failNextCreate = null
      throw new Error(message)
    }
    const id = `page-${this.nextId++}`
    this.created.push({ siteId, input, actor })
    // -> Mirrors the real `models/pages.ts#createPage()`'s own behavior (OpenProject #1716): content
    //    with no `render` queues its own re-render internally, with no separate caller-side call --
    //    `page-import.ts` relies on exactly this (OpenProject #1723).
    if (input.render === undefined) {
      this.queued.push({ siteId, id, actor })
    }
    return {
      id,
      path: input.path,
      hash: 'hash',
      alias: null,
      title: input.title,
      description: input.description ?? null,
      icon: null,
      locale: input.locale ?? 'en',
      editor: input.editor,
      contentType: 'markdown',
      publishState: input.publishState ?? 'published',
      publishStartDate: null,
      publishEndDate: null,
      isBrowsable: true,
      isSearchable: true,
      isLocked: false,
      relations: [],
      tags: input.tags ?? [],
      toc: [],
      render: input.render ?? '',
      allowComments: true,
      allowContributions: true,
      showSidebar: true,
      showTags: true,
      showToc: true,
      tocDepth: { min: 1, max: 6 },
      navigationId: null,
      navigationMode: 'default',
      authorId: actor.id,
      authorName: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      classification: input.classification ?? 'classification-1'
    }
  }
}

const noExistingEntries = () => false

/** What `runImport()` folds a whole run's per-page outcomes back into, so a test can assert against
 * the run as a whole rather than call-by-call. */
interface ImportRun {
  succeeded: PageImportSuccess[]
  failed: { oldId: number; reason: PageImportFailureReason; message: string }[]
  /** Every succeeded page's warnings, flattened in processing order. */
  warnings: string[]
  pageIdMap: Map<number, string>
}

/** Drives `createPageImporter()` over a whole page list one `importOne()` call at a time — exactly
 * what `phases/content.ts` does per record — and collects the run's outcomes. */
async function runImport(
  pages: StagedPage[],
  deps: ImportPagesDeps,
  options: ImportPagesOptions
): Promise<ImportRun> {
  const importer = createPageImporter(deps, options)
  const failed: ImportRun['failed'] = []
  for (const staged of pages) {
    const outcome = await importer.importOne(staged)
    if (outcome.status === 'failed') {
      failed.push({ oldId: staged.oldId, reason: outcome.reason, message: outcome.message })
    }
  }
  return {
    succeeded: importer.succeeded,
    failed,
    warnings: importer.succeeded.flatMap((page) => page.warnings),
    pageIdMap: importer.pageIdMap
  }
}

describe('derivePublishState', () => {
  test('isPublished false is always draft, regardless of dates', () => {
    assert.equal(
      derivePublishState(
        { isPublished: false, publishStartDate: null, publishEndDate: null },
        1000
      ),
      'draft'
    )
    assert.equal(
      derivePublishState(
        { isPublished: false, publishStartDate: '2020-01-01T00:00:00.000Z', publishEndDate: null },
        1000
      ),
      'draft'
    )
  })

  test('isPublished true with no dates is published', () => {
    assert.equal(
      derivePublishState({ isPublished: true, publishStartDate: null, publishEndDate: null }, 1000),
      'published'
    )
  })

  test('isPublished true with a future start date is scheduled', () => {
    const now = Date.parse('2024-01-01T00:00:00.000Z')
    assert.equal(
      derivePublishState(
        { isPublished: true, publishStartDate: '2024-06-01T00:00:00.000Z', publishEndDate: null },
        now
      ),
      'scheduled'
    )
  })

  test('isPublished true with an already-past end date is scheduled', () => {
    const now = Date.parse('2024-01-01T00:00:00.000Z')
    assert.equal(
      derivePublishState(
        { isPublished: true, publishStartDate: null, publishEndDate: '2023-06-01T00:00:00.000Z' },
        now
      ),
      'scheduled'
    )
  })

  test('isPublished true and now falls inside the start/end window is published', () => {
    const now = Date.parse('2024-03-01T00:00:00.000Z')
    assert.equal(
      derivePublishState(
        {
          isPublished: true,
          publishStartDate: '2024-01-01T00:00:00.000Z',
          publishEndDate: '2024-06-01T00:00:00.000Z'
        },
        now
      ),
      'published'
    )
  })

  test('an unparseable date is treated as absent rather than thrown on', () => {
    assert.equal(
      derivePublishState(
        { isPublished: true, publishStartDate: 'not-a-date', publishEndDate: null },
        1000
      ),
      'published'
    )
  })
})

describe('mapEditor', () => {
  test('a recognized editorKey maps straight across with no warning', () => {
    const warnings: string[] = []
    assert.equal(
      mapEditor({ oldId: 1, editorKey: 'markdown', contentType: 'markdown' }, warnings),
      'markdown'
    )
    assert.deepEqual(warnings, [])
  })

  test('ckeditor maps onto wysiwyg with no warning', () => {
    const warnings: string[] = []
    assert.equal(
      mapEditor({ oldId: 1, editorKey: 'ckeditor', contentType: 'html' }, warnings),
      'wysiwyg'
    )
    assert.deepEqual(warnings, [])
  })

  test('an unrecognized editorKey with a usable contentType hint warns but still resolves', () => {
    const warnings: string[] = []
    const editor = mapEditor(
      { oldId: 7, editorKey: 'some-plugin-editor', contentType: 'html' },
      warnings
    )
    assert.equal(editor, 'wysiwyg')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /page 7/)
    assert.match(warnings[0], /no 3\.0 equivalent/)
  })

  test('an unrecognized editorKey with no usable hint warns and defaults to markdown', () => {
    const warnings: string[] = []
    const editor = mapEditor(
      { oldId: 9, editorKey: 'some-plugin-editor', contentType: 'weird' },
      warnings
    )
    assert.equal(editor, 'markdown')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /defaulting to editor "markdown"/)
  })

  test('a missing editorKey falls back to contentType with no warning', () => {
    const warnings: string[] = []
    assert.equal(
      mapEditor({ oldId: 1, editorKey: null, contentType: 'markdown' }, warnings),
      'markdown'
    )
    assert.deepEqual(warnings, [])
  })
})

describe('describePrivacyWarning', () => {
  test('an ordinary page produces no warning', () => {
    assert.equal(describePrivacyWarning({ oldId: 1, isPrivate: false, privateNS: null }), null)
  })

  test('isPrivate surfaces a warning naming the unmigrated setting', () => {
    const warning = describePrivacyWarning({ oldId: 3, isPrivate: true, privateNS: null })
    assert.match(warning!, /page 3/)
    assert.match(warning!, /no 3\.0 destination/)
  })

  test('privateNS is named in the warning when present', () => {
    const warning = describePrivacyWarning({ oldId: 3, isPrivate: true, privateNS: 'confidential' })
    assert.match(warning!, /privateNS "confidential"/)
  })
})

describe('per-page import', () => {
  test('creates a page via createPage() with mapped fields', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({
      oldId: 42,
      path: 'Getting_Started',
      locale: 'en',
      title: 'Getting Started',
      description: 'An intro',
      tags: ['intro', 'onboarding'],
      editorKey: 'markdown',
      isPublished: true
    })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: ['write:scripts', 'write:styles'] }
    )

    assert.equal(result.failed.length, 0)
    assert.equal(result.succeeded.length, 1)
    assert.equal(pagesModel.created.length, 1)

    const { siteId, input, actor } = pagesModel.created[0]
    assert.equal(siteId, 'site-1')
    assert.equal(input.path, 'getting-started')
    assert.equal(input.title, 'Getting Started')
    assert.equal(input.description, 'An intro')
    assert.deepEqual(input.tags, ['intro', 'onboarding'])
    assert.equal(input.editor, 'markdown')
    assert.equal(input.publishState, 'published')
    assert.equal(input.render, '<h1>Welcome</h1>')
    assert.equal(actor.id, 'actor-1')

    assert.equal(result.pageIdMap.get(42), 'page-1')
    assert.equal(result.succeeded[0].pageId, 'page-1')
  })

  test('carries the staged createdAt/updatedAt through to PageInput rather than dropping them', async () => {
    // -> Regression test for OpenProject #835 / upstream requarks/wiki#4631 ("Importing from Local
    //    File System is ignoring dateCreated and date fields"): StagedPage already carries the
    //    source's real timestamps (content-staging.ts) — this asserts importOne() actually forwards
    //    them to createPage() instead of leaving PageInput.createdAt/updatedAt unset, which would let
    //    createPage()'s now() default silently stamp every imported page with import time.
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({
      createdAt: '2018-05-01T12:00:00.000Z',
      updatedAt: '2020-09-15T09:30:00.000Z'
    })

    await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.createdAt, '2018-05-01T12:00:00.000Z')
    assert.equal(pagesModel.created[0].input.updatedAt, '2020-09-15T09:30:00.000Z')
  })

  test('a malformed staged createdAt/updatedAt degrades to unset rather than reaching createPage()', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ createdAt: 'not-a-date', updatedAt: '' })

    await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.createdAt, undefined)
    assert.equal(pagesModel.created[0].input.updatedAt, undefined)
  })

  test('a non-empty unparsable publishStartDate/publishEndDate degrades to null with a warning, rather than reaching createPage() raw (OpenProject #1853)', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({
      publishStartDate: 'not-a-date',
      publishEndDate: '2024-01-01T00:00:00.000Z'
    })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(result.failed.length, 0)
    assert.equal(pagesModel.created[0].input.publishStartDate, null)
    assert.equal(pagesModel.created[0].input.publishEndDate, '2024-01-01T00:00:00.000Z')
    assert.ok(
      result.warnings.some((w) => w.includes('publishStartDate') && w.includes('not-a-date'))
    )
    assert.ok(
      result.succeeded[0].warnings.some(
        (w) => w.includes('publishStartDate') && w.includes('not-a-date')
      )
    )
  })

  test('a null publishStartDate/publishEndDate stays null with no warning', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ publishStartDate: null, publishEndDate: null })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.publishStartDate, null)
    assert.equal(pagesModel.created[0].input.publishEndDate, null)
    assert.equal(
      result.warnings.some((w) => w.includes('publishStartDate') || w.includes('publishEndDate')),
      false
    )
  })

  test('a valid publishStartDate/publishEndDate is carried straight through', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({
      publishStartDate: '2024-01-01T00:00:00.000Z',
      publishEndDate: '2024-06-01T00:00:00.000Z'
    })

    await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.publishStartDate, '2024-01-01T00:00:00.000Z')
    assert.equal(pagesModel.created[0].input.publishEndDate, '2024-06-01T00:00:00.000Z')
  })

  test('uses creatorId as the synthetic actor and warns when authorId differs', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 1, authorId: 'editor-uuid', creatorId: 'creator-uuid' })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].actor.id, 'creator-uuid')
    assert.ok(
      result.warnings.some((w) => /authorId \(last editor\) differs from creatorId/.test(w))
    )
  })

  test('defaults to passthrough rendering: render carried straight through, no render queued', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ render: '<p>from 2.x</p>' })

    await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.render, '<p>from 2.x</p>')
    assert.equal(pagesModel.queued.length, 0)
  })

  test('renderBootstrap "queue" creates with no render, and createPage() alone queues exactly one re-render for a markdown page', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ editorKey: 'markdown', render: '<p>stale 2.x render</p>' })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [], renderBootstrap: 'queue' }
    )

    assert.equal(pagesModel.created[0].input.render, undefined)
    assert.equal(pagesModel.queued.length, 1)
    assert.equal(pagesModel.queued[0].id, 'page-1')
    assert.equal(result.warnings.length, 0)
  })

  test('renderBootstrap "queue" falls back to passthrough with a warning for a non-markdown editor', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({
      editorKey: 'ckeditor',
      contentType: 'html',
      render: '<p>from 2.x</p>'
    })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [], renderBootstrap: 'queue' }
    )

    assert.equal(pagesModel.created[0].input.render, '<p>from 2.x</p>')
    assert.equal(pagesModel.queued.length, 0)
    assert.ok(result.warnings.some((w) => /only supports the markdown editor/.test(w)))
  })

  test('a privateNS/isPrivate page is imported with a warning rather than dropped', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ isPrivate: true, privateNS: 'secret-team' })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 1)
    assert.ok(result.warnings.some((w) => /privateNS "secret-team"/.test(w)))
    assert.ok(result.succeeded[0].warnings.some((w) => /privateNS "secret-team"/.test(w)))
  })

  test('a page whose path collides with a pre-existing tree entry never reaches createPage(), and is never retried with a numeric suffix', async () => {
    // -> Unlike sibling-collision, existing-entry-collision is deliberately NOT retried with a
    //    suffix at all — phases/content.ts relies on this exact reason firing immediately to treat
    //    an already-migrated page as an idempotent skip on a re-run of the migration CLI, rather
    //    than creating a renamed duplicate. See resolveStreamedFileName()'s doc comment.
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 5, path: 'taken' })

    const result = await runImport(
      [staged],
      // -> Only the unsuffixed name is reported as occupied — "taken-1" would be free, proving the
      //    importer never even tries it for this reason.
      {
        pagesModel,
        existingEntry: (_siteId, _locale, _parentPath, fileName) => fileName === 'taken'
      },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 0)
    assert.equal(result.succeeded.length, 0)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].reason, 'existing-entry-collision')
    assert.equal(result.failed[0].oldId, 5)
    assert.equal(result.pageIdMap.has(5), false)
    assert.doesNotMatch(result.failed[0].message, /numeric-suffix/)
  })

  test('a page whose path fails to normalize never reaches createPage()', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 6, path: '' })

    const result = await runImport(
      [staged],
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 0)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].reason, 'empty-path')
  })

  test('createPage() throwing for one page is captured as a failure without aborting the rest', async () => {
    const pagesModel = new FakePagesModel()
    pagesModel.failNextCreate = 'A page cannot be empty.'
    const pages = [
      buildStagedPage({ oldId: 1, path: 'empty-page' }),
      buildStagedPage({ oldId: 2, path: 'second-page' })
    ]

    const result = await runImport(
      pages,
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].oldId, 1)
    assert.equal(result.failed[0].reason, 'create-error')
    assert.match(result.failed[0].message, /A page cannot be empty\./)

    assert.equal(result.succeeded.length, 1)
    assert.equal(result.succeeded[0].oldId, 2)
    assert.equal(pagesModel.created.length, 1)
  })

  test('sibling-collision: streaming is single-pass, so the earlier page is already created by the time the later, colliding one is discovered — the later one is renamed via a numeric suffix rather than dropped', async () => {
    // -> A single-pass stream cannot fail both sides of a collision: by the time "foobar" is seen to
    //    collide with "FooBar", "FooBar" has already been created. See the module doc comment's
    //    "Streaming input and per-page sibling-collision detection" — the later page retries with
    //    "foobar-1" and succeeds, rather than being dropped.
    const pagesModel = new FakePagesModel()
    const pages = [
      buildStagedPage({ oldId: 1, path: 'FooBar' }),
      buildStagedPage({ oldId: 2, path: 'foobar' })
    ]

    const result = await runImport(
      pages,
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 2)
    assert.equal(result.succeeded.length, 2)
    assert.equal(result.failed.length, 0)
    assert.equal(pagesModel.created[0].input.path, 'foobar')
    assert.equal(pagesModel.created[1].input.path, 'foobar-1')
    assert.equal(result.pageIdMap.get(1), 'page-1')
    assert.equal(result.pageIdMap.get(2), 'page-2')
    const renamed = result.succeeded.find((s) => s.oldId === 2)!
    assert.ok(renamed.warnings.some((w) => /collided with page 1/.test(w) && /"foobar-1"/.test(w)))
  })

  test('sibling-collision: exhausts every numeric-suffix retry and fails once no free name can be found', async () => {
    const pagesModel = new FakePagesModel()
    const pages = [
      buildStagedPage({ oldId: 1, path: 'FooBar' }),
      buildStagedPage({ oldId: 2, path: 'foobar' })
    ]

    const result = await runImport(
      pages,
      {
        pagesModel,
        // -> "foobar" itself is free (page 1 claims it), but every numbered suffix "foobar-1"…
        //    "foobar-100" is reported as already occupying a pre-existing tree entry, so page 2's
        //    retry budget is exhausted with no free name found — the original sibling-collision (not
        //    the incidental existing-entry-collisions the suffixed retries hit) is what's reported.
        existingEntry: (_siteId, _locale, _parentPath, fileName) => fileName !== 'foobar'
      },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 1)
    assert.equal(result.succeeded.length, 1)
    assert.equal(result.succeeded[0].oldId, 1)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].oldId, 2)
    assert.equal(result.failed[0].reason, 'sibling-collision')
    assert.match(result.failed[0].message, /same tree location as page 1/)
    assert.match(result.failed[0].message, /numeric-suffix retry/)
    assert.match(result.failed[0].message, /100/)
  })

  test("with backfillHistory wired, a page's history is backfilled immediately after it is created — before the next page is even staged", async () => {
    const pagesModel = new FakePagesModel()
    const order: string[] = []
    const staged = [
      buildStagedPage({ oldId: 1, path: 'one' }),
      buildStagedPage({ oldId: 2, path: 'two' })
    ]

    async function* source(): AsyncGenerator<StagedPage> {
      for (const page of staged) {
        order.push(`staged:${page.oldId}`)
        yield page
      }
    }

    const backfillHistory = async (
      page: StagedPage,
      newPageId: string
    ): Promise<PageHistoryImportResult> => {
      order.push(`history:${page.oldId}:${newPageId}`)
      return { inserted: 1, warnings: [], failed: [] }
    }

    const importer = createPageImporter(
      { pagesModel, existingEntry: noExistingEntries, backfillHistory },
      { siteId: 'site-1', actorPermissions: [] }
    )
    for await (const page of source()) {
      await importer.importOne(page)
    }

    // -> Page 1's history landed before page 2 was even pulled off the generator.
    assert.deepEqual(order, ['staged:1', 'history:1:page-1', 'staged:2', 'history:2:page-2'])
  })

  test('a history backfill failure for one page is folded into its warnings without aborting the run or losing other pages', async () => {
    const pagesModel = new FakePagesModel()
    const staged = [
      buildStagedPage({ oldId: 1, path: 'one' }),
      buildStagedPage({ oldId: 2, path: 'two' }),
      buildStagedPage({ oldId: 3, path: 'three' })
    ]

    const backfillHistory = async (
      page: StagedPage,
      _newPageId: string
    ): Promise<PageHistoryImportResult> => {
      if (page.oldId === 2) {
        return { inserted: 0, warnings: [], failed: [{ oldId: 2, message: 'insert failed' }] }
      }
      return { inserted: 1, warnings: [], failed: [] }
    }

    const result = await runImport(
      staged,
      {
        pagesModel,
        existingEntry: noExistingEntries,
        backfillHistory
      },
      { siteId: 'site-1', actorPermissions: [] }
    )

    // -> All three pages were created — the history failure did not abort the run.
    assert.equal(result.succeeded.length, 3)
    assert.equal(result.failed.length, 0)
    assert.equal(pagesModel.created.length, 3)

    const page2 = result.succeeded.find((s) => s.oldId === 2)!
    assert.ok(
      page2.warnings.some((w) => /pageHistory backfill failed/.test(w) && /insert failed/.test(w))
    )
    // -> The other two pages carry no such warning.
    for (const oldId of [1, 3]) {
      const page = result.succeeded.find((s) => s.oldId === oldId)!
      assert.ok(!page.warnings.some((w) => /pageHistory backfill failed/.test(w)))
    }
  })

  test('without backfillHistory, no history backfill is attempted at all', async () => {
    const pagesModel = new FakePagesModel()
    const staged = [buildStagedPage({ oldId: 1, path: 'one' })]

    const result = await runImport(
      staged,
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(result.succeeded.length, 1)
    assert.deepEqual(result.succeeded[0].warnings, [])
  })
})

describe('createPageImporter', () => {
  test('accumulates state across multiple importOne() calls', async () => {
    const pagesModel = new FakePagesModel()
    const importer = createPageImporter(
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    await importer.importOne(buildStagedPage({ oldId: 1, path: 'one' }))
    await importer.importOne(buildStagedPage({ oldId: 2, path: 'two' }))

    assert.equal(importer.succeeded.length, 2)
    assert.equal(importer.pageIdMap.size, 2)
    assert.equal(importer.pageIdMap.get(1), 'page-1')
    assert.equal(importer.pageIdMap.get(2), 'page-2')
    assert.equal(pagesModel.created.length, 2)
  })

  test('claimedLocations persists across importOne() calls, so repeated collisions keep incrementing the suffix', async () => {
    // -> Same single-pass semantics as the sibling-collision test above, but driven through separate
    //    importOne() calls on an importer a test built itself rather than through runImport() — this
    //    is exactly the calling shape phases/content.ts needs: claimedLocations (and every suffixed
    //    name a rename has already claimed) must persist in the importer's own closure between calls,
    //    not just within one loop.
    const pagesModel = new FakePagesModel()
    const importer = createPageImporter(
      { pagesModel, existingEntry: noExistingEntries },
      { siteId: 'site-1', actorPermissions: [] }
    )

    await importer.importOne(buildStagedPage({ oldId: 1, path: 'FooBar' }))
    const outcome2 = await importer.importOne(buildStagedPage({ oldId: 2, path: 'foobar' }))
    const outcome3 = await importer.importOne(buildStagedPage({ oldId: 3, path: 'FOOBAR' }))

    assert.equal(pagesModel.created.length, 3)
    assert.equal(importer.succeeded.length, 3)
    assert.equal(outcome2.status, 'created')
    assert.equal(outcome3.status, 'created')
    assert.equal(pagesModel.created[0].input.path, 'foobar')
    assert.equal(pagesModel.created[1].input.path, 'foobar-1')
    assert.equal(pagesModel.created[2].input.path, 'foobar-2')
  })

  describe('importOne() return value', () => {
    // -> importOne() never throws for a bad page (a sibling-collision, an existing-entry-collision, a
    //    createPage() error), so a caller that blindly wrapped it as recorder.create()'s own write
    //    callback would misreport every failed page as a successful wouldCreate. These assertions are
    //    what phases/content.ts's toRecordOutcome() routes on.
    test('resolves { status: "created", pageId } on success, matching pageIdMap and succeeded[]', async () => {
      const pagesModel = new FakePagesModel()
      const importer = createPageImporter(
        { pagesModel, existingEntry: noExistingEntries },
        { siteId: 'site-1', actorPermissions: [] }
      )

      const outcome = await importer.importOne(buildStagedPage({ oldId: 1, path: 'one' }))

      assert.deepEqual(outcome, { status: 'created', pageId: 'page-1' })
      assert.equal(importer.pageIdMap.get(1), 'page-1')
    })

    test('resolves { status: "created" } for a page renamed via a numeric suffix after a collision, not a failure', async () => {
      const pagesModel = new FakePagesModel()
      const importer = createPageImporter(
        { pagesModel, existingEntry: noExistingEntries },
        { siteId: 'site-1', actorPermissions: [] }
      )

      await importer.importOne(buildStagedPage({ oldId: 1, path: 'FooBar' }))
      const outcome = await importer.importOne(buildStagedPage({ oldId: 2, path: 'foobar' }))

      assert.deepEqual(outcome, { status: 'created', pageId: 'page-2' })
      assert.equal(pagesModel.created[1].input.path, 'foobar-1')
    })

    test('resolves { status: "failed", reason: "sibling-collision", message } once every numeric-suffix retry also collides, not a thrown error', async () => {
      const pagesModel = new FakePagesModel()
      const importer = createPageImporter(
        {
          pagesModel,
          // -> Every suffixed retry ("foobar-1".."foobar-100") also collides with a pre-existing tree
          //    entry, so the retry budget is exhausted and the original sibling-collision is reported.
          existingEntry: (_siteId, _locale, _parentPath, fileName) => fileName !== 'foobar'
        },
        { siteId: 'site-1', actorPermissions: [] }
      )

      await importer.importOne(buildStagedPage({ oldId: 1, path: 'FooBar' }))
      const outcome = await importer.importOne(buildStagedPage({ oldId: 2, path: 'foobar' }))

      assert.equal(outcome.status, 'failed')
      assert.equal((outcome as { reason: string }).reason, 'sibling-collision')
      assert.match((outcome as { message: string }).message, /same tree location/)
      assert.match((outcome as { message: string }).message, /numeric-suffix retry/)
    })

    test('resolves { status: "failed", reason: "existing-entry-collision" } immediately, without any numeric-suffix retry, and without throwing', async () => {
      const pagesModel = new FakePagesModel()
      const importer = createPageImporter(
        {
          pagesModel,
          existingEntry: (_siteId, _locale, _parentPath, fileName) => fileName === 'taken'
        },
        { siteId: 'site-1', actorPermissions: [] }
      )

      const outcome = await importer.importOne(buildStagedPage({ oldId: 5, path: 'taken' }))

      assert.deepEqual(outcome.status, 'failed')
      assert.equal((outcome as { reason: string }).reason, 'existing-entry-collision')
      assert.doesNotMatch((outcome as { message: string }).message, /numeric-suffix/)
      assert.equal(pagesModel.created.length, 0)
    })

    test('resolves { status: "failed", reason: "create-error" } when createPage() throws', async () => {
      const pagesModel = new FakePagesModel()
      pagesModel.failNextCreate = 'A page cannot be empty.'
      const importer = createPageImporter(
        { pagesModel, existingEntry: noExistingEntries },
        { siteId: 'site-1', actorPermissions: [] }
      )

      const outcome = await importer.importOne(buildStagedPage({ oldId: 1, path: 'empty-page' }))

      assert.equal(outcome.status, 'failed')
      assert.equal((outcome as { reason: string }).reason, 'create-error')
      assert.match((outcome as { message: string }).message, /A page cannot be empty\./)
    })

    test('resolves { status: "failed", reason: "empty-path" } for a page whose path never normalizes', async () => {
      const pagesModel = new FakePagesModel()
      const importer = createPageImporter(
        { pagesModel, existingEntry: noExistingEntries },
        { siteId: 'site-1', actorPermissions: [] }
      )

      const outcome = await importer.importOne(buildStagedPage({ oldId: 6, path: '' }))

      assert.equal(outcome.status, 'failed')
      assert.equal((outcome as { reason: string }).reason, 'empty-path')
    })
  })
})
