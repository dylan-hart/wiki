import type { MigrationPhaseId } from './context.ts'

/**
 * The named categories a record can be unmappable for — see Feature 421 task 744's description.
 *
 * `unsupported-auth-provider`: a 2.x user (`unmappable.ts#classifyUserAuthProvider`) or a 2.x
 * `authentication` row (`mappers/authentication.ts`, Task 15) on an auth strategy 3.0 has no module
 * for (LDAP/SAML/CAS/Auth0/Okta and friends — see `unmappable.ts`'s `KNOWN_3_0_AUTH_MODULES` for the
 * sixteen modules 3.0 actually ships, `backend/modules/authentication/`).
 *
 * `no-destination-table`: an entity 3.0's schema has nowhere to put yet — today that is exactly
 * comments (`backend/db/schema.ts` has no comments table until the sibling Comments epic, #335,
 * lands; see `docs/migration/2.5x-to-3.0-mapping.md`'s "comments" section).
 *
 * `unsupported-storage-module`: a 2.x `storage` row (`mappers/storage.ts`, Task 15) whose `key` names
 * a module 3.0 has no directory for at all (`box`/`digitalocean`/`dropbox`/`gdrive`/`onedrive`/
 * `s3generic` — confirmed NO DESTINATION by
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 3). Kept distinct from
 * `unsupported-auth-provider` rather than reused for it: that reason's own doc comment above is
 * scoped to auth strategies specifically, and `mappers/storage.ts`'s own module doc explains storage
 * modules have no verified 1:1 relationship with 3.0's own directory listing the way the four
 * "originally-surviving" authentication modules do — conflating the two would make a future reader of
 * either mapper's `unmappable` report wonder whether a row failed on auth or storage grounds.
 */
export type UnmappableReason =
  | 'unsupported-auth-provider'
  | 'no-destination-table'
  | 'unsupported-storage-module'

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
