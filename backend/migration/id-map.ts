/**
 * Every legacy integer PK becomes a fresh UUID on import, so an importer needs an old-id →
 * new-UUID table per 2.x entity for the whole run. Those tables are plain `Map<number, string>`
 * instances, built incrementally by whichever importer creates the 3.0 row and read by anything
 * resolving a reference against them.
 */

/**
 * The read-only half of the user importer's own map, narrowed so a caller can be handed a plain
 * `Map<number, string>` or a fixture interchangeably.
 */
export interface UserIdMap {
  get(oldUserId: number): string | undefined
}

/** `usedFallback` tells the caller whether an orphaned-FK warning is worth recording: a genuinely
 * null source column is not warning-worthy, only an unmapped-but-present id is. */
export interface ActorResolution {
  actorId: string
  usedFallback: boolean
}

/**
 * Resolves a nullable 2.x `authorId`/`creatorId` onto a UUID satisfying 3.0's NOT NULL constraint
 * on the equivalent column. Falls back to `fallbackActorId` both when the source column is null
 * (normal — 2.x never required an author) and when it names a user id the map has no entry for (an
 * orphaned FK, since 2.x enforced none). Only the latter is source data that could not be carried
 * across faithfully, so only it reports `usedFallback: true`.
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
