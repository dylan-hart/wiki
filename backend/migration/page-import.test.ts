import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { StagedPage, StagedPageHistoryEntry } from './content-staging.ts'
import type { PageHistoryImportDeps, PageHistoryInsertRow } from './page-history-import.ts'
import type { Page, PageActor, PageInput } from '../models/pages.ts'
import {
  derivePublishState,
  describePrivacyWarning,
  importPages,
  mapEditor,
  type PagesWriteModel
} from './page-import.ts'

function buildStagedPage(overrides: Partial<StagedPage> = {}): StagedPage {
  return {
    oldId: 1,
    path: 'welcome',
    locale: 'en',
    title: 'Welcome',
    hash: 'hash-1',
    description: null,
    content: '# Welcome',
    render: '<h1>Welcome</h1>',
    toc: null,
    contentType: 'markdown',
    isPrivate: false,
    privateNS: null,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    extra: {},
    editorKey: 'markdown',
    tags: [],
    authorId: 'actor-1',
    creatorId: 'actor-1',
    sourceAuthorId: null,
    sourceCreatorId: null,
    localeSiblingOldIds: [],
    history: [],
    ...overrides
  }
}

function buildHistoryEntry(
  overrides: Partial<StagedPageHistoryEntry> = {}
): StagedPageHistoryEntry {
  return {
    oldId: 101,
    action: 'updated',
    path: 'welcome',
    locale: 'en',
    title: 'Welcome',
    description: null,
    content: '# Welcome (old)',
    contentType: 'markdown',
    isPrivate: false,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    editorKey: 'markdown',
    versionDate: '2023-06-01T00:00:00.000Z',
    createdAt: '2023-06-01T00:00:00.000Z',
    extra: {},
    tags: [],
    authorId: 'actor-1',
    sourceAuthorId: null,
    ...overrides
  }
}

/** Never invoked by any test whose staged pages carry no `history` — a required field on
 * `ImportPagesDeps` since #1818 wired `importPages()` straight to `backfillPageHistory()`. */
const noHistoryDeps: PageHistoryImportDeps = {
  async insertVersions() {}
}

/** In-memory fake standing in for `WIKI.models.pages` — records every call so tests can assert on
 * what `importPages` actually sent it, without touching a database. */
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
      allowRatings: true,
      showSidebar: true,
      showTags: true,
      showToc: true,
      tocDepth: { min: 1, max: 6 },
      scriptJsLoad: '',
      scriptJsUnload: '',
      scriptCss: '',
      navigationId: null,
      navigationMode: 'default',
      authorId: actor.id,
      authorName: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      classification: input.classification ?? 'classification-1'
    }
  }

  async queueRerender(siteId: string, id: string, actor: PageActor): Promise<boolean> {
    this.queued.push({ siteId, id, actor })
    return true
  }
}

const noExistingEntries = () => false

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

describe('importPages', () => {
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

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
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
    //    source's real timestamps (content-staging.ts) — this asserts importPages() actually forwards
    //    them to createPage() instead of leaving PageInput.createdAt/updatedAt unset, which would let
    //    createPage()'s now() default silently stamp every imported page with import time.
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({
      createdAt: '2018-05-01T12:00:00.000Z',
      updatedAt: '2020-09-15T09:30:00.000Z'
    })

    await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.createdAt, '2018-05-01T12:00:00.000Z')
    assert.equal(pagesModel.created[0].input.updatedAt, '2020-09-15T09:30:00.000Z')
  })

  test('a malformed staged createdAt/updatedAt degrades to unset rather than reaching createPage()', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ createdAt: 'not-a-date', updatedAt: '' })

    await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.createdAt, undefined)
    assert.equal(pagesModel.created[0].input.updatedAt, undefined)
  })

  test('uses creatorId as the synthetic actor and warns when authorId differs', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 1, authorId: 'editor-uuid', creatorId: 'creator-uuid' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].actor.id, 'creator-uuid')
    assert.ok(
      result.warnings.some((w) => /authorId \(last editor\) differs from creatorId/.test(w))
    )
  })

  test('defaults to passthrough rendering: render carried straight through, no queueRerender call', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ render: '<p>from 2.x</p>' })

    await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created[0].input.render, '<p>from 2.x</p>')
    assert.equal(pagesModel.queued.length, 0)
  })

  test('renderBootstrap "queue" creates with empty render and calls queueRerender for a markdown page', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ editorKey: 'markdown', render: '<p>stale 2.x render</p>' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
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

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [], renderBootstrap: 'queue' }
    )

    assert.equal(pagesModel.created[0].input.render, '<p>from 2.x</p>')
    assert.equal(pagesModel.queued.length, 0)
    assert.ok(result.warnings.some((w) => /only supports the markdown editor/.test(w)))
  })

  test('a privateNS/isPrivate page is imported with a warning rather than dropped', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ isPrivate: true, privateNS: 'secret-team' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 1)
    assert.ok(result.warnings.some((w) => /privateNS "secret-team"/.test(w)))
    assert.ok(result.succeeded[0].warnings.some((w) => /privateNS "secret-team"/.test(w)))
  })

  test('a page whose path collides with a pre-existing tree entry never reaches createPage()', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 5, path: 'taken' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: () => true, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 0)
    assert.equal(result.succeeded.length, 0)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].reason, 'existing-entry-collision')
    assert.equal(result.failed[0].oldId, 5)
    assert.equal(result.pageIdMap.has(5), false)
  })

  test('a page whose path fails to normalize never reaches createPage()', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 6, path: '' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
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

    const result = await importPages(
      pages,
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
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

  test('sibling-collision: streaming is single-pass, so the earlier page is already created by the time the later, colliding one is discovered — only the later one fails', async () => {
    // -> Before #1818, both sides of a sibling collision failed together, because assignTreePaths()
    //    saw the whole batch up front and could refuse both. A one-pass stream can't do that: by the
    //    time "foobar" is seen to collide with "FooBar", "FooBar" has already been created. See the
    //    module doc comment's "Streaming input and per-page sibling-collision detection".
    const pagesModel = new FakePagesModel()
    const pages = [
      buildStagedPage({ oldId: 1, path: 'FooBar' }),
      buildStagedPage({ oldId: 2, path: 'foobar' })
    ]

    const result = await importPages(
      pages,
      { pagesModel, existingEntry: noExistingEntries, historyDeps: noHistoryDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 1)
    assert.equal(result.succeeded.length, 1)
    assert.equal(result.succeeded[0].oldId, 1)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].oldId, 2)
    assert.equal(result.failed[0].reason, 'sibling-collision')
  })

  test('pages and their history are written interleaved: page 1 is fully imported before page 2 is even staged', async () => {
    const pagesModel = new FakePagesModel()
    const events: string[] = []

    async function* streamPages(): AsyncGenerator<StagedPage> {
      const page1 = buildStagedPage({
        oldId: 1,
        path: 'first',
        history: [buildHistoryEntry({ oldId: 101 })]
      })
      events.push('staged:1')
      yield page1

      const page2 = buildStagedPage({
        oldId: 2,
        path: 'second',
        history: [buildHistoryEntry({ oldId: 201 })]
      })
      events.push('staged:2')
      yield page2
    }

    const historyDeps: PageHistoryImportDeps = {
      async insertVersions(rows: PageHistoryInsertRow[]) {
        events.push(`history-inserted:${rows[0]?.pageId}`)
      }
    }

    const result = await importPages(
      streamPages(),
      { pagesModel, existingEntry: noExistingEntries, historyDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.deepEqual(events, [
      'staged:1',
      'history-inserted:page-1',
      'staged:2',
      'history-inserted:page-2'
    ])
    assert.equal(result.succeeded.length, 2)
    assert.equal(result.failed.length, 0)
  })

  test('a failure backfilling one page history neither aborts the run nor loses the other pages', async () => {
    const pagesModel = new FakePagesModel()
    const pages = [
      buildStagedPage({ oldId: 1, path: 'first', history: [buildHistoryEntry({ oldId: 101 })] }),
      buildStagedPage({ oldId: 2, path: 'second', history: [buildHistoryEntry({ oldId: 201 })] })
    ]

    let calls = 0
    const historyDeps: PageHistoryImportDeps = {
      async insertVersions() {
        calls++
        if (calls === 1) {
          throw new Error('insert failed: constraint violation')
        }
      }
    }

    const result = await importPages(
      pages,
      { pagesModel, existingEntry: noExistingEntries, historyDeps },
      { siteId: 'site-1', actorPermissions: [] }
    )

    // -> Both pages were still created — a history-insert failure is not a page-import failure.
    assert.equal(pagesModel.created.length, 2)
    assert.equal(result.succeeded.length, 2)
    assert.equal(result.failed.length, 0)

    assert.ok(result.succeeded[0].warnings.some((w) => /history backfill failed/.test(w)))
    assert.ok(result.warnings.some((w) => /history backfill failed/.test(w)))
    // -> Page 2's history insert was never told to fail — its own warnings stay clean.
    assert.equal(result.succeeded[1].warnings.length, 0)
  })
})
