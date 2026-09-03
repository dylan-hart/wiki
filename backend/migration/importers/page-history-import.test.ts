import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  OrphanedPageHistoryEntry,
  StagedPage,
  StagedPageHistoryEntry
} from '../content-staging.ts'
import {
  backfillOrphanedPageHistory,
  backfillPageHistoryForPage,
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
    ...overrides
  }
}

function buildStagedPage(overrides: Partial<StagedPage> = {}): StagedPage {
  return {
    oldId: 1,
    path: 'welcome',
    locale: 'en',
    title: 'Welcome',
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
    history: [],
    ...overrides
  }
}

function buildOrphanedHistoryEntry(
  overrides: Partial<OrphanedPageHistoryEntry> = {}
): OrphanedPageHistoryEntry {
  return {
    ...buildHistoryEntry(),
    sourcePageOldId: 900,
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
      history: [buildHistoryEntry({ authorId: 'resolved-uuid-9' })]
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

  test("merges a 2.x row's extra blob into meta, alongside the computed keys", () => {
    const page = buildStagedPage({
      history: [buildHistoryEntry({ extra: { customField: 'kept', anotherOne: 42 } })]
    })
    const warnings: string[] = []
    const [row] = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)

    assert.equal(row.meta.customField, 'kept')
    assert.equal(row.meta.anotherOne, 42)
  })

  test('does not let a stray extra key clobber a real computed meta field', () => {
    const page = buildStagedPage({
      history: [
        buildHistoryEntry({
          tags: ['real-tag'],
          editorKey: 'markdown',
          contentType: 'markdown',
          extra: { tags: ['stale-tag'], editor: 'stale-editor', contentType: 'stale-type' }
        })
      ]
    })
    const warnings: string[] = []
    const [row] = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)

    assert.deepEqual(row.meta.tags, ['real-tag'])
    assert.equal(row.meta.editor, 'markdown')
    assert.equal(row.meta.contentType, 'markdown')
  })

  test('does not report extra as a changed field even when it differs between versions', () => {
    const page = buildStagedPage({
      history: [
        buildHistoryEntry({ oldId: 10, extra: { a: 1 } }),
        buildHistoryEntry({ oldId: 11, extra: { a: 2 } })
      ]
    })
    const warnings: string[] = []
    const rows = buildPageHistoryRowsForPage(page, 'new-page-1', 'site-1', warnings)
    assert.deepEqual(rows[1].changedFields, [])
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

describe('backfillPageHistoryForPage', () => {
  test('chunks a single page above HISTORY_INSERT_CHUNK_SIZE into more than one insertVersions call', async () => {
    const bigHistory = Array.from({ length: 12000 }, (_, i) =>
      buildHistoryEntry({ oldId: i + 1, versionDate: new Date(2024, 0, 1, 0, 0, i).toISOString() })
    )
    const page = buildStagedPage({ oldId: 1, history: bigHistory })

    const deps = new FakePageHistoryWriteModel()
    const result = await backfillPageHistoryForPage(page, 'new-page-1', 'site-1', deps)

    assert.equal(result.inserted, 12000)
    assert.deepEqual(result.failed, [])
    // -> 12000 rows over a 5000-row chunk size is 3 calls (5000 + 5000 + 2000), well under Postgres's
    //    65535 bind-parameter ceiling per call (12 fields * 5000 = 60000).
    assert.ok(deps.inserted.length > 1)
    assert.equal(
      deps.inserted.reduce((sum, rows) => sum + rows.length, 0),
      12000
    )
    for (const rows of deps.inserted) {
      assert.ok(rows.length * 12 <= 65535)
    }
  })

  test('an insertVersions rejection reports this page as failed without throwing', async () => {
    const page = buildStagedPage({ oldId: 1, history: [buildHistoryEntry({ oldId: 100 })] })
    const deps: PageHistoryImportDeps = {
      insertVersions: async () => {
        throw new Error('db unavailable')
      }
    }

    const result = await backfillPageHistoryForPage(page, 'new-page-1', 'site-1', deps)

    assert.equal(result.inserted, 0)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].oldId, 1)
    assert.match(result.failed[0].message, /db unavailable/)
  })

  test('a page with no history calls insertVersions zero times', async () => {
    const page = buildStagedPage({ oldId: 1, history: [] })
    const deps = new FakePageHistoryWriteModel()

    const result = await backfillPageHistoryForPage(page, 'new-page-1', 'site-1', deps)

    assert.equal(result.inserted, 0)
    assert.equal(deps.inserted.length, 0)
  })

  test('inserts orphaned history rows under one synthesized pageId per source page, distinct from real pages', () => {
    const orphaned = [
      buildOrphanedHistoryEntry({
        oldId: 500,
        sourcePageOldId: 900,
        versionDate: '2024-01-01T00:00:00.000Z',
        action: 'updated'
      }),
      buildOrphanedHistoryEntry({
        oldId: 501,
        sourcePageOldId: 900,
        versionDate: '2024-02-01T00:00:00.000Z',
        action: 'deleted'
      })
    ]
    const deps = new FakePageHistoryWriteModel()
    return backfillOrphanedPageHistory(orphaned, 'site-1', deps).then((result) => {
      assert.equal(result.inserted, 2)
      const [row0, row1] = deps.inserted[0]
      // -> Both rows for the same deleted 2.x page share one synthesized pageId ...
      assert.equal(row0.pageId, row1.pageId)
      // -> ... which is a real UUID, not the source's numeric old id or anything derived from it.
      assert.match(row0.pageId, /^[0-9a-f-]{36}$/)
      assert.equal(row0.siteId, 'site-1')
      assert.equal(row1.action, 'deleted')
    })
  })

  test('gives two different orphaned source pages two different synthesized pageIds', async () => {
    const orphaned = [
      buildOrphanedHistoryEntry({ oldId: 500, sourcePageOldId: 900 }),
      buildOrphanedHistoryEntry({ oldId: 600, sourcePageOldId: 901 })
    ]
    const deps = new FakePageHistoryWriteModel()
    const result = await backfillOrphanedPageHistory(orphaned, 'site-1', deps)

    assert.equal(result.inserted, 2)
    // -> Each orphaned source page goes through its own backfillPageHistoryForPage call (and
    //    therefore its own insertVersions call), the same way two real pages are isolated from
    //    each other.
    assert.equal(deps.inserted.length, 2)
    assert.notEqual(deps.inserted[0][0].pageId, deps.inserted[1][0].pageId)
  })
})
