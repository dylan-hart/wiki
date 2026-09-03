import type { MigrationPhaseId } from './context.ts'
import type { SourceRecord } from './connector.ts'

/**
 * The named categories a record can be unmappable for — see Feature 421 task 744's description.
 *
 * `unsupported-auth-provider`: a 2.x user (`classifyUserAuthProvider` below) or a 2.x
 * `authentication` row (`mappers/authentication.ts`) on an auth strategy 3.0 has no module
 * for (LDAP/SAML/CAS/Auth0/Okta and friends — see `KNOWN_3_0_AUTH_MODULES` below for the
 * sixteen modules 3.0 actually ships, `backend/modules/authentication/`).
 *
 * `unsupported-storage-module`: a 2.x `storage` row (`mappers/storage.ts`) whose `key` names
 * a module 3.0 has no directory for at all (`box`/`digitalocean`/`dropbox`/`gdrive`/`onedrive`/
 * `s3generic` — confirmed NO DESTINATION by
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 3). Kept distinct from
 * `unsupported-auth-provider` rather than reused for it: that reason's own doc comment above is
 * scoped to auth strategies specifically, and `mappers/storage.ts`'s own module doc explains storage
 * modules have no verified 1:1 relationship with 3.0's own directory listing the way the four
 * "originally-surviving" authentication modules do — conflating the two would make a future reader of
 * either mapper's `unmappable` report wonder whether a row failed on auth or storage grounds.
 */
export type UnmappableReason = 'unsupported-auth-provider' | 'unsupported-storage-module'

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
 * `wouldSkipExisting` is nonzero whenever a phase's `classify` decides a record cannot or should not be
 * written even though it isn't a genuine conflict either — there is no single shared idempotency
 * module behind this; each phase makes its own call instead. `content`'s `pages`
 * entity checks the real destination tree for a collision (`pagesDeps.existingEntry`, backed by
 * `WIKI.models.tree.getEntryAt()`); `users`' three entities route a `'skipped'`/`'flagged'`
 * `RecordStatus` the importer's own per-record converter already decided (an unconvertible or
 * already-a-system-object record, not a live destination lookup — see `phases/users.ts#routeOutcome()`'s
 * own doc comment); `settings` reports a `flagged` authentication/storage row whose module is
 * real but whose config could not be safely carried across. `assets`'s two entities have no
 * `skipExisting` bucket of their own at all — an asset or comment either creates or conflicts (see
 * `phases/assets.ts`'s own `toRecordOutcome()`), never skips. `pageHistory` and `tags` are folded into
 * `pages` (see `phases/content.ts`'s own doc comment on why neither has its own entity any more), so
 * neither contributes a `wouldCreate`/`unmappable` count of its own either. `conflicts` is empty for
 * most phases today — no general rule yet for what makes two records genuinely conflict rather than one
 * simply superseding the other — except the `settings` phase, which uses it for the
 * (expected-never, defensive) case of a storage row naming a module with no matching per-site row
 * already seeded, and the `content`/`assets` phases, which use it for a write that was genuinely
 * attempted and failed (a sibling-collision, an unresolvable `pageId`, ...).
 *
 * The `found === wouldCreate + wouldSkipExisting + conflicts.length + unmappable.length` invariant
 * holds **per record** for every phase except `settings`. That phase's single `settings`
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

// ---------------------------------------------------------------------------
// Classifying a source record as unmappable
// ---------------------------------------------------------------------------

/**
 * 3.0's real authentication module directory (`ls backend/modules/authentication/`), cross-checked
 * live against disk by `report.test.ts` the same way `mappers/storage.ts`'s
 * `KNOWN_3_0_STORAGE_MODULES` is checked against `backend/modules/storage/` — so this list drifting
 * from what's actually on disk fails a test rather than silently going stale again.
 */
export const KNOWN_3_0_AUTH_MODULES = new Set([
  'auth0',
  'cas',
  'discord',
  'github',
  'gitlab',
  'google',
  'keycloak',
  'ldap',
  'local',
  'microsoft',
  'oauth2',
  'oidc',
  'okta',
  'saml',
  'slack',
  'twitch'
])

/**
 * 2.x auth strategy keys with **no** matching 3.0 authentication module — confirmed by
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s "Confirmed no-destination 2.x auth
 * providers" section: 2.x's 21 providers minus 3.0's 16 `KNOWN_3_0_AUTH_MODULES` leaves exactly these
 * five with nowhere to land. A user or strategy on one of them is dropped entirely — no account is
 * created — and reported as `unsupported-auth-provider` so the operator can decide what to do about
 * it. Every other 2.x provider key, including one this list doesn't recognize at all, passes through
 * unflagged; `importers/users-groups.ts`'s provider fallback is what actually routes those.
 */
const UNSUPPORTED_AUTH_PROVIDERS = new Set([
  'azure',
  'dropbox',
  'facebook',
  'firebase',
  'rocketchat'
])

function stringField(record: SourceRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Classifies one source `users` record as unmappable when its `providerKey` names an auth strategy
 * 3.0 has no module for. Returns `null` for every other provider — including ones 3.0 does support,
 * and any provider key this function doesn't recognize; those are routed by
 * `importers/users-groups.ts`'s provider fallback instead.
 */
export function classifyUserAuthProvider(record: SourceRecord): UnmappableEntry | null {
  const providerKey = (stringField(record, 'providerKey') ?? '').toLowerCase()
  if (!UNSUPPORTED_AUTH_PROVIDERS.has(providerKey)) {
    return null
  }
  const identifier = stringField(record, 'email') ?? String(record.id ?? providerKey)
  return {
    identifier,
    reason: 'unsupported-auth-provider',
    detail: `providerKey "${providerKey}" has no matching 3.0 authentication module (confirmed no-destination — see docs/migration/2.5x-settings-auth-storage-field-mapping.md's Part 2 provider inventory).`
  }
}

// ---------------------------------------------------------------------------
// Rendering the aggregate report
// ---------------------------------------------------------------------------

type ColumnKey =
  | 'phase'
  | 'found'
  | 'wouldCreate'
  | 'wouldSkipExisting'
  | 'conflictCount'
  | 'unmappableCount'

const COLUMNS: { key: ColumnKey; header: string }[] = [
  { key: 'phase', header: 'Phase' },
  { key: 'found', header: 'Found' },
  { key: 'wouldCreate', header: 'Would Create' },
  { key: 'wouldSkipExisting', header: 'Would Skip' },
  { key: 'conflictCount', header: 'Conflicts' },
  { key: 'unmappableCount', header: 'Unmappable' }
]

function cell(report: PhaseReport, key: ColumnKey): string {
  switch (key) {
    case 'conflictCount':
      return String(report.conflicts.length)
    case 'unmappableCount':
      return String(report.unmappable.length)
    default:
      return String(report[key])
  }
}

/**
 * Renders the aggregate dry-run report as a plain-text table, one row per phase, plus a detail line
 * per conflict/unmappable entry beneath it — the console default (Feature 421 task 744). Returns a
 * plain string rather than printing directly, so a caller can choose stdout vs. the structured logger
 * vs. a test assertion. `--report-file` additionally writes the same reports as JSON (`reportsToJson`)
 * for diffing between runs.
 */
export function formatReportTable(reports: PhaseReport[]): string {
  if (reports.length === 0) {
    return '(no phases ran)'
  }

  const rows = reports.map((report) => COLUMNS.map((column) => cell(report, column.key)))
  const widths = COLUMNS.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => row[i].length))
  )
  const formatRow = (cells: string[]) =>
    cells
      .map((value, i) => value.padEnd(widths[i]))
      .join('  ')
      .trimEnd()

  const lines = [
    formatRow(COLUMNS.map((column) => column.header)),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(formatRow)
  ]

  for (const report of reports) {
    for (const conflict of report.conflicts) {
      lines.push(`  [${report.phase}] conflict: ${conflict.identifier} — ${conflict.detail}`)
    }
    for (const entry of report.unmappable) {
      lines.push(
        `  [${report.phase}] unmappable (${entry.reason}): ${entry.identifier} — ${entry.detail}`
      )
    }
  }

  return lines.join('\n')
}

/** JSON form of the aggregate report, written to `--report-file` for later diffing between runs. */
export function reportsToJson(reports: PhaseReport[]): string {
  return JSON.stringify(reports, null, 2)
}
