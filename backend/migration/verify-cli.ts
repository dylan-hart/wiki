import { InvalidArgumentError } from 'commander'
import { buildSourceProgram, parseArgv, resolveSource, splitCommaList } from './source-args.ts'
import type { Command } from 'commander'
import type { ParsedSource, SourceRawOptions } from './source-args.ts'

export type { ParsedSource } from './source-args.ts'

export interface ParsedVerifyArgs {
  source: ParsedSource
  siteId: string
  /** Ignored when `samplePaths` is given. */
  sampleSize: number
  samplePaths?: string[]
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
 * `argv` is bare — no `node`/script prefix, same convention as `cli.ts`'s `parseMigrationArgs`.
 *
 * @throws A plain `Error`, never commander's own `CommanderError`.
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
