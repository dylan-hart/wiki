import { eq, sql } from 'drizzle-orm'
import { assets as assetsTable } from '../../db/schema.ts'
import { chunkText } from '../../helpers/textChunking.ts'
import { embedText } from '../../helpers/embeddings.ts'

/**
 * Exported for `tasks/simple/rebuild-embeddings-index.ts`; `task()` below is the path an extraction
 * job chains into, with payload `{ assetId }`.
 *
 * The slow part (inference) runs before any write, so the delete-and-insert that follows can be one
 * short transaction. That transaction only writes when the asset still holds the text that was
 * embedded: a replace or delete landing mid-job leaves the chunks cleared rather than stale, and
 * whatever extracts the replacement's text enqueues a fresh job.
 *
 * Blank or missing text just clears the asset's chunks. The extracted text itself is never logged.
 */
export async function embedAsset(assetId: string): Promise<void> {
  if (!CARDINAL.capabilities?.semanticSearch) {
    return
  }

  const rows = await CARDINAL.db
    .select({ searchContent: assetsTable.searchContent })
    .from(assetsTable)
    .where(eq(assetsTable.id, assetId))
    .limit(1)
  const searchContent = rows[0]?.searchContent ?? null

  const embedded: { index: number; text: string; vectorLiteral: string }[] = []
  const chunks = searchContent ? chunkText(searchContent) : []
  for (const chunk of chunks) {
    const embedding = await embedText(chunk.text)
    if (!embedding) {
      continue
    }
    embedded.push({
      index: chunk.index,
      text: chunk.text,
      vectorLiteral: `[${embedding.join(',')}]`
    })
  }

  const written = await CARDINAL.db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM "assetEmbeddingChunks" WHERE "assetId" = ${assetId}`)
    if (embedded.length < 1) {
      return 0
    }

    const current = await tx.execute(
      sql`SELECT "searchContent" FROM "assets" WHERE "id" = ${assetId} FOR SHARE`
    )
    const currentText = (current.rows[0] as { searchContent: string | null } | undefined)
      ?.searchContent
    if (currentText !== searchContent) {
      return 0
    }

    for (const chunk of embedded) {
      await tx.execute(sql`
        INSERT INTO "assetEmbeddingChunks" ("id", "assetId", "chunkIndex", "chunkText", "embedding", "updatedAt")
        VALUES (gen_random_uuid(), ${assetId}, ${chunk.index}, ${chunk.text}, ${chunk.vectorLiteral}::vector, now())
      `)
    }
    return embedded.length
  })

  CARDINAL.logger.debug('worker', 'embedded asset chunks', {
    asset: assetId,
    chunks: chunks.length,
    embedded: written
  })
}

export async function task(job: { payload: { assetId: string } }): Promise<void> {
  await CARDINAL.ensureDb!()
  await embedAsset(job.payload.assetId)
}
