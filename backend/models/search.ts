import path from 'node:path'
import { maskSensitiveConfig } from '../helpers/moduleProps.ts'
import {
  loadModule,
  mergeModuleConfig,
  moduleHasFile,
  readModuleDefinitions,
  validateModuleConfig
} from '../helpers/moduleRegistry.ts'
import { withTimeout } from '../helpers/timeout.ts'
import type { AccessActor } from './groups.ts'
import type { ModuleProp } from '../helpers/moduleProps.ts'
import type { pages as pagesTable } from '../db/schema.ts'
import type { TranslationStatusEntry } from '../helpers/translationStatus.ts'

/** Postgres full-text search: the only engine guaranteed to have an implementation, so it is both
 *  the picker's first entry and what every dispatch falls back to. */
const DB_MODULE = 'db'

/**
 * A misconfigured host (firewalled, black-holed) can leave `init()` neither resolving nor rejecting
 * — several of these engines' SDK HTTP clients have no default request timeout of their own — and a
 * bare try/catch only covers a service that actively refuses. This ceiling makes a hang behave like
 * any other init failure.
 */
const ENGINE_INIT_TIMEOUT_MS = 30_000

/**
 * The per-site search settings that belong to no engine. `dictOverrides` is a free-form locale ->
 * dictionary map rather than a scalar prop; `semanticEnabled` is engine-independent (semantic search
 * is always backed by Postgres/pgvector) and is ANDed with the instance-wide
 * `CARDINAL.capabilities.semanticSearch` before the feature is reachable.
 */
export interface SearchConfig {
  dictOverrides: Record<string, string>
  semanticEnabled: boolean
}

/**
 * `dictionary` is optional because it names the postgres text-search dictionary the `db` engine chose
 * for a locale, which an external index has no equivalent of. `warnings` likewise: a non-fatal
 * problem that did not stop the rebuild (a page skipped for exceeding an engine's document size
 * limit) surfaced on the result as well as in the log, so a caller can read it without scraping logs.
 */
export interface RebuildResult {
  pages: number
  locales: { locale: string; dictionary?: string; pages: number }[]
  warnings?: string[]
}

export const SEARCH_ORDER_BY = ['relevancy', 'title', 'updatedAt'] as const
export type SearchOrderBy = (typeof SEARCH_ORDER_BY)[number]

export interface SearchResult {
  id: string
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  tags: string[]
  updatedAt: string
  relevancy: number
  highlight: string | null
  /**
   * Per-locale translation staleness for this result's path, attached by the search route after
   * `query()` returns and only when the caller opts in: no engine knows about locales it is not
   * scoped to, so none sets it.
   */
  localeStatus?: TranslationStatusEntry[]
}

export interface SearchPagesResult {
  results: SearchResult[]
  /**
   * How many pages match AND are visible to the searching actor, ignoring `limit`/`offset`: derived
   * only from rows that survived `read:pages` filtering, never from a raw match count taken before
   * permissions are applied. Exact up to whatever cap the active engine scans before filtering;
   * beyond that cap it is a floor, not a precise total.
   */
  totalHits: number
  /**
   * `true` when `totalHits` is not exact: the actor's page rules dropped rows the engine's own count
   * included. It is corrected by exactly what was dropped from *this* page of results, so rows the
   * same actor could not see on other, unfetched pages are never discounted at all. `false` also
   * covers having no actor to check against.
   */
  totalHitsApproximate: boolean
  /**
   * The closest page title to a query that matched nothing, for a "did you mean" prompt. Only ever
   * set alongside `totalHits === 0`.
   */
  suggestion: string | null
}

export interface SuggestTitleParams {
  siteId: string
  query: string
  publicOnly?: boolean
  includeDrafts?: boolean
  actor?: AccessActor
}

/** Minimum trigram similarity (`pg_trgm`'s `similarity()`, 0..1) for a title to be worth suggesting.
 *  A starting point rather than a value tuned against real usage. */
export const SUGGEST_TITLE_THRESHOLD = 0.3

/** How many similarity candidates to pull before permission-filtering them down to one. */
export const SUGGEST_TITLE_CANDIDATES = 5

export type TagsMatch = 'all' | 'any'

export const TAGS_MATCH: readonly TagsMatch[] = ['all', 'any']

/**
 * `creatorId` is the page's first creator and `authorId` its last editor. Neither is called
 * `editor`, which is the editor-type filter.
 */
export interface SearchFilters {
  path?: string[]
  excludePath?: string[]
  locales?: string[]
  excludeLocales?: string[]
  tags?: string[]
  tagsMatch?: TagsMatch
  excludeTags?: string[]
  editor?: string[]
  excludeEditor?: string[]
  publishState?: string[]
  excludePublishState?: string[]
  creatorId?: string[]
  excludeCreatorId?: string[]
  authorId?: string[]
  excludeAuthorId?: string[]
}

export interface SearchPagesParams extends SearchFilters {
  siteId: string
  query?: string
  orderBy?: SearchOrderBy
  orderByDirection?: 'asc' | 'desc'
  offset?: number
  limit?: number
  /** Restrict to what a reader with no session may see: published pages. */
  publicOnly?: boolean
  includeDrafts?: boolean
  /**
   * Who is searching, so that a result they could not open never reaches them. Applied to the rows
   * rather than in the query: which pages a rule covers can depend on a regular expression or on a
   * page's tags, neither of which a `WHERE` clause here could express.
   */
  actor?: AccessActor
  /**
   * Keep a password-protected page's *body* out of the results. The page itself still appears — its
   * title and description are not what the password covers — but it can only be matched on those,
   * and comes back with no excerpt.
   */
  hideProtectedContent?: boolean
}

/**
 * A site has exactly one *active* engine rather than several independently-enabled targets as
 * `StorageTarget` does, so there is no `id`/`isEnabled` pair here — `key` plus `isSelected` is all a
 * picker needs.
 */
export interface SearchEngine {
  key: string
  title: string
  description: string
  icon?: string
  logo?: string
  vendor: string
  website: string
  props: Record<string, ModuleProp>
  hasImplementation: boolean
  isSelected: boolean
  config: Record<string, any>
  /**
   * Attached by `api/search.ts` onto the `db` entry after `getSiteEngines()` returns, never by
   * `getSiteEngines()` itself: resolving them for every engine on every listing would load and query
   * the `db` module even when it is not selected, for a value only the `db` panel reads. Every other
   * engine's entry carries neither.
   */
  dictOverrides?: Record<string, string>
  availableDictionaries?: string[]
}

export interface SearchEngineDefinition {
  key: string
  title: string
  description: string
  icon?: string
  logo?: string
  vendor: string
  website: string
  /**
   * `dictOverrides` (a locale -> text search dictionary map) is deliberately not declared as a prop:
   * `parseModuleProps` validates boolean/number/string/enum scalars only, and an override map is a
   * free-form object with no fixed set of keys, so it stays a JSON config field an engine reads off
   * its stored config itself.
   */
  props: Record<string, ModuleProp>
}

/**
 * The full page row rather than a narrowed shape: which fields an engine indexes is that module's
 * decision, and an external engine needs enough to build its own document without querying the
 * database back.
 */
export type SearchIndexablePage = typeof pagesTable.$inferSelect

/**
 * One file per engine, exported as its default and resolved by its `definition.yml` key. Every hook
 * is mandatory: an index has to stay in step with every page mutation, since a stale or missing entry
 * in an external index is a silently wrong result rather than a visibly broken feature.
 */
export interface SearchModule {
  /** Connect, verify the index exists, etc. Must be idempotent — it runs on every selection and
   *  again for every site at boot. */
  init(siteId: string, config: Record<string, any>): Promise<void>
  created(page: SearchIndexablePage): Promise<void>
  updated(page: SearchIndexablePage): Promise<void>
  /** Only the ID travels — there is no row left to read anything else from. */
  deleted(siteId: string, pageId: string): Promise<void>
  /** `previousPath` and `previousLocale` are what the module indexed the page under before; a move
   *  can change either, and `page` already carries where it ended up. */
  renamed(
    siteId: string,
    page: SearchIndexablePage,
    previousPath: string,
    previousLocale: string
  ): Promise<void>
  query(params: SearchPagesParams): Promise<SearchPagesResult>
  rebuild(siteId: string): Promise<RebuildResult>
}

/**
 * A thin dispatcher: it holds no indexing logic of its own. Every real implementation is a
 * `SearchModule`, resolved per site from `CARDINAL.sites[siteId]?.config?.search?.engine` and loaded
 * through `ensureModule()`.
 */
class Search {
  definitions: SearchEngineDefinition[] = []

  /**
   * Keyed by module key rather than by `(siteId, key)`: every `SearchModule` hook takes `siteId`
   * explicitly, so one loaded module can serve several sites' distinct clusters out of state it keeps
   * internally, and caching per site here would only duplicate that bookkeeping one layer up.
   */
  modules: Record<string, SearchModule> = {}

  async refreshFromDisk(): Promise<void> {
    const searchPath = path.join(CARDINAL.SERVERPATH, 'modules/search')
    try {
      const definitions = await readModuleDefinitions<SearchEngineDefinition>(searchPath, {
        parseProps: true,
        sortPropsByOrder: true
      })
      // -> `db` first, then alphabetically: it is the one every site starts with
      this.definitions = definitions.sort((a, b) =>
        a.key === DB_MODULE ? -1 : b.key === DB_MODULE ? 1 : a.title.localeCompare(b.title)
      )
      CARDINAL.logger.debug('search', 'loaded engine definitions', {
        engines: this.definitions.length
      })
    } catch (err: any) {
      this.definitions = []
      CARDINAL.logger.error('search', 'reading the engine definitions failed', {
        path: searchPath,
        error: err
      })
    }
  }

  /** Whether the module has any code to run, as opposed to only a definition. */
  async hasImplementation(key: string): Promise<boolean> {
    return moduleHasFile(CARDINAL.SERVERPATH, 'modules/search', key, 'search.ts')
  }

  getDefinition(key: string): SearchEngineDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /** Null both when the module ships no implementation and when loading one threw. */
  async ensureModule(key: string): Promise<SearchModule | null> {
    return loadModule(
      this.modules,
      key,
      // -> Extension-sensitive dynamic import, invisible to the type checker
      () => import(`../modules/search/${key}/search.ts`),
      'search',
      () => this.hasImplementation(key)
    )
  }

  /**
   * Driven by `this.definitions` rather than by anything stored: an engine dropped from disk without
   * a restart is simply absent, rather than half-present with no metadata behind it.
   *
   * @param opts.mask Replace a `sensitive` prop's stored value with a mask. Off by default, so a
   *   caller that is not rendering config to an administrator never gets a masked value back.
   */
  async getSiteEngines(
    siteId: string,
    { mask = false }: { mask?: boolean } = {}
  ): Promise<SearchEngine[]> {
    const selected = CARDINAL.sites[siteId]?.config?.search?.engine ?? DB_MODULE
    const engines: SearchEngine[] = []
    for (const definition of this.definitions) {
      const config = this.getEngineConfig(siteId, definition.key)
      engines.push({
        key: definition.key,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        logo: definition.logo,
        vendor: definition.vendor,
        website: definition.website,
        props: definition.props,
        hasImplementation: await this.hasImplementation(definition.key),
        isSelected: definition.key === selected,
        config: mask ? maskSensitiveConfig(definition.props, config) : config
      })
    }
    return engines
  }

  /** The stored config values for one engine on one site, completed with that engine's declared
   *  defaults -- the single-engine version of what `getSiteEngines()` builds for every entry. */
  getEngineConfig(siteId: string, key: string): Record<string, any> {
    const stored = (CARDINAL.sites[siteId]?.config?.search?.engines?.[key] ?? {}) as Record<
      string,
      any
    >
    return this.buildEngineConfig(key, {}, stored)
  }

  /**
   * A search engine is a per-site *selection*, not a set of independently-enabled rows, so config for
   * an engine that is not currently active still needs somewhere to live -- under its own key in
   * `site.config.search.engines` -- so that switching back to it does not lose what was entered.
   * Hence this wrapper over the shared merge, with `existing` read off the site rather than a row.
   */
  buildEngineConfig(
    key: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return mergeModuleConfig(this.getDefinition(key)?.props ?? {}, incoming, existing)
  }

  /**
   * An unknown key is refused, unlike `Storage.validateConfig` -- which drops one so that losing a
   * prop can never make the admin area unable to save. The engine picker only ever sends what the
   * engine's own props currently list, so an unrecognized key means a stale or wrong request.
   *
   * `required` and `pattern` are checked against the *effective* config -- `incoming` merged onto
   * `existing`, the same merge `buildEngineConfig` does -- rather than `incoming` alone: an engine
   * switch that sends no config at all is still refused when a required field was never filled in,
   * and a value saved on an earlier request need not be resent on every later save to keep validating.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateEngineConfig(
    key: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): string | null {
    const definition = this.getDefinition(key)
    return validateModuleConfig(definition?.props ?? {}, incoming, {
      refuseUnknown: true,
      requiredAndPattern: true,
      moduleTitle: definition?.title ?? key,
      existing
    })
  }

  /**
   * The caller validates first (`validateEngineConfig`): only declared props survive into what gets
   * stored, keyed under the engine so a later switch back to it starts from what was last saved
   * rather than from the engine's bare defaults.
   *
   * `init()` provisions the engine here, and a failure from it is left uncaught on purpose: bad
   * credentials or an unreachable service are what an operator picking an engine needs to see
   * immediately, not a selection that silently saved but never works.
   *
   * @returns Whether the site was written
   */
  async selectEngine(
    siteId: string,
    key: string,
    incoming: Record<string, any> = {}
  ): Promise<boolean> {
    const stored = (CARDINAL.sites[siteId]?.config?.search?.engines?.[key] ?? {}) as Record<
      string,
      any
    >
    const config = this.buildEngineConfig(key, incoming, stored)
    const updated = await CARDINAL.models.sites.updateSite(siteId, {
      config: { search: { engine: key, engines: { [key]: config } } }
    })
    if (updated) {
      const module = await this.ensureModule(key)
      if (module) {
        await module.init(siteId, config)
      }
    }
    return updated
  }

  /**
   * Each site is provisioned independently: one site's bad credentials or unreachable service is
   * logged and skipped, not allowed to abort boot for every other site.
   *
   * Concurrently rather than in a loop, since a serial boot would pay up to `ENGINE_INIT_TIMEOUT_MS`
   * per unreachable site instead of one window for all of them. Safe because `ensureModule()`
   * memoises into `this.modules[key]` and concurrent `import()`s of one module hit Node's ESM cache.
   */
  async initActiveEngines(): Promise<void> {
    await Promise.allSettled(
      Object.keys(CARDINAL.sites).map(async (siteId) => {
        let key = CARDINAL.sites[siteId]?.config?.search?.engine ?? DB_MODULE
        let module = await this.ensureModule(key)
        // -> The configured engine has no implementation on disk at all, as opposed to `init()`
        //    below throwing. `getActiveEngine()` falls back to `db` silently because it runs per
        //    query and would spam; once per site per boot is where the warning belongs.
        if (!module && key !== DB_MODULE) {
          CARDINAL.logger.warn(
            'search',
            'configured engine has no implementation, falling back to db',
            {
              engine: key,
              site: siteId
            }
          )
          key = DB_MODULE
          module = await this.ensureModule(DB_MODULE)
        }
        if (!module) {
          return
        }
        try {
          await withTimeout(
            module.init(siteId, this.getEngineConfig(siteId, key)),
            ENGINE_INIT_TIMEOUT_MS,
            () =>
              new Error(
                `Timed out after ${ENGINE_INIT_TIMEOUT_MS / 1000}s waiting for "${key}" to initialize.`
              )
          )
        } catch (err: any) {
          CARDINAL.logger.warn('search', 'initializing the engine failed', {
            engine: key,
            site: siteId,
            error: err
          })
        }
      })
    )
  }

  /** Read off the site's own `config.search.config`, seeded by `models/sites.ts`'s per-site defaults,
   *  rather than `CARDINAL.config.search`: these settings apply to one site, not the instance. */
  getConfig(siteId: string): SearchConfig {
    const config = CARDINAL.sites[siteId]?.config?.search?.config as
      | Partial<SearchConfig>
      | undefined
    return {
      dictOverrides: (config?.dictOverrides ?? {}) as Record<string, string>,
      semanticEnabled: config?.semanticEnabled ?? false
    }
  }

  /**
   * The text search configurations this postgres installation has, e.g. `english`, `simple`. Not
   * site-scoped — postgres is one installation shared by every site — so it always asks the `db`
   * module rather than the site's active engine: an operator can still configure `db`'s dictionaries
   * while another engine serves that site's queries.
   */
  async getAvailableDictionaries(): Promise<string[]> {
    const engine = await this.ensureModule(DB_MODULE)
    if (!engine) {
      return []
    }
    // -> A `db`-specific capability, not part of `SearchModule`: no other engine has anything
    //    resembling a postgres text search dictionary to report
    return (
      engine as unknown as { getAvailableDictionaries(): Promise<string[]> }
    ).getAvailableDictionaries()
  }

  /**
   * A site that names no engine, or one whose implementation is missing or failed to load, gets
   * `db` — rather than search breaking outright for it.
   *
   * Every caller reaches an engine through this, which is what keeps them off any specific
   * implementation. A `db`-only capability that genuinely has to reach past the dispatcher asks
   * `ensureModule(DB_MODULE)` directly, the way `getAvailableDictionaries()` above does.
   */
  private async getActiveEngine(siteId: string): Promise<SearchModule> {
    const key = CARDINAL.sites[siteId]?.config?.search?.engine ?? DB_MODULE
    const module = (await this.ensureModule(key)) ?? (await this.ensureModule(DB_MODULE))
    if (!module) {
      throw new Error(
        `No search engine implementation is available (tried "${key}" and "${DB_MODULE}").`
      )
    }
    return module
  }

  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const engine = await this.getActiveEngine(params.siteId)
    return engine.query(params)
  }

  async rebuild(siteId: string): Promise<RebuildResult> {
    const engine = await this.getActiveEngine(siteId)
    return engine.rebuild(siteId)
  }

  async created(page: SearchIndexablePage): Promise<void> {
    const engine = await this.getActiveEngine(page.siteId)
    await engine.created(page)
  }

  async updated(page: SearchIndexablePage): Promise<void> {
    const engine = await this.getActiveEngine(page.siteId)
    await engine.updated(page)
  }

  async deleted(siteId: string, pageId: string): Promise<void> {
    const engine = await this.getActiveEngine(siteId)
    await engine.deleted(siteId, pageId)
  }

  async renamed(
    siteId: string,
    page: SearchIndexablePage,
    previousPath: string,
    previousLocale: string
  ): Promise<void> {
    const engine = await this.getActiveEngine(siteId)
    await engine.renamed(siteId, page, previousPath, previousLocale)
  }
}

export const search = new Search()
