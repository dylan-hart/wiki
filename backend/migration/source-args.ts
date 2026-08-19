import { Command, InvalidArgumentError } from 'commander'
import type { PostgresSourceConfig } from './connectors/postgres.ts'

/**
 * The 2.x source a CLI invocation resolved to, shared between `../tasks/migrate.ts`'s CLI (`cli.ts`)
 * and `../tasks/verify-migration.ts`'s CLI (`verify-cli.ts`) — both need to open the exact same kind of
 * connection to the same source, just for different purposes (import vs. post-import verification).
 */
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

/** Adds the source-selection flags (`--bundle-path` or the discrete `--source-*` Postgres fields)
 * shared by every migration-CLI entry point onto `program`, returning it for chaining. */
export function addSourceOptions(program: Command): Command {
  return program
    .option('--bundle-path <path>', 'Path to a 2.x "export to disk" bundle directory')
    .option('--source-host <host>', 'Source Postgres host (live-connection source)')
    .option('--source-port <port>', 'Source Postgres port', '5432')
    .option('--source-database <database>', 'Source Postgres database name')
    .option('--source-user <user>', 'Source Postgres user')
    .option('--source-password <password>', 'Source Postgres password')
    .option('--source-ssl', 'Use SSL for the source Postgres connection', false)
}

export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10)
  if (Number.isNaN(port) || port <= 0) {
    throw new InvalidArgumentError(`"${raw}" is not a valid port number.`)
  }
  return port
}

/**
 * Resolves the source-selection flags into exactly one `ParsedSource`: an export bundle path, or a
 * complete set of discrete Postgres fields. Shared validation logic for every migration-CLI entry
 * point, so a typo or an incomplete source is rejected identically wherever it is given.
 *
 * @throws A plain `Error` when neither source kind was given completely.
 */
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
