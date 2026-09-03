import { InvalidArgumentError } from 'commander'
import { buildSourceProgram, parseArgv, resolveSource, splitCommaList } from './source-args.ts'
import type { Command } from 'commander'
import type { ParsedSource, SourceRawOptions } from './source-args.ts'

export type { ParsedSource } from './source-args.ts'

export interface ParsedVerifyArgs {
  source: ParsedSource
  siteId: string
  /** Random sample size for the content spot-check when `samplePaths` is not given. Defaults to 20
   * per Feature 421 task 748's description. */
  sampleSize: number
  /** Explicit paths to spot-check instead of a random sample — `--sample-paths`. */
  samplePaths?: string[]
  /** Path to a dry-run report JSON (written by `migrate.ts --report-file`, task 744) to diff live
   * phase totals against. */
  againstReport?: string
}

interface RawOptions extends SourceRawOptions {
  siteId: string
  sampleSize: string
  samplePaths?: string
  againstReport?: string
}

function parseSampleSize(raw: string): number {
  const size = Number.parseInt(raw, 10)
  if (Number.isNaN(size) || size <= 0) {
    throw new InvalidArgumentError(`"${raw}" is not a valid positive sample size.`)
  }
  return size
}

function buildProgram(): Command {
  return buildSourceProgram({
    name: 'verify-migration',
    description:
      'Verify a completed Wiki.js 2.5.x -> 3.0 migration: compare per-entity record counts and ' +
      'spot-check page content against the same source the import ran against.',
    options: (program) => {
      program
        .requiredOption('--site-id <id>', 'Destination site ID that was imported into')
        .option(
          '--sample-size <n>',
          'Number of random pages to content-spot-check when --sample-paths is not given',
          '20'
        )
        .option(
          '--sample-paths <paths>',
          'Comma-separated list of specific page paths to spot-check instead of a random sample'
        )
        .option(
          '--against-report <path>',
          'Path to a dry-run report JSON (written by "migrate --report-file") to diff live phase totals against'
        )
    }
  })
}

/**
 * Parses `verify-migration.ts`'s argv into a fully-resolved `ParsedVerifyArgs` — the verification
 * counterpart to `cli.ts`'s `parseMigrationArgs`, sharing the same source-selection flags/validation
 * (`../migration/source-args.ts`) since a verification run reads through the exact same kind of
 * `SourceConnector` the import did.
 *
 * Takes bare argv (no `node`/script path prefix), same convention as `parseMigrationArgs`.
 *
 * @throws A plain `Error` (never commander's own `CommanderError`) describing what was wrong.
 */
export function parseVerifyArgs(argv: string[]): ParsedVerifyArgs {
  const opts = parseArgv<RawOptions>(buildProgram(), argv)
  // -> `--sample-paths=,,` names nothing, which is the same as not asking for explicit paths at all.
  const parsed = splitCommaList(opts.samplePaths)
  const samplePaths = parsed && parsed.length > 0 ? parsed : undefined
  return {
    source: resolveSource(opts),
    siteId: opts.siteId,
    sampleSize: parseSampleSize(opts.sampleSize),
    ...(samplePaths ? { samplePaths } : {}),
    ...(opts.againstReport ? { againstReport: opts.againstReport } : {})
  }
}
