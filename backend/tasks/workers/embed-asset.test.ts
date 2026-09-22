import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { installTestWiki } from '../../test/mocks.ts'
import { assets as assetsTable } from '../../db/schema.ts'
import { embedAsset, task } from './embed-asset.ts'

const ASSET_ID = '22222222-2222-4222-8222-222222222222'

/**
 * `assetEmbeddingChunks` is not in `db/schema.ts` (it is created by `bootstrapPgvector`, conditional
 * on pgvector), so `setupTestDb()`'s migrated schema has no such table and this suite creates it.
 */
async function ensureAssetEmbeddingChunksTable(db: TestFixtures['db']): Promise<boolean> {
  const probe = await db.execute(sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
  if ((probe.rows as unknown[]).length < 1) {
    return false
  }
  await db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'))
  await db.execute(
    sql.raw(`
      CREATE TABLE IF NOT EXISTS "assetEmbeddingChunks" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "assetId" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
        "chunkIndex" integer NOT NULL,
        "chunkText" text NOT NULL,
        "embedding" vector(384),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `)
  )
  await db.execute(
    sql.raw(`
      CREATE TABLE IF NOT EXISTS "pageEmbeddingChunks" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pageId" uuid NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
        "chunkIndex" integer NOT NULL,
        "chunkText" text NOT NULL,
        "embedding" vector(384),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `)
  )
  return true
}

async function chunkRows(db: TestFixtures['db'], assetId: string) {
  const result = await db.execute(
    sql`SELECT "chunkIndex", "chunkText" FROM "assetEmbeddingChunks" WHERE "assetId" = ${assetId} ORDER BY "chunkIndex"`
  )
  return result.rows as Array<{ chunkIndex: number; chunkText: string }>
}

describe('tasks/workers/embed-asset (pure)', () => {
  test('embedAsset no-ops without touching the database when semantic search is unavailable', async () => {
    const executeMock = mock.fn(async () => ({ rows: [] }))
    const selectMock = mock.fn()
    const transactionMock = mock.fn()
    const handle = installTestWiki({
      capabilities: { semanticSearch: false },
      db: { execute: executeMock, select: selectMock, transaction: transactionMock }
    })
    try {
      await embedAsset(ASSET_ID)
      assert.equal(executeMock.mock.calls.length, 0)
      assert.equal(selectMock.mock.calls.length, 0)
      assert.equal(transactionMock.mock.calls.length, 0)
    } finally {
      handle.restore()
    }
  })

  test('an asset with no extracted text has its chunks cleared and nothing inserted', async () => {
    const statements: string[] = []
    const tx = {
      execute: async (query: { queryChunks?: unknown[] }) => {
        statements.push(JSON.stringify(query.queryChunks ?? []))
        return { rows: [] }
      }
    }
    const select = () => {
      const node: any = Promise.resolve([{ searchContent: null }])
      for (const method of ['from', 'where', 'limit']) {
        node[method] = () => node
      }
      return node
    }
    const handle = installTestWiki({
      capabilities: { semanticSearch: true },
      db: { select, transaction: async (fn: (t: typeof tx) => Promise<number>) => fn(tx) }
    })
    try {
      await embedAsset(ASSET_ID)
      assert.equal(statements.length, 1)
      assert.match(statements[0]!, /DELETE FROM \\"assetEmbeddingChunks\\"/)
    } finally {
      handle.restore()
    }
  })

  test('task() waits for the database and then embeds the payload asset', async () => {
    const events: string[] = []
    const handle = installTestWiki({
      capabilities: { semanticSearch: false },
      ensureDb: async () => {
        events.push('ensureDb')
        return true
      }
    })
    try {
      await task({ payload: { assetId: ASSET_ID } })
      assert.deepEqual(events, ['ensureDb'])
    } finally {
      handle.restore()
    }
  })
})

describe('tasks/workers/embed-asset (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pgvectorAvailable = false

  before(async () => {
    fixtures = await setupTestDb()
    pgvectorAvailable = await ensureAssetEmbeddingChunksTable(fixtures.db)
    CARDINAL.capabilities = { semanticSearch: true }
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
  })

  async function seedAsset(searchContent: string | null): Promise<string> {
    const inserted = await fixtures.db
      .insert(assetsTable)
      .values({
        fileName: `embed-${crypto.randomUUID()}.pdf`,
        fileExt: 'pdf',
        authorId: fixtures.userId,
        siteId: fixtures.siteId,
        searchContent
      })
      .returning({ id: assetsTable.id })
    return inserted[0]!.id
  }

  function longText(tag: string): string {
    return Array.from({ length: 400 }, (_, i) => `${tag}-${i}`).join(' ')
  }

  test('writes chunks for extracted text when semantic search is on, and fully replaces on re-run', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }
    const assetId = await seedAsset(longText('quarterly'))

    await embedAsset(assetId)
    const firstPass = await chunkRows(fixtures.db, assetId)
    assert.ok(firstPass.length > 1, 'expected more than one chunk for 400 words of text')
    assert.deepEqual(
      firstPass.map((r) => r.chunkIndex),
      firstPass.map((_, i) => i)
    )

    const dims = await fixtures.db.execute(
      sql`SELECT vector_dims("embedding") AS dims FROM "assetEmbeddingChunks" WHERE "assetId" = ${assetId} LIMIT 1`
    )
    assert.equal((dims.rows[0] as { dims: number }).dims, 384)

    await embedAsset(assetId)
    assert.equal((await chunkRows(fixtures.db, assetId)).length, firstPass.length)
  })

  test('writes nothing when the semantic search capability is off', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }
    const assetId = await seedAsset(longText('capoff'))
    CARDINAL.capabilities = { semanticSearch: false }
    try {
      await embedAsset(assetId)
      assert.equal((await chunkRows(fixtures.db, assetId)).length, 0)
    } finally {
      CARDINAL.capabilities = { semanticSearch: true }
    }
  })

  test('clears chunks once the asset no longer has extracted text', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }
    const assetId = await seedAsset(longText('replaced'))
    await embedAsset(assetId)
    assert.ok((await chunkRows(fixtures.db, assetId)).length > 0)

    await fixtures.db
      .update(assetsTable)
      .set({ searchContent: null })
      .where(eq(assetsTable.id, assetId))
    await embedAsset(assetId)

    assert.equal((await chunkRows(fixtures.db, assetId)).length, 0)
  })

  test('deleting an asset cascades to its embedding chunks via the FK, unassisted by the worker', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }
    const assetId = await seedAsset(longText('doomed'))
    await embedAsset(assetId)
    assert.ok((await chunkRows(fixtures.db, assetId)).length > 0)

    await fixtures.db.delete(assetsTable).where(eq(assetsTable.id, assetId))

    assert.equal((await chunkRows(fixtures.db, assetId)).length, 0)
  })

  test('an embedAsset for an asset that no longer exists writes nothing and does not throw', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }
    await embedAsset('33333333-3333-4333-8333-333333333333')
  })

  test('asset chunks never surface through the page semantic search', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }
    const { annSearch } = await import('../../models/semanticSearch.ts')
    const assetId = await seedAsset(longText('secretasset'))
    await embedAsset(assetId)
    const stored = await fixtures.db.execute(
      sql`SELECT "embedding"::text AS embedding FROM "assetEmbeddingChunks" WHERE "assetId" = ${assetId} LIMIT 1`
    )
    const vector = (stored.rows[0] as { embedding: string }).embedding
      .slice(1, -1)
      .split(',')
      .map(Number)

    const matches = await annSearch(vector, { siteId: fixtures.siteId, locales: ['en'] })

    assert.equal(
      matches.some((match) => match.pageId === assetId || match.chunkText.includes('secretasset')),
      false
    )
  })
})
