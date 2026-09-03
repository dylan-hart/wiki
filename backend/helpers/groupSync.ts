/**
 * The set of memberships a `mapGroups`-enabled strategy's `mappableGroups` allow-list can currently
 * revoke, computed independent of any one reported-groups list.
 *
 * This is the same exclusion the real reconciliation, `models/login.ts#syncProviderGroups()`, applies
 * to the `toRemove` half of its diff -- extracted here so the two never drift apart: one owner decides
 * "can this strategy revoke this group at all", read both by the sync that actually does the
 * revoking and by `models/authentication.ts#getGroupSyncWarnings()`, the admin-facing read behind the
 * group-assignment warning (WP #2440).
 */
export interface SyncGuardedStrategy {
  /** Admin-chosen subset of groups this strategy may grant or revoke at all. Empty means none. */
  mappableGroups?: string[] | null
  /** A group named here is granted by this strategy directly and is never revoked by the sync,
   *  however its own `mappableGroups` list is configured. */
  autoEnrollGroups?: string[] | null
}

export interface SyncGuardedGroups {
  /** Anonymous access, not something a provider grants or takes away. */
  guestsGroupId: string
  /** The configured root administrators group, if any -- an IdP can never revoke it. */
  rootAdminGroupId?: string | null
  /** Every group carrying `manage:system` (`WIKI.models.groups.systemGroupIds()`, which already
   *  folds the root administrators group in on its own -- passing `rootAdminGroupId` too is
   *  harmless, not required). */
  systemGroupIds: string[]
}

/**
 * Group ids `strategy.mappableGroups` could revoke from an account on a login that stops reporting
 * them -- i.e. every mappable group except the guests group, the root administrators group, any
 * group carrying `manage:system`, and any group the strategy also auto-enrolls (an admin-configured
 * grant, which the sync leaves alone regardless of what an IdP reports).
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
