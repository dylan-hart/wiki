import type { LogFields } from '../../core/logger.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult
} from '../../models/search.ts'

/**
 * What the four external search engine modules — `algolia`, `elasticsearch`, `azure-search`,
 * `aws-cloudsearch` — all do the same way, because it is decided by `SearchModule`'s contract rather
 * than by any vendor.
 *
 * `db` deliberately does not extend this: it implements the bare `SearchModule` interface directly.
 * Its `deleted` and `renamed` are genuinely different (a page's `ts` vector is a column on its own
 * row, so a delete needs nothing done and a rename only matters when the *locale* changed), and it
 * has no client, no external write to wrap, and nothing that can fail for a reason a page save
 * should survive — so inheriting these forwarders would give it four hooks that are wrong for it.
 *
 * Deliberately NOT here: client construction and caching. Every engine's is a different shape
 * (Algolia's needs an index-settings push before first use, Elasticsearch's a create-index-if-absent,
 * and both Azure and AWS keep *two* clients — an admin one and a query one — behind injected
 * factories), so a shared `getClient` would be three abstract hooks wrapping four lines. What is
 * shared is what is genuinely identical.
 */
export abstract class ExternalSearchModule implements SearchModule {
  /**
   * The `modules/search/<key>` directory name — each engine's own `MODULE_KEY`. Rides every line
   * this class logs as `engine=`, which is what tells four engines' lines apart now that none of
   * them names its vendor in the sentence.
   */
  protected abstract readonly engine: string

  abstract init(siteId: string, config: Record<string, any>): Promise<void>
  abstract query(params: SearchPagesParams): Promise<SearchPagesResult>
  abstract rebuild(siteId: string): Promise<RebuildResult>

  /** Write (or overwrite) one page's document in the index. Must never throw — see `neverThrows`. */
  protected abstract indexPage(page: SearchIndexablePage): Promise<void>

  /** Remove one page's document from the index. Must never throw — same contract as `indexPage`. */
  protected abstract removePage(siteId: string, pageId: string): Promise<void>

  async created(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  async updated(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  async deleted(siteId: string, pageId: string): Promise<void> {
    await this.removePage(siteId, pageId)
  }

  /**
   * A move is an ordinary re-index of the same document, so `previousPath` and `previousLocale` go
   * unused for every engine here.
   *
   * Unlike 2.5.x — which derived a document's id from a hash of its path and locale, so a rename had
   * to delete the old id and add a new one — this schema's `pages.id` is a stable UUID a move never
   * touches (`models/pages.ts`'s `movePage` updates the row in place). Re-indexing under the same id
   * keeps the page continuously findable instead of briefly missing between a delete and an add, and
   * rewrites a locale change by the same call. The `db` engine is the exception, which is one of the
   * reasons it does not extend this class.
   */
  async renamed(_siteId: string, page: SearchIndexablePage, _previousPath: string): Promise<void> {
    await this.indexPage(page)
  }

  /**
   * Run one index write, swallowing whatever the vendor's client throws and logging it instead.
   *
   * A page that saved correctly must not report failure because an external index could not be
   * reached — the contract `indexPage`/`removePage` give `models/search.ts`'s dispatcher, and the
   * reason a later `rebuild()` exists to put a missed write right.
   *
   * The message is the caller's, since only it knows which write was attempted; the error itself is
   * never interpolated into it — it rides `fields.error`, where the renderer puts it (and its stack,
   * at `logLevel: debug`) in one record. `engine=` is added here rather than by each caller.
   *
   * @param message What the failed write was trying to do, as a lowercase fragment.
   * @param fields Anything else that identifies it — the page id, chiefly.
   */
  protected async neverThrows(
    work: () => Promise<void>,
    message: string,
    fields: LogFields = {}
  ): Promise<void> {
    try {
      await work()
    } catch (err: any) {
      WIKI.logger.warn('search', message, { engine: this.engine, ...fields, error: err })
    }
  }
}
