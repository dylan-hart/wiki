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
 * `wouldSkipExisting` and `conflicts` are always empty today: telling a "would create" apart from a
 * "would skip, already imported" requires the provenance/idempotency tracking Feature 421 task 746
 * owns building — there is no destination lookup here to tell the two apart yet. Every record a phase
 * can classify at all is therefore either `unmappable` or counted into `wouldCreate`, which holds the
 * invariant `found === wouldCreate + wouldSkipExisting + conflicts.length + unmappable.length`.
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
