export interface SyncGuardedStrategy {
  /** Groups this strategy may grant or revoke at all. Empty means none. */
  mappableGroups?: string[] | null
  /** Granted by the strategy directly, so the sync never revokes these. */
  autoEnrollGroups?: string[] | null
}

export interface SyncGuardedGroups {
  /** Anonymous access, not something a provider grants or takes away. */
  guestsGroupId: string
  rootAdminGroupId?: string | null
  /** From `CARDINAL.models.groups.systemGroupIds()`, which already includes the root
   *  administrators group -- passing `rootAdminGroupId` too is harmless, not required. */
  systemGroupIds: string[]
}

/**
 * Group ids a strategy could revoke from an account on a login that stops reporting them. Shared by
 * `models/login.ts#syncProviderGroups()` and `models/authentication.ts#getGroupSyncWarnings()`, so
 * the sync and the admin-facing warning cannot disagree.
 */
export function syncRevocableGroupIds(
  strategy: SyncGuardedStrategy,
  guarded: SyncGuardedGroups
): string[] {
  const protectedFromRemoval = new Set<string>([
    guarded.guestsGroupId,
    ...(guarded.rootAdminGroupId ? [guarded.rootAdminGroupId] : []),
    ...guarded.systemGroupIds,
    ...(strategy.autoEnrollGroups ?? [])
  ])
  return (strategy.mappableGroups ?? []).filter((id) => !protectedFromRemoval.has(id))
}
