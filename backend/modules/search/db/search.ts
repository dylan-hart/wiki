import { sql } from 'drizzle-orm'
import { search } from '../../../models/search.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult
} from '../../../models/search.ts'

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

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'db'

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
 * The `db` search module: postgres full-text search against the wiki's own database.
 *
 * The engine every site starts with, and the only one guaranteed to work: every page carries a `ts`
 * tsvector, indexed with GIN. Which dictionary builds that vector depends on the page's locale, which
 * is why the mapping is configurable — using the wrong stemmer for a language quietly degrades results
 * rather than failing.
 *
 * `dictOverrides` is read through `models/search.ts`'s `getConfig(siteId)` rather than duplicated
 * here: it is a per-site setting the admin area edits through the same `/sites/:siteId/search`
 * endpoint regardless of which engine that site has active, so the dispatcher stays the one place that
 * reads `WIKI.sites[siteId].config.search.config`. `termHighlighting` is different: it is this
 * module's own declared prop (`definition.yml`), edited through the generic per-engine config form and
 * saved to `WIKI.sites[siteId].config.search.engines.db`, so it's read back the same way, through
 * `search.getEngineConfig(siteId, MODULE_KEY)`.
 */
class DbSearchModule implements SearchModule {
  /** Nothing to connect: this module runs queries straight through `WIKI.db`, already open at boot. */
  async init(_siteId: string, _config: Record<string, any>): Promise<void> {}

  async created(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page.id, page.locale, page.siteId)
  }

  async updated(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page.id, page.locale, page.siteId)
  }

  /**
   * Nothing to do: a page's `ts` tsvector is a column on its own row, so deleting the row already
   * takes the index entry with it. This hook exists so the dispatcher has something to call on every
   * engine — a remote index (Elasticsearch, ...) genuinely needs telling.
   */
  async deleted(_siteId: string, _pageId: string): Promise<void> {}

  /**
   * Nothing to do: `indexPage` weights title, description and body into `ts` — none of which is the
   * path — so a move leaves the vector correct without recomputing it. Same reasoning as `deleted`.
   */
  async renamed(
    _siteId: string,
    _page: SearchIndexablePage,
    _previousPath: string
  ): Promise<void> {}

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
  dictionaryForLocale(locale: string, available: string[], siteId: string): string {
    const { dictOverrides } = search.getConfig(siteId)
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
  private dictionaryExpression(locales: string[], available: string[], siteId: string) {
    const arms = locales.map((locale) => {
      const dictionary = this.dictionaryForLocale(locale, available, siteId)
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
  async query({
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
      ? this.dictionaryExpression(searchedLocales, await this.getAvailableDictionaries(), siteId)
      : this.dictionaryExpression([], [], siteId)
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

    const { termHighlighting } = search.getEngineConfig(siteId, MODULE_KEY)
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
   * Recompute the search vector of every page of a site.
   *
   * Grouped by locale, since the dictionary is chosen per locale. Title and description are weighted
   * above the body so that a page whose title matches outranks one that merely mentions the term.
   *
   * Runs over every page of the site rather than only searchable ones: whether a page shows up in
   * results is decided at query time by `isSearchable`, and keeping the vector current means flipping
   * a page back to searchable needs no reindex.
   *
   * Scoped to `siteId` because `SearchModule.rebuild` is: an operator with several sites rebuilds one
   * at a time, the same way `query` already does.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const available = await this.getAvailableDictionaries()
    const localeRows = await WIKI.db.execute(
      sql`SELECT DISTINCT locale FROM pages WHERE "siteId" = ${siteId} ORDER BY locale`
    )
    const locales = ((localeRows.rows ?? localeRows) as any[]).map((r) => r.locale as string)

    WIKI.logger.info(`Rebuilding the search index for ${locales.length} locale(s)...`)
    const result: RebuildResult = { pages: 0, locales: [] }

    for (const locale of locales) {
      const dictionary = this.dictionaryForLocale(locale, available, siteId)
      // -> The dictionary name is an identifier in `to_tsvector`, and it is only ever one of the
      //    names postgres itself reported, so it cannot carry anything unexpected
      const updated = await WIKI.db.execute(sql`
        UPDATE pages SET ts =
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce(title, '')), 'A') ||
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce(description, '')), 'B') ||
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce("searchContent", '')), 'C')
        WHERE locale = ${locale} AND "siteId" = ${siteId}
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
  private async indexPage(id: string, locale: string, siteId: string): Promise<void> {
    try {
      const dictionary = this.dictionaryForLocale(
        locale,
        await this.getAvailableDictionaries(),
        siteId
      )
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

export default new DbSearchModule()
