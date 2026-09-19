import { Command, InvalidArgumentError } from 'commander'
import type { PostgresSourceConfig } from './connectors/postgres.ts'

export type ParsedSource =
  | { kind: 'postgres'; config: PostgresSourceConfig }
  | { kind: 'export-bundle'; path: string }

export interface SourceRawOptions {
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

/**
 * Adds the source-selection flags every migration CLI shares. `exitOverride()` plus the silenced
 * output are what let `parseArgv()` report a plain `Error` instead of commander printing usage and
 * calling `process.exit`.
 */
export function buildSourceProgram(config: {
  name: string
  description: string
  options: (program: Command) => void
}): Command {
  const program = new Command()
  program.name(config.name).description(config.description)
  config.options(program)
  program
    .option('--bundle-path <path>', 'Path to a 2.x "export to disk" bundle directory')
    .option('--source-host <host>', 'Source Postgres host (live-connection source)')
    .option('--source-port <port>', 'Source Postgres port', '5432')
    .option('--source-database <database>', 'Source Postgres database name')
    .option('--source-user <user>', 'Source Postgres user')
    .option('--source-password <password>', 'Source Postgres password')
    .option('--source-ssl', 'Use SSL for the source Postgres connection', false)
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  return program
}

/**
 * `argv` is bare — no `node`/script prefix.
 *
 * @throws A plain `Error`, never commander's own `CommanderError`.
 */
export function parseArgv<TOptions extends Record<string, any>>(
  program: Command,
  argv: string[]
): TOptions {
  try {
    program.parse(argv, { from: 'user' })
  } catch (err: any) {
    throw new Error(err.message)
  }
  return program.opts<TOptions>()
}

/** `undefined` means the flag was absent; `[]` means it was given but named nothing usable. */
export function splitCommaList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10)
  if (Number.isNaN(port) || port <= 0) {
    throw new InvalidArgumentError(`"${raw}" is not a valid port number.`)
  }
  return port
}

/** @throws A plain `Error` when neither source kind was given completely. */
export function resolveSource(opts: SourceRawOptions): ParsedSource {
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
