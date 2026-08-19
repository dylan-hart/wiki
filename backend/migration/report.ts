import type { MigrationPhaseId } from './context.ts'

/**
 * The two named categories a record can be unmappable for — see Feature 421 task 744's description.
 *
 * `unsupported-auth-provider`: a 2.x user on an auth strategy 3.0 has no module for (LDAP/SAML/CAS/
 * Auth0/Okta — 3.0 ships exactly `local`/`google`/`github`/`oidc`, see `backend/modules/authentication/`).
 *
 * `no-destination-table`: an entity 3.0's schema has nowhere to put yet — today that is exactly
 * comments (`backend/db/schema.ts` has no comments table until the sibling Comments epic, #335,
 * lands; see `docs/migration/2.5x-to-3.0-mapping.md`'s "comments" section).
 */
export type UnmappableReason = 'unsupported-auth-provider' | 'no-destination-table'

export interface ConflictEntry {
  identifier: string
  detail: string
}

export interface UnmappableEntry {
  identifier: string
  reason: UnmappableReason
  detail: string
}

/**
 * What one phase's dry run reconciled, independent of `PhaseResult`'s read-status bookkeeping
 * (`counts`/`notImplemented`/`errors`) — see Feature 421 task 744. `found` is every record the phase
 * read off the source; `wouldCreate`/`wouldSkipExisting`/`conflicts` are how those records would be
 * written to the 3.0 destination; `unmappable` is a record that cannot be written at all, regardless
 * of dry-run vs. live.
 *
 * `wouldSkipExisting` is nonzero once a phase's `classify` checks the provenance/idempotency tracking
 * Feature 421 task 746 built (`../provenance.ts`'s `resolveExisting`/`lookupOrInsert`) — currently the
 * `users`, `content` (pages only) and `assets` phases; `settings`, `groups`, `pageHistory` and `tags`
 * still count every record into `wouldCreate` or `unmappable`, having no per-record idempotency rule
 * of their own yet. `conflicts` is always empty today — no phase has a rule yet for what makes two
 * records genuinely conflict rather than one simply superseding the other. Either way the invariant
 * holds: `found === wouldCreate + wouldSkipExisting + conflicts.length + unmappable.length`.
 */
export interface PhaseReport {
  phase: MigrationPhaseId
  found: number
  wouldCreate: number
  wouldSkipExisting: number
  conflicts: ConflictEntry[]
  unmappable: UnmappableEntry[]
}

/** An empty report for a phase that aborted before any reconciliation happened (`status: 'error'`). */
export function emptyPhaseReport(phase: MigrationPhaseId): PhaseReport {
  return { phase, found: 0, wouldCreate: 0, wouldSkipExisting: 0, conflicts: [], unmappable: [] }
}
