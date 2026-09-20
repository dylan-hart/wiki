import { eq, sql } from 'drizzle-orm'
import { pages as pagesTable, tree as treeTable } from '../../db/schema.ts'
import { deriveAutoTags } from '../../helpers/autoTag.ts'
import type { TaskResult } from '../../core/scheduler.ts'

export interface AutoTagPagePayload {
  pageId: string
}

class ChunksNotEmbeddedError extends Error {
  constructor(pageId: string) {
    super(`Page ${pageId} is not embedded yet`)
    this.name = 'ChunksNotEmbeddedError'
  }
}

async function clearMarker(pageId: string): Promise<void> {
  await CARDINAL.db
    .update(pagesTable)
    .set({ autoTagPending: false })
    .where(eq(pagesTable.id, pageId))
}

export async function task(payload?: AutoTagPagePayload): Promise<TaskResult | void> {
  const pageId = payload?.pageId
  if (!pageId) {
    return
  }

  const rows = await CARDINAL.db
    .select({
      id: pagesTable.id,
      siteId: pagesTable.siteId,
      title: pagesTable.title,
      searchContent: pagesTable.searchContent,
      tags: pagesTable.tags,
      autoTagPending: pagesTable.autoTagPending
    })
    .from(pagesTable)
    .where(eq(pagesTable.id, pageId))
    .limit(1)
  const page = rows[0]
  if (!page || !page.autoTagPending) {
    return
  }

  if (!CARDINAL.capabilities?.semanticSearch) {
    await clearMarker(pageId)
    return { summary: 'auto-tagging skipped, semantic search unavailable', applied: 0 }
  }

  try {
    const result = await CARDINAL.db.execute(sql`
      SELECT "chunkText" FROM "pageEmbeddingChunks"
      WHERE "pageId" = ${pageId}
      ORDER BY "chunkIndex"
    `)
    const chunkTexts = ((result.rows ?? []) as any[]).map((row) => row.chunkText as string)
    if (chunkTexts.length < 1 && (page.searchContent ?? '').trim().length > 0) {
      throw new ChunksNotEmbeddedError(pageId)
    }

    const carried = new Set<string>(page.tags ?? [])
    const siteTags = await CARDINAL.models.tags.getTags(page.siteId)
    const derived = deriveAutoTags({
      title: page.title,
      text: chunkTexts,
      existingTags: siteTags.map((entry) => entry.tag).filter((tag) => !carried.has(tag))
    })
    if (derived.length < 1) {
      await clearMarker(pageId)
      return { summary: 'auto-tagging found no matching tags', applied: 0 }
    }

    const tags = [...(page.tags ?? []), ...derived]
    const updatedRows = await CARDINAL.db
      .update(pagesTable)
      .set({ tags, autoTagPending: false })
      .where(eq(pagesTable.id, pageId))
      .returning()
    await CARDINAL.db.update(treeTable).set({ tags }).where(eq(treeTable.id, pageId))
    if (updatedRows[0]) {
      await CARDINAL.models.search.updated(updatedRows[0])
    }
    CARDINAL.models.glossary.invalidateCache(page.siteId)

    CARDINAL.logger.debug('pages', 'auto-tagged page', {
      page: pageId,
      site: page.siteId,
      tags: derived
    })
    return { summary: 'auto-tagged page', applied: derived.length }
  } catch (err) {
    if (!(err instanceof ChunksNotEmbeddedError)) {
      await clearMarker(pageId)
    }
    throw err
  }
}
