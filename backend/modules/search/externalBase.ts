import type { LogFields } from '../../core/logger.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult
} from '../../models/search.ts'

/**
 * `db` deliberately implements the bare `SearchModule` interface instead of extending this: a page's
 * `ts` vector is a column on its own row, so its `deleted` needs nothing done and its `renamed` only
 * matters when the *locale* changed, and it has no external write that can fail for a reason a page
 * save should survive.
 *
 * Client construction and caching stay out deliberately — every engine's is a different shape, so a
 * shared `getClient` would be several abstract hooks wrapping four lines each.
 */
export abstract class ExternalSearchModule implements SearchModule {
  /** Each engine's own `MODULE_KEY`; rides every line this class logs as `engine=`. */
  protected abstract readonly engine: string

  abstract init(siteId: string, config: Record<string, any>): Promise<void>
  abstract query(params: SearchPagesParams): Promise<SearchPagesResult>
  abstract rebuild(siteId: string): Promise<RebuildResult>

  /** Must never throw — see `neverThrows`. */
  protected abstract indexPage(page: SearchIndexablePage): Promise<void>

  /** Must never throw — same contract as `indexPage`. */
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
   * A move is an ordinary re-index of the same document, so `previousPath` goes unused: `pages.id`
   * is a stable UUID a move never touches, and re-indexing under it keeps the page continuously
   * findable rather than briefly missing between a delete and an add.
   */
  async renamed(_siteId: string, page: SearchIndexablePage, _previousPath: string): Promise<void> {
    await this.indexPage(page)
  }

  /**
   * A page that saved correctly must not report failure because an external index could not be
   * reached; a later `rebuild()` is what puts a missed write right.
   *
   * @param message What the failed write was trying to do, as a lowercase fragment.
   */
  protected async neverThrows(
    work: () => Promise<void>,
    message: string,
    fields: LogFields = {}
  ): Promise<void> {
    try {
      await work()
    } catch (err: any) {
      CARDINAL.logger.warn('search', message, { engine: this.engine, ...fields, error: err })
    }
  }
}
