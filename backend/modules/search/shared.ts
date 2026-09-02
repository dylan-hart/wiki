import { and, asc, eq } from 'drizzle-orm'
import { pages as pagesTable } from '../../db/schema.ts'
import type { SearchIndexablePage } from '../../models/search.ts'

/**
 * Helpers every `modules/search/*` engine shares.
 *
 * These used to be copied into each engine, on the doctrine that "each engine module stays
 * self-contained" (`azure-search/search.ts` and `aws-cloudsearch/search.ts` both said so above their
 * own `escapeHtml`) — which produced three byte-identical `escapeHtml` bodies, two byte-identical
 * `RebuildPageSource`/`defaultPageSource` pairs, and two copies each of several near-identical
 * result-shaping helpers, every one of which had to be re-read and re-reasoned-about on any change.
 * Self-containment is worth having between an engine and a *vendor* — nothing here reaches for one —
 * but not between an engine and the shared vocabulary (`SearchIndexablePage`, `SearchPagesResult`)
 * every one of them already imports from `models/search.ts`.
 *
 * Everything in here is either pure or reads only `WIKI.db`/`WIKI.models`, which is what lets the
 * `db` engine — the one engine that stays on the bare `SearchModule` interface rather than extending
 * `externalBase.ts`'s `ExternalSearchModule` — import from it too.
 */

/**
 * The four characters that could turn page text into markup, escaped before any highlight marker is
 * turned into a real `<b>` tag.
 *
 * A single quote is deliberately not one of them: nothing here ever interpolates an excerpt into a
 * single-quoted attribute, and every engine's copy of this behaved the same way.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Markers an engine asks its backend to wrap a matched term in, in place of that backend's own
 * default (`<em>`/`</em>` for both Azure AI Search and CloudSearch, nothing at all for postgres).
 *
 * Control characters, because the excerpt is page text that may itself contain anything: it is HTML
 * escaped before these are turned into tags, so a page whose text reads `<script>` cannot come back
 * as markup. Anything that could occur in real text — a literal `<em>`, say — would defeat that.
 */
export const HL_START = '\u0002'
export const HL_STOP = '\u0003'

/**
 * One highlighted fragment, as a `SearchResult.highlight`: escaped first, so the only markup that
 * survives is the emphasis the search backend itself marked.
 *
 * `null` for an absent or empty fragment, which is what every caller wants for a row the backend
 * highlighted nothing in.
 */
export function normalizeMarkers(fragment: string | null | undefined): string | null {
  if (!fragment) {
    return null
  }
  return escapeHtml(fragment).replaceAll(HL_START, '<b>').replaceAll(HL_STOP, '</b>')
}

/**
 * Where a bulk-indexing `rebuild()` reads pages from — narrowed to what it needs, so a test can hand
 * it a fake that returns fixed pages with no real postgres involved, rather than requiring a live
 * database for logic that is really about pagination and per-locale counting.
 */
export interface RebuildPageSource {
  /** Every distinct locale a site currently has at least one page in, in a stable order. */
  locales(siteId: string): Promise<string[]>
  /**
   * One page of a site's rows for one locale, ordered by `id` so repeated calls with an increasing
   * `offset` walk the whole set exactly once each, with no gaps or duplicates.
   */
  pageBatch(
    siteId: string,
    locale: string,
    offset: number,
    limit: number
  ): Promise<SearchIndexablePage[]>
}

/** Rows read from postgres, and documents sent per bulk-upload call, in one `rebuild()` step. */
export const REBUILD_BATCH_SIZE = 500

/**
 * The real, database-backed `RebuildPageSource`.
 *
 * Paginated rather than one `SELECT *`, the same reason a `rebuild()` streams through its bulk
 * indexing client instead of building one giant document array: a site's full page set should never
 * have to fit in memory at once, and an external index's own bulk endpoint has request-size limits of
 * its own that a `REBUILD_BATCH_SIZE`-sized chunk comfortably stays under.
 */
export function defaultPageSource(): RebuildPageSource {
  return {
    async locales(siteId) {
      const rows = await WIKI.db
        .selectDistinct({ locale: pagesTable.locale })
        .from(pagesTable)
        .where(eq(pagesTable.siteId, siteId))
        .orderBy(pagesTable.locale)
      return rows.map((r) => r.locale)
    },
    async pageBatch(siteId, locale, offset, limit) {
      return WIKI.db
        .select()
        .from(pagesTable)
        .where(and(eq(pagesTable.siteId, siteId), eq(pagesTable.locale, locale)))
        .orderBy(asc(pagesTable.id))
        .limit(limit)
        .offset(offset)
    }
  }
}
