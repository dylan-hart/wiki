import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SOURCE_SYSTEM_WIKIJS_2_5X } from './provenance.ts'
import type { MigrationRecord, ProvenanceStore } from './provenance.ts'
import type { StagedPage } from './content-staging.ts'
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

interface FakeExistingPage {
  siteId: string
  locale: string
  path: string
  id: string
}

/** In-memory `ProvenanceStore` fake for `importPages()` re-run tests — mirrors `provenance.test.ts`'s
 * own `fakeStore()`, plus a seedable `pages` list backing `findExistingPageByPath` so a test can plant a
 * pre-existing 3.0 page (with or without a matching provenance record) the way an interrupted or
 * previously-successful migration run would leave one. */
function fakeProvenanceStore(
  seed: { records?: MigrationRecord[]; pages?: FakeExistingPage[] } = {}
): ProvenanceStore & { records: MigrationRecord[]; pages: FakeExistingPage[] } {
  const records = [...(seed.records ?? [])]
  const pages = [...(seed.pages ?? [])]
  return {
    records,
    pages,
    async find(key) {
      return records.find(
        (r) =>
          r.siteId === key.siteId &&
          r.sourceSystem === key.sourceSystem &&
          r.sourceTable === key.sourceTable &&
          r.sourceId === key.sourceId
      )
    },
    async record(entry) {
      if (
        records.some(
          (r) =>
            r.siteId === entry.siteId &&
            r.sourceSystem === entry.sourceSystem &&
            r.sourceTable === entry.sourceTable &&
            r.sourceId === entry.sourceId
        )
      ) {
        return
      }
      records.push({ ...entry, importedAt: new Date() })
    },
    async findExistingUserByEmail() {
      return undefined
    },
    async findExistingPageByPath(siteId, locale, path) {
      return pages.find((p) => p.siteId === siteId && p.locale === locale && p.path === path)?.id
    },
    async findExistingAssetByFolderAndFilename() {
      return undefined
    }
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
    assert.equal(result.succeeded[0].action, 'created')
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 1)
    assert.ok(result.warnings.some((w) => /privateNS "secret-team"/.test(w)))
    assert.ok(result.succeeded[0].warnings.some((w) => /privateNS "secret-team"/.test(w)))
  })

  test('a page whose path collides with a genuinely foreign tree entry never reaches createPage()', async () => {
    // -> existingEntry() reports the tree slot occupied, but findExistingPageByPath finds no matching
    //    `pages` row there (the fake store's default, empty `pages` list) — a foreign, non-page occupant
    //    (a folder, an asset, ...) rather than this import's own earlier output, so this must still fail.
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 5, path: 'taken' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: () => true, provenanceStore: fakeProvenanceStore() },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 0)
    assert.equal(result.succeeded.length, 0)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].reason, 'existing-entry-collision')
    assert.equal(result.failed[0].oldId, 5)
    assert.equal(result.pageIdMap.has(5), false)
  })

  test('re-running the same page set reports skipped rather than existing-entry-collision', async () => {
    const provenanceStore = fakeProvenanceStore()
    const pagesModel = new FakePagesModel()
    const pages = [
      buildStagedPage({ oldId: 1, path: 'welcome', locale: 'en' }),
      buildStagedPage({ oldId: 2, path: 'second-page', locale: 'en' })
    ]
    // -> The tree entries this run creates: existingEntry() must report each occupied on run 2, exactly
    //    as a real WIKI.models.tree lookup would after run 1 actually created them.
    const occupiedTreePaths = new Set<string>()
    const existingEntry = (
      _siteId: string,
      _locale: string,
      parentPath: string,
      fileName: string
    ) => occupiedTreePaths.has(parentPath ? `${parentPath}/${fileName}` : fileName)

    const runOne = await importPages(
      pages,
      { pagesModel, existingEntry, provenanceStore },
      { siteId: 'site-1', actorPermissions: [] }
    )
    assert.equal(runOne.failed.length, 0)
    assert.equal(runOne.succeeded.length, 2)
    assert.ok(runOne.succeeded.every((s) => s.action === 'created'))
    assert.equal(pagesModel.created.length, 2)
    // -> Simulate what run one's createPage() calls actually did to the destination: a real, live
    //    WIKI.models.tree now has each slot occupied, and a real ProvenanceStore.findExistingPageByPath
    //    would now find each page — both of which this fake needs telling by hand since it has no
    //    shared backing store with FakePagesModel.
    for (const s of runOne.succeeded) {
      const path = pages.find((p) => p.oldId === s.oldId)!.path
      occupiedTreePaths.add(path)
      provenanceStore.pages.push({ siteId: 'site-1', locale: 'en', path, id: s.pageId })
    }

    const runTwo = await importPages(
      pages,
      { pagesModel, existingEntry, provenanceStore },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(runTwo.failed.length, 0)
    assert.equal(runTwo.succeeded.length, 2)
    assert.ok(runTwo.succeeded.every((s) => s.action === 'skipped'))
    // -> No second createPage() call for either page — still exactly the two from run one.
    assert.equal(pagesModel.created.length, 2)
    assert.equal(runTwo.pageIdMap.get(1), runOne.pageIdMap.get(1))
    assert.equal(runTwo.pageIdMap.get(2), runOne.pageIdMap.get(2))
  })

  test('a page missing only its provenance record (interrupted prior run) is skipped and reconciled via natural key', async () => {
    // -> Simulates the module doc's "interrupted-run edge case": a prior run's createPage() succeeded
    //    (the page + tree row exist) but the process died before the matching migrationRecords row was
    //    written — no exact-key provenance hit, only a natural-key match on the pages table.
    const pagesModel = new FakePagesModel()
    const provenanceStore = fakeProvenanceStore({
      pages: [{ siteId: 'site-1', locale: 'en', path: 'welcome', id: 'page-from-interrupted-run' }]
    })
    const staged = buildStagedPage({ oldId: 1, path: 'welcome', locale: 'en' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: () => true, provenanceStore },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(result.failed.length, 0)
    assert.equal(pagesModel.created.length, 0)
    assert.equal(result.succeeded.length, 1)
    assert.equal(result.succeeded[0].action, 'skipped')
    assert.equal(result.succeeded[0].pageId, 'page-from-interrupted-run')
    assert.equal(result.pageIdMap.get(1), 'page-from-interrupted-run')
    // -> The missing provenance record is backfilled so the *next* run hits the fast exact-key path.
    assert.equal(provenanceStore.records.length, 1)
    assert.equal(provenanceStore.records[0].sourceTable, 'pages')
    assert.equal(provenanceStore.records[0].sourceId, '1')
    assert.equal(provenanceStore.records[0].destId, 'page-from-interrupted-run')
    assert.equal(provenanceStore.records[0].sourceSystem, SOURCE_SYSTEM_WIKIJS_2_5X)
  })

  test('a page whose path fails to normalize never reaches createPage()', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({ oldId: 6, path: '' })

    const result = await importPages(
      [staged],
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
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

  test('sibling-collision pages are both reported as failures and neither is created', async () => {
    const pagesModel = new FakePagesModel()
    const pages = [
      buildStagedPage({ oldId: 1, path: 'FooBar' }),
      buildStagedPage({ oldId: 2, path: 'foobar' })
    ]

    const result = await importPages(
      pages,
      { pagesModel, existingEntry: noExistingEntries, provenanceStore: fakeProvenanceStore() },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 0)
    assert.equal(result.failed.length, 2)
    assert.ok(result.failed.every((f) => f.reason === 'sibling-collision'))
  })
})
