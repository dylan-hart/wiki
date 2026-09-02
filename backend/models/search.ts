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

/**
 * The engine every site starts with, and the only one guaranteed to work: postgres full-text search
 * against the wiki's own database. Sorted first among definitions, same as storage's `db` module —
 * it's the safe default an operator sees before any others, and the fallback `query`/`rebuild`/
 * `created`/`updated`/`deleted`/`renamed` resolve to when a site's config names no engine.
 */
const DB_MODULE = 'db'

/**
 * How long `initActiveEngines()` waits on one site's `init()` before giving up on it (OpenProject
 * #920 follow-up).
 *
 * `init()` reaches an external service (Azure/AWS/Elasticsearch/Algolia) with no bound of its own —
 * a couple of these SDKs' underlying HTTP clients have no default request timeout at all, so a
 * misconfigured host (firewalled, black-holed) can leave the promise neither resolving nor rejecting.
 * `initActiveEngines()`'s own doc comment promises that "one site's bad credentials or unreachable
 * service is logged and skipped, not allowed to abort boot for every other site" -- a bare `try`/
 * `catch` only delivers that for a service that actively refuses, not one that never answers, since
 * the `for` loop awaits each site in turn before moving to the next. This ceiling is what makes a hang
 * behave the same as any other failure here.
 */
const ENGINE_INIT_TIMEOUT_MS = 30_000

/**
 * `dictOverrides` only: `termHighlighting` used to live here too (task #563), but task #574 folded it
 * into the `db` engine's own per-engine config (`site.config.search.engines.db.termHighlighting`,
 * `getEngineConfig()` below) since it is already expressed as a normal boolean prop on `db`'s
 * `definition.yml` and edited through the same generic engine-picker form as any other engine's props.
 * `dictOverrides` cannot follow it there — it is a free-form locale -> dictionary map, not a scalar
 * `parseModuleProps` can validate — so it keeps its own bucket and its own admin-area editor.
 */
export interface SearchConfig {
  dictOverrides: Record<string, string>
}

/**
 * What a rebuild did, per locale, so the caller can report something concrete.
 *
 * `dictionary` is optional: it names the postgres text-search dictionary the `db` engine chose for
 * that locale, a concept with no equivalent in an external index. `azure-search` and `aws-cloudsearch`
 * (task #564) report `pages` per locale like every engine, but omit `dictionary` entirely rather than
 * inventing a value for a thing they don't have.
 *
 * `warnings` is optional too: a non-fatal problem worth an operator's attention that did not stop the
 * rebuild from finishing -- e.g. the Algolia module (OpenProject #830) skipping a page whose document
 * exceeds Algolia's per-object size limit rather than aborting the whole rebuild over it. Every engine
 * already writes the same information to `WIKI.logger.warn` as it happens (the admin-visible channel
 * every other per-page indexing failure in these modules uses, e.g. `indexPage`'s catch blocks); this
 * field additionally surfaces it on the structured result itself, which is what a test -- or a future
 * caller that actually reads a rebuild's return value instead of discarding it -- can assert against
 * without scraping logs.
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
}

export interface SearchPagesResult {
  results: SearchResult[]
  /**
   * How many pages match AND are visible to the searching actor, ignoring `limit`/`offset`.
   *
   * OpenProject #2146/#2151: derived only from rows that survived `read:pages` filtering, never from
   * a raw match count computed before permissions are applied — the `db` engine's own
   * `MAX_SCANNED_ROWS` doc comment (`modules/search/db/search.ts`) has the detail. Exact up to
   * whatever cap the active engine scans before filtering; beyond that cap it is a floor (at least
   * this many), not a precise total — an engine that caps should say so at its own cap constant.
   */
  totalHits: number
  /**
   * `true` when `totalHits` is not exact: an actor's page rules dropped one or more of the rows the
   * engine's own count included, on this page of results. Every engine's `totalHits` is corrected by
   * exactly what was dropped from *this* page (see each engine's own comment by its `totalHits`
   * calculation), but rows on other, unfetched pages the same actor could not see either are never
   * counted at all — so a searcher with restrictive rules can still see fewer results than the total
   * promises. `false` means every row the engine counted was actually visible to the actor, or no
   * actor was given to check against (an internal caller, or a config that trusts the caller already
   * filtered).
   */
  totalHitsApproximate: boolean
  /**
   * The closest page title to a query that matched nothing, for a "did you mean" prompt.
   *
   * `null` whenever there is nothing to suggest: no query was given, the query already found
   * results, or nothing cleared the similarity threshold. Only ever set alongside `totalHits === 0`.
   */
  suggestion: string | null
}

export interface SuggestTitleParams {
  siteId: string
  query: string
  /** Same meaning as on `SearchPagesParams`: restrict the candidates to what an anonymous reader may see. */
  publicOnly?: boolean
  /** Same meaning as on `SearchPagesParams`: include unpublished pages among the candidates. */
  includeDrafts?: boolean
  /** Same meaning as on `SearchPagesParams`: drop a candidate the actor could not actually open. */
  actor?: AccessActor
}

/**
 * Minimum trigram similarity (`pg_trgm`'s `similarity()`, 0..1) for a title to be worth suggesting.
 *
 * Picked as a starting point rather than tuned against real usage — see the note on `suggestTitle`
 * in `modules/search/db/search.ts`, the only engine that implements a "did you mean" today.
 */
export const SUGGEST_TITLE_THRESHOLD = 0.3

/** How many similarity candidates to pull before permission-filtering them down to one. */
export const SUGGEST_TITLE_CANDIDATES = 5

export interface SearchPagesParams {
  siteId: string
  query?: string
  path?: string
  locales?: string[]
  tags?: string[]
  editor?: string
  publishState?: string
  orderBy?: SearchOrderBy
  orderByDirection?: 'asc' | 'desc'
  offset?: number
  limit?: number
  /** Restrict to what a reader with no session may see: published pages. */
  publicOnly?: boolean
  /** Whether unpublished pages belong in the results, which is an editor's view of the wiki. */
  includeDrafts?: boolean
  /**
   * Who is searching, so that a result they could not open never reaches them.
   *
   * Applied to the rows rather than in the query: which pages a rule covers can depend on a regular
   * expression or on a page's tags, neither of which a `WHERE` clause here could express.
   */
  actor?: AccessActor
  /**
   * Keep a password-protected page's *body* out of the results, for a searcher who would have to enter
   * the password to read it. The page itself still appears — its title and description are not what
   * the password covers — but it can only be matched on those, and comes back with no excerpt.
   */
  hideProtectedContent?: boolean
}

/**
 * A search engine, for a site's engine picker: the module definition plus how the site has it set up.
 *
 * Mirrors `StorageTarget` (`models/storage.ts`), with one structural difference: a site has exactly
 * one *active* engine (`isSelected`) rather than several independently-enabled targets, so there is no
 * `id`/`isEnabled` pair here — `key` plus `isSelected` is all a picker needs.
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
   * The `db` engine's dictionary override map and what postgres actually has installed, task #574.
   *
   * Not populated by `getSiteEngines()` itself — calling `getAvailableDictionaries()` for every
   * engine on every listing would load and query the `db` module even when it is not selected, for a
   * value only the `db` panel ever reads. `api/search.ts` attaches both onto the `db` entry after
   * calling `getSiteEngines()`, which is also why they are optional here: every other engine's entry
   * carries neither.
   */
  dictOverrides?: Record<string, string>
  availableDictionaries?: string[]
}

/** A search engine module, as declared by its `definition.yml`. */
export interface SearchEngineDefinition {
  key: string
  title: string
  description: string
  icon?: string
  logo?: string
  vendor: string
  website: string
  /**
   * Engine-specific config fields, e.g. an API key or an index name.
   *
   * `dictOverrides` (a locale -> text search dictionary map) is deliberately not declared here:
   * `parseModuleProps` (`helpers/moduleProps.ts`) only knows how to validate boolean/number/string/enum
   * scalars, and an override map is a free-form object with no fixed set of keys. It stays a JSON
   * config field a provider reads directly off its stored config — same as `AdminSearch.vue`'s
   * `util-code-editor` already edits it today — rather than being forced through prop validation that
   * cannot express it. A provider that wants it need only read `config.dictOverrides` itself.
   */
  props: Record<string, ModuleProp>
}

/**
 * A page row, as handed to a search module's `created`/`updated`/`renamed` hooks.
 *
 * The full row rather than a narrowed shape: which fields a given engine actually indexes (title vs.
 * body vs. tags) is that module's decision, not this interface's, and an external engine needs enough
 * to build its own document without querying the database back.
 */
export type SearchIndexablePage = typeof pagesTable.$inferSelect

/**
 * What a search engine module implementation is expected to export as its default.
 *
 * Mirrors `StorageModule` (`models/storage.ts`) and the per-strategy classes `models/authentication.ts`
 * dynamically imports: one file per engine, resolved by its `definition.yml` key. Unlike storage —
 * where most of the interface is still unimplemented — every hook here is mandatory from the start:
 * a search index has to stay in step with every page mutation from the moment an engine exists, since a
 * stale or missing entry in an external index (Elasticsearch, Algolia, ...) is a silently wrong result
 * rather than a visibly broken feature.
 */
export interface SearchModule {
  /** Called when the engine is (re)configured for a site — connect, verify the index exists, etc. */
  init(siteId: string, config: Record<string, any>): Promise<void>
  /** A page was created. */
  created(page: SearchIndexablePage): Promise<void>
  /** A page's content or metadata changed. */
  updated(page: SearchIndexablePage): Promise<void>
  /** A page was deleted. Only the ID travels — there is no row left to read anything else from. */
  deleted(siteId: string, pageId: string): Promise<void>
  /**
   * A page moved. `previousPath` and `previousLocale` are what the module indexed it under before —
   * a move can change either, and `page` already carries where it ended up.
   */
  renamed(
    siteId: string,
    page: SearchIndexablePage,
    previousPath: string,
    previousLocale: string
  ): Promise<void>
  /** Serve a search request. */
  query(params: SearchPagesParams): Promise<SearchPagesResult>
  /** Recompute the whole index of a site from scratch. */
  rebuild(siteId: string): Promise<RebuildResult>
}

/**
 * Search model
 *
 * A thin dispatcher: it holds no indexing logic of its own. Every real implementation — starting with
 * postgres full-text search, `modules/search/db/search.ts` — is a `SearchModule`, resolved per site by
 * `WIKI.sites[siteId]?.config?.search?.engine` and loaded through `ensureModule()`. `query`, `rebuild`,
 * `created`, `updated`, `deleted` and `renamed` below all just resolve the engine and call through.
 *
 * `getConfig()` is the one exception: `dictOverrides` is a per-site setting the admin area edits
 * regardless of which engine that site has active, so it stays read here rather than moving into a
 * specific module -- `dictOverrides` only makes sense for `db` today, but nothing stops a future
 * engine's admin panel from reading it too. `termHighlighting` used to live alongside it here, but task
 * #574 folded it into `db`'s own per-engine config (`getEngineConfig()` below) since, unlike
 * `dictOverrides`, it is a plain boolean the generic props system already expresses and edits.
 */
class Search {
  /** Definitions read from disk, refreshed by `refreshFromDisk()`. */
  definitions: SearchEngineDefinition[] = []

  /**
   * Implementations loaded by `ensureModule()`, keyed by module key rather than by `(siteId, key)`.
   *
   * A site has exactly one active search engine (`site.config.search.engine`), unlike storage's many
   * concurrently-enabled targets — but that doesn't make a *module* single-site. Every `SearchModule`
   * hook (`init`, `created`, `deleted`, `renamed`, `query`, `rebuild`) already takes `siteId` as an
   * explicit argument on every call (see `SearchModule` above), which is what lets one loaded module —
   * say, an Elasticsearch provider — serve several sites' distinct clusters/indices out of state it
   * keeps internally (e.g. a `Map<siteId, Client>` built up as `init()` is called once per site),
   * exactly the way a stateless module needs no such map at all. Caching per-siteId here would only
   * duplicate that bookkeeping one layer up for no benefit, so this stays singleton-per-key, same as
   * storage's `modules`.
   */
  modules: Record<string, SearchModule> = {}

  /**
   * Load the search engine definitions from disk.
   */
  async refreshFromDisk(): Promise<void> {
    const searchPath = path.join(WIKI.SERVERPATH, 'modules/search')
    try {
      const definitions = await readModuleDefinitions<SearchEngineDefinition>(searchPath, {
        parseProps: true,
        sortPropsByOrder: true
      })
      // -> The database engine first, then alphabetically: it is the one every site starts with
      this.definitions = definitions.sort((a, b) =>
        a.key === DB_MODULE ? -1 : b.key === DB_MODULE ? 1 : a.title.localeCompare(b.title)
      )
      WIKI.logger.info(`Found ${this.definitions.length} search modules [ OK ]`)
    } catch (err: any) {
      this.definitions = []
      WIKI.logger.error(`Could not read the search module definitions at ${searchPath} [ FAILED ]`)
      WIKI.logger.error(err.message)
    }
  }

  /**
   * Whether the module has any code to run, as opposed to only a definition
   */
  async hasImplementation(key: string): Promise<boolean> {
    return moduleHasFile(WIKI.SERVERPATH, 'modules/search', key, 'search.ts')
  }

  /**
   * A single definition, or null when nothing on disk declares that key
   */
  getDefinition(key: string): SearchEngineDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /**
   * Ensure a module's implementation is loaded
   *
   * @returns The implementation, or null when the module has none or it failed to load
   */
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
   * Every installed search engine, for a site's engine picker.
   *
   * Driven by `this.definitions` rather than by anything stored, the same way
   * `Storage.getSiteTargets()` is driven by its own definitions: an engine dropped from disk without a
   * restart is simply absent, rather than half-present with no metadata behind it.
   *
   * @param opts.mask When true, a `sensitive` prop's stored value (Algolia's `apiKey`, ...) is
   *   replaced with a mask before being returned -- see `helpers/moduleProps.ts#maskSensitiveConfig`.
   *   Defaults to false; `selectEngine()`/`initActiveEngines()` never call this at all (they read
   *   `getEngineConfig()` directly), but the default stays false here too so a caller other than the
   *   admin list route never gets a masked value it did not ask for.
   */
  async getSiteEngines(
    siteId: string,
    { mask = false }: { mask?: boolean } = {}
  ): Promise<SearchEngine[]> {
    const selected = WIKI.sites[siteId]?.config?.search?.engine ?? DB_MODULE
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

  /**
   * The stored config values for one engine on one site, completed with that engine's declared
   * defaults -- the single-engine version of what `getSiteEngines()` builds for every entry.
   *
   * The `db` module calls this directly (rather than through `WIKI.models.search`, which it already
   * bypasses by importing the `search` singleton) to read its own `termHighlighting`, so that the value
   * a `PUT .../search/engines/db` save writes is the exact same one a query reads back -- see the
   * `SearchEngine.dictOverrides`/`availableDictionaries` doc comment for why `dictOverrides` could not
   * follow the same path.
   */
  getEngineConfig(siteId: string, key: string): Record<string, any> {
    const stored = (WIKI.sites[siteId]?.config?.search?.engines?.[key] ?? {}) as Record<string, any>
    return this.buildEngineConfig(key, {}, stored)
  }

  /**
   * Merge incoming config values for one engine onto what is already stored for it, keeping only what
   * the engine declares.
   *
   * The merge itself is the shared one every module-backed model uses
   * (`helpers/moduleRegistry.ts#mergeModuleConfig`); what stays specific to search is *where* the
   * config it merges lives. A search engine is a per-site *selection*, not a set of
   * independently-enabled rows, so config for an engine that isn't currently active still needs
   * somewhere to live -- under its own key in `site.config.search.engines` -- so that switching back
   * to it does not lose what was entered. Hence this wrapper, and its `existing` argument being read
   * off the site rather than off a row of its own.
   */
  buildEngineConfig(
    key: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return mergeModuleConfig(this.getDefinition(key)?.props ?? {}, incoming, existing)
  }

  /**
   * Check incoming config values for one engine against what it declares.
   *
   * Unlike `Storage.validateConfig` -- which silently drops a key a module no longer declares, so that
   * losing a prop can never make the admin area unable to save -- an unknown key here is refused: the
   * engine picker only ever sends what the engine's own props currently list, so an unrecognized key
   * means the request is stale or wrong, not that a prop was removed server-side.
   *
   * Beyond the per-key type/enum check above, a `required` prop (e.g. Algolia's `apiKey`, Elasticsearch's
   * `hosts`) and a `pattern` prop (e.g. Elasticsearch's `hosts` shape) are checked against the
   * *effective* config -- `incoming` merged onto `existing`, the same merge `buildEngineConfig` does for
   * what actually gets saved -- rather than against `incoming` alone. Two things fall out of that: an
   * engine switch that sends no config at all is still refused if a required field was genuinely never
   * filled in (its default is empty, and empty stays empty through the merge), and a value saved on an
   * earlier request does not need to be resent on every later save just to keep validating.
   *
   * @param existing What is already stored for this engine on the site making the request, task #556 --
   *   omit it (e.g. for a plain type/enum check with no site in play) to validate `incoming` as if
   *   nothing were stored yet.
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
   * Select a site's active search engine and save its config.
   *
   * Caller validates first (`validateEngineConfig`): only the declared props survive into what gets
   * stored, keyed under the engine so a later switch back to it starts from what was last saved rather
   * than from the engine's bare defaults.
   *
   * Also provisions the engine (OpenProject #920): before this, nothing anywhere ever called a
   * `SearchModule`'s `init()` — `azure-search` and `aws-cloudsearch` put all of their index/domain
   * provisioning exclusively there (unlike `algolia`/`elasticsearch`, which additionally provision
   * lazily on first use), so selecting either left an operator with an index that was never created.
   * Every implementation's `init()` is expected to be idempotent (each module's own doc comment says
   * so), so calling it here on every selection -- including reselecting the engine that was already
   * active -- is safe. Left uncaught on purpose: a provisioning failure (bad credentials, an
   * unreachable service) is exactly what an operator picking an engine needs to see immediately, not a
   * selection that silently saved but never works. `initActiveEngines()` below covers the boot-time
   * half of the same gap.
   *
   * @returns Whether the site was written
   */
  async selectEngine(
    siteId: string,
    key: string,
    incoming: Record<string, any> = {}
  ): Promise<boolean> {
    const stored = (WIKI.sites[siteId]?.config?.search?.engines?.[key] ?? {}) as Record<string, any>
    const config = this.buildEngineConfig(key, incoming, stored)
    const updated = await WIKI.models.sites.updateSite(siteId, {
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
   * Provision every site's currently active search engine, task #920's boot-time counterpart to
   * `selectEngine()` above.
   *
   * Covers what a per-selection call cannot: a site whose non-`db` engine was already selected before
   * this task existed (so `selectEngine()` never ran for it), and a normal restart, which every
   * implementation's `init()` is safe to run again for. Each site is provisioned independently -- one
   * site's bad credentials or unreachable service is logged and skipped, not allowed to abort boot for
   * every other site.
   *
   * Sites are provisioned concurrently (OpenProject #1848): the `for` loop this used to be awaited each
   * site's `init()` -- and its up-to-`ENGINE_INIT_TIMEOUT_MS` race -- before starting the next, so N
   * sites pointed at unreachable external engines cost up to 30xN seconds of boot. `Promise.allSettled`
   * runs every site's init (each still wrapped in its own try/catch and timeout race) in parallel, so
   * the worst case is one timeout, not N. `ensureModule()` memoises into `this.modules[key]` and
   * concurrent `import()` calls for the same module hit Node's own ESM cache, so two sites sharing an
   * engine key racing through `ensureModule()` here is safe.
   */
  async initActiveEngines(): Promise<void> {
    await Promise.allSettled(
      Object.keys(WIKI.sites).map(async (siteId) => {
        const key = WIKI.sites[siteId]?.config?.search?.engine ?? DB_MODULE
        const module = await this.ensureModule(key)
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
          WIKI.logger.warn(
            `(SEARCH) Failed to initialize search engine "${key}" for site ${siteId} [ FAILED ]`
          )
          WIKI.logger.warn(err.message)
        }
      })
    )
  }

  /**
   * A site's dictionary override map, with the shape the API and the admin area expect.
   *
   * Read off `WIKI.sites[siteId].config.search.config` -- a sibling of `search.engine`, seeded by
   * `models/sites.ts`'s per-site defaults -- rather than `WIKI.config.search`: this setting applies to
   * one site, not the instance, the same way `dictOverrides` (a locale mapping) only ever made sense
   * per site once more than one could each run their own engine.
   */
  getConfig(siteId: string): SearchConfig {
    const config = WIKI.sites[siteId]?.config?.search?.config as Partial<SearchConfig> | undefined
    return {
      dictOverrides: (config?.dictOverrides ?? {}) as Record<string, string>
    }
  }

  /**
   * The text search configurations this postgres installation actually has, e.g. `english`, `simple`.
   *
   * Not site-scoped — postgres itself is one installation shared by every site — so this always asks
   * the `db` module specifically rather than the site's active engine. Used by the admin area to
   * validate a `dictOverrides` mapping before it's saved, and by `db`'s own indexing, regardless of
   * whether `db` is any given site's active engine: an operator can still configure its dictionaries
   * from the search settings screen even while another engine serves queries.
   */
  async getAvailableDictionaries(): Promise<string[]> {
    const engine = await this.ensureModule(DB_MODULE)
    if (!engine) {
      return []
    }
    // -> `getAvailableDictionaries` is a `db`-specific capability, not part of `SearchModule` — every
    //    other engine has nothing resembling a postgres text search dictionary to report
    return (
      engine as unknown as { getAvailableDictionaries(): Promise<string[]> }
    ).getAvailableDictionaries()
  }

  /**
   * The search engine configured for a site, loaded and ready to receive calls.
   *
   * A site that names no engine — every site, until per-site engine selection ships — gets `db`, the
   * one guaranteed to have an implementation. A site that names an engine whose implementation is
   * missing or failed to load also falls back to `db`, rather than search breaking outright for it.
   *
   * Internal to the dispatcher: `query`/`rebuild`/`created`/`updated`/`deleted`/`renamed` below all
   * resolve through this and forward straight to it, which is what keeps every caller
   * (`api/pages.ts`, `models/pages.ts`, `tasks/simple/rebuild-search-index.ts`) off any specific
   * engine implementation — they only ever call `WIKI.models.search.*`. A `db`-only capability that
   * genuinely has to reach past the dispatcher asks `ensureModule(DB_MODULE)` directly, the way
   * `getAvailableDictionaries()` above does.
   */
  private async getActiveEngine(siteId: string): Promise<SearchModule> {
    const key = WIKI.sites[siteId]?.config?.search?.engine ?? DB_MODULE
    const module = (await this.ensureModule(key)) ?? (await this.ensureModule(DB_MODULE))
    if (!module) {
      throw new Error(
        `No search engine implementation is available (tried "${key}" and "${DB_MODULE}").`
      )
    }
    return module
  }

  /**
   * Full-text search over the pages of a site. Delegates to the site's configured engine.
   */
  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const engine = await this.getActiveEngine(params.siteId)
    return engine.query(params)
  }

  /**
   * Recompute the whole search index of a site. Delegates to the site's configured engine.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const engine = await this.getActiveEngine(siteId)
    return engine.rebuild(siteId)
  }

  /** A page was created. Delegates to the page's site's configured engine. */
  async created(page: SearchIndexablePage): Promise<void> {
    const engine = await this.getActiveEngine(page.siteId)
    await engine.created(page)
  }

  /** A page's content or metadata changed. Delegates to the page's site's configured engine. */
  async updated(page: SearchIndexablePage): Promise<void> {
    const engine = await this.getActiveEngine(page.siteId)
    await engine.updated(page)
  }

  /** A page was deleted. Delegates to the site's configured engine. */
  async deleted(siteId: string, pageId: string): Promise<void> {
    const engine = await this.getActiveEngine(siteId)
    await engine.deleted(siteId, pageId)
  }

  /** A page moved. Delegates to the page's site's configured engine. */
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
