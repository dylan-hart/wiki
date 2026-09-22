import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { assets as assetsTable, jobs as jobsTable } from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { installFakeCommands, withEmptyPath, type FakeCommands } from '../../test/fakeCommands.ts'
import { ocrAsset, task } from './ocr-asset.ts'

const posix = process.platform !== 'win32'

describe('tasks/workers/ocr-asset (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let fake: FakeCommands | undefined

  before(async () => {
    fixtures = await setupTestDb()
    CARDINAL.config.scheduler = { maxRetries: 3 }
    CARDINAL.ensureDb = async () => true
  })

  afterEach(async () => {
    await fake?.restore()
    fake = undefined
  })

  after(async () => {
    await teardownTestDb()
  })

  async function insertAsset(
    data: Buffer | null,
    fileName = 'scan.png',
    mimeType = 'image/png',
    searchContent: string | null = null
  ) {
    const rows = await fixtures.db
      .insert(assetsTable)
      .values({
        fileName,
        fileExt: fileName.split('.').pop()!,
        kind: mimeType.startsWith('image/') ? 'image' : 'document',
        mimeType,
        fileSize: data?.length ?? 0,
        data,
        searchContent,
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

  test('is skipped, not failed, when tesseract is absent', async () => {
    const warn = mock.method(CARDINAL.logger, 'warn')
    const id = await insertAsset(Buffer.from('image bytes'))

    await withEmptyPath(async () => {
      await assert.doesNotReject(ocrAsset(id))
    })

    assert.equal((await readAsset(id)).searchContent, null)
    assert.equal(warn.mock.calls.length, 0)
    warn.mock.restore()
  })

  test('ignores an asset that is not an image or PDF, and one that no longer exists', async () => {
    const id = await insertAsset(Buffer.from('plain'), 'notes.txt', 'text/plain')

    await assert.doesNotReject(ocrAsset(id))
    await assert.doesNotReject(ocrAsset('11111111-1111-4111-8111-111111111111'))
  })

  test(
    'stores recognized text from an image and makes it searchable',
    { skip: !posix },
    async () => {
      CARDINAL.capabilities = { semanticSearch: false }
      fake = await installFakeCommands({
        tesseract: 'cat >/dev/null\nprintf "Whiteboard roadmap Q3"'
      })
      const id = await insertAsset(Buffer.from('image bytes'))

      await ocrAsset(id)

      assert.equal((await readAsset(id)).searchContent, 'Whiteboard roadmap Q3')
      assert.equal(await matches(id, 'roadmap'), true)
      assert.deepEqual(await embedJobsFor(id), [])
    }
  )

  test('task() reads the asset id from the job payload', { skip: !posix }, async () => {
    CARDINAL.capabilities = { semanticSearch: false }
    fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nprintf "Routed by payload"' })
    const id = await insertAsset(Buffer.from('image bytes'))

    await task({ payload: { assetId: id } })

    assert.equal((await readAsset(id)).searchContent, 'Routed by payload')
  })

  test(
    'queues one embedAsset job when semantic search is available',
    { skip: !posix },
    async () => {
      CARDINAL.capabilities = { semanticSearch: true }
      fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nprintf "Embed this"' })
      const id = await insertAsset(Buffer.from('image bytes'))

      await ocrAsset(id)

      const jobs = await embedJobsFor(id)
      assert.equal(jobs.length, 1)
      assert.equal(jobs[0]!.useWorker, true)
    }
  )

  test(
    'an image with no recognizable text stores nothing and queues no embedding',
    { skip: !posix },
    async () => {
      CARDINAL.capabilities = { semanticSearch: true }
      fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nprintf "  \\n"' })
      const id = await insertAsset(Buffer.from('image bytes'))

      await ocrAsset(id)

      assert.equal((await readAsset(id)).searchContent, null)
      assert.deepEqual(await embedJobsFor(id), [])
    }
  )

  test(
    'a crashing tesseract does not throw and leaves the text empty',
    { skip: !posix },
    async () => {
      fake = await installFakeCommands({ tesseract: 'cat >/dev/null\nexit 1' })
      const id = await insertAsset(Buffer.from('image bytes'))

      await assert.doesNotReject(ocrAsset(id))

      assert.equal((await readAsset(id)).searchContent, null)
    }
  )

  test(
    'discards the result when the asset is replaced while OCR runs',
    { skip: !posix },
    async () => {
      CARDINAL.capabilities = { semanticSearch: false }
      const id = await insertAsset(Buffer.from('old bytes'))
      fake = await installFakeCommands({
        tesseract: `cat >/dev/null\nsleep 0.3\nprintf "stale text"`
      })

      const running = ocrAsset(id)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fixtures.db
        .update(assetsTable)
        .set({ data: Buffer.from('new bytes'), updatedAt: sql`now() + interval '1 second'` })
        .where(eq(assetsTable.id, id))
      await running

      assert.equal((await readAsset(id)).searchContent, null)
    }
  )

  test('never overwrites the text layer of a PDF', { skip: !posix }, async () => {
    fake = await installFakeCommands({
      pdftoppm: 'exit 0',
      tesseract: 'printf "should not be used"'
    })
    const id = await insertAsset(
      Buffer.from('%PDF-1.4'),
      'doc.pdf',
      'application/pdf',
      'Existing text layer'
    )

    await ocrAsset(id)

    assert.equal((await readAsset(id)).searchContent, 'Existing text layer')
  })

  test('OCRs a scanned PDF that has no text layer', { skip: !posix }, async () => {
    CARDINAL.capabilities = { semanticSearch: false }
    fake = await installFakeCommands({
      pdftoppm: 'for arg; do root="$arg"; done\nprintf x > "$root-1.png"',
      tesseract: 'printf "Scanned contract clause"'
    })
    const id = await insertAsset(Buffer.from('%PDF-1.4'), 'scan.pdf', 'application/pdf')

    await ocrAsset(id)

    assert.equal((await readAsset(id)).searchContent, 'Scanned contract clause')
  })
})
