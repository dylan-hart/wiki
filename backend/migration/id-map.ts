/**
 * Old-id → new-UUID resolution for the 2.5.x import —
 * `docs/migration/2.5x-to-3.0-mapping.md`'s "Read this first" point 1: every legacy integer/string PK
 * becomes a fresh UUID, so an importer needs an old-id → new-UUID table per 2.x entity for the whole
 * run. Those tables are plain `Map<number, string>` instances, built incrementally by whichever
 * importer actually creates the 3.0 row (e.g. `createPage()`) and read by anything resolving a
 * reference against them (e.g. `pageHistory.pageId`).
 */

/**
 * The read-only contract this feature consumes from #414 (Users, Groups & Permissions): an old 2.x
 * `users.id` resolved to whatever UUID the user importer created for it. #414 owns building the real
 * instance — `Map<number, string>` already satisfies this structurally, so #414's own map can be
 * passed in here directly once it exists; a fixture/fake is enough for this feature's own unit
 * coverage.
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
