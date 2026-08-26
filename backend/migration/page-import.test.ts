import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { StagedPage } from './content-staging.ts'
import type { MigrationRecord, MigrationRecordKey, ProvenanceStore } from './provenance.ts'
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

/** In-memory fake standing in for `../provenance.ts`'s `ProvenanceStore` — records every `find()` call
 * so a test can assert on which pages actually reached the provenance lookup ahead of `assignTreePaths`,
 * and defaults to "nothing is mapped yet" (a fresh corpus) so existing tests that don't care about
 * provenance keep exercising the same fresh-corpus path they always have. */
function createFakeProvenanceStore(
  overrides: {
    records?: (MigrationRecordKey & { destId: string })[]
    findExistingPageByPath?: () => Promise<string | undefined>
  } = {}
): ProvenanceStore & { findCalls: MigrationRecordKey[] } {
  const records = overrides.records ?? []
  const findCalls: MigrationRecordKey[] = []
  return {
    findCalls,
    async find(key: MigrationRecordKey): Promise<MigrationRecord | undefined> {
      findCalls.push(key)
      const record = records.find(
        (r) =>
          r.siteId === key.siteId &&
          r.sourceSystem === key.sourceSystem &&
          r.sourceTable === key.sourceTable &&
          r.sourceId === key.sourceId
      )
      return record ? { ...record, destTable: 'pages', importedAt: new Date() } : undefined
    },
    async record() {},
    async findExistingUserByEmail() {
      return undefined
    },
    async findExistingPageByPath() {
      return overrides.findExistingPageByPath ? overrides.findExistingPageByPath() : undefined
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      { pagesModel, existingEntry: () => true, provenanceStore: createFakeProvenanceStore() },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
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
      {
        pagesModel,
        existingEntry: noExistingEntries,
        provenanceStore: createFakeProvenanceStore()
      },
      { siteId: 'site-1', actorPermissions: [] }
    )

    assert.equal(pagesModel.created.length, 0)
    assert.equal(result.failed.length, 2)
    assert.ok(result.failed.every((f) => f.reason === 'sibling-collision'))
  })

  describe('provenance lookup ahead of assignTreePaths (Bug 1761 / Task 1770)', () => {
    test('a page already mapped in provenance is resolved without ever reaching assignTreePaths, and does not compete for the same tree slot as a colliding new page', async () => {
      // -> Both pages normalize to the exact same tree location ("dup"). If the already-mapped page
      //    (oldId 1) were still handed to assignTreePaths alongside the new page (oldId 2), both would
      //    land in the same location bucket and assignTreePaths would fail *both* as a sibling-collision
      //    (see the "sibling-collision" tests above). Since the already-mapped page must instead be
      //    filtered out ahead of assignTreePaths, the new page is the sole occupant of that bucket and
      //    is created normally — proving assignTreePaths was invoked with only the pre-filtered set.
      const pagesModel = new FakePagesModel()
      const provenanceStore = createFakeProvenanceStore({
        records: [
          {
            siteId: 'site-1',
            sourceSystem: 'wikijs-2.5x',
            sourceTable: 'pages',
            sourceId: '1',
            destId: 'existing-page-1'
          }
        ]
      })
      const pages = [
        buildStagedPage({ oldId: 1, path: 'dup' }),
        buildStagedPage({ oldId: 2, path: 'dup' })
      ]

      const result = await importPages(
        pages,
        { pagesModel, existingEntry: noExistingEntries, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )

      // -> No sibling-collision: the already-mapped page never reached assignTreePaths, so the new page
      //    had the location bucket to itself.
      assert.equal(result.failed.length, 0)
      assert.equal(pagesModel.created.length, 1)
      assert.equal(pagesModel.created[0].input.path, 'dup')

      // -> The already-mapped page resolved straight to its existing destination id, with no createPage()
      //    call of its own.
      assert.equal(result.succeeded.length, 2)
      const preResolved = result.succeeded.find((s) => s.oldId === 1)
      assert.equal(preResolved?.pageId, 'existing-page-1')
      assert.deepEqual(preResolved?.warnings, [])
      assert.equal(result.pageIdMap.get(1), 'existing-page-1')

      const created = result.succeeded.find((s) => s.oldId === 2)
      assert.equal(created?.pageId, 'page-1')
      assert.equal(result.pageIdMap.get(2), 'page-1')

      // -> The provenance lookup itself happened for both pages, exact-key keyed by their own oldId.
      assert.deepEqual(
        provenanceStore.findCalls.map((k) => k.sourceId),
        ['1', '2']
      )
    })

    test('a page resolved only via the natural-key fallback is also excluded from assignTreePaths', async () => {
      const pagesModel = new FakePagesModel()
      const provenanceStore = createFakeProvenanceStore({
        findExistingPageByPath: async () => 'existing-page-via-natural-key'
      })
      const staged = buildStagedPage({ oldId: 7, path: 'already-there' })

      const result = await importPages(
        [staged],
        { pagesModel, existingEntry: () => true, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )

      // -> existingEntry is only ever consulted by assignTreePaths, so it being wired to always report a
      //    collision (and yet the page still succeeding) proves this page never reached assignTreePaths.
      assert.equal(result.failed.length, 0)
      assert.equal(result.succeeded.length, 1)
      assert.equal(result.succeeded[0].pageId, 'existing-page-via-natural-key')
      assert.equal(pagesModel.created.length, 0)
    })

    test('a fresh corpus (no existing provenance mappings) still passes every existing failure/creation case unchanged', async () => {
      // -> Belt-and-suspenders on top of the individual tests above, which already run against
      //    createFakeProvenanceStore()'s "nothing mapped" default: with no provenance entries, every
      //    staged page is a "pagesNeedingTreeSlot" page, so assignTreePaths sees the exact same input it
      //    always did and outcomes are unchanged from before this task.
      const pagesModel = new FakePagesModel()
      const provenanceStore = createFakeProvenanceStore()
      const staged = buildStagedPage({ oldId: 99, path: 'brand-new' })

      const result = await importPages(
        [staged],
        { pagesModel, existingEntry: noExistingEntries, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )

      assert.equal(result.failed.length, 0)
      assert.equal(result.succeeded.length, 1)
      assert.equal(pagesModel.created.length, 1)
      assert.equal(result.succeeded[0].pageId, 'page-1')
    })
  })
})
