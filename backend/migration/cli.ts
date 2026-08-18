import { Command } from 'commander'
import { MIGRATION_PHASE_IDS } from './phases/index.ts'
import { addSourceOptions, resolveSource } from './source-args.ts'
import type { MigrationPhaseId } from './context.ts'
import type { ParsedSource, SourceRawOptions } from './source-args.ts'

export type { ParsedSource } from './source-args.ts'

export interface ParsedMigrationArgs {
  source: ParsedSource
  siteId: string
  dryRun: boolean
  /** Feature 421 task 746: when an importer phase finds a source row already mapped to a destination
   * row (via `../provenance.ts`'s `lookupOrInsert()`), update that row in place instead of leaving it
   * untouched. Defaults to `false` — a re-run is a safe no-op on already-imported rows unless this is
   * explicitly passed. */
  updateExisting: boolean
  /** Absent means "run every phase". Every id is checked against `MIGRATION_PHASE_IDS` here, so a
   * typo is rejected before anything connects to a database. */
  only?: MigrationPhaseId[]
  /** When given, the aggregate dry-run/report-mode report (Feature 421 task 744) is also written here
   * as JSON, in addition to the console table always printed. */
  reportFile?: string
}

interface RawOptions extends SourceRawOptions {
  siteId: string
  dryRun: boolean
  updateExisting: boolean
  only?: string
  reportFile?: string
}

function buildProgram(): Command {
  const program = new Command()
  program
    .name('migrate')
    .description('Import a Wiki.js 2.5.x installation into this 3.0 instance.')
    .requiredOption('--site-id <id>', 'Destination site ID to import into')
    .option('--dry-run', 'Compute what would change without writing anything', false)
    .option(
      '--update-existing',
      'Update an already-imported row in place instead of skipping it',
      false
    )
    .option(
      '--only <phases>',
      `Comma-separated phase id(s) to (re-)run, e.g. "content" or "users,content". One of: ${MIGRATION_PHASE_IDS.join(', ')}.`
    )
    .option(
      '--report-file <path>',
      'Also write the aggregate dry-run report as JSON to this path, in addition to the console table'
    )
  addSourceOptions(program)
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  return program
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
    updateExisting: Boolean(opts.updateExisting),
    only: parseOnly(opts.only),
    // Omitted entirely (not set to `undefined`) when absent, so a caller can tell "write a report
    // file" apart from "don't" with a plain truthiness check rather than an `in` check.
    ...(opts.reportFile ? { reportFile: opts.reportFile } : {})
  }
}
