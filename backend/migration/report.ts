import type { MigrationPhaseId } from './context.ts'
import type { SourceRecord } from './connector.ts'

/**
 * Auth and storage stay distinct reasons rather than one shared "unsupported module": an operator
 * reading an `unmappable` entry has to know which half of the source a row failed on.
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
 * What one phase's dry run reconciled, independent of `PhaseResult`'s read-status bookkeeping.
 * `unmappable` is a record that cannot be written at all, dry run or live.
 *
 * `found === wouldCreate + wouldSkipExisting + conflicts.length + unmappable.length` holds per
 * record for every phase but `settings`, where any number of `settings`-tagged source rows collapse
 * into one sentinel `recorder.create()` call, so `found` may legitimately exceed the sum.
 */
export interface PhaseReport {
  phase: MigrationPhaseId
  found: number
  wouldCreate: number
  wouldSkipExisting: number
  conflicts: ConflictEntry[]
  unmappable: UnmappableEntry[]
}

export function emptyPhaseReport(phase: MigrationPhaseId): PhaseReport {
  return { phase, found: 0, wouldCreate: 0, wouldSkipExisting: 0, conflicts: [], unmappable: [] }
}

/** Mirrors `backend/modules/authentication/`; `report.test.ts` checks it against disk. */
export const KNOWN_3_0_AUTH_MODULES = new Set([
  'auth0',
  'cas',
  'discord',
  'facebook',
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
  'rocketchat',
  'saml',
  'slack',
  'twitch'
])

/**
 * 2.x auth strategy keys with no 3.0 destination — see
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`. A user or strategy on one is dropped
 * entirely, no account created. This is an explicit denylist, not the complement of
 * `KNOWN_3_0_AUTH_MODULES`: an unrecognized provider key passes through unflagged for
 * `importers/users-groups.ts`'s provider fallback to route.
 */
const UNSUPPORTED_AUTH_PROVIDERS = new Set(['azure', 'dropbox', 'firebase'])

function stringField(record: SourceRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

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

/** Returns a string rather than printing, so a caller picks stdout, the logger or an assertion. */
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

export function reportsToJson(reports: PhaseReport[]): string {
  return JSON.stringify(reports, null, 2)
}

/**
 * A notice the operator needs that no `PhaseReport` can carry, because no phase reads the source
 * record class it is about. A typed list plus one renderer so a second notice is an array entry
 * rather than another hand-written print statement — look for an existing entry before adding one.
 */
export interface PostMigrationNotice {
  summary: string
  action: string
}

/**
 * 2.5.x record classes no phase reads at all, so a static notice is the only place an operator hears
 * about them. 2.5.x's `apiToken` rows are GraphQL-scoped JWTs with no shape to translate onto this
 * fork's group-bound REST `apiKeys`; Slack/Discord notification config was never a first-party 2.5.x
 * feature, so there is nothing in the source schema to read.
 */
export const POST_MIGRATION_NOTICES: PostMigrationNotice[] = [
  {
    summary:
      'API tokens and Slack/Discord notification config from your 2.5.x source were not migrated.',
    action:
      'Issue new API keys against the migrated groups (Admin > API Access) — see ' +
      'docs/migration/migration-runbook.md\'s "Not migrated at all" section for details.'
  }
]

export function formatPostMigrationNotices(notices: PostMigrationNotice[]): string {
  if (notices.length === 0) {
    return ''
  }
  const lines = ['Post-migration notices:']
  for (const notice of notices) {
    lines.push(`  - ${notice.summary} ${notice.action}`)
  }
  return lines.join('\n')
}
