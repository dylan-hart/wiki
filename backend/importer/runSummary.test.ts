import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import type { AssetBatchImportSummary } from './assetBatch.ts'
import type { SourceAssetRecord } from './assets.ts'
import type { PageIdMap, SourceCommentRecord, UserIdMap } from './comments.ts'
import {
  applyComments,
  createImportRunSummary,
  mergeAssetBatchSummary,
  validateAssetRecord,
  validateAssets,
  validateCommentRecord,
  validateComments,
  type ImportRunSummary
} from './runSummary.ts'

/**
 * Pure-logic coverage: none of these touch `WIKI.db` (`validateAssetRecord`/`validateAssets` need only
 * the in-memory `WIKI.sites` cache; `applyComments` writes to a throwaway tmp directory, exactly what
 * `writeCommentsStagingBundle` itself already does with no database involved). The DB-backed half of
 * this task's coverage — confirming `applyAssets` folds a real `importAssetsInBatches` run into the
 * exact same `ImportRunSummary` shape `validateAssets` would have produced — lives in
 * `runSummary.integration.test.ts`.
 */

const SITE_ID = randomUUID()

before(() => {
  ;(global as any).WIKI = { sites: { [SITE_ID]: { config: { locales: { primary: 'en' } } } } }
})

function baseAssetRecord(overrides: Partial<SourceAssetRecord> = {}): SourceAssetRecord {
  const filename = overrides.filename ?? 'photo.png'
  return {
    sourceId: filename,
    filename,
    ext: '.png',
    mime: 'image/png',
    fileSize: 100,
    data: Buffer.from('data'),
    folderPath: '',
    authorId: null,
    siteId: SITE_ID,
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
    updatedAt: new Date('2020-01-01T00:00:00.000Z'),
    ...overrides
  }
}

describe('createImportRunSummary', () => {
  test('starts every category at zero with no items', () => {
    const run = createImportRunSummary('dry-run')
    assert.deepEqual(run, {
      mode: 'dry-run',
      assets: { imported: 0, skipped: 0, failed: 0, byteTotal: 0 },
      comments: { imported: 0, skipped: 0, failed: 0, byteTotal: 0 },
      items: []
    })
  })
})

describe('validateAssetRecord', () => {
  test('counts a fully valid record as imported and adds its fileSize to byteTotal', async () => {
    const run = createImportRunSummary('dry-run')
    await validateAssetRecord(baseAssetRecord({ fileSize: 42 }), run)
    assert.equal(run.assets.imported, 1)
    assert.equal(run.assets.failed, 0)
    assert.equal(run.assets.byteTotal, 42)
    assert.deepEqual(run.items, [])
  })

  test('fails a record whose target site does not exist', async () => {
    const run = createImportRunSummary('dry-run')
    await validateAssetRecord(baseAssetRecord({ siteId: randomUUID() }), run)
    assert.equal(run.assets.failed, 1)
    assert.equal(run.assets.imported, 0)
    assert.equal(run.items.length, 1)
    assert.equal(run.items[0].severity, 'error')
    assert.match(run.items[0].reason, /does not exist/)
  })

  test('fails a record whose bytes cannot be read', async () => {
    const run = createImportRunSummary('dry-run')
    const brokenStream = new Readable({
      read() {
        this.destroy(new Error('stream broke'))
      }
    })
    await validateAssetRecord(baseAssetRecord({ data: brokenStream }), run)
    assert.equal(run.assets.failed, 1)
    assert.equal(run.assets.byteTotal, 0)
    assert.ok(
      run.items.some(
        (item) => item.severity === 'error' && /bytes could not be read/.test(item.reason)
      )
    )
  })

  test('fails a record whose folderPath is not constructible', async () => {
    const run = createImportRunSummary('dry-run')
    await validateAssetRecord(baseAssetRecord({ folderPath: 'Bad Folder/sub' }), run)
    assert.equal(run.assets.failed, 1)
    assert.ok(
      run.items.some((item) => item.severity === 'error' && /not a constructible/.test(item.reason))
    )
  })

  test('fails a record whose folderPath hides an empty segment', async () => {
    const run = createImportRunSummary('dry-run')
    await validateAssetRecord(baseAssetRecord({ folderPath: 'a//b' }), run)
    assert.equal(run.assets.failed, 1)
  })

  test('warns, but still imports, when mime cannot be determined from name or source', async () => {
    const run = createImportRunSummary('dry-run')
    await validateAssetRecord(
      baseAssetRecord({ filename: 'mystery.unknownext', ext: 'unknownext', mime: null }),
      run
    )
    assert.equal(run.assets.imported, 1)
    assert.equal(run.assets.failed, 0)
    assert.ok(
      run.items.some(
        (item) =>
          item.severity === 'warning' && /mime type could not be determined/.test(item.reason)
      )
    )
  })

  test('records enough context (sourceId, path) on every item to act on', async () => {
    const run = createImportRunSummary('dry-run')
    await validateAssetRecord(baseAssetRecord({ siteId: randomUUID(), filename: 'x.png' }), run)
    assert.equal(run.items[0].sourceId, 'x.png')
    assert.equal(run.items[0].path, 'x.png')
  })
})

describe('validateAssets', () => {
  test('skips an oversize record before ever reading its bytes, without failing the run', async () => {
    const run = createImportRunSummary('dry-run')
    let dataRead = false
    const trackedStream = new Readable({
      read() {
        dataRead = true
        this.push(Buffer.from('x'))
        this.push(null)
      }
    })
    const oversized = baseAssetRecord({ filename: 'huge.png', fileSize: 1000, data: trackedStream })
    await validateAssets([oversized], run, { maxFileSizeBytes: 500 })
    assert.equal(run.assets.skipped, 1)
    assert.equal(run.assets.imported, 0)
    assert.equal(dataRead, false)
  })

  test('validates every non-oversize record normally', async () => {
    const run = createImportRunSummary('dry-run')
    await validateAssets(
      [baseAssetRecord({ filename: 'a.png' }), baseAssetRecord({ filename: 'b.png' })],
      run,
      { maxFileSizeBytes: 500 }
    )
    assert.equal(run.assets.imported, 2)
  })
})

describe('mergeAssetBatchSummary', () => {
  function emptyBatch(): AssetBatchImportSummary {
    return {
      written: 0,
      authorFallbacks: [],
      alreadyImported: 0,
      skippedOversize: [],
      failedBatches: []
    }
  }

  test('counts written + alreadyImported as imported', () => {
    const run = createImportRunSummary('apply')
    const batch = emptyBatch()
    batch.written = 3
    batch.alreadyImported = 2
    mergeAssetBatchSummary(run, batch)
    assert.equal(run.assets.imported, 5)
  })

  test('folds an authorFallback into a warning item, still counted via written', () => {
    const run = createImportRunSummary('apply')
    const batch = emptyBatch()
    batch.written = 1
    batch.authorFallbacks = [
      { assetId: randomUUID(), sourceId: 'src-1', fileName: 'photo.png', sourceAuthorId: null }
    ]
    mergeAssetBatchSummary(run, batch)
    assert.equal(run.items.length, 1)
    assert.equal(run.items[0].severity, 'warning')
    assert.equal(run.items[0].sourceId, 'src-1')
  })

  test('folds skippedOversize into run.assets.skipped and a warning item', () => {
    const run = createImportRunSummary('apply')
    const batch = emptyBatch()
    batch.skippedOversize = [
      { sourceId: 'src-2', fileName: 'huge.png', siteId: SITE_ID, fileSize: 999, reason: 'too big' }
    ]
    mergeAssetBatchSummary(run, batch)
    assert.equal(run.assets.skipped, 1)
    assert.equal(run.items[0].reason, 'too big')
  })

  test('folds a failedBatch into one failed + one error item per sourceId', () => {
    const run = createImportRunSummary('apply')
    const batch = emptyBatch()
    batch.failedBatches = [
      { batchIndex: 1, sourceIds: ['src-3', 'src-4'], error: 'constraint violation' }
    ]
    mergeAssetBatchSummary(run, batch)
    assert.equal(run.assets.failed, 2)
    assert.equal(run.items.length, 2)
    assert.ok(run.items.every((item) => item.severity === 'error'))
  })
})

function baseCommentRecord(overrides: Partial<SourceCommentRecord> = {}): SourceCommentRecord {
  return {
    id: 1,
    content: 'hello',
    render: '<p>hello</p>',
    name: 'Guest',
    email: 'guest@example.com',
    ip: '127.0.0.1',
    authorId: null,
    pageId: 10,
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
    updatedAt: new Date('2020-01-01T00:00:00.000Z'),
    ...overrides
  }
}

const resolvingPageMap: PageIdMap = { get: (id) => (id === 10 ? 'page-uuid' : undefined) }
const resolvingUserMap: UserIdMap = { get: (id) => (id === 5 ? 'user-uuid' : undefined) }
const emptyPageMap: PageIdMap = { get: () => undefined }
const emptyUserMap: UserIdMap = { get: () => undefined }

describe('validateCommentRecord', () => {
  test('a fully resolvable comment counts as imported with no items', () => {
    const run = createImportRunSummary('dry-run')
    validateCommentRecord(
      baseCommentRecord({ authorId: 5 }),
      resolvingPageMap,
      resolvingUserMap,
      run
    )
    assert.equal(run.comments.imported, 1)
    assert.equal(run.comments.failed, 0)
    assert.deepEqual(run.items, [])
  })

  test('a guest comment (null authorId) is never flagged', () => {
    const run = createImportRunSummary('dry-run')
    validateCommentRecord(
      baseCommentRecord({ authorId: null }),
      resolvingPageMap,
      resolvingUserMap,
      run
    )
    assert.equal(run.comments.imported, 1)
    assert.deepEqual(run.items, [])
  })

  test('an unresolved pageId is a warning, not a failure — legitimately orphaned', () => {
    const run = createImportRunSummary('dry-run')
    validateCommentRecord(baseCommentRecord({ pageId: 999 }), emptyPageMap, resolvingUserMap, run)
    assert.equal(run.comments.imported, 1)
    assert.equal(run.comments.failed, 0)
    assert.equal(run.items[0].severity, 'warning')
    assert.match(run.items[0].reason, /did not resolve to an imported page/)
  })

  test('an unresolved authorId is a warning, not a failure — legitimately guest', () => {
    const run = createImportRunSummary('dry-run')
    validateCommentRecord(baseCommentRecord({ authorId: 999 }), resolvingPageMap, emptyUserMap, run)
    assert.equal(run.comments.imported, 1)
    assert.equal(run.comments.failed, 0)
    assert.match(run.items[0].reason, /did not resolve to an imported user/)
  })

  test('non-string content is a genuine failure', () => {
    const run = createImportRunSummary('dry-run')
    validateCommentRecord(
      baseCommentRecord({ content: undefined as any }),
      resolvingPageMap,
      resolvingUserMap,
      run
    )
    assert.equal(run.comments.failed, 1)
    assert.equal(run.comments.imported, 0)
    assert.equal(run.items[0].severity, 'error')
  })
})

describe('validateComments', () => {
  test('validates every record in the stream', async () => {
    const run = createImportRunSummary('dry-run')
    await validateComments(
      [baseCommentRecord({ id: 1 }), baseCommentRecord({ id: 2, pageId: 999 })],
      resolvingPageMap,
      resolvingUserMap,
      run
    )
    assert.equal(run.comments.imported, 2)
    assert.equal(run.items.length, 1)
  })
})

describe('applyComments', () => {
  let bundleDir: string

  before(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-comments-'))
  })

  after(async () => {
    await fs.rm(bundleDir, { recursive: true, force: true })
  })

  test('stages every comment and folds the same item-detail shape validateComments would produce', async () => {
    const run: ImportRunSummary = createImportRunSummary('apply')
    const manifest = await applyComments(
      bundleDir,
      'site-a',
      [
        baseCommentRecord({ id: 1, authorId: 5 }),
        baseCommentRecord({ id: 2, pageId: 999 }),
        baseCommentRecord({ id: 3, authorId: 999 })
      ],
      resolvingPageMap,
      resolvingUserMap,
      run
    )
    assert.equal(manifest.rowCount, 3)
    assert.equal(run.comments.imported, 3)
    assert.equal(run.comments.failed, 0)
    // -> One warning for comment 2's unresolved page, one for comment 3's unresolved author.
    assert.equal(run.items.length, 2)
    assert.ok(run.items.every((item) => item.severity === 'warning'))
  })
})
