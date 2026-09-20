import { eq, sql } from 'drizzle-orm'
import { pages as pagesTable } from '../../db/schema.ts'
import { chunkText } from '../../helpers/textChunking.ts'
import { embedText } from '../../helpers/embeddings.ts'

/**
 * Exported for `tasks/simple/rebuild-embeddings-index.ts`, which calls it in a loop; the worker
 * `task()` below is the per-save path.
 *
 * A chunk `embedText()` cannot embed is skipped rather than aborting the page, which leaves it with
 * fewer chunks rather than none at all.
 *
 * `pageEmbeddingChunks` is deliberately not in `db/schema.ts`, hence raw SQL throughout.
 */
export async function embedPage(pageId: string): Promise<void> {
  if (!CARDINAL.capabilities?.semanticSearch) {
    return
  }

  await CARDINAL.db.execute(sql`DELETE FROM "pageEmbeddingChunks" WHERE "pageId" = ${pageId}`)

  const rows = await CARDINAL.db
    .select({ searchContent: pagesTable.searchContent })
    .from(pagesTable)
    .where(eq(pagesTable.id, pageId))
    .limit(1)
  const searchContent = rows[0]?.searchContent
  if (!searchContent) {
    return
  }

  const chunks = chunkText(searchContent)
  if (chunks.length < 1) {
    return
  }

  let embedded = 0
  for (const chunk of chunks) {
    const embedding = await embedText(chunk.text)
    if (!embedding) {
      continue
    }
    const vectorLiteral = `[${embedding.join(',')}]`
    await CARDINAL.db.execute(sql`
      INSERT INTO "pageEmbeddingChunks" ("id", "pageId", "chunkIndex", "chunkText", "embedding", "updatedAt")
      VALUES (gen_random_uuid(), ${pageId}, ${chunk.index}, ${chunk.text}, ${vectorLiteral}::vector, now())
    `)
    embedded++
  }

  CARDINAL.logger.debug('worker', 'embedded page chunks', {
    page: pageId,
    chunks: chunks.length,
    embedded
  })
}

export async function task(job: { payload: { pageId: string } }): Promise<void> {
  await CARDINAL.ensureDb!()
  await embedPage(job.payload.pageId)
}
