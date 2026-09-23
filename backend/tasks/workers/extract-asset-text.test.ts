import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { assets as assetsTable, jobs as jobsTable } from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { buildTextPdf } from '../../test/pdfFixture.ts'
import { storeAssetText } from '../../helpers/assetText.ts'
import { extractAssetText, task } from './extract-asset-text.ts'

describe('tasks/workers/extract-asset-text (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
    CARDINAL.config.scheduler = { maxRetries: 3 }
    CARDINAL.ensureDb = async () => true
  })

  after(async () => {
    await teardownTestDb()
  })

  async function insertAsset(
    data: Buffer | null,
    fileName = 'file.pdf',
    mimeType = 'application/pdf'
  ) {
    const rows = await fixtures.db
      .insert(assetsTable)
      .values({
        fileName,
        fileExt: fileName.split('.').pop()!,
        kind: 'document',
        mimeType,
        fileSize: data?.length ?? 0,
        data,
        authorId: fixtures.userId,
        siteId: fixtures.siteId
      })
      .returning({ id: assetsTable.id })
    return rows[0]!.id
  }

  async function readAsset(id: string) {
    const rows = await fixtures.db
      .select({ searchContent: assetsTable.searchContent })
      .from(assetsTable)
      .where(eq(assetsTable.id, id))
    return rows[0]!
  }

  async function matches(id: string, term: string): Promise<boolean> {
    const result = await fixtures.db.execute(
      sql`SELECT 1 FROM "assets" WHERE "id" = ${id} AND "ts" @@ to_tsquery('simple', ${term})`
    )
    return result.rows.length > 0
  }

  async function embedJobsFor(assetId: string) {
    const rows = await fixtures.db.select().from(jobsTable)
    return rows.filter(
      (job) => job.task === 'embedAsset' && (job.payload as any)?.assetId === assetId
    )
  }

  test('stores the text layer of a PDF and makes it searchable', async () => {
    CARDINAL.capabilities = { semanticSearch: false }
    const id = await insertAsset(buildTextPdf(['Quarterly revenue forecast for the board']))

    await extractAssetText(id)

    const row = await readAsset(id)
    assert.match(row.searchContent ?? '', /Quarterly revenue forecast for the board/)
    assert.equal(await matches(id, 'forecast'), true)
    assert.equal(await matches(id, 'unrelated'), false)
  })

  test('task() reads the asset id from the job payload', async () => {
    CARDINAL.capabilities = { semanticSearch: false }
    const id = await insertAsset(buildTextPdf(['Payload routed phrase']))

    await task({ payload: { assetId: id } })

    assert.match((await readAsset(id)).searchContent ?? '', /Payload routed phrase/)
  })

  test('a corrupt PDF does not throw and leaves the text empty', async () => {
    CARDINAL.capabilities = { semanticSearch: true }
    const id = await insertAsset(Buffer.from('%PDF-1.4 definitely not a pdf'))

    await assert.doesNotReject(extractAssetText(id))

    assert.equal((await readAsset(id)).searchContent, null)
    assert.deepEqual(await embedJobsFor(id), [])
  })

  test('an encrypted PDF does not throw and leaves the text empty', async () => {
    const id = await insertAsset(buildTextPdf(['hidden'], { encrypted: true }))

    await assert.doesNotReject(extractAssetText(id))

    assert.equal((await readAsset(id)).searchContent, null)
  })

  test('a PDF with no text layer stores nothing and queues no embedding', async () => {
    CARDINAL.capabilities = { semanticSearch: true }
    const id = await insertAsset(buildTextPdf(['']))

    await extractAssetText(id)

    assert.equal((await readAsset(id)).searchContent, null)
    assert.deepEqual(await embedJobsFor(id), [])
  })

  test('queues one embedAsset job when semantic search is available', async () => {
    CARDINAL.capabilities = { semanticSearch: true }
    const id = await insertAsset(buildTextPdf(['Embed me please']))

    await extractAssetText(id)

    const jobs = await embedJobsFor(id)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.useWorker, true)
  })

  test('queues no embedAsset job without semantic search', async () => {
    CARDINAL.capabilities = { semanticSearch: false }
    const id = await insertAsset(buildTextPdf(['No embedding here']))

    await extractAssetText(id)

    assert.deepEqual(await embedJobsFor(id), [])
  })

  test('ignores an asset that is not a PDF, and one that no longer exists', async () => {
    const id = await insertAsset(Buffer.from('plain'), 'notes.txt', 'text/plain')

    await assert.doesNotReject(extractAssetText(id))
    await assert.doesNotReject(extractAssetText('11111111-1111-4111-8111-111111111111'))

    assert.equal((await readAsset(id)).searchContent, null)
  })

  test('a result computed for bytes since replaced is discarded', async () => {
    const oldBytes = buildTextPdf(['old file text'])
    const id = await insertAsset(oldBytes)

    await fixtures.db
      .update(assetsTable)
      .set({ data: buildTextPdf(['new file text']), searchContent: null, ts: null })
      .where(eq(assetsTable.id, id))

    assert.equal(await storeAssetText(fixtures.db, id, oldBytes, 'old file text'), false)
    assert.equal((await readAsset(id)).searchContent, null)
  })

  test('a result is kept when the asset was only renamed meanwhile', async () => {
    const bytes = buildTextPdf(['renamed file text'])
    const id = await insertAsset(bytes)

    // -> What `models/assets.ts#renameAsset` writes: a new name and a new modification time
    await fixtures.db
      .update(assetsTable)
      .set({ fileName: 'renamed.pdf', updatedAt: sql`now() + interval '1 second'` })
      .where(eq(assetsTable.id, id))

    assert.equal(await storeAssetText(fixtures.db, id, bytes, 'renamed file text'), true)
    assert.equal((await readAsset(id)).searchContent, 'renamed file text')
  })
})
