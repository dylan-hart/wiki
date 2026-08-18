import { Command, InvalidArgumentError } from 'commander'
import { MIGRATION_PHASE_IDS } from './phases/index.ts'
import type { MigrationPhaseId } from './context.ts'
import type { PostgresSourceConfig } from './connectors/postgres.ts'

export type ParsedSource =
  | { kind: 'postgres'; config: PostgresSourceConfig }
  | { kind: 'export-bundle'; path: string }

export interface ParsedMigrationArgs {
  source: ParsedSource
  siteId: string
  dryRun: boolean
  /** Absent means "run every phase". Every id is checked against `MIGRATION_PHASE_IDS` here, so a
   * typo is rejected before anything connects to a database. */
  only?: MigrationPhaseId[]
  /** When given, the aggregate dry-run/report-mode report (Feature 421 task 744) is also written here
   * as JSON, in addition to the console table always printed. */
  reportFile?: string
}

interface RawOptions {
  siteId: string
  dryRun: boolean
  only?: string
  reportFile?: string
  bundlePath?: string
  sourceHost?: string
  sourcePort: string
  sourceDatabase?: string
  sourceUser?: string
  sourcePassword?: string
  sourceSsl: boolean
}

const POSTGRES_SOURCE_FIELDS = [
  ['sourceHost', '--source-host'],
  ['sourceDatabase', '--source-database'],
  ['sourceUser', '--source-user'],
  ['sourcePassword', '--source-password']
] as const

function buildProgram(): Command {
  const program = new Command()
  program
    .name('migrate')
    .description('Import a Wiki.js 2.5.x installation into this 3.0 instance.')
    .requiredOption('--site-id <id>', 'Destination site ID to import into')
    .option('--dry-run', 'Compute what would change without writing anything', false)
    .option(
      '--only <phases>',
      `Comma-separated phase id(s) to (re-)run, e.g. "content" or "users,content". One of: ${MIGRATION_PHASE_IDS.join(', ')}.`
    )
    .option(
      '--report-file <path>',
      'Also write the aggregate dry-run report as JSON to this path, in addition to the console table'
    )
    .option('--bundle-path <path>', 'Path to a 2.x "export to disk" bundle directory')
    .option('--source-host <host>', 'Source Postgres host (live-connection source)')
    .option('--source-port <port>', 'Source Postgres port', '5432')
    .option('--source-database <database>', 'Source Postgres database name')
    .option('--source-user <user>', 'Source Postgres user')
    .option('--source-password <password>', 'Source Postgres password')
    .option('--source-ssl', 'Use SSL for the source Postgres connection', false)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
  return program
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10)
  if (Number.isNaN(port) || port <= 0) {
    throw new InvalidArgumentError(`"${raw}" is not a valid port number.`)
  }
  return port
}

function resolveSource(opts: RawOptions): ParsedSource {
  if (opts.bundlePath) {
    return { kind: 'export-bundle', path: opts.bundlePath }
  }

  const providedFields = POSTGRES_SOURCE_FIELDS.filter(([key]) => Boolean(opts[key]))
  if (providedFields.length === 0) {
    throw new Error(
      'No source given: pass --bundle-path <dir> for an export bundle, or --source-host/--source-database/' +
        '--source-user/--source-password for a live Postgres source.'
    )
  }

  const missingFields = POSTGRES_SOURCE_FIELDS.filter(([key]) => !opts[key])
  if (missingFields.length > 0) {
    throw new Error(
      `Incomplete Postgres source: missing ${missingFields.map(([, flag]) => flag).join(', ')}.`
    )
  }

  return {
    kind: 'postgres',
    config: {
      host: opts.sourceHost!,
      port: parsePort(opts.sourcePort),
      database: opts.sourceDatabase!,
      user: opts.sourceUser!,
      password: opts.sourcePassword!,
      ssl: opts.sourceSsl ? true : undefined
    }
  }
}

function parseOnly(raw: string | undefined): MigrationPhaseId[] | undefined {
  if (!raw) {
    return undefined
  }
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const unknown = ids.filter((id) => !MIGRATION_PHASE_IDS.includes(id as MigrationPhaseId))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown phase(s) in --only: ${unknown.join(', ')}. Known phases: ${MIGRATION_PHASE_IDS.join(', ')}.`
    )
  }
  return ids as MigrationPhaseId[]
}

/**
 * Parses the migration CLI's argv into a fully-resolved `ParsedMigrationArgs`, validating everything
 * that can be checked before a database connection is opened: the required `--site-id`, that exactly
 * one source kind's fields were given and completely, the port is a real number, and every `--only`
 * id is a known phase.
 *
 * Takes bare argv (no `node`/script path prefix) so it is callable the same way from the CLI entry
 * point (`../tasks/migrate.ts`, via `process.argv.slice(2)`) and from tests.
 *
 * @throws A plain `Error` (never commander's own `CommanderError`) describing what was wrong.
 */
export function parseMigrationArgs(argv: string[]): ParsedMigrationArgs {
  const program = buildProgram()
  try {
    program.parse(argv, { from: 'user' })
  } catch (err: any) {
    throw new Error(err.message)
  }

  const opts = program.opts<RawOptions>()
  return {
    source: resolveSource(opts),
    siteId: opts.siteId,
    dryRun: Boolean(opts.dryRun),
    only: parseOnly(opts.only),
    // Omitted entirely (not set to `undefined`) when absent, so a caller can tell "write a report
    // file" apart from "don't" with a plain truthiness check rather than an `in` check.
    ...(opts.reportFile ? { reportFile: opts.reportFile } : {})
  }
}
