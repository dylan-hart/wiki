import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { parseModuleProps } from '../helpers/common.ts'
import type { AccessActor } from './groups.ts'
import type { ModuleProp } from '../helpers/common.ts'
import type { pages as pagesTable } from '../db/schema.ts'

/**
 * The engine every site starts with, and the only one guaranteed to work: postgres full-text search
 * against the wiki's own database. Sorted first among definitions, same as storage's `db` module —
 * it's the safe default an operator sees before any others, and the fallback `query`/`rebuild`/
 * `created`/`updated`/`deleted`/`renamed` resolve to when a site's config names no engine.
 */
const DB_MODULE = 'db'

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

/** What a rebuild did, per locale, so the caller can report something concrete. */
export interface RebuildResult {
  pages: number
  locales: { locale: string; dictionary: string; pages: number }[]
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
  totalHits: number
}

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
   * `parseModuleProps` (`helpers/common.ts`) only knows how to validate boolean/number/string/enum
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
  /** A page moved. `previousPath` is what the module indexed it under before. */
  renamed(siteId: string, page: SearchIndexablePage, previousPath: string): Promise<void>
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
    const definitions: SearchEngineDefinition[] = []
    try {
      for (const dir of await fs.readdir(searchPath)) {
        const raw = await fs.readFile(path.join(searchPath, dir, 'definition.yml'), 'utf8')
        const parsed = load(raw) as Record<string, any>
        // -> The directory name is the key, as it is for every other module type
        parsed.key = dir
        // -> Props carry a display `order`, applied once here so that every consumer — the admin
        //    area included — reads them in the order the module meant them to be shown in
        parsed.props = Object.fromEntries(
          Object.entries(parseModuleProps(parsed.props ?? {})).sort(
            ([, a], [, b]) => a.order - b.order
          )
        )
        definitions.push(parsed as SearchEngineDefinition)
      }
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
    try {
      await fs.access(path.join(WIKI.SERVERPATH, 'modules/search', key, 'search.ts'))
      return true
    } catch {
      return false
    }
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
    if (this.modules[key]) {
      return this.modules[key]
    }
    if (!(await this.hasImplementation(key))) {
      return null
    }
    try {
      // -> Extension-sensitive dynamic import, invisible to the type checker
      this.modules[key] = (await import(`../modules/search/${key}/search.ts`)).default
      WIKI.logger.debug(`Activated search module ${key} [ OK ]`)
      return this.modules[key]
    } catch (err: any) {
      WIKI.logger.warn(`Failed to load search module ${key} [ FAILED ]`)
      WIKI.logger.warn(err)
      return null
    }
  }

  /**
   * Every installed search engine, for a site's engine picker.
   *
   * Driven by `this.definitions` rather than by anything stored, the same way
   * `Storage.getSiteTargets()` is driven by its own definitions: an engine dropped from disk without a
   * restart is simply absent, rather than half-present with no metadata behind it.
   */
  async getSiteEngines(siteId: string): Promise<SearchEngine[]> {
    const selected = WIKI.sites[siteId]?.config?.search?.engine ?? DB_MODULE
    const engines: SearchEngine[] = []
    for (const definition of this.definitions) {
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
        config: this.getEngineConfig(siteId, definition.key)
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
   * Same shape as `Storage.buildConfig`, kept as its own method rather than shared: a search engine is
   * a per-site *selection*, not a set of independently-enabled rows, so config for an engine that
   * isn't currently active still needs somewhere to live -- under its own key in
   * `site.config.search.engines` -- so that switching back to it does not lose what was entered.
   */
  buildEngineConfig(
    key: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    const props = this.getDefinition(key)?.props ?? {}
    const config: Record<string, any> = {}
    for (const [propKey, prop] of Object.entries(props)) {
      const current = existing[propKey] !== undefined ? existing[propKey] : prop.default
      config[propKey] =
        prop.readOnly || incoming[propKey] === undefined ? current : incoming[propKey]
    }
    return config
  }

  /**
   * Check incoming config values for one engine against what it declares.
   *
   * Unlike `Storage.validateConfig` -- which silently drops a key a module no longer declares, so that
   * losing a prop can never make the admin area unable to save -- an unknown key here is refused: the
   * engine picker only ever sends what the engine's own props currently list, so an unrecognized key
   * means the request is stale or wrong, not that a prop was removed server-side.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateEngineConfig(key: string, incoming: Record<string, any> = {}): string | null {
    const definition = this.getDefinition(key)
    const props = definition?.props ?? {}
    for (const [propKey, value] of Object.entries(incoming)) {
      const prop = props[propKey]
      if (!prop) {
        return `"${propKey}" is not a config value ${definition?.title ?? key} accepts.`
      }
      if (prop.readOnly || value === undefined) {
        continue
      }
      if (prop.enum) {
        // -> Enum entries are declared as `value` or `value|label`
        const allowed = prop.enum.map((entry) => entry.split('|')[0])
        if (!allowed.includes(`${value}`)) {
          return `"${value}" is not a valid value for ${prop.title}.`
        }
        continue
      }
      switch (prop.type) {
        case 'boolean':
          if (typeof value !== 'boolean') {
            return `${prop.title} must be true or false.`
          }
          break
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return `${prop.title} must be a number.`
          }
          break
        default:
          if (typeof value !== 'string') {
            return `${prop.title} must be a string.`
          }
      }
    }
    return null
  }

  /**
   * Select a site's active search engine and save its config.
   *
   * Caller validates first (`validateEngineConfig`): only the declared props survive into what gets
   * stored, keyed under the engine so a later switch back to it starts from what was last saved rather
   * than from the engine's bare defaults.
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
    return WIKI.models.sites.updateSite(siteId, {
      config: { search: { engine: key, engines: { [key]: config } } }
    })
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
   * the `db` module specifically rather than going through `engineFor`. Used by the admin area to
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
   */
  private async engineFor(siteId: string): Promise<SearchModule> {
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
    const engine = await this.engineFor(params.siteId)
    return engine.query(params)
  }

  /**
   * Recompute the whole search index of a site. Delegates to the site's configured engine.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const engine = await this.engineFor(siteId)
    return engine.rebuild(siteId)
  }

  /** A page was created. Delegates to the page's site's configured engine. */
  async created(page: SearchIndexablePage): Promise<void> {
    const engine = await this.engineFor(page.siteId)
    await engine.created(page)
  }

  /** A page's content or metadata changed. Delegates to the page's site's configured engine. */
  async updated(page: SearchIndexablePage): Promise<void> {
    const engine = await this.engineFor(page.siteId)
    await engine.updated(page)
  }

  /** A page was deleted. Delegates to the site's configured engine. */
  async deleted(siteId: string, pageId: string): Promise<void> {
    const engine = await this.engineFor(siteId)
    await engine.deleted(siteId, pageId)
  }

  /** A page moved. Delegates to the page's site's configured engine. */
  async renamed(siteId: string, page: SearchIndexablePage, previousPath: string): Promise<void> {
    const engine = await this.engineFor(siteId)
    await engine.renamed(siteId, page, previousPath)
  }
}

export const search = new Search()
