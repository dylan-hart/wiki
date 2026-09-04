import { MIGRATION_PHASE_IDS } from './phases/index.ts'
import { buildSourceProgram, parseArgv, resolveSource, splitCommaList } from './source-args.ts'
import type { Command } from 'commander'
import type { MigrationPhaseId } from './context.ts'
import type { ParsedSource, SourceRawOptions } from './source-args.ts'

export type { ParsedSource } from './source-args.ts'

/** The three `--render-mode` values. `'auto'` is resolved by `tasks/migrate.ts` (which has a live
 * `WIKI` to check Puppeteer availability with) into a concrete `'queue'`/`'passthrough'` before a
 * `MigrationContext` is built — see `context.ts`'s `renderMode` doc and `migrate.ts`'s
 * `resolveRenderMode()`. */
export type RenderModeOption = 'auto' | 'queue' | 'passthrough'
const RENDER_MODE_OPTIONS: RenderModeOption[] = ['auto', 'queue', 'passthrough']

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
  /** How each imported page's initial render is seeded — see `RenderModeOption`'s own doc comment.
   * Defaults to `'auto'`: a real 3.0 render when this destination can produce one, otherwise the old
   * passthrough behavior, so a migration is correct by default without forcing every operator to pay
   * the Puppeteer render-queue cost when their destination has no Puppeteer at all. */
  renderMode: RenderModeOption
}

interface RawOptions extends SourceRawOptions {
  siteId: string
  dryRun: boolean
  only?: string
  reportFile?: string
  renderMode: string
}

function buildProgram(): Command {
  return buildSourceProgram({
    name: 'migrate',
    description: 'Import a Wiki.js 2.5.x installation into this 3.0 instance.',
    options: (program) => {
      program
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
        .option(
          '--render-mode <mode>',
          `How each imported page's initial render is seeded: "auto" (default) uses a real 3.0 render ` +
            `when this destination has Puppeteer installed, otherwise falls back to "passthrough"; ` +
            `"queue" always requests a native 3.0 render (one headless-browser render per markdown ` +
            `page — a real operational cost on a large wiki, and refused up front if this destination ` +
            `cannot render at all); "passthrough" always carries 2.x's stored render HTML through ` +
            `unchanged (instant, but its asset URLs are 2.x's, not 3.0's, until the page is next ` +
            `edited or re-rendered by hand). One of: ${RENDER_MODE_OPTIONS.join(', ')}.`,
          'auto'
        )
    }
  })
}

function parseRenderMode(raw: string): RenderModeOption {
  if (!RENDER_MODE_OPTIONS.includes(raw as RenderModeOption)) {
    throw new Error(`Unknown --render-mode "${raw}". One of: ${RENDER_MODE_OPTIONS.join(', ')}.`)
  }
  return raw as RenderModeOption
}

function parseOnly(raw: string | undefined): MigrationPhaseId[] | undefined {
  const ids = splitCommaList(raw)
  if (!ids) {
    return undefined
  }
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
  const opts = parseArgv<RawOptions>(buildProgram(), argv)
  return {
    source: resolveSource(opts),
    siteId: opts.siteId,
    dryRun: Boolean(opts.dryRun),
    only: parseOnly(opts.only),
    // Omitted entirely (not set to `undefined`) when absent, so a caller can tell "write a report
    // file" apart from "don't" with a plain truthiness check rather than an `in` check.
    ...(opts.reportFile ? { reportFile: opts.reportFile } : {}),
    renderMode: parseRenderMode(opts.renderMode)
  }
}
