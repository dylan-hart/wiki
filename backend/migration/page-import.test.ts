import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SOURCE_SYSTEM_WIKIJS_2_5X } from './provenance.ts'
import type { StagedPage } from './content-staging.ts'
import type { MigrationRecord, ProvenanceStore } from './provenance.ts'
import type { Page, PageActor, PageInput } from '../models/pages.ts'
import {
  derivePublishState,
  describePrivacyWarning,
  importPages,
  mapEditor,
  type PagesWriteModel
} from './page-import.ts'

/** A `ProvenanceStore` backed by plain arrays, same approach `provenance.test.ts` and `phases.test.ts`
 * use, so `importPages`'s provenance/idempotency branches never need a working `db`. `seed.records`
 * pre-populates exact provenance mappings; `seed.byPath` pre-populates what the natural-key fallback
 * would find, standing in for a row that already exists at the destination from a prior run. */
function fakeProvenanceStore(
  seed: { records?: MigrationRecord[]; byPath?: Record<string, string> } = {}
): ProvenanceStore & { records: MigrationRecord[] } {
  const records = [...(seed.records ?? [])]
  return {
    records,
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
      records.push({ ...entry, importedAt: new Date() })
    },
    async findExistingUserByEmail() {
      return undefined
    },
    async findExistingPageByPath(_siteId, _locale, path) {
      return seed.byPath?.[path]
    },
    async findExistingAssetByFolderAndFilename() {
      return undefined
    }
  }
}

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

  test('a non-empty unparsable publishStartDate/publishEndDate degrades to null with a warning, rather than reaching createPage() raw (OpenProject #1853)', async () => {
    const pagesModel = new FakePagesModel()
    const staged = buildStagedPage({
      publishStartDate: 'not-a-date',
      publishEndDate: '2024-01-01T00:00:00.000Z'
    })

    const result = await importPages(
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

    const result = await importPages(
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

    await importPages(
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

  test('a page whose path collides with a pre-existing tree entry never reaches createPage()', async () => {
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

  describe('provenance/idempotency (Feature 421 task 746 / Bug 1761)', () => {
    test('a page already mapped by an exact provenance record is skipped rather than competing for its own tree slot', async () => {
      const pagesModel = new FakePagesModel()
      const staged = buildStagedPage({ oldId: 42, path: 'welcome', locale: 'en' })
      const provenanceStore = fakeProvenanceStore({
        records: [
          {
            siteId: 'site-1',
            sourceSystem: SOURCE_SYSTEM_WIKIJS_2_5X,
            sourceTable: 'pages',
            sourceId: '42',
            destTable: 'pages',
            destId: 'page-from-prior-run',
            importedAt: new Date()
          }
        ]
      })

      // The prior run's own page really does occupy this tree slot — existingEntry would report a
      // collision if assignTreePaths ever saw this page, which is exactly what the provenance lookup
      // ahead of it must prevent.
      const result = await importPages(
        [staged],
        { pagesModel, existingEntry: () => true, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )

      assert.equal(result.failed.length, 0)
      assert.equal(pagesModel.created.length, 0)
      assert.equal(result.succeeded.length, 1)
      assert.equal(result.succeeded[0].action, 'skipped')
      assert.equal(result.succeeded[0].pageId, 'page-from-prior-run')
      assert.equal(result.pageIdMap.get(42), 'page-from-prior-run')
    })

    test('a genuinely foreign occupant of the same tree slot still fails as existing-entry-collision', async () => {
      const pagesModel = new FakePagesModel()
      const staged = buildStagedPage({ oldId: 99, path: 'welcome', locale: 'en' })

      const result = await importPages(
        [staged],
        { pagesModel, existingEntry: () => true, provenanceStore: fakeProvenanceStore() },
        { siteId: 'site-1', actorPermissions: [] }
      )

      assert.equal(pagesModel.created.length, 0)
      assert.equal(result.succeeded.length, 0)
      assert.equal(result.failed.length, 1)
      assert.equal(result.failed[0].reason, 'existing-entry-collision')
    })

    test('re-running the same page set is idempotent: pages created on the first run are skipped, not collided, on the second', async () => {
      const pagesModel = new FakePagesModel()
      const provenanceStore = fakeProvenanceStore()
      const pages = [
        buildStagedPage({ oldId: 1, path: 'alpha' }),
        buildStagedPage({ oldId: 2, path: 'beta' })
      ]

      const first = await importPages(
        pages,
        { pagesModel, existingEntry: noExistingEntries, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )
      assert.equal(first.failed.length, 0)
      assert.equal(first.succeeded.length, 2)
      assert.ok(first.succeeded.every((s) => s.action === 'created'))
      assert.equal(pagesModel.created.length, 2)

      // Re-run against the same provenanceStore: the destination tree really does now hold these two
      // pages (existingEntry reports true for everything), the way it would for real on a second CLI
      // invocation.
      const second = await importPages(
        pages,
        { pagesModel, existingEntry: () => true, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )
      assert.equal(second.failed.length, 0)
      assert.equal(pagesModel.created.length, 2) // no additional createPage() calls
      assert.equal(second.succeeded.length, 2)
      assert.ok(second.succeeded.every((s) => s.action === 'skipped'))
      assert.equal(second.succeeded.find((s) => s.oldId === 1)!.pageId, 'page-1')
      assert.equal(second.succeeded.find((s) => s.oldId === 2)!.pageId, 'page-2')
    })

    test('a natural-key match (interrupted-run edge case) is skipped and backfilled into provenance', async () => {
      const pagesModel = new FakePagesModel()
      const provenanceStore = fakeProvenanceStore({
        byPath: { welcome: 'dest-from-interrupted-run' }
      })
      const staged = buildStagedPage({ oldId: 7, path: 'welcome', locale: 'en' })

      const result = await importPages(
        [staged],
        { pagesModel, existingEntry: noExistingEntries, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )

      assert.equal(pagesModel.created.length, 0)
      assert.equal(result.succeeded[0].action, 'skipped')
      assert.equal(result.succeeded[0].pageId, 'dest-from-interrupted-run')
      assert.equal(provenanceStore.records.length, 1)
      assert.equal(provenanceStore.records[0].sourceId, '7')
      assert.equal(provenanceStore.records[0].destId, 'dest-from-interrupted-run')
    })

    test('a genuinely new page is created and its mapping is persisted for a later run to find', async () => {
      const pagesModel = new FakePagesModel()
      const provenanceStore = fakeProvenanceStore()
      const staged = buildStagedPage({ oldId: 3, path: 'brand-new' })

      const result = await importPages(
        [staged],
        { pagesModel, existingEntry: noExistingEntries, provenanceStore },
        { siteId: 'site-1', actorPermissions: [] }
      )

      assert.equal(pagesModel.created.length, 1)
      assert.equal(result.succeeded[0].action, 'created')
      assert.equal(provenanceStore.records.length, 1)
      assert.equal(provenanceStore.records[0].sourceId, '3')
      assert.equal(provenanceStore.records[0].destId, result.succeeded[0].pageId)
    })
  })
})
