import { asc, eq, sql } from 'drizzle-orm'
import {
  apiKeys as apiKeysTable,
  classificationLevels as levelsTable,
  pages as pagesTable
} from '../db/schema.ts'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { CustomError } from '../helpers/common.ts'
import type { SystemIds } from './types.ts'

export type ClassificationLevel = typeof levelsTable.$inferSelect

/**
 * Every level, ordered most-open (lowest `sortOrder`) first. Cached because a page's classification
 * is resolved against it on every page create, move and update.
 */
let levelsCache: ClassificationLevel[] = []

class ClassificationLevels extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadClassificationLevels'

  /**
   * Never call this directly from a mutator -- `broadcastReload()` is what carries the change to the
   * rest of the cluster.
   */
  async reloadCache(): Promise<void> {
    const rows = await CARDINAL.db.select().from(levelsTable).orderBy(asc(levelsTable.sortOrder))
    levelsCache = rows
    CARDINAL.logger.debug('config', 'reloaded the classification levels', {
      levels: levelsCache.length
    })
  }

  list(): ClassificationLevel[] {
    return levelsCache
  }

  byId(id: string): ClassificationLevel | null {
    return levelsCache.find((level) => level.id === id) ?? null
  }

  /** The most-open level -- what a page with no parent to inherit a floor from is classified as. */
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
   * Whether `candidateId` is at or above `floorId` in openness -- the floor invariant: a child
   * page's classification can never be more open than its immediate parent's. An id that resolves
   * to no level fails closed.
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
   * its new parent's floor is stricter than its own classification. An id that no longer resolves
   * loses to one that does: a real level is at least as strict as one deleted out from under a
   * stale reference.
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

  isLowerThan(candidateId: string, otherId: string): boolean {
    const candidate = this.byId(candidateId)
    const other = this.byId(otherId)
    if (!candidate || !other) {
      return false
    }
    return candidate.sortOrder < other.sortOrder
  }

  /**
   * Whether a page's classification is one of an API key's `allowedClassifications`. A `null`
   * allow-set means unrestricted -- every level, including one added after the key was minted -- and
   * never reaches here: callers resolve that case first. An id resolving to no level fails closed.
   */
  isAllowed(candidateId: string, allowedIds: string[]): boolean {
    if (!this.byId(candidateId)) {
      return false
    }
    return allowedIds.includes(candidateId)
  }

  /**
   * Create a level, always appended after the current highest `sortOrder`. A caller-supplied
   * `sortOrder` could only collide, so there is no way to pass one; the position comes from a fresh
   * `MAX` read rather than the cache, so a create racing a delete's renumbering still lands one past
   * what is actually in the table.
   */
  async create(input: { name: string }): Promise<ClassificationLevel> {
    const name = input.name.trim()
    if (name.length < 1) {
      throw new CustomError('classificationNameMissing', 'A classification level needs a name.')
    }
    const [row] = await CARDINAL.db
      .select({ max: sql<number>`coalesce(max(${levelsTable.sortOrder}), -1)` })
      .from(levelsTable)
    const sortOrder = (row?.max ?? -1) + 1
    const inserted = await CARDINAL.db.insert(levelsTable).values({ name, sortOrder }).returning()
    await this.broadcastReload()
    return inserted[0]
  }

  /**
   * Rename a level. Ordering is `reorder()`'s alone, so no single-level write path can be handed a
   * `sortOrder` colliding with another level's.
   */
  async update(id: string, patch: { name?: string }): Promise<ClassificationLevel | null> {
    const values: Record<string, any> = { updatedAt: sql`now()` }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (name.length < 1) {
        throw new CustomError('classificationNameMissing', 'A classification level needs a name.')
      }
      values.name = name
    }
    const updated = await CARDINAL.db
      .update(levelsTable)
      .set(values)
      .where(eq(levelsTable.id, id))
      .returning()
    await this.broadcastReload()
    return updated[0] ?? null
  }

  /**
   * Reorder every level at once: `sortOrder` becomes the position in `orderedIds`, so every
   * existing level has to be named.
   *
   * Two-phase to survive the `sortOrder` unique index -- a plain positional reassignment can collide
   * mid-transaction with a row not yet touched, whose still-current `sortOrder` equals another row's
   * target. Every row moves to a disjoint staging range below any current value first.
   */
  async reorder(orderedIds: string[]): Promise<void> {
    await CARDINAL.db.transaction(async (tx) => {
      const currentMin = Math.min(0, ...levelsCache.map((level) => level.sortOrder))
      const stagingBase = currentMin - orderedIds.length - 1
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(levelsTable)
          .set({ sortOrder: stagingBase - index, updatedAt: sql`now()` })
          .where(eq(levelsTable.id, id))
      }
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(levelsTable)
          .set({ sortOrder: index, updatedAt: sql`now()` })
          .where(eq(levelsTable.id, id))
      }
    })
    await this.broadcastReload()
  }

  /**
   * Delete a level. The last one left is refused outright -- every page always carries a
   * classification, so the list can never reach zero. The page FK is `RESTRICT`, so the database
   * would refuse a page-referenced level anyway; `allowedClassifications` is `jsonb` with no FK, so
   * the containment check below is the only thing stopping a delete from silently dropping the level
   * out of an API key's allow-set. Survivors are renumbered gapless in the same transaction, or the
   * gap a middle delete leaves is exactly where `create()`'s next append lands.
   */
  async delete(id: string): Promise<boolean> {
    if (levelsCache.length <= 1) {
      throw new CustomError(
        'classificationLastLevel',
        'At least one classification level must exist.'
      )
    }
    const inUseByPages = await CARDINAL.db
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
    const inUseByKeys = await CARDINAL.db
      .select({ id: apiKeysTable.id })
      .from(apiKeysTable)
      .where(sql`${apiKeysTable.allowedClassifications} @> ${JSON.stringify([id])}::jsonb`)
      .limit(1)
    if (inUseByKeys.length > 0) {
      throw new CustomError(
        'classificationInUse',
        'This classification level is still used in the allow-set of at least one API key.',
        409
      )
    }
    const deleted = await CARDINAL.db.transaction(async (tx) => {
      const result = await tx.delete(levelsTable).where(eq(levelsTable.id, id))
      if ((result.rowCount ?? 0) === 0) {
        return false
      }
      const survivors = await tx
        .select({ id: levelsTable.id })
        .from(levelsTable)
        .orderBy(asc(levelsTable.sortOrder))
      for (const [index, level] of survivors.entries()) {
        await tx
          .update(levelsTable)
          .set({ sortOrder: index, updatedAt: sql`now()` })
          .where(eq(levelsTable.id, level.id))
      }
      return true
    })
    await this.broadcastReload()
    return deleted
  }

  /**
   * Seed the three default levels. `onConflictDoNothing` because the migration adding
   * `pages.classification` already seeds these same rows at these same fixed ids -- it has to, to
   * backfill a NOT NULL column on a database that may already hold pages -- so on a real boot this
   * is a no-op, while a caller arriving with an empty table is still seeded.
   */
  async init(ids: SystemIds): Promise<void> {
    CARDINAL.logger.debug('config', 'seeding the default classification levels')
    await CARDINAL.db
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
