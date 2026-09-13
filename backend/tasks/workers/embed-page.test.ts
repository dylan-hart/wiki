import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { installTestWiki } from '../../test/mocks.ts'
import type { PageActor, PageInput } from '../../models/pages.ts'
import { embedPage } from './embed-page.ts'

/**
 * `pageEmbeddingChunks` is not part of `db/schema.ts` (Task #3095's own decision -- it is created by
 * raw SQL, conditional on `pgvector` being installable), so this suite creates it itself rather than
 * depending on a bootstrap module: `setupTestDb()`'s migrated schema has no such table by default.
 */
async function ensurePageEmbeddingChunksTable(db: TestFixtures['db']): Promise<boolean> {
  const probe = await db.execute(sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
  if ((probe.rows as unknown[]).length < 1) {
    return false
  }
  await db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'))
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

async function chunkRows(db: TestFixtures['db'], pageId: string) {
  const result = await db.execute(
    sql`SELECT "chunkIndex", "chunkText" FROM "pageEmbeddingChunks" WHERE "pageId" = ${pageId} ORDER BY "chunkIndex"`
  )
  return result.rows as Array<{ chunkIndex: number; chunkText: string }>
}

describe('tasks/workers/embed-page -- capability off (pure)', () => {
  test('embedPage no-ops without touching the database when semantic search is unavailable', async () => {
    const executeMock = mock.fn(async () => ({ rows: [] }))
    const handle = installTestWiki({
      capabilities: { semanticSearch: false },
      db: { execute: executeMock }
    })
    try {
      await embedPage('11111111-1111-4111-8111-111111111111')
      assert.equal(executeMock.mock.calls.length, 0)
    } finally {
      handle.restore()
    }
  })
})

describe('tasks/workers/embed-page (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('../../models/pages.ts').pages
  let actor: PageActor
  let pgvectorAvailable = false
  let pageCounter = 0

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('../../models/pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    mock.method(WIKI.models.renderQueue, 'ensureCanRender', async () => {})
    pgvectorAvailable = await ensurePageEmbeddingChunksTable(fixtures.db)
    WIKI.capabilities = { semanticSearch: true }
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
  })

  function longRenderInput(overrides: Partial<PageInput> = {}): PageInput {
    pageCounter++
    const body = Array.from({ length: 400 }, (_, i) => `word${pageCounter}-${i}`).join(' ')
    return {
      path: `embed-test-page-${pageCounter}`,
      title: 'Embed Test',
      editor: 'wysiwyg',
      content: `<p>${body}</p>`,
      // -> A real `render` is what makes `hasRenderInput` true in `createPage()`, so the fresh text
      //    is available immediately rather than waiting on a render-queue drain this test environment
      //    has no puppeteer to service
      render: `<p>${body}</p>`,
      ...overrides
    }
  }

  test('creating a page with a render queues exactly one embedPage job', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }
    const addJob = WIKI.scheduler.addJob as unknown as {
      mock: { calls: Array<{ arguments: unknown[] }>; resetCalls: () => void }
    }
    addJob.mock.resetCalls()

    const page = await pagesModel.createPage(fixtures.siteId, longRenderInput(), actor)

    const embedCalls = addJob.mock.calls.filter(
      (call) => (call.arguments[0] as { task: string }).task === 'embedPage'
    )
    assert.equal(embedCalls.length, 1)
    assert.deepEqual(embedCalls[0]!.arguments[0], {
      task: 'embedPage',
      payload: { pageId: page.id }
    })
  })

  test('embedPage performs a save -> job -> fresh-rows round trip, and fully replaces on re-run', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }

    const page = await pagesModel.createPage(fixtures.siteId, longRenderInput(), actor)

    // -> The scheduler is stubbed (`test/mocks.ts#createSchedulerStub`), so the job it queued never
    //    actually runs a worker thread -- calling the plain importable function directly is how this
    //    exercises the delete+chunk+embed+insert logic itself, matching #3104's own planned reuse
    await embedPage(page.id)

    const firstPass = await chunkRows(fixtures.db, page.id)
    assert.ok(firstPass.length > 1, 'expected more than one chunk for 400 words of content')
    assert.deepEqual(
      firstPass.map((r) => r.chunkIndex),
      firstPass.map((_, i) => i)
    )

    const dims = await fixtures.db.execute(
      sql`SELECT vector_dims("embedding") as dims FROM "pageEmbeddingChunks" WHERE "pageId" = ${page.id} LIMIT 1`
    )
    assert.equal((dims.rows[0] as { dims: number }).dims, 384)

    // -> Re-running must fully replace, not append -- same row count, not double
    await embedPage(page.id)
    const secondPass = await chunkRows(fixtures.db, page.id)
    assert.equal(secondPass.length, firstPass.length)
  })

  test('embedPage no-ops when the semantic search capability is off', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }

    const page = await pagesModel.createPage(fixtures.siteId, longRenderInput(), actor)
    WIKI.capabilities = { semanticSearch: false }
    try {
      await embedPage(page.id)
      const rows = await chunkRows(fixtures.db, page.id)
      assert.equal(rows.length, 0)
    } finally {
      WIKI.capabilities = { semanticSearch: true }
    }
  })

  test('deleting a page cascades to its embedding chunks via the FK, unassisted by the worker', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this postgres')
      return
    }

    const page = await pagesModel.createPage(fixtures.siteId, longRenderInput(), actor)
    await embedPage(page.id)
    const before = await chunkRows(fixtures.db, page.id)
    assert.ok(before.length > 0)

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)

    const after = await chunkRows(fixtures.db, page.id)
    assert.equal(after.length, 0)
  })
})
