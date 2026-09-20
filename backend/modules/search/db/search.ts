import { sql } from 'drizzle-orm'
import {
  search,
  SUGGEST_TITLE_CANDIDATES,
  SUGGEST_TITLE_THRESHOLD
} from '../../../models/search.ts'
import {
  buildSqlFilterConditions,
  filterVisible,
  HL_START,
  HL_STOP,
  normalizeMarkers
} from '../shared.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult,
  SuggestTitleParams
} from '../../../models/search.ts'

/**
 * The languages postgres ships a snowball stemmer for. Anything unlisted falls back to `simple`,
 * which indexes words without stemming — still searchable, just without matching plurals and
 * conjugations.
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

const FALLBACK_DICTIONARY = 'simple'

/** Must match the directory name of this module's `definition.yml`. */
const MODULE_KEY = 'db'

/** Extra rows fetched beyond the requested page, to absorb rows the reader's page rules deny. */
const OVERFETCH_MARGIN = 25

const OVERFETCH_GROWTH_FACTOR = 4

/**
 * Ceiling on the candidate window `query()` scans. Page-rule filtering cannot be expressed in the
 * `WHERE` clause, so without a ceiling a reader denied nearly everything could turn one `query()`
 * call into an unbounded scan of the site.
 */
const OVERFETCH_HARD_CAP = 5000

/**
 * Every page carries a `ts` tsvector, indexed with GIN. Which dictionary builds that vector depends
 * on the page's locale, which is why the mapping is configurable — the wrong stemmer for a language
 * quietly degrades results rather than failing.
 *
 * Two config reads, deliberately: `dictOverrides` is a per-site setting shared by every engine, so
 * it comes from `search.getConfig(siteId)`; `termHighlighting` is this module's own declared prop,
 * so it comes from `search.getEngineConfig(siteId, MODULE_KEY)`.
 */
class DbSearchModule implements SearchModule {
  /** Nothing to connect: queries go straight through `CARDINAL.db`, already open at boot. */
  async init(_siteId: string, _config: Record<string, any>): Promise<void> {}

  async created(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page.id, page.locale, page.siteId)
  }

  async updated(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page.id, page.locale, page.siteId)
  }

  /**
   * Nothing to do: the `ts` tsvector is a column on the page's own row, so deleting the row takes
   * the index entry with it. The hook exists because a remote index genuinely needs telling.
   */
  async deleted(_siteId: string, _pageId: string): Promise<void> {}

  /**
   * A path change needs nothing: `ts` weights title, description and body, none of which is the
   * path. A *locale* change does, and is why this hook is not empty — the dictionary is chosen by
   * locale, so a page re-homed from `en` to `fr` stays stemmed by the wrong language until rebuilt.
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
   * Validates what an operator maps a locale to: a name postgres does not know would fail every
   * `to_tsvector` call at rebuild time, long after the setting was saved.
   */
  async getAvailableDictionaries(): Promise<string[]> {
    const rows = await CARDINAL.db.execute(sql`SELECT cfgname FROM pg_ts_config ORDER BY cfgname`)
    return rows.rows.map((r: any) => r.cfgname as string)
  }

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
      CARDINAL.logger.warn('search', 'text search dictionary is not installed, falling back', {
        engine: MODULE_KEY,
        locale,
        dictionary: wanted,
        fallback: FALLBACK_DICTIONARY
      })
    }
    return FALLBACK_DICTIONARY
  }

  /**
   * A page's vector was built with its own locale's dictionary, so the query has to be parsed with
   * the same one — an English query stemmed as French matches nothing. Postgres accepts a
   * `regconfig` expression, so the mapping travels with the row rather than being fixed per query.
   */
  private dictionaryExpression(locales: string[], available: string[], siteId: string) {
    const arms = locales.map((locale) => {
      const dictionary = this.dictionaryForLocale(locale, available, siteId)
      // -> `sql.raw` is safe here: the dictionary name is one postgres itself reported, and the
      //    locale is bound as a parameter
      return sql`WHEN ${locale} THEN ${sql.raw(`'${dictionary}'`)}`
    })
    if (arms.length < 1) {
      return sql`${sql.raw(`'${FALLBACK_DICTIONARY}'`)}::regconfig`
    }
    return sql`(CASE p.locale ${sql.join(arms, sql` `)} ELSE ${sql.raw(`'${FALLBACK_DICTIONARY}'`)} END)::regconfig`
  }

  /**
   * The text query is optional: with only tags or filters this is a browse rather than a search.
   * `isSearchable` is honoured for everyone — a page excluded from search was excluded on purpose.
   */
  async query({
    siteId,
    query = '',
    locales = [],
    orderBy = 'relevancy',
    orderByDirection = 'desc',
    offset = 0,
    limit = 25,
    publicOnly = false,
    includeDrafts = false,
    hideProtectedContent = true,
    actor,
    ...filters
  }: SearchPagesParams): Promise<SearchPagesResult> {
    const terms = query.trim()
    const hasQuery = terms.length > 0

    // -> Only the locales in play need an arm in the dictionary CASE
    const siteLocales: string[] = CARDINAL.sites[siteId]?.config?.locales?.active ?? ['en']
    const searchedLocales = locales.length > 0 ? locales : siteLocales
    /*
      No terms means no query to parse, and therefore no dictionary to parse it with. Both arguments
      are withheld together on purpose: passing the locales while claiming nothing is installed --
      which is what an empty `available` says -- makes every locale resolve to the fallback and warn
      that its dictionary is missing, on a code path that never uses the answer.
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
      // -> Search must not surface a page an anonymous reader could not then open
      conditions.push(sql`p."publishState" = 'published'`)
    } else if (!includeDrafts) {
      conditions.push(sql`p."publishState" <> 'draft'`)
    }
    if (hideProtectedContent && hasQuery) {
      /*
        A protected page is findable by name, not by what it says: `indexPage` weights title as `A`,
        description as `B` and body as `C`, so `ts_filter` can drop the body and ask whether the
        query still matches. Otherwise a search for a distinctive phrase would confirm the phrase is
        in there, which is the thing the password is for.

        Cheap test first: with no password the OR short-circuits and `ts_filter` never runs.
      */
      conditions.push(sql`(p.password IS NULL OR ts_filter(p.ts, '{a,b}') @@ ${tsQuery})`)
    }
    conditions.push(...buildSqlFilterConditions({ ...filters, locales }))

    const direction = orderByDirection === 'asc' ? sql`ASC` : sql`DESC`
    // -> Every page ranks 0 without a query, which would leave the order down to the planner
    const effectiveOrderBy = orderBy === 'relevancy' && !hasQuery ? 'updatedAt' : orderBy
    // -> `p.id` breaks every tie: slicing the caller's window out of an over-fetched candidate list
    //    below only lands on a stable page when the underlying order is fully deterministic
    const ordering = {
      relevancy: sql`relevancy ${direction}, p."updatedAt" DESC, p.id`,
      title: sql`p.title ${direction}, p.id`,
      updatedAt: sql`p."updatedAt" ${direction}, p.id`
    }[effectiveOrderBy]

    const { termHighlighting } = search.getEngineConfig(siteId, MODULE_KEY)
    const headline = sql`ts_headline(${dict}, coalesce(p."searchContent", ''), ${tsQuery},
      ${`StartSel=${HL_START},StopSel=${HL_STOP},MaxWords=25,MinWords=10,MaxFragments=1`})`
    /*
      A protected page has no excerpt to give a searcher who would be shown a lock screen on the page
      itself. `CASE` rather than a filter on the rows: the page still belongs in the results, it just
      arrives without the part the password covers.
    */
    const highlight =
      !hasQuery || !termHighlighting
        ? sql`NULL`
        : hideProtectedContent
          ? sql`CASE WHEN p.password IS NULL THEN ${headline} ELSE NULL END`
          : headline

    /*
      Deliberately no `COUNT(*) OVER()`: an unfiltered match count is a count oracle, confirming to
      an unauthenticated searcher that a phrase exists in a page they cannot open. `totalHits` is
      derived from access-filtered rows instead -- exact whenever the true count is within the
      scanned window, a floor beyond it, never an overcount. A floor cannot confirm anything about a
      page that was not already checked, which is the asymmetry that closes the oracle.
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
      Filtered in JS rather than in SQL: a page rule can be a regular expression or a set of tags, so
      the deciding rule is only knowable per row. Search must not be a way around page permissions --
      a title and an excerpt are content too. It runs over the whole candidate window, not just the
      caller's page, because `totalHits` is derived from what survives it.
    */
    const toRef = (row: any) => ({
      path: row.path as string,
      locale: row.locale as string,
      tags: (row.tags ?? []) as string[],
      classification: (row.classification as string | null) ?? null
    })

    /*
      A plain `LIMIT`/`OFFSET` window filtered afterward shrinks whenever a rule denies a row inside
      it, and never pulls in a later surviving row to fill the gap -- page 1 of 25 could come back
      with 22 rows while row 26 was visible, and the boundary the next `offset` lands on would depend
      on how many rows THIS reader was denied rather than on the query. So with an actor the window
      is always re-fetched from row 0 (the order is deterministic, so that prefix is stable), sized
      to `offset + limit` plus a margin, and grown until enough rows survive, the raw fetch comes
      back short, or `OVERFETCH_HARD_CAP` is reached. Slicing that filtered array is then stable: no
      row resurfaces on a later page and none in between is skipped.

      With no actor nothing is ever dropped, so the direct windowed query is exact and cheaper.
    */
    let rawRows: any[]
    let visibleRows: any[]
    if (actor) {
      const needed = offset + limit
      let candidateLimit = Math.min(needed + OVERFETCH_MARGIN, OVERFETCH_HARD_CAP)
      for (;;) {
        const fetched = await CARDINAL.db.execute(rowsQuery(candidateLimit, 0))
        rawRows = fetched.rows as any[]
        visibleRows = filterVisible(rawRows, actor, siteId, toRef)
        const exhausted = rawRows.length < candidateLimit
        if (visibleRows.length >= needed || exhausted || candidateLimit >= OVERFETCH_HARD_CAP) {
          break
        }
        candidateLimit = Math.min(candidateLimit * OVERFETCH_GROWTH_FACTOR, OVERFETCH_HARD_CAP)
      }
    } else {
      const fetched = await CARDINAL.db.execute(rowsQuery(limit, offset))
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
      highlight: normalizeMarkers(row.highlight as string | null)
    }))

    const totalHits = visibleRows.length

    const suggestion =
      totalHits === 0 && hasQuery
        ? await this.suggestTitle({ siteId, query: terms, publicOnly, includeDrafts, actor })
        : null

    // -> Anything dropped by the rules filter makes `totalHits` a floor rather than an exact count
    const totalHitsApproximate = rawRows.length !== visibleRows.length

    return { results: result, totalHits, totalHitsApproximate, suggestion }
  }

  /**
   * Trigram similarity (`pg_trgm`), not full-text search: a typo like "settngs" shares no stemmed
   * token with "settings" for `websearch_to_tsquery` to match, but the two strings are close letter
   * for letter. Held to the same visibility and permission conditions `query` applies, so a
   * suggestion never names a page the searcher could not then open. `path`/`locales`/`tags` are
   * deliberately not repeated: they narrow what the searcher was looking *in*, not what they may
   * see, and enforcing them would stay silent for exactly the title worth suggesting.
   *
   * `SUGGEST_TITLE_THRESHOLD` is a starting value, not one tuned against real queries.
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

    const rows = await CARDINAL.db.execute(sql`
      SELECT p.path, p.locale, p.title, p.tags, p.classification, similarity(p.title, ${terms}) AS score
      FROM pages p
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY score DESC
      LIMIT ${SUGGEST_TITLE_CANDIDATES}
    `)

    const visible = filterVisible(rows.rows as any[], actor, siteId, (row) => ({
      path: row.path as string,
      locale: row.locale as string,
      tags: (row.tags ?? []) as string[],
      classification: (row.classification as string | null) ?? null
    }))

    return (visible[0]?.title as string | undefined) ?? null
  }

  /**
   * Grouped by locale because the dictionary is chosen per locale. Runs over every page rather than
   * only searchable ones: whether a page shows up is decided at query time by `isSearchable`, so
   * keeping every vector current means flipping a page back to searchable needs no reindex.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const available = await this.getAvailableDictionaries()
    const localeRows = await CARDINAL.db.execute(
      sql`SELECT DISTINCT locale FROM pages WHERE "siteId" = ${siteId} ORDER BY locale`
    )
    const locales = (localeRows.rows as any[]).map((r) => r.locale as string)

    CARDINAL.logger.debug('search', 'rebuilding the index', {
      engine: MODULE_KEY,
      site: siteId,
      locales: locales.length
    })
    const result: RebuildResult = { pages: 0, locales: [] }

    for (const locale of locales) {
      const dictionary = this.dictionaryForLocale(locale, available, siteId)
      // -> `sql.raw` is safe here: the dictionary name is only ever one postgres itself reported
      const updated = await CARDINAL.db.execute(sql`
        UPDATE pages SET ts =
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce(title, '')), 'A') ||
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce(description, '')), 'B') ||
          setweight(to_tsvector(${sql.raw(`'${dictionary}'`)}, coalesce("searchContent", '')), 'C')
        WHERE locale = ${locale} AND "siteId" = ${siteId}
      `)
      const pages = updated.rowCount ?? 0
      result.pages += pages
      result.locales.push({ locale, dictionary, pages })
      CARDINAL.logger.debug('search', 'locale reindexed', {
        engine: MODULE_KEY,
        locale,
        dictionary,
        pages
      })
    }

    CARDINAL.logger.info('search', 'index rebuild completed', {
      engine: MODULE_KEY,
      site: siteId,
      pages: result.pages,
      locales: result.locales.length
    })
    return result
  }

  /**
   * The weighting must stay identical to `rebuild()`'s, or a page saved today ranks against pages
   * last indexed by a rebuild rather than alongside them.
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
      // -> `sql.raw` is safe here: the dictionary name is only ever one postgres itself reported
      const dict = sql.raw(`'${dictionary}'`)
      await CARDINAL.db.execute(sql`
        UPDATE pages SET ts =
          setweight(to_tsvector(${dict}, coalesce(title, '')), 'A') ||
          setweight(to_tsvector(${dict}, coalesce(description, '')), 'B') ||
          setweight(to_tsvector(${dict}, coalesce("searchContent", '')), 'C')
        WHERE id = ${id}
      `)
    } catch (err: any) {
      CARDINAL.logger.warn('search', 'indexing a page failed', {
        engine: MODULE_KEY,
        page: id,
        error: err
      })
    }
  }
}

export default new DbSearchModule()
