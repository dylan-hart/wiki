import { pageStream } from '../../modules/search/shared.ts'
import { embedPage } from '../workers/embed-page.ts'

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
  CARDINAL.logger.info('jobs', 'rebuildEmbeddingsIndex finished', { site: payload.siteId, pages })
}
