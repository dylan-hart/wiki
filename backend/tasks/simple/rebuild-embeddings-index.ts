import { and, asc, eq, gt } from 'drizzle-orm'
import { assets as assetsTable } from '../../db/schema.ts'
import { pageStream, REBUILD_BATCH_SIZE } from '../../modules/search/shared.ts'
import { embedAsset } from '../workers/embed-asset.ts'
import { embedPage } from '../workers/embed-page.ts'

async function* assetIdStream(siteId: string): AsyncGenerator<string[]> {
  let cursor: string | null = null
  for (;;) {
    const condition = cursor
      ? and(eq(assetsTable.siteId, siteId), gt(assetsTable.id, cursor))
      : eq(assetsTable.siteId, siteId)
    const rows: { id: string }[] = await CARDINAL.db
      .select({ id: assetsTable.id })
      .from(assetsTable)
      .where(condition)
      .orderBy(asc(assetsTable.id))
      .limit(REBUILD_BATCH_SIZE)

    if (rows.length === 0) {
      return
    }
    yield rows.map((row) => row.id)
    if (rows.length < REBUILD_BATCH_SIZE) {
      return
    }
    cursor = rows[rows.length - 1]!.id
  }
}

/**
 * Loops itself rather than delegating to one model method: unlike a full-text engine's `rebuild()`
 * there is no `models.semanticSearch.rebuild()`, and `embedPage(pageId)` already does the whole
 * delete-chunks / re-render / re-chunk / re-embed cycle for one page and is safe to call for a page
 * whose chunks are already current — which is what makes running this task twice leave the same end
 * state as running it once.
 *
 * Sequential, not parallel: `embedPage` performs local model inference, so a whole site's pages at
 * once would contend for the same limited inference capacity a keyword-search rebuild never has to
 * think about.
 */
export async function task(payload: { siteId: string }): Promise<void> {
  let pages = 0
  for await (const batch of pageStream(payload.siteId)) {
    for (const page of batch) {
      await embedPage(page.id)
      pages++
    }
  }
  let assets = 0
  for await (const ids of assetIdStream(payload.siteId)) {
    for (const id of ids) {
      await embedAsset(id)
      assets++
    }
  }
  CARDINAL.logger.info('jobs', 'rebuildEmbeddingsIndex finished', {
    site: payload.siteId,
    pages,
    assets
  })
}
