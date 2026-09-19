import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { pages as pagesTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { paginate } from '../helpers/pagination.ts'
import type { WikiDbOrTx } from '../core/db.ts'

/**
 * A page's classification level and the one rule that governs it: a page may never be more open than
 * its immediate parent page (the floor invariant).
 */
class PageClassification {
  /**
   * The batched form of `parentClassification`: one query over the distinct parent paths.
   *
   * @returns A Map keyed by `${locale}\0${path}` — the ORIGINAL pair passed in, not the derived
   *          parent path, so a caller looks up its own targets without re-deriving anything. Every
   *          input pair gets an entry; `null` means no floor, as in `parentClassification`.
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
    const rows = await CARDINAL.db
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
   * Immediate parent only, not the whole ancestor chain: a real parent already satisfies the floor
   * against ITS OWN parent by induction.
   */
  async parentClassification(
    siteId: string,
    locale: string,
    path: string,
    db: WikiDbOrTx = CARDINAL.db
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
    return floorId ?? CARDINAL.models.classificationLevels.defaultLevel().id
  }

  /**
   * @param floorId The parent page's classification, or null when there is no parent to inherit a
   *   floor from (root-level, or an empty folder) — in which case any existing level is allowed
   * @throws CustomError `classificationInvalid` or `classificationBelowFloor`, both 400
   */
  assertClassificationMeetsFloor(requested: string, floorId: string | null): void {
    if (!CARDINAL.models.classificationLevels.byId(requested)) {
      throw new CustomError(
        'classificationInvalid',
        'This classification level does not exist.',
        400
      )
    }
    if (floorId && !CARDINAL.models.classificationLevels.meetsFloor(requested, floorId)) {
      throw new CustomError(
        'classificationBelowFloor',
        "A page's classification cannot be more open than its parent page's.",
        400
      )
    }
  }

  /**
   * Every published page under `parentPath` (any depth) whose classification sits below `floorId` --
   * what a parent-classification raise surfaces for an admin to resolve explicitly rather than
   * cascading silently.
   */
  async descendantsBelowFloor(
    siteId: string,
    locale: string,
    parentPath: string,
    floorId: string
  ): Promise<{ id: string; path: string; title: string; classification: string }[]> {
    const prefix = `${parentPath}/`
    const rows = await CARDINAL.db
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
      (row) => !CARDINAL.models.classificationLevels.meetsFloor(row.classification, floorId)
    )
  }

  /**
   * Bump a set of pages (by id, all on this site) to a classification. No floor or permission checks
   * here: the API route decides who may call this and validates the target level.
   *
   * The search re-index is not optional -- an external engine decides `read:pages` visibility per-hit
   * off the indexed copy, so skipping it leaves raised pages searchable at their prior, more open
   * level. The glossary caches `pageClassification` per term, so it has to be dropped too.
   */
  async bulkSetClassification(
    siteId: string,
    ids: string[],
    classification: string
  ): Promise<number> {
    if (ids.length < 1) {
      return 0
    }
    const rows = await CARDINAL.db
      .update(pagesTable)
      .set({ classification, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, ids)))
      .returning()
    for (const row of rows) {
      await CARDINAL.models.search.updated(row)
    }
    if (rows.length > 0) {
      CARDINAL.models.glossary.invalidateCache(siteId)
    }
    return rows.length
  }

  /**
   * Every level is included even at zero, in level order (most-open first) -- a level nothing is
   * classified as is itself worth an admin seeing, not a row silently missing from the report.
   */
  async classificationReport(
    siteId?: string
  ): Promise<{ levelId: string; name: string; sortOrder: number; count: number }[]> {
    const rows = await CARDINAL.db
      .select({ classification: pagesTable.classification, count: sql<number>`count(*)::int` })
      .from(pagesTable)
      .where(siteId ? eq(pagesTable.siteId, siteId) : undefined)
      .groupBy(pagesTable.classification)
    const counts = new Map(rows.map((row) => [row.classification, row.count]))
    return CARDINAL.models.classificationLevels.list().map((level) => ({
      levelId: level.id,
      name: level.name,
      sortOrder: level.sortOrder,
      count: counts.get(level.id) ?? 0
    }))
  }

  /** The drill-down `classificationReport()`'s counts point into. Metadata only, never content. */
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
        CARDINAL.db
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
      total: () => CARDINAL.db.select({ total: count() }).from(pagesTable).where(where)
    })
    return { total, entries: rows }
  }
}

export const pageClassification = new PageClassification()
