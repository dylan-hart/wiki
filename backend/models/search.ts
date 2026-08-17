import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { sql } from 'drizzle-orm'
import { parseModuleProps } from '../helpers/common.ts'
import type { AccessActor } from './groups.ts'
import type { ModuleProp } from '../helpers/common.ts'
import type { pages as pagesTable } from '../db/schema.ts'

/**
 * The engine every site starts with, and the only one guaranteed to work: postgres full-text search
 * against the wiki's own database. Sorted first among definitions, same as storage's `db` module —
 * it's the safe default an operator sees before any others.
 */
const DB_MODULE = 'db'

/**
 * Locale to PostgreSQL text search dictionary, for the languages postgres ships a snowball stemmer
 * for. Anything not listed here falls back to `simple`, which indexes words without stemming — still
 * searchable, just without matching plurals and conjugations.
 *
 * An operator can override or extend this from the admin area, which is what `dictOverrides` is for.
 */
export const DEFAULT_DICTIONARIES: Record<string, string> = {
  ar: 'arabic',
  ca: 'catalan',
  da: 'danish',
  de: 'german',
  el: 'greek',
  en: 'english',
  es: 'spanish',
  et: 'estonian',
  eu: 'basque',
  fi: 'finnish',
  fr: 'french',
  ga: 'irish',
  hi: 'hindi',
  hu: 'hungarian',
  hy: 'armenian',
  id: 'indonesian',
  it: 'italian',
  lt: 'lithuanian',
  ne: 'nepali',
  nl: 'dutch',
  no: 'norwegian',
  pt: 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  sr: 'serbian',
  sv: 'swedish',
  ta: 'tamil',
  tr: 'turkish',
  yi: 'yiddish'
}

/** The dictionary used when a locale has no mapping, or when its mapping is not installed. */
export const FALLBACK_DICTIONARY = 'simple'

export interface SearchConfig {
  termHighlighting: boolean
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
 * Markers `ts_headline` wraps a matched term in.
 *
 * Control characters, because the excerpt is page text that may itself contain anything: it is HTML
 * escaped before these are turned into tags, so a page whose text reads `<script>` cannot come back as
 * markup. Anything that could occur in real text would defeat that.
 */
const HL_START = '\u0002'
const HL_STOP = '\u0003'

/** Escape the LIKE wildcards, so that a path filter is a prefix rather than a pattern. */
function escapeLikePrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Search model
 *
 * Search is postgres full-text: every page carries a `ts` tsvector, indexed with GIN. Which
 * dictionary builds that vector depends on the page's locale, which is why the mapping is
 * configurable — using the wrong stemmer for a language quietly degrades results rather than
 * failing.
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
   * The search configuration, with the shape the API and the admin area expect
   */
  getConfig(): SearchConfig {
    return {
      termHighlighting: WIKI.config.search?.termHighlighting === true,
      dictOverrides: (WIKI.config.search?.dictOverrides ?? {}) as Record<string, string>
    }
  }

  /**
   * The text search configurations this postgres actually has, e.g. `english`, `simple`.
   *
   * Used to validate what an operator maps a locale to: a name postgres does not know would make
   * every `to_tsvector` call fail at rebuild time, long after the setting was saved.
   */
  async getAvailableDictionaries(): Promise<string[]> {
    const rows = await WIKI.db.execute(sql`SELECT cfgname FROM pg_ts_config ORDER BY cfgname`)
    return (rows.rows ?? rows).map((r: any) => r.cfgname as string)
  }

  /**
   * The dictionary to index a locale with, preferring the operator's override
   *
   * @param available Dictionary names postgres knows; an unknown mapping degrades to the fallback
   */
  dictionaryForLocale(locale: string, available: string[]): string {
    const { dictOverrides } = this.getConfig()
    // -> Locales can be regional (`en-US`), while dictionaries are per language
    const language = locale.split(/[-_]/)[0] ?? locale
    const wanted =
      dictOverrides[locale] ?? dictOverrides[language] ?? DEFAULT_DICTIONARIES[language]
    if (wanted && available.includes(wanted)) {
      return wanted
    }
    if (wanted) {
      WIKI.logger.warn(
        `Text search dictionary "${wanted}" for locale ${locale} is not installed — falling back to ${FALLBACK_DICTIONARY}.`
      )
    }
    return FALLBACK_DICTIONARY
  }

  /**
   * A SQL expression giving the text search dictionary to use for each row.
   *
   * The vector on a page was built with its own locale's dictionary, so the query has to be parsed
   * with the same one — an English query stemmed as French matches nothing. Postgres accepts a
   * `regconfig` expression, so the mapping travels with the row rather than being fixed per query.
   *
   * @param locales Locales the search covers, which is what the CASE needs arms for
   * @param available Dictionary names postgres knows
   */
  private dictionaryExpression(locales: string[], available: string[]) {
    const arms = locales.map((locale) => {
      const dictionary = this.dictionaryForLocale(locale, available)
      // -> Both sides are checked values: the locale is compared as a parameter, and the dictionary
      //    name is one postgres itself reported
      return sql`WHEN ${locale} THEN ${sql.raw(`'${dictionary}'`)}`
    })
    if (arms.length < 1) {
      return sql`${sql.raw(`'${FALLBACK_DICTIONARY}'`)}::regconfig`
    }
    return sql`(CASE p.locale ${sql.join(arms, sql` `)} ELSE ${sql.raw(`'${FALLBACK_DICTIONARY}'`)} END)::regconfig`
  }

  /**
   * Full-text search over the pages of a site.
   *
   * The text query is optional: with only tags or filters this is a browse rather than a search, which
   * is what a query of nothing but `#tags` amounts to. Ranking needs matched terms, so ordering by
   * relevancy without a query falls back to the most recently updated.
   *
   * `isSearchable` is honoured for everyone — a page excluded from search was excluded on purpose.
   */
  async searchPages({
    siteId,
    query = '',
    path = '',
    locales = [],
    tags = [],
    editor = '',
    publishState = '',
    orderBy = 'relevancy',
    orderByDirection = 'desc',
    offset = 0,
    limit = 25,
    publicOnly = false,
    includeDrafts = false,
    hideProtectedContent = true,
    actor
  }: SearchPagesParams): Promise<SearchPagesResult> {
    const terms = query.trim()
    const hasQuery = terms.length > 0

    // -> Only the locales in play need an arm in the dictionary CASE
    const siteLocales: string[] = WIKI.sites[siteId]?.config?.locales?.active ?? ['en']
    const searchedLocales = locales.length > 0 ? locales : siteLocales
    /*
      No terms means no query to parse, and therefore no dictionary to parse it with.

      Both arguments are withheld together on purpose. Passing the locales while claiming nothing is
      installed -- which is what an empty `available` says -- made every locale resolve to the
      fallback and warn that its dictionary was missing, on a code path that never uses the answer.
      That warning was the one in the logs: `english` is installed, nobody had looked.
    */
    const dict = hasQuery
      ? this.dictionaryExpression(searchedLocales, await this.getAvailableDictionaries())
      : this.dictionaryExpression([], [])
    const tsQuery = sql`websearch_to_tsquery(${dict}, ${terms})`

    const conditions = [sql`p."siteId" = ${siteId}`, sql`p."isSearchable" = true`]
    if (hasQuery) {
      conditions.push(sql`p.ts @@ ${tsQuery}`)
    }
    if (publicOnly) {
      // -> Matches what a page view shows an anonymous reader, so that search cannot surface a page
      //    that could not then be opened
      conditions.push(sql`p."publishState" = 'published'`)
    } else if (!includeDrafts) {
      conditions.push(sql`p."publishState" <> 'draft'`)
    }
    if (hideProtectedContent && hasQuery) {
      /*
        A protected page is findable by name, not by what it says.

        `indexPage` stores the three parts of a page under distinct weights — title `A`, description
        `B`, body `C` — so `ts_filter` can drop the body and ask whether the query still matches. A
        protected page therefore surfaces when the terms are in its title or description, both of which
        it shows to everyone anyway, and stays out when they are only in the text behind the password.
        Otherwise a search for a distinctive phrase would confirm the phrase is in there, which is the
        thing the password is for.

        Written with the cheap test first: for a page with no password the OR short-circuits and
        `ts_filter` never runs.
      */
      conditions.push(sql`(p.password IS NULL OR ts_filter(p.ts, '{a,b}') @@ ${tsQuery})`)
    }
    if (publishState) {
      conditions.push(sql`p."publishState" = ${publishState}`)
    }
    if (path) {
      conditions.push(sql`p.path LIKE ${`${escapeLikePrefix(path)}%`}`)
    }
    if (locales.length > 0) {
      // -> `sql.param`, because a bare array is expanded into a list of placeholders rather than
      //    bound as one array value
      conditions.push(sql`p.locale = ANY(${sql.param(locales)}::text[])`)
    }
    if (tags.length > 0) {
      conditions.push(sql`p.tags @> ${sql.param(tags)}::text[]`)
    }
    if (editor) {
      conditions.push(sql`p.editor = ${editor}`)
    }

    const direction = orderByDirection === 'asc' ? sql`ASC` : sql`DESC`
    // -> Every page ranks 0 without a query, which would leave the order down to the planner
    const effectiveOrderBy = orderBy === 'relevancy' && !hasQuery ? 'updatedAt' : orderBy
    const ordering = {
      relevancy: sql`relevancy ${direction}, p."updatedAt" DESC`,
      title: sql`p.title ${direction}`,
      updatedAt: sql`p."updatedAt" ${direction}`
    }[effectiveOrderBy]

    const { termHighlighting } = this.getConfig()
    const headline = sql`ts_headline(${dict}, coalesce(p."searchContent", ''), ${tsQuery},
      ${`StartSel=${HL_START},StopSel=${HL_STOP},MaxWords=25,MinWords=10,MaxFragments=1`})`
    /*
      The excerpt is cut from the page's own text, so a protected page has none to give a searcher who
      would be shown a lock screen on the page itself. `CASE` rather than a filter on the rows: the page
      still belongs in the results, it just arrives without the part the password covers.
    */
    const highlight =
      !hasQuery || !termHighlighting
        ? sql`NULL`
        : hideProtectedContent
          ? sql`CASE WHEN p.password IS NULL THEN ${headline} ELSE NULL END`
          : headline

    const rows = await WIKI.db.execute(sql`
      SELECT
        p.id,
        p.path,
        p.locale,
        p.title,
        p.description,
        p.icon,
        p.tags,
        to_char(p."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
        ${hasQuery ? sql`ts_rank(p.ts, ${tsQuery})` : sql`0`} AS relevancy,
        ${highlight} AS highlight,
        COUNT(*) OVER() AS "totalHits"
      FROM pages p
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${ordering}
      LIMIT ${limit} OFFSET ${offset}
    `)

    /*
      Filtered here rather than in SQL: a page rule can be a regular expression or a set of tags, so
      the deciding rule is only knowable per row. Search must not be a way around page permissions —
      a title and an excerpt are content too.
    */
    const visible = actor
      ? ((rows.rows ?? rows) as any[]).filter((row) =>
          WIKI.models.groups.checkAccess(actor, 'read:pages', {
            path: row.path as string,
            locale: row.locale as string,
            tags: (row.tags ?? []) as string[]
          })
        )
      : ((rows.rows ?? rows) as any[])

    const result = visible.map((row) => ({
      id: row.id as string,
      path: row.path as string,
      locale: row.locale as string,
      title: row.title as string,
      description: row.description ?? null,
      icon: row.icon ?? null,
      tags: (row.tags ?? []) as string[],
      updatedAt: row.updatedAt as string,
      relevancy: Number(row.relevancy ?? 0),
      // -> Escaped first, so the only markup that survives is the emphasis postgres marked
      highlight: row.highlight
        ? escapeHtml(row.highlight as string)
            .replaceAll(HL_START, '<b>')
            .replaceAll(HL_STOP, '</b>')
        : null
    }))

    return {
      results: result,
      /*
        The count postgres reported, less whatever the rules just removed from this page of results.
        Not exact when rows are dropped -- the window function counted every match, including ones on
        later pages this reader may not see -- but a total that ignored the filtering entirely would
        promise results that do not exist.
      */
      totalHits: Math.max(
        0,
        Number((rows.rows ?? rows)[0]?.totalHits ?? 0) -
          ((rows.rows ?? rows) as any[]).length +
          visible.length
      )
    }
  }

  /**
   * Recompute the search vector of every page.
   *
   * Grouped by locale, since the dictionary is chosen per locale. Title and description are weighted
   * above the body so that a page whose title matches outranks one that merely mentions the term.
   *
   * Runs over every page rather than only searchable ones: whether a page shows up in results is
   * decided at query time by `isSearchableComputed`, and keeping the vector current means flipping a
   * page back to searchable needs no reindex.
   */
  async rebuildIndex(): Promise<RebuildResult> {
    const available = await this.getAvailableDictionaries()
    const localeRows = await WIKI.db.execute(sql`SELECT DISTINCT locale FROM pages ORDER BY locale`)
    const locales = ((localeRows.rows ?? localeRows) as any[]).map((r) => r.locale as string)

    WIKI.logger.info(`Rebuilding the search index for ${locales.length} locale(s)...`)
    const result: RebuildResult = { pages: 0, locales: [] }

    for (const locale of locales) {
      const dictionary = this.dictionaryForLocale(locale, available)
      // -> The dictionary name is an identifier in `to_tsvector`, and it is only ever one of the
      //    names postgres itself reported, so it cannot carry anything unexpected
      const updated = await WIKI.db.execute(sql`
        UPDATE pages SET ts =
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce(title, '')), 'A') ||
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce(description, '')), 'B') ||
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce("searchContent", '')), 'C')
        WHERE locale = ${locale}
      `)
      const pages = updated.rowCount ?? 0
      result.pages += pages
      result.locales.push({ locale, dictionary, pages })
      WIKI.logger.info(
        `Reindexed ${pages} page(s) in ${locale} using the ${dictionary} dictionary.`
      )
    }

    WIKI.logger.info(`Search index rebuild completed: ${result.pages} page(s) [ OK ]`)
    return result
  }

  /**
   * Recompute one page's search vector, after it was created or edited.
   *
   * Same weighting as a full rebuild — title above description above body — so that a page saved
   * today ranks against pages last indexed by a rebuild rather than alongside them.
   *
   * Never throws: a page that saved correctly must not report failure because its index entry could
   * not be written, and the next rebuild puts it right.
   */
  async indexPage(id: string, locale: string): Promise<void> {
    try {
      const dictionary = this.dictionaryForLocale(locale, await this.getAvailableDictionaries())
      // -> The dictionary name is an identifier in `to_tsvector`, and it is only ever one of the
      //    names postgres itself reported, so it cannot carry anything unexpected
      const dict = sql.raw(`'${dictionary}'`)
      await WIKI.db.execute(sql`
        UPDATE pages SET ts =
          setweight(to_tsvector(${dict}, coalesce(title, '')), 'A') ||
          setweight(to_tsvector(${dict}, coalesce(description, '')), 'B') ||
          setweight(to_tsvector(${dict}, coalesce("searchContent", '')), 'C')
        WHERE id = ${id}
      `)
    } catch (err: any) {
      WIKI.logger.warn(`Failed to update the search index for page ${id}: ${err.message}`)
    }
  }
}

export const search = new Search()
