import { asc, eq, sql } from 'drizzle-orm'
import {
  apiKeys as apiKeysTable,
  classificationLevels as levelsTable,
  pages as pagesTable
} from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import type { SystemIds } from './types.ts'

/** A classification level row, as the admin area and every level picker read it. */
export interface ClassificationLevel {
  id: string
  name: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

/**
 * Every level, ordered most-open (lowest `sortOrder`) first.
 *
 * Cached the same way `groups`' page rules are (`models/groups.ts`'s `rulesCache`): a page's
 * classification is resolved against this on every page create/move/update, so reading it from the
 * database on every request would put a query in front of everything the floor invariant (#1080)
 * touches. Reloaded whenever a level is created, edited, reordered or removed.
 */
let levelsCache: ClassificationLevel[] = []

class ClassificationLevels {
  /** Reload every level into memory. Called at boot, same as `groups.reloadCache()`. */
  async reloadCache(): Promise<void> {
    const rows = await WIKI.db.select().from(levelsTable).orderBy(asc(levelsTable.sortOrder))
    levelsCache = rows as ClassificationLevel[]
    WIKI.logger.info(`Loaded ${levelsCache.length} classification level(s) [ OK ]`)
  }

  /** Every level, most-open first. What the admin list and every level picker render. */
  list(): ClassificationLevel[] {
    return levelsCache
  }

  /** A single level by id, or null. */
  byId(id: string): ClassificationLevel | null {
    return levelsCache.find((level) => level.id === id) ?? null
  }

  /**
   * The most-open level configured -- a brand new page's classification when it has no parent to
   * inherit a floor from (OpenProject #1080).
   */
  defaultLevel(): ClassificationLevel {
    const level = levelsCache[0]
    if (!level) {
      throw new CustomError(
        'classificationNoLevels',
        'No classification levels are configured.',
        500
      )
    }
    return level
  }

  /**
   * Whether `candidateId` is at or above `floorId` in openness -- the floor invariant (#1080): a
   * child page's classification can never be more open than its immediate parent's.
   *
   * Unknown ids (a level that no longer exists) fail closed: neither can be compared, so this is not
   * satisfied.
   */
  meetsFloor(candidateId: string, floorId: string): boolean {
    const candidate = this.byId(candidateId)
    const floor = this.byId(floorId)
    if (!candidate || !floor) {
      return false
    }
    return candidate.sortOrder >= floor.sortOrder
  }

  /**
   * The stricter (higher `sortOrder`) of two levels -- what a move's auto-bump raises a page to when
   * its new parent's floor is stricter than its own current classification (OpenProject #1080). An
   * id that no longer resolves loses to the one that still does, on the assumption that a real level
   * is always at least as strict as one that has been deleted out from under a stale reference.
   */
  stricterOf(aId: string, bId: string): string {
    const a = this.byId(aId)
    const b = this.byId(bId)
    if (!a) {
      return bId
    }
    if (!b) {
      return aId
    }
    return a.sortOrder >= b.sortOrder ? aId : bId
  }

  /** Whether `candidateId` is strictly more open (lower `sortOrder`) than `otherId`. */
  isLowerThan(candidateId: string, otherId: string): boolean {
    const candidate = this.byId(candidateId)
    const other = this.byId(otherId)
    if (!candidate || !other) {
      return false
    }
    return candidate.sortOrder < other.sortOrder
  }

  /**
   * Whether `candidateId` is at or below a classification ceiling `maxId` -- an API key's
   * `maxClassification` cap (OpenProject #1055): `candidate` is a page's classification, `max` the
   * key's cap, and this asks whether the page is within what the key may touch. Unknown ids fail
   * closed (neither can be compared, so this is not satisfied), the same as `meetsFloor`.
   */
  withinMax(candidateId: string, maxId: string): boolean {
    const candidate = this.byId(candidateId)
    const max = this.byId(maxId)
    if (!candidate || !max) {
      return false
    }
    return candidate.sortOrder <= max.sortOrder
  }

  async create(input: { name: string; sortOrder?: number }): Promise<ClassificationLevel> {
    const name = input.name.trim()
    if (name.length < 1) {
      throw new CustomError('classificationNameMissing', 'A classification level needs a name.')
    }
    const sortOrder = input.sortOrder ?? (levelsCache.at(-1)?.sortOrder ?? -1) + 1
    const inserted = await WIKI.db.insert(levelsTable).values({ name, sortOrder }).returning()
    await this.reloadCache()
    return inserted[0] as ClassificationLevel
  }

  async update(
    id: string,
    patch: { name?: string; sortOrder?: number }
  ): Promise<ClassificationLevel | null> {
    const values: Record<string, any> = { updatedAt: sql`now()` }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (name.length < 1) {
        throw new CustomError('classificationNameMissing', 'A classification level needs a name.')
      }
      values.name = name
    }
    if (patch.sortOrder !== undefined) {
      values.sortOrder = patch.sortOrder
    }
    const updated = await WIKI.db
      .update(levelsTable)
      .set(values)
      .where(eq(levelsTable.id, id))
      .returning()
    await this.reloadCache()
    return (updated[0] as ClassificationLevel) ?? null
  }

  /**
   * Reorder every level at once -- assigns `sortOrder` = position in `orderedIds`, the shape a
   * drag-to-reorder admin list naturally produces without a numeric field per row.
   */
  async reorder(orderedIds: string[]): Promise<void> {
    await WIKI.db.transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(levelsTable)
          .set({ sortOrder: index, updatedAt: sql`now()` })
          .where(eq(levelsTable.id, id))
      }
    })
    await this.reloadCache()
  }

  /**
   * Delete a level.
   *
   * Refused when it is the last one left -- every page always has a classification, so removing the
   * only level would leave nothing for that invariant to point at -- and refused when any page, or
   * any API key/token still capped at it (`apiKeys.maxClassification`, OpenProject #1055), still
   * references it. Both FKs are already `RESTRICT` (see `db/schema.ts`), so the database would
   * refuse this anyway; the explicit check here is what turns that into a message an admin can act on
   * instead of a raw constraint-violation error -- and, for the key case, what stops a level's
   * deletion from silently un-capping a key that pointed at it if the FK were ever loosened later.
   */
  async delete(id: string): Promise<boolean> {
    if (levelsCache.length <= 1) {
      throw new CustomError(
        'classificationLastLevel',
        'At least one classification level must exist.'
      )
    }
    const inUseByPages = await WIKI.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(eq(pagesTable.classification, id))
      .limit(1)
    if (inUseByPages.length > 0) {
      throw new CustomError(
        'classificationInUse',
        'This classification level is still used by at least one page.',
        409
      )
    }
    const inUseByKeys = await WIKI.db
      .select({ id: apiKeysTable.id })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.maxClassification, id))
      .limit(1)
    if (inUseByKeys.length > 0) {
      throw new CustomError(
        'classificationInUse',
        'This classification level is still used as the cap on at least one API key.',
        409
      )
    }
    const result = await WIKI.db.delete(levelsTable).where(eq(levelsTable.id, id))
    await this.reloadCache()
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Seed the three default levels, if they are not already there.
   *
   * `onConflictDoNothing` rather than a plain insert: the migration that adds `pages.classification`
   * (`db/migrations/.../migration.sql`) already seeds these same three rows at these same fixed ids
   * unconditionally -- it has to, so that ADDING that NOT NULL column to a database that may already
   * hold pages backfills them rather than the migration failing outright. This call therefore always
   * finds them already present on every real boot (`core/config.ts#initDbValues()` only reaches here
   * after migrations have run) and is a no-op; it stays idempotent regardless, rather than depending
   * on that ordering never changing, since a caller with no rows yet (a test building `WIKI` by hand
   * rather than through migrations) still gets seeded correctly.
   */
  async init(ids: SystemIds): Promise<void> {
    WIKI.logger.info('Inserting default classification levels...')
    await WIKI.db
      .insert(levelsTable)
      .values([
        { id: ids.classificationPublicId, name: 'Public', sortOrder: 0 },
        { id: ids.classificationInternalId, name: 'Internal', sortOrder: 1 },
        { id: ids.classificationRestrictedId, name: 'Restricted', sortOrder: 2 }
      ])
      .onConflictDoNothing({ target: levelsTable.id })
    await this.reloadCache()
  }
}

export const classificationLevels = new ClassificationLevels()
