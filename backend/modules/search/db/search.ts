import { sql } from 'drizzle-orm'
import { escapeLikePattern } from '../../../helpers/common.ts'
import {
  search,
  SUGGEST_TITLE_CANDIDATES,
  SUGGEST_TITLE_THRESHOLD
} from '../../../models/search.ts'
import { filterVisible, HL_START, HL_STOP, normalizeMarkers } from '../shared.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult,
  SuggestTitleParams
} from '../../../models/search.ts'

/**
 * Locale to PostgreSQL text search dictionary, for the languages postgres ships a snowball stemmer
 * for. Anything not listed here falls back to `simple`, which indexes words without stemming — still
 * searchable, just without matching plurals and conjugations.
 *
 * An operator can override or extend this from the admin area, which is what `dictOverrides` is for.
 */
const DEFAULT_DICTIONARIES: Record<string, string> = {
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
const FALLBACK_DICTIONARY = 'simple'

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'db'

/**
 * Extra raw rows fetched beyond a page's own `[offset, offset + limit)` span, to absorb rows a
 * reader's page rules will end up denying before they ever reach the page — see the comment on the
 * over-fetch loop in `query()` for why this exists.
 */
const OVERFETCH_MARGIN = 25

/** How much the candidate window grows on each retry when `OVERFETCH_MARGIN` wasn't enough. */
const OVERFETCH_GROWTH_FACTOR = 4

/**
 * Hard ceiling on raw rows fetched to fill one page (OpenProject #2151, #2010). Page-rule filtering
 * cannot be expressed in the `WHERE` clause — a rule can be a regular expression or a set of tags —
 * so `query()` scans a candidate window and derives both `totalHits` and the requested page from
 * what survives `checkAccess()` rather than from postgres's own unfiltered match count (see
 * `query()`'s own comment for why that used to be an oracle). This is the ceiling on that window, so
 * a reader denied nearly everything cannot turn a single `query()` call into an unbounded scan of
 * the site.
 */
const OVERFETCH_HARD_CAP = 5000

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
   * A path change needs nothing done: `indexPage` weights title, description and body into `ts` —
   * none of which is the path — so a move within one locale leaves the vector correct without
   * recomputing it, same reasoning as `deleted`.
   *
   * A *locale* change does need it, and is why this hook is not empty: which dictionary builds the
   * vector is decided by the page's locale (`dictionaryForLocale`), so a page re-homed from `en` to
   * `fr` is left stemmed by the wrong language until it is rebuilt with the right one.
   */
  async renamed(
    _siteId: string,
    page: SearchIndexablePage,
    _previousPath: string,
    previousLocale: string
  ): Promise<void> {
    if (previousLocale === page.locale) return
    await this.indexPage(page.id, page.locale, page.siteId)
  }

  /**
   * The text search configurations this postgres actually has, e.g. `english`, `simple`.
   *
   * Used to validate what an operator maps a locale to: a name postgres does not know would make
   * every `to_tsvector` call fail at rebuild time, long after the setting was saved.
   */
  async getAvailableDictionaries(): Promise<string[]> {
    const rows = await WIKI.db.execute(sql`SELECT cfgname FROM pg_ts_config ORDER BY cfgname`)
    return rows.rows.map((r: any) => r.cfgname as string)
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
      // -> `escapeLikePattern` makes the filter literal; the trailing `%` is what turns it into a
      //    prefix match rather than an exact one.
      conditions.push(sql`p.path LIKE ${`${escapeLikePattern(path)}%`}`)
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
    // -> `p.id` breaks every tie: over-fetching a candidate window and then slicing the caller's
    //    `offset`/`limit` window out in JS (below) only lands on a stable page of results when the
    //    underlying order is fully deterministic
    const ordering = {
      relevancy: sql`relevancy ${direction}, p."updatedAt" DESC, p.id`,
      title: sql`p.title ${direction}, p.id`,
      updatedAt: sql`p."updatedAt" ${direction}, p.id`
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

    /*
      OpenProject #2151: `totalHits` used to be derived from a `COUNT(*) OVER()` window over every
      SQL-matching row, corrected only for the rows actually dropped from THIS page -- so a match on
      a later page the reader may never see still inflated the reported count. `?query=<phrase>&
      limit=1` against a corpus with at least two matches, one of them permission-denied, confirmed
      the phrase existed in a page the caller could not open: a count oracle, reachable
      unauthenticated wherever guest search is exposed.
      Fixed by dropping the SQL `COUNT(*) OVER()` entirely, filtering a scanned candidate window
      through `checkAccess()`, and deriving both `totalHits` and the requested page from that
      filtered set alone -- neither can ever count or return a row the caller was not actually
      granted `read:pages` on. `totalHits` is exact whenever the true match count is within the
      window that was scanned; beyond that it is a floor (verified-visible matches within the window
      only), never an overcount -- the asymmetry that closes the oracle, since a floor cannot confirm
      anything about a page beyond what was already checked. See the over-fetch loop below
      (OpenProject #2010) for how big that window is.
    */
    const rowsQuery = (queryLimit: number, queryOffset: number) => sql`
      SELECT
        p.id,
        p.path,
        p.locale,
        p.title,
        p.description,
        p.icon,
        p.tags,
        p.classification,
        to_char(p."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
        ${hasQuery ? sql`ts_rank(p.ts, ${tsQuery})` : sql`0`} AS relevancy,
        ${highlight} AS highlight
      FROM pages p
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${ordering}
      LIMIT ${queryLimit} OFFSET ${queryOffset}
    `

    /*
      Filtered by `shared.ts`'s `filterVisible` rather than in SQL: a page rule can be a regular
      expression or a set of tags, so the deciding rule is only knowable per row. Search must not be
      a way around page permissions — a title and an excerpt are content too. The same helper, and
      the same discipline, as all four external engines.

      This runs over every scanned row in the candidate window (see the over-fetch loop below), not
      just the caller's page of `limit` results -- `totalHits` further down is derived from
      `visibleRows.length`, so it has to see every row that survived the query before the caller's
      `offset`/`limit` window is sliced out of it.
    */
    const toRef = (row: any) => ({
      path: row.path as string,
      locale: row.locale as string,
      tags: (row.tags ?? []) as string[],
      classification: (row.classification as string | null) ?? null
    })

    /*
      A plain `LIMIT`/`OFFSET` window filtered afterward shrinks whenever a rule denies a row inside
      that window, without ever pulling in a later surviving row to fill the gap -- page 1 of 25 could
      come back with 22 rows even though row 26 was visible and could have completed it, and the
      boundary a caller's next `offset` lands on then depends on how many rows THIS reader was denied,
      not on the query itself. So when there is an actor to filter for, the candidate window is always
      re-fetched from row 0 -- the query order is deterministic, so that prefix is the same on every
      call -- sized to `offset + limit` plus a margin, and grown (up to `OVERFETCH_HARD_CAP`) until
      either enough rows survive the filter or the raw fetch comes back short of what it asked for
      (nothing left to fetch). The page itself is then a plain slice of that filtered, consistently-
      ordered array: nothing already surfaced on an earlier page can resurface on a later one, and
      nothing in between is skipped, for as long as enough visible matches exist.

      No actor means nothing is ever filtered out, so the original direct windowed query is exact and
      cheaper -- no reason to over-fetch when nothing will be dropped.
    */
    let rawRows: any[]
    let visibleRows: any[]
    if (actor) {
      const needed = offset + limit
      let candidateLimit = Math.min(needed + OVERFETCH_MARGIN, OVERFETCH_HARD_CAP)
      for (;;) {
        const fetched = await WIKI.db.execute(rowsQuery(candidateLimit, 0))
        rawRows = fetched.rows as any[]
        visibleRows = filterVisible(rawRows, actor, siteId, toRef)
        const exhausted = rawRows.length < candidateLimit
        if (visibleRows.length >= needed || exhausted || candidateLimit >= OVERFETCH_HARD_CAP) {
          break
        }
        candidateLimit = Math.min(candidateLimit * OVERFETCH_GROWTH_FACTOR, OVERFETCH_HARD_CAP)
      }
    } else {
      const fetched = await WIKI.db.execute(rowsQuery(limit, offset))
      rawRows = fetched.rows as any[]
      visibleRows = rawRows
    }

    const pageRows = actor ? visibleRows.slice(offset, offset + limit) : visibleRows

    const result = pageRows.map((row) => ({
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
      highlight: normalizeMarkers(row.highlight as string | null)
    }))

    /*
      A count of rows that survived `checkAccess`, and nothing else -- see `OVERFETCH_HARD_CAP`'s doc
      comment for why this is exact up to the scanned candidate window and a floor beyond it, never a
      total that includes a match the caller could not open.
    */
    const totalHits = visibleRows.length

    // -> Only worth asking when the search itself came up empty: a query that matched something has
    //    nothing to be corrected, and no query means there was nothing to have mistyped.
    const suggestion =
      totalHits === 0 && hasQuery
        ? await this.suggestTitle({ siteId, query: terms, publicOnly, includeDrafts, actor })
        : null

    // -> Rows were dropped from this page by the rules filter above, so the corrected `totalHits`
    //    is a floor, not an exact count -- see `SearchPagesResult.totalHitsApproximate`'s own doc.
    const totalHitsApproximate = rawRows.length !== visibleRows.length

    return { results: result, totalHits, totalHitsApproximate, suggestion }
  }

  /**
   * The closest page title to a query that found nothing, for a "did you mean" prompt.
   *
   * Trigram similarity (`pg_trgm`), not full-text search: a typo like "settngs" shares no stemmed
   * token with "settings" for `websearch_to_tsquery` to match, but the two strings are close letter
   * for letter, which is exactly what `similarity()` measures. Capped to the same
   * visibility/permission conditions `query` applies — `isSearchable`, `publishState`, and the
   * actor's `read:pages` access — so a suggestion never names a page the searcher could not then
   * open. Filters like `path`/`locales`/`tags` are deliberately not repeated here: those narrow what
   * the searcher was looking *in*, not what they may see at all, and a "did you mean" that also
   * enforced them would stay silent for a title that exists just outside the filtered scope, which
   * defeats the point of suggesting it.
   *
   * `0.3` (`SUGGEST_TITLE_THRESHOLD`) is a starting threshold, not a tuned one — there is no query
   * log yet to tune it against. If it turns out too loose or too tight in practice, that is a
   * follow-up once real usage exists, not something to guess further at here.
   */
  private async suggestTitle({
    siteId,
    query,
    publicOnly = false,
    includeDrafts = false,
    actor
  }: SuggestTitleParams): Promise<string | null> {
    const terms = query.trim()
    if (!terms) {
      return null
    }

    const conditions = [sql`p."siteId" = ${siteId}`, sql`p."isSearchable" = true`]
    if (publicOnly) {
      conditions.push(sql`p."publishState" = 'published'`)
    } else if (!includeDrafts) {
      conditions.push(sql`p."publishState" <> 'draft'`)
    }
    conditions.push(sql`similarity(p.title, ${terms}) > ${SUGGEST_TITLE_THRESHOLD}`)

    const rows = await WIKI.db.execute(sql`
      SELECT p.path, p.locale, p.title, p.tags, p.classification, similarity(p.title, ${terms}) AS score
      FROM pages p
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY score DESC
      LIMIT ${SUGGEST_TITLE_CANDIDATES}
    `)

    // -> Same reasoning as `query`: which rule covers a candidate can depend on a regular
    //    expression or its tags, neither of which the query above could express.
    const visible = filterVisible(rows.rows as any[], actor, siteId, (row) => ({
      path: row.path as string,
      locale: row.locale as string,
      tags: (row.tags ?? []) as string[],
      classification: (row.classification as string | null) ?? null
    }))

    return (visible[0]?.title as string | undefined) ?? null
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
    const locales = (localeRows.rows as any[]).map((r) => r.locale as string)

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
