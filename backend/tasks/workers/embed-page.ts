import { eq, sql } from 'drizzle-orm'
import { pages as pagesTable } from '../../db/schema.ts'
import { chunkText } from '../../helpers/textChunking.ts'
import { embedText } from '../../helpers/embeddings.ts'

/**
 * Re-embed one page's content for semantic search.
 *
 * A plain importable function -- called from the worker-thread `task()` entry below, and also meant
 * to be called directly, in a loop, by Task #3104's "rebuild the whole site's embeddings" admin
 * action, so that logic exists in exactly one place. Always a full replace: every existing
 * `pageEmbeddingChunks` row for `pageId` is deleted before any fresh one is inserted, never appended
 * to or partially updated.
 *
 * No-ops immediately (deleting nothing, embedding nothing) when the instance-wide semantic search
 * capability (`WIKI.capabilities.semanticSearch`, Task #3095) is off, or when the page has no
 * rendered content yet to chunk -- a brand new page saved without a render, or one whose editor
 * cannot produce one, has nothing worth embedding until a real render lands.
 *
 * Content is read from `pages.searchContent` -- the plain-text extraction `models/rendering.ts`'s
 * `postProcess()` already produces on every save -- rather than re-rendering from raw markdown here,
 * matching Task #3096's own scope note that chunking consumes already-rendered text.
 *
 * A chunk `embedText()` cannot embed (an unusable model, matching Task #3097's `null`-on-failure
 * contract) is skipped rather than aborting the whole page: a page ends up with fewer, partially
 * stale chunks rather than none at all just because one passage's inference failed.
 *
 * `pageEmbeddingChunks` is deliberately not part of `db/schema.ts` (Task #3095's own decision --
 * see `docs/variances.md`), so every statement here is raw SQL via Drizzle's `sql` template rather
 * than the query builder.
 */
export async function embedPage(pageId: string): Promise<void> {
  if (!WIKI.capabilities?.semanticSearch) {
    return
  }

  await WIKI.db.execute(sql`DELETE FROM "pageEmbeddingChunks" WHERE "pageId" = ${pageId}`)

  const rows = await WIKI.db
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
    await WIKI.db.execute(sql`
      INSERT INTO "pageEmbeddingChunks" ("id", "pageId", "chunkIndex", "chunkText", "embedding", "updatedAt")
      VALUES (gen_random_uuid(), ${pageId}, ${chunk.index}, ${chunk.text}, ${vectorLiteral}::vector, now())
    `)
    embedded++
  }

  WIKI.logger.debug('worker', 'embedded page chunks', {
    page: pageId,
    chunks: chunks.length,
    embedded
  })
}

/**
 * Worker-thread entry point, dynamically imported by `worker.ts` as `tasks/workers/embed-page.ts`
 * for the `embedPage` job (see CLAUDE.md's "Five dynamic paths are extension-sensitive").
 *
 * Enqueued once per page save (`models/pages.ts`) via `WIKI.scheduler.addJob({ task: 'embedPage',
 * payload: { pageId } })` -- never once per chunk, since chunking happens inside `embedPage()`
 * itself, after the job has already been claimed by a worker thread.
 */
export async function task(job: { payload: { pageId: string } }): Promise<void> {
  await WIKI.ensureDb!()
  await embedPage(job.payload.pageId)
}
