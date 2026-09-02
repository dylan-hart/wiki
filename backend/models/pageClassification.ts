import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { pages as pagesTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { paginate } from '../helpers/pagination.ts'
import type { WikiDbOrTx } from '../core/db.ts'

/**
 * Page classification model
 *
 * A page's classification level and the one rule that governs it: a page may never be more open than
 * its immediate parent page (the floor invariant, OpenProject #1079/#1080). Everything here reads or
 * writes `pages.classification` and consults `models/classificationLevels.ts`; none of it touches the
 * rest of a page.
 *
 * Split out of `models/pages.ts` (MOD-F18) for exactly that reason — it is a coherent subject with
 * one seam back into page writes (`parentClassification`, which `createPage`, `updatePage` and
 * `moveOnePageInTx` each ask before letting a level through) rather than a layer of it.
 */
class PageClassification {
  /**
   * The immediate-parent classification floor for a set of `(locale, path)` pairs, in one query over
   * their distinct parent paths — the batched form of `parentClassification`, for a caller checking
   * the floor invariant against many targets at once (the classification-conflicts resolve route,
   * OpenProject #1897/#1902).
   *
   * @returns A Map keyed by `${locale}\0${path}` (the ORIGINAL pair passed in, not the derived parent
   *          path) so a caller looks up each of its own targets directly without re-deriving the
   *          parent path itself. Every input pair gets an entry — `null` when `path` is root-level or
   *          its parent has no page (an empty folder), the same "null means no floor" contract
   *          `parentClassification` itself has.
   */
  async parentClassifications(
    siteId: string,
    entries: { locale: string; path: string }[]
  ): Promise<Map<string, string | null>> {
    const keyOf = (locale: string, path: string) => `${locale}\0${path}`
    const result = new Map<string, string | null>()
    const parentOf = new Map<string, { locale: string; parentPath: string }>()
    for (const { locale, path } of entries) {
      result.set(keyOf(locale, path), null)
      const parentPath = path.split('/').slice(0, -1).join('/')
      if (parentPath) {
        parentOf.set(keyOf(locale, path), { locale, parentPath })
      }
    }
    if (parentOf.size < 1) {
      return result
    }
    const distinctParents = new Map<string, { locale: string; parentPath: string }>()
    for (const parent of parentOf.values()) {
      distinctParents.set(keyOf(parent.locale, parent.parentPath), parent)
    }
    const rows = await WIKI.db
      .select({
        locale: pagesTable.locale,
        path: pagesTable.path,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          or(
            ...[...distinctParents.values()].map(({ locale, parentPath }) =>
              and(eq(pagesTable.locale, locale), eq(pagesTable.path, parentPath))
            )
          )
        )
      )
    const floorByParent = new Map(
      rows.map((row) => [keyOf(row.locale, row.path), row.classification])
    )
    for (const [entryKey, parent] of parentOf) {
      result.set(entryKey, floorByParent.get(keyOf(parent.locale, parent.parentPath)) ?? null)
    }
    return result
  }

  /**
   * The immediate parent PAGE's classification, or null when there is none -- either because `path`
   * is at the root, or because nothing is actually published at the parent path (an empty folder).
   *
   * "Immediate parent only" is the floor invariant's own scope (OpenProject #1080): a page is checked
   * against its immediate parent's classification, not the whole ancestor chain, since a real parent
   * already satisfies the floor against ITS OWN parent by induction.
   *
   * Public rather than private: `api/pages.ts`'s classification-conflicts resolve route needs it to
   * enforce the same floor invariant against an admin-chosen target level (see that route's own
   * comment on why `bulkSetClassification` alone was not enough).
   */
  async parentClassification(
    siteId: string,
    locale: string,
    path: string,
    db: WikiDbOrTx = WIKI.db
  ): Promise<string | null> {
    const parentPath = path.split('/').slice(0, -1).join('/')
    if (!parentPath) {
      return null
    }
    const rows = await db
      .select({ classification: pagesTable.classification })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          eq(pagesTable.locale, locale),
          eq(pagesTable.path, parentPath)
        )
      )
      .limit(1)
    return rows[0]?.classification ?? null
  }

  /**
   * The classification a new page should be created with, and the floor-invariant check on an
   * explicitly requested one (OpenProject #1079/#1080).
   *
   * No parent page to inherit a floor from (root-level, or an empty folder) means no constraint: an
   * explicit request is honored as given, and the default is the most-open configured level.
   */
  async resolveCreateClassification(
    siteId: string,
    locale: string,
    path: string,
    requested: string | undefined
  ): Promise<string> {
    const floorId = await this.parentClassification(siteId, locale, path)
    if (requested) {
      this.assertClassificationMeetsFloor(requested, floorId)
      return requested
    }
    return floorId ?? WIKI.models.classificationLevels.defaultLevel().id
  }

  /**
   * The two refusals a requested classification can meet: a level that does not exist, and one that
   * would sit below the floor its parent page sets (OpenProject #1079/#1080). The only two places
   * either error is thrown — a page being created with an explicit level, and a page being edited to
   * one — asked exactly the same pair of questions.
   *
   * @param floorId The parent page's classification, or null when there is no parent to inherit a
   *   floor from (root-level, or an empty folder) — in which case any existing level is allowed
   * @throws CustomError `classificationInvalid` or `classificationBelowFloor`, both 400
   */
  assertClassificationMeetsFloor(requested: string, floorId: string | null): void {
    if (!WIKI.models.classificationLevels.byId(requested)) {
      throw new CustomError(
        'classificationInvalid',
        'This classification level does not exist.',
        400
      )
    }
    if (floorId && !WIKI.models.classificationLevels.meetsFloor(requested, floorId)) {
      throw new CustomError(
        'classificationBelowFloor',
        "A page's classification cannot be more open than its parent page's.",
        400
      )
    }
  }

  /**
   * Every published page under `parentPath` (any depth) whose classification sits below `floorId` --
   * what a retroactive parent-classification raise surfaces for an admin to resolve explicitly rather
   * than cascading silently (OpenProject #1080's "classification resolution dialog").
   */
  async descendantsBelowFloor(
    siteId: string,
    locale: string,
    parentPath: string,
    floorId: string
  ): Promise<{ id: string; path: string; title: string; classification: string }[]> {
    const prefix = `${parentPath}/`
    const rows = await WIKI.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        title: pagesTable.title,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          eq(pagesTable.locale, locale),
          sql`${pagesTable.path} LIKE ${prefix + '%'}`
        )
      )
    return rows.filter(
      (row) => !WIKI.models.classificationLevels.meetsFloor(row.classification, floorId)
    )
  }

  /**
   * Bump a set of pages (by id, all on this site) to a classification, in one transaction -- what
   * resolving a classification-resolution-dialog conflict actually does to the descendants an admin
   * chose to bring up to the new floor. No floor/permission checks here: the API route is the one
   * place that decides who may call this and validates the target level, the same layering
   * `updatePage`'s own caller (`api/pages.ts`) already follows for the declassification guardrail.
   *
   * `.returning()` gets the raw rows for free off the same write -- exactly what
   * `WIKI.models.search.updated` wants (`SearchIndexablePage`, `updatePage`'s own comment above
   * explains why), and without it every external search module keeps indexing the old
   * classification, so a raise leaves those pages searchable at their prior, more open level (an
   * external module decides `read:pages` visibility per-hit off the indexed copy -- see
   * `modules/search/algolia/search.ts`). And since `pageClassification` is part of what
   * `glossary.ts#getRawCachedTerms` caches per term, a batch that changes it needs the cache dropped
   * too -- one call after the loop covers the whole batch, same as `deleteOrphaned`'s glossary
   * invalidation.
   */
  async bulkSetClassification(
    siteId: string,
    ids: string[],
    classification: string
  ): Promise<number> {
    if (ids.length < 1) {
      return 0
    }
    const rows = await WIKI.db
      .update(pagesTable)
      .set({ classification, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, ids)))
      .returning()
    for (const row of rows) {
      await WIKI.models.search.updated(row)
    }
    if (rows.length > 0) {
      WIKI.models.glossary.invalidateCache(siteId)
    }
    return rows.length
  }

  /**
   * How many pages currently carry each classification level, instance-wide or narrowed to one site
   * (OpenProject #1081) -- the coverage half of the epic's auditability goal: what does the wiki
   * actually consider sensitive, at a glance, before drilling into any one level's pages.
   *
   * Every level is included even at zero, in level order (most-open first) -- a level nothing is
   * classified as is itself worth an admin seeing, not a row silently missing from the report.
   */
  async classificationReport(
    siteId?: string
  ): Promise<{ levelId: string; name: string; sortOrder: number; count: number }[]> {
    const rows = await WIKI.db
      .select({ classification: pagesTable.classification, count: sql<number>`count(*)::int` })
      .from(pagesTable)
      .where(siteId ? eq(pagesTable.siteId, siteId) : undefined)
      .groupBy(pagesTable.classification)
    const counts = new Map(rows.map((row) => [row.classification, row.count]))
    return WIKI.models.classificationLevels.list().map((level) => ({
      levelId: level.id,
      name: level.name,
      sortOrder: level.sortOrder,
      count: counts.get(level.id) ?? 0
    }))
  }

  /**
   * Every page currently at one classification level, instance-wide or narrowed to one site
   * (OpenProject #1081) -- the drill-down `classificationReport()`'s counts point into. Paginated,
   * newest-updated first; metadata only, matching `listAllForSite()`'s own reasoning for staying out
   * of content.
   */
  async listByClassification(
    levelId: string,
    { siteId, limit = 50, offset = 0 }: { siteId?: string; limit?: number; offset?: number } = {}
  ): Promise<{
    total: number
    entries: { id: string; path: string; locale: string; title: string; siteId: string }[]
  }> {
    const conditions = [
      eq(pagesTable.classification, levelId),
      ...(siteId ? [eq(pagesTable.siteId, siteId)] : [])
    ]
    const where = and(...conditions)
    const { total, rows } = await paginate({
      rows: () =>
        WIKI.db
          .select({
            id: pagesTable.id,
            path: pagesTable.path,
            locale: pagesTable.locale,
            title: pagesTable.title,
            siteId: pagesTable.siteId
          })
          .from(pagesTable)
          .where(where)
          .orderBy(desc(pagesTable.updatedAt))
          .limit(limit)
          .offset(offset),
      total: () => WIKI.db.select({ total: count() }).from(pagesTable).where(where)
    })
    return { total, entries: rows }
  }
}

export const pageClassification = new PageClassification()
