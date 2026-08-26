import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { StagedPage, StagedPageHistoryEntry } from './content-staging.ts'
import { IdMap } from './id-map.ts'
import {
  backfillPageHistory,
  buildPageHistoryRowsForPage,
  mapHistoryAction,
  type PageHistoryImportDeps,
  type PageHistoryInsertRow
} from './page-history-import.ts'

function buildHistoryEntry(
  overrides: Partial<StagedPageHistoryEntry> = {}
): StagedPageHistoryEntry {
  return {
    oldId: 1,
    action: 'updated',
    path: 'welcome',
    locale: 'en',
    title: 'Welcome',
    description: null,
    content: '# Welcome',
    contentType: 'markdown',
    isPrivate: false,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    editorKey: 'markdown',
    versionDate: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    extra: {},
    tags: [],
    authorId: 'user-1',
    sourceAuthorId: 1,
    ...overrides
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
    content: '# Welcome, current',
    render: '<h1>Welcome, current</h1>',
    toc: null,
    contentType: 'markdown',
    isPrivate: false,
    privateNS: null,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-03-01T00:00:00.000Z',
    extra: {},
    editorKey: 'markdown',
    tags: [],
    authorId: 'user-1',
    creatorId: 'user-1',
    sourceAuthorId: 1,
    sourceCreatorId: 1,
    localeSiblingOldIds: [],
    history: [],
    ...overrides
  }
}

class FakePageHistoryWriteModel implements PageHistoryImportDeps {
  inserted: PageHistoryInsertRow[][] = []

  async insertVersions(rows: PageHistoryInsertRow[]): Promise<void> {
    this.inserted.push(rows)
  }
}

describe('mapHistoryAction', () => {
  test('passes the three actions 3.0 also has straight through', () => {
    const warnings: string[] = []
    assert.equal(mapHistoryAction('updated', 'ctx', warnings), 'updated')
    assert.equal(mapHistoryAction('moved', 'ctx', warnings), 'moved')
    assert.equal(mapHistoryAction('deleted', 'ctx', warnings), 'deleted')
    assert.equal(mapHistoryAction('created', 'ctx', warnings), 'created')
    assert.deepEqual(warnings, [])
  })

  test('folds 2.x-only "restored" onto 3.0\'s "updated", with no warning', () => {
    const warnings: string[] = []
    assert.equal(mapHistoryAction('restored', 'ctx', warnings), 'updated')
    assert.deepEqual(warnings, [])
  })

  test('defaults null/undefined to "updated", matching the 2.x column default, with no warning', () => {
    const warnings: string[] = []
    assert.equal(mapHistoryAction(null, 'ctx', warnings), 'updated')
    assert.equal(mapHistoryAction(undefined, 'ctx', warnings), 'updated')
    assert.deepEqual(warnings, [])
  })

  test('falls back to "updated" with a warning for anything outside the confirmed vocabulary', () => {
    const warnings: string[] = []
    const result = mapHistoryAction('archived', 'page 7 pageHistory 3', warnings)
    assert.equal(result, 'updated')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /page 7 pageHistory 3/)
    assert.match(warnings[0], /"archived"/)
  })
})

describe('buildPageHistoryRowsForPage', () => {
  test('returns one row per history entry, in the given order, with an empty changedFields for the first', () => {
    const page = buildStagedPage({
      history: [
        buildHistoryEntry({ oldId: 10, versionDate: '2024-01-01T00:00:00.000Z' }),
        buildHistoryEntry({
          oldId: 11,
          versionDate: '2024-02-01T00:00:00.000Z',
          content: '# Welcome, edited'
        })
      ]
    })
    const warnings: string[] = []
    const rows = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)

    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0].changedFields, [])
    assert.equal(rows[0].pageId, 'new-page-1')
    assert.equal(rows[0].siteId, 'site-1')
    assert.equal(rows[0].versionDate.toISOString(), '2024-01-01T00:00:00.000Z')
    assert.equal(rows[1].versionDate.toISOString(), '2024-02-01T00:00:00.000Z')
  })

  test('diffs consecutive versions and reports only the fields that actually changed', () => {
    const page = buildStagedPage({
      history: [
        buildHistoryEntry({ oldId: 10, title: 'Welcome', content: 'one' }),
        // -> Only content changed; title, tags, etc. are identical to the previous entry.
        buildHistoryEntry({ oldId: 11, title: 'Welcome', content: 'two' }),
        // -> Title changed this time, content did not.
        buildHistoryEntry({ oldId: 12, title: 'Welcome (renamed)', content: 'two' })
      ]
    })
    const warnings: string[] = []
    const rows = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)

    assert.deepEqual(rows[1].changedFields, ['content'])
    assert.deepEqual(rows[2].changedFields, ['title'])
  })

  test('maps action per entry through mapHistoryAction, including the 2.x-only "restored"', () => {
    const page = buildStagedPage({
      history: [
        buildHistoryEntry({ oldId: 10, action: 'updated' }),
        buildHistoryEntry({ oldId: 11, action: 'moved', path: 'welcome-2' }),
        buildHistoryEntry({ oldId: 12, action: 'restored' })
      ]
    })
    const warnings: string[] = []
    const rows = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)

    assert.deepEqual(
      rows.map((r) => r.action),
      ['updated', 'moved', 'updated']
    )
  })

  test('carries the already-resolved authorId straight through, with no further id-map lookup', () => {
    const page = buildStagedPage({
      history: [buildHistoryEntry({ authorId: 'resolved-uuid-9', sourceAuthorId: 42 })]
    })
    const warnings: string[] = []
    const rows = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)
    assert.equal(rows[0].authorId, 'resolved-uuid-9')
  })

  test('builds meta with the same field set record() would, using schema defaults for columns 2.x history has none of', () => {
    const page = buildStagedPage({
      history: [
        buildHistoryEntry({
          description: 'A page about welcoming',
          tags: ['intro', 'home'],
          contentType: 'markdown',
          editorKey: 'markdown'
        })
      ]
    })
    const warnings: string[] = []
    const [row] = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)

    assert.deepEqual(row.meta, {
      alias: null,
      description: 'A page about welcoming',
      icon: null,
      publishState: 'published',
      publishStartDate: null,
      publishEndDate: null,
      config: {},
      relations: [],
      tags: ['intro', 'home'],
      editor: 'markdown',
      contentType: 'markdown',
      isBrowsable: true,
      isSearchable: true,
      password: null
    })
  })

  test("merges the 2.x entry's extra blob into meta without clobbering tags, editor or contentType", () => {
    const page = buildStagedPage({
      history: [
        buildHistoryEntry({
          tags: ['intro'],
          contentType: 'markdown',
          editorKey: 'markdown',
          extra: {
            customField: 'kept',
            // -> Same-named as real meta keys record() derives — must not win.
            tags: ['should-not-appear'],
            editor: 'should-not-appear',
            contentType: 'should-not-appear'
          }
        })
      ]
    })
    const warnings: string[] = []
    const [row] = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)

    assert.equal(row.meta.customField, 'kept')
    assert.deepEqual(row.meta.tags, ['intro'])
    assert.equal(row.meta.editor, 'markdown')
    assert.equal(row.meta.contentType, 'markdown')
  })

  test('has no reason column to carry — 2.x pageHistory rows have none', () => {
    const page = buildStagedPage({ history: [buildHistoryEntry()] })
    const warnings: string[] = []
    const [row] = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)
    assert.equal(row.reason, null)
  })

  test('warns (via mapEditor) once per entry whose editorKey has no 3.0 equivalent', () => {
    const page = buildStagedPage({
      oldId: 5,
      history: [buildHistoryEntry({ oldId: 20, editorKey: 'flatlist', contentType: 'markdown' })]
    })
    const warnings: string[] = []
    buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /page 5/)
    assert.match(warnings[0], /flatlist/)
  })
})

describe('backfillPageHistory', () => {
  test('inserts rows only for pages present in pageIdMap, skipping import failures', () => {
    const created = buildStagedPage({ oldId: 1, history: [buildHistoryEntry({ oldId: 100 })] })
    const failed = buildStagedPage({ oldId: 2, history: [buildHistoryEntry({ oldId: 200 })] })
    const pageIdMap = new IdMap<number>()
    pageIdMap.set(1, 'new-page-1')
    // -> Page 2 never got created, so it has no entry in pageIdMap.

    const deps = new FakePageHistoryWriteModel()
    return backfillPageHistory([created, failed], pageIdMap, 'site-1', deps).then((result) => {
      assert.equal(result.inserted, 1)
      assert.equal(deps.inserted.length, 1)
      assert.equal(deps.inserted[0].length, 1)
      assert.equal(deps.inserted[0][0].pageId, 'new-page-1')
    })
  })

  test('skips pages with no history entirely, without calling insertVersions for them', async () => {
    const noHistory = buildStagedPage({ oldId: 1, history: [] })
    const pageIdMap = new IdMap<number>()
    pageIdMap.set(1, 'new-page-1')

    const deps = new FakePageHistoryWriteModel()
    const result = await backfillPageHistory([noHistory], pageIdMap, 'site-1', deps)

    assert.equal(result.inserted, 0)
    assert.equal(deps.inserted.length, 0)
  })

  test("batches every page's rows into a single insertVersions call", async () => {
    const pageA = buildStagedPage({
      oldId: 1,
      history: [buildHistoryEntry({ oldId: 100 }), buildHistoryEntry({ oldId: 101 })]
    })
    const pageB = buildStagedPage({ oldId: 2, history: [buildHistoryEntry({ oldId: 200 })] })
    const pageIdMap = new IdMap<number>()
    pageIdMap.set(1, 'new-page-1')
    pageIdMap.set(2, 'new-page-2')

    const deps = new FakePageHistoryWriteModel()
    const result = await backfillPageHistory([pageA, pageB], pageIdMap, 'site-1', deps)

    assert.equal(result.inserted, 3)
    assert.equal(deps.inserted.length, 1)
    assert.equal(deps.inserted[0].length, 3)
  })
})
