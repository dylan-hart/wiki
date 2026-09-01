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
 * `users`, `content` (pages only) and `assets` phases — or (Task 15) reports a `flagged`
 * authentication/storage row whose module is real but whose config could not be safely carried
 * across; `groups`, `pageHistory` and `tags` still count every record into `wouldCreate` or
 * `unmappable`, having no per-record idempotency rule of their own yet. `conflicts` is empty for most
 * phases today — no general rule yet for what makes two records genuinely conflict rather than one
 * simply superseding the other — except the `settings` phase (Task 15), which uses it for both an
 * authentication row's `conflict-skipped` multi-source collision and the (expected-never, defensive)
 * case of a storage row naming a module with no matching per-site row already seeded.
 *
 * The `found === wouldCreate + wouldSkipExisting + conflicts.length + unmappable.length` invariant
 * holds **per record** for every phase except `settings` (Task 15). That phase's single `settings`
 * entity reads every `settings`/`authentication`/`storage`-tagged row off `ctx.source.settings()` as
 * one raw count (`found`), but every `settings`-tagged row collapses into exactly one `site-config`
 * sentinel `recorder.create()` call — regardless of whether there were zero, one, or a dozen of
 * them — while each `authentication`/`storage`-tagged row still gets its own 1:1 recorder call. So
 * `found` can legitimately exceed `wouldCreate + wouldSkipExisting + conflicts.length +
 * unmappable.length` for this one phase whenever more than one `settings`-tagged row is read in the
 * same run — see `phases/settings.ts`'s own module doc comment ("Why this drains the source itself").
 * `phases/content.ts`'s `site-navigation` sentinel avoids this exact shape by giving itself a
 * dedicated one-yield source entity, so its own `found` contribution is always exactly 1;
 * `phases/settings.ts` does not do the same, since doing so would mean a second (or third) full pass
 * over `ctx.source.settings()`'s tagged stream purely to filter it by tag, on top of the one
 * `runSettingsImport()` already re-reads beyond `readEntity()`'s own counting pass.
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
