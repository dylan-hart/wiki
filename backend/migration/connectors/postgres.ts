import { Client } from 'pg'
import type { ClientConfig } from 'pg'
import {
  NotYetImplementedError,
  type SourceAssetFile,
  type SourceConnector,
  type SourceDescription,
  type SourceRecord
} from '../connector.ts'

/** Connection fields, matching `config.sample.yml`'s `db:` block — see
 * `docs/migration/decision-source-scope.md`'s "Connection/authentication surface" section for why
 * this deliberately mirrors this app's own Postgres connection shape, `db.schema` aside (2.x has no
 * equivalent — it always used Postgres's default `public` schema). */
export interface PostgresSourceConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl?: ClientConfig['ssl']
}

/**
 * Columns `checkShape` treats as evidence a table is really 2.5.x's shape, not merely same-named —
 * picked from `docs/migration/2.5x-source-schema.md` to include at least one column added late in the
 * 2.5.x line (`groups.redirectOnLogin`, `2.5.12.js`), so an install below this connector's supported
 * floor is rejected here rather than failing confusingly deep inside a later import step.
 */
const EXPECTED_COLUMNS: Record<string, string[]> = {
  pages: ['id', 'path', 'hash', 'authorId', 'creatorId', 'contentType'],
  users: ['id', 'email', 'providerKey', 'tfaIsActive'],
  groups: ['id', 'name', 'permissions', 'pageRules', 'redirectOnLogin']
}

/**
 * PostgresSourceConnector
 *
 * Opens a read-only connection to a 2.5.x install that already runs on Postgres, and confirms via
 * schema introspection only — never a row read — that `pages`/`users`/`groups` are shaped like 2.5.x.
 * See `docs/migration/decision-source-scope.md` for why this is the only live-database connector kind
 * this connector supports, and for the read-only requirement `connect()` enforces defensively.
 *
 * The entity generators are not implemented here: this connector proves the lifecycle and the
 * introspection check are real, and leaves reading actual rows to the tasks that own each entity
 * (see each generator's `NotYetImplementedError`).
 */
export class PostgresSourceConnector implements SourceConnector {
  readonly kind = 'postgres' as const

  private readonly config: PostgresSourceConfig
  private client: Client | null = null
  private notes: string[] = []
  private detectedVersion: string | undefined

  constructor(config: PostgresSourceConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    const client = new Client({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl,
      application_name: 'Wiki.js 3.0 Migration Connector (read-only)'
    })
    await client.connect()
    try {
      // Defense in depth: this connection must never be able to write to the 2.x source, even by
      // accident — see docs/migration/decision-source-scope.md's "Read-only requirement".
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
      this.notes = await this.checkShape(client)
      this.detectedVersion = await this.detectVersion(client)
    } catch (err) {
      await client.end().catch(() => {})
      throw err
    }
    this.client = client
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end()
      this.client = null
    }
  }

  async describe(): Promise<SourceDescription> {
    if (!this.client) {
      throw new Error('describe() called before a successful connect().')
    }
    return {
      kind: this.kind,
      location: `${this.config.host}:${this.config.port}/${this.config.database}`,
      version: this.detectedVersion,
      notes: this.notes
    }
  }

  /**
   * Confirm `pages`/`users`/`groups` exist and carry the expected 2.5.x columns, rejecting `connect()`
   * otherwise. Schema introspection only — no row from any of these tables is ever read here.
   *
   * @throws When a table is missing, or is missing an expected column.
   */
  private async checkShape(client: Client): Promise<string[]> {
    const notes: string[] = []
    for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
      const res = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      )
      if (res.rows.length === 0) {
        throw new Error(
          `This does not look like a 2.5.x Wiki.js database: table "${table}" was not found.`
        )
      }
      const actualColumns = new Set(res.rows.map((row) => row.column_name))
      const missing = expectedColumns.filter((column) => !actualColumns.has(column))
      if (missing.length > 0) {
        throw new Error(
          `This does not look like a 2.5.x Wiki.js database: table "${table}" is missing expected column(s) ${missing.join(', ')}.`
        )
      }
      notes.push(`"${table}" has all expected 2.5.x columns.`)
    }
    return notes
  }

  /**
   * Best-effort: reads the highest applied 2.x migration name out of `knex_migrations`, per
   * `docs/migration/decision-source-scope.md`'s minimum-version check. Absence is not fatal —
   * `describe()` simply reports no detected version; enforcing the 2.5.12 floor for real is left to
   * the importer tasks that actually read rows.
   */
  private async detectVersion(client: Client): Promise<string | undefined> {
    try {
      const res = await client.query<{ name: string }>(
        `SELECT name FROM knex_migrations ORDER BY id DESC LIMIT 1`
      )
      return res.rows[0]?.name
    } catch {
      return undefined
    }
  }

  users(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('users', 'Task 414 (Users/Groups importer)')
  }

  groups(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('groups', 'Task 414 (Users/Groups importer)')
  }

  pages(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('pages', 'Task 416 (Content importer)')
  }

  pageHistory(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('pageHistory', 'Task 416 (Content importer)')
  }

  tags(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('tags', 'Task 416 (Content importer)')
  }

  navigation(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('navigation', 'Task 420 (Settings/Auth/Storage importer)')
  }

  settings(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('settings', 'Task 420 (Settings/Auth/Storage importer)')
  }

  assets(): AsyncIterable<SourceAssetFile> {
    throw new NotYetImplementedError('assets', 'Task 418 (Assets/Comments importer)')
  }
}
