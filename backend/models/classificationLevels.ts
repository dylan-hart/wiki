import { asc, eq, sql } from 'drizzle-orm'
import {
  apiKeys as apiKeysTable,
  classificationLevels as levelsTable,
  pages as pagesTable
} from '../db/schema.ts'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { CustomError } from '../helpers/common.ts'
import type { SystemIds } from './types.ts'

/** A classification level row, as the admin area and every level picker read it. */
export type ClassificationLevel = typeof levelsTable.$inferSelect

/**
 * Every level, ordered most-open (lowest `sortOrder`) first.
 *
 * Cached the same way `groups`' page rules are (`models/groups.ts`'s `rulesCache`): a page's
 * classification is resolved against this on every page create/move/update, so reading it from the
 * database on every request would put a query in front of everything the floor invariant (#1080)
 * touches. Reloaded whenever a level is created, edited, reordered or removed -- and, unlike
 * `rulesCache`, that reload is broadcast to every other instance in the cluster via
 * `broadcastReload()`/`subscribeToEvents()`, the same HA propagation `groups.ts` uses, so a reorder
 * on one instance doesn't leave another comparing `sortOrder` values against a stale hierarchy.
 */
let levelsCache: ClassificationLevel[] = []

class ClassificationLevels extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadClassificationLevels'

  /**
   * Reload every level into memory. Called at boot, and by both halves of the cross-instance
   * propagation `ClusterReloaded` owns -- `broadcastReload()` (this instance's own change) and
   * `subscribeToEvents()`'s handler (another instance's). Never call this directly from a mutator; go
   * through `broadcastReload()` instead, or the change never reaches the rest of the cluster.
   */
  async reloadCache(): Promise<void> {
    const rows = await WIKI.db.select().from(levelsTable).orderBy(asc(levelsTable.sortOrder))
    levelsCache = rows
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
   * Whether `candidateId` is one of `allowedIds` -- an API key's `allowedClassifications` per-level
   * allow-set (OpenProject #1205, replacing the earlier #1055 single-value "ceiling"): `candidate` is
   * a page's classification, `allowedIds` the key's own checkbox-grid selection. `null` means
   * unrestricted (every level, including one added after the key was minted) and is never passed
   * here directly -- `groups.checkAccess()` only calls this once it has already confirmed
   * `allowedIds` is non-null. An unknown `candidateId` fails closed (nothing to compare against), the
   * same as `meetsFloor`.
   */
  isAllowed(candidateId: string, allowedIds: string[]): boolean {
    if (!this.byId(candidateId)) {
      return false
    }
    return allowedIds.includes(candidateId)
  }

  /**
   * Create a level, always appended after the current highest `sortOrder`.
   *
   * `sortOrder` is never taken from the caller (OpenProject #1651) -- a caller-supplied value could
   * collide with a survivor left behind by an uncompacted `delete()`, or with another level entirely.
   * The insert position is computed from a fresh `MAX(sortOrder)` read rather than the in-memory
   * cache, so a create racing a delete's renumbering still lands one past whatever is actually in the
   * database.
   */
  async create(input: { name: string }): Promise<ClassificationLevel> {
    const name = input.name.trim()
    if (name.length < 1) {
      throw new CustomError('classificationNameMissing', 'A classification level needs a name.')
    }
    const [row] = await WIKI.db
      .select({ max: sql<number>`coalesce(max(${levelsTable.sortOrder}), -1)` })
      .from(levelsTable)
    const sortOrder = (row?.max ?? -1) + 1
    const inserted = await WIKI.db.insert(levelsTable).values({ name, sortOrder }).returning()
    await this.broadcastReload()
    return inserted[0]
  }

  /**
   * Rename a level. `sortOrder` is not settable here (OpenProject #1651) -- `reorder()` is the only
   * way to change ordering, so there is no single-level write path that could be handed a value
   * colliding with another level's.
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
    const updated = await WIKI.db
      .update(levelsTable)
      .set(values)
      .where(eq(levelsTable.id, id))
      .returning()
    await this.broadcastReload()
    return updated[0] ?? null
  }

  /**
   * Reorder every level at once -- assigns `sortOrder` = position in `orderedIds`, the shape a
   * drag-to-reorder admin list naturally produces without a numeric field per row.
   *
   * Two-phase to survive the `sortOrder` unique index (OpenProject #1654): a plain positional
   * reassignment can collide mid-transaction with a row not yet touched -- its still-current
   * `sortOrder` may equal another row's target position. First move every row to a disjoint
   * "staging" range strictly below any current `sortOrder`, so nothing can collide, then assign the
   * real `0..N-1` positions once every row is out of that range.
   */
  async reorder(orderedIds: string[]): Promise<void> {
    await WIKI.db.transaction(async (tx) => {
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
   * Delete a level.
   *
   * Refused when it is the last one left -- every page always has a classification, so removing the
   * only level would leave nothing for that invariant to point at -- and refused when any page, or
   * any API key/token whose `allowedClassifications` still names it (OpenProject #1205, replacing the
   * earlier #1055 single-value ceiling), still references it. The page FK is `RESTRICT` (see
   * `db/schema.ts`), so the database would refuse that half anyway; `allowedClassifications` is
   * `jsonb` with no FK to enforce the key half at all, so this jsonb containment check is the ONLY
   * thing stopping a level's deletion from silently dropping it out of a key's allow-set out from
   * under it.
   *
   * The survivors are renumbered to a gapless `0..n-1` in the same transaction as the delete
   * (OpenProject #1651) -- otherwise a delete out of the middle of the list (Public(0)/Internal(1)/
   * Restricted(2), delete Internal) leaves a gap ({0, 2}) that `create()`'s next append lands on,
   * colliding with the survivor already there.
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
      .where(sql`${apiKeysTable.allowedClassifications} @> ${JSON.stringify([id])}::jsonb`)
      .limit(1)
    if (inUseByKeys.length > 0) {
      throw new CustomError(
        'classificationInUse',
        'This classification level is still used in the allow-set of at least one API key.',
        409
      )
    }
    const deleted = await WIKI.db.transaction(async (tx) => {
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
