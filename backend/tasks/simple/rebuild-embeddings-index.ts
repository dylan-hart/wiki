import { pageStream } from '../../modules/search/shared.ts'
import { embedPage } from '../workers/embed-page.ts'

/**
 * Re-embed every page of one site, for the admin area's manual "Rebuild embeddings index" action
 * (`POST /sites/:siteId/search/rebuild-embeddings`, Task #3104).
 *
 * Mirrors `tasks/simple/rebuild-search-index.ts`'s shape (queued from the request, run here so the
 * HTTP response never waits on per-page work) but loops itself rather than delegating to a single
 * model method: unlike a full-text engine's `rebuild()`, there is no `WIKI.models.semanticSearch
 * .rebuild()` — `embedPage(pageId)` (Task #3098) already does the whole delete-existing-chunks /
 * re-render / re-chunk / re-embed / insert cycle for one page and is safe to call again for a page
 * that already has current chunks, which is what makes calling it once per page here idempotent:
 * running this task twice in a row leaves the same end state as running it once.
 *
 * `pageStream` (`modules/search/shared.ts`) is reused rather than re-deriving a second keyset-paginated
 * walk over `pages` for one site — the only thing this loop needs from each row is `id`.
 *
 * Sequential, not parallel: `embedPage` performs local model inference (Epic #3050's design doc — no
 * external API, no per-page cost, but real CPU/GPU work per chunk), so running a whole site's pages
 * concurrently would contend for the same limited local inference capacity a keyword-search rebuild
 * never has to think about.
 */
export async function task(payload: { siteId: string }): Promise<void> {
  let pages = 0
  for await (const batch of pageStream(payload.siteId)) {
    for (const page of batch) {
      await embedPage(page.id)
      pages++
    }
  }
  WIKI.logger.info('jobs', 'rebuildEmbeddingsIndex finished', { site: payload.siteId, pages })
}
