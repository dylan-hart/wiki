/**
 * Generic old-id → new-UUID lookup, the shape every importer feature needs at least once —
 * `docs/migration/2.5x-to-3.0-mapping.md`'s "Read this first" point 1: every legacy integer/string PK
 * becomes a fresh UUID, so an importer needs an old-id → new-UUID table per 2.x entity for the whole
 * run.
 *
 * A map instance is deliberately mutable and built incrementally, because the entity that actually
 * creates the 3.0 row (e.g. `createPage()`) is what learns the new UUID — generally in a task
 * downstream of whichever task owns extraction. This class is the shared contract between the two:
 * the extraction side (this feature's Task 733) hands back one `IdMap` per entity kind, a later write
 * step calls `set()` as each row is actually created, and anything needing to resolve a reference
 * (e.g. `pageHistory.pageId`) calls `get()`/`resolve()` once that has happened.
 */
export class IdMap<TOldId = number> {
  private readonly byOldId = new Map<TOldId, string>()

  /** Records the new UUID a 3.0 row got for `oldId`. Overwrites any previous mapping for the same id. */
  set(oldId: TOldId, newId: string): void {
    this.byOldId.set(oldId, newId)
  }

  has(oldId: TOldId): boolean {
    return this.byOldId.has(oldId)
  }

  /** Looks up the mapped UUID, or `undefined` if `oldId` has not been mapped (yet, or ever). */
  get(oldId: TOldId): string | undefined {
    return this.byOldId.get(oldId)
  }

  /** Same as `get()`, but throws instead of returning `undefined` — for call sites where a missing
   * mapping is a bug in run ordering rather than a value to handle. */
  resolve(oldId: TOldId): string {
    const newId = this.byOldId.get(oldId)
    if (newId === undefined) {
      throw new Error(`No new-UUID mapping for old id "${String(oldId)}".`)
    }
    return newId
  }

  get size(): number {
    return this.byOldId.size
  }

  entries(): IterableIterator<[TOldId, string]> {
    return this.byOldId.entries()
  }
}

/**
 * The read-only contract this feature consumes from #414 (Users, Groups & Permissions): an old 2.x
 * `users.id` resolved to whatever UUID the user importer created for it. #414 owns building the real
 * instance — `IdMap<number>` already satisfies this structurally, so #414's own map can be passed in
 * here directly once it exists; a fixture/fake is enough for this feature's own unit coverage.
 */
export interface UserIdMap {
  get(oldUserId: number): string | undefined
}

/** What `resolveActorId` decided, and whether the fallback path was actually exercised — the caller
 * uses `usedFallback` to decide whether an orphaned-FK warning is worth recording; a genuinely null
 * source column is not a warning-worthy event, only an unmapped-but-present one is. */
export interface ActorResolution {
  actorId: string
  usedFallback: boolean
}

/**
 * Resolves a 2.x `pages`/`pageHistory` `authorId`/`creatorId` (nullable in 2.x) onto a 3.0 UUID that
 * satisfies the NOT NULL constraint 3.0 puts on the equivalent column.
 *
 * Falls back to `fallbackActorId` — the operator running the import, per this task's description —
 * whenever the source column is null/undefined (normal: 2.x never required an author), or names a
 * 2.x user id `userIdMap` has no entry for (an orphaned FK, since 2.x never enforced one on
 * `pages.authorId`/`creatorId`). Only the second case is reported back as `usedFallback: true`, since
 * only it represents source data that could not be faithfully carried across.
 */
export function resolveActorId(
  oldUserId: number | null | undefined,
  userIdMap: UserIdMap,
  fallbackActorId: string
): ActorResolution {
  if (oldUserId === null || oldUserId === undefined) {
    return { actorId: fallbackActorId, usedFallback: false }
  }
  const mapped = userIdMap.get(oldUserId)
  if (mapped === undefined) {
    return { actorId: fallbackActorId, usedFallback: true }
  }
  return { actorId: mapped, usedFallback: false }
}
