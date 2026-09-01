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
 * `pages()`, `pageHistory()`, `tags()`, `navigation()`, `users()` and `groups()` are implemented for
 * real via plain SQL against the connected client — the rest (`settings()`, `assets()`) remain
 * `NotYetImplementedError` stubs, deferred to the tasks that own those entities.
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

  /** Batch size mirrors `PAGE_BATCH_SIZE`'s reasoning at a smaller row size, matching the
   * export-bundle exporter's own 50/batch for `users.json.gz`
   * (`docs/migration/2.5x-export-bundle-format.md`). */
  private static readonly USER_BATCH_SIZE = 50

  users(): AsyncIterable<SourceRecord> {
    // Embeds group membership the same way the export-bundle format's users.json.gz does
    // (`{ groups: [{id, name}] }`) — see connector.ts's own doc comment on why users() carries this
    // rather than exposing a separate userGroups() generator. Both connector kinds hand callers an
    // identically-shaped users() row this way.
    return this.paginatedQuery(
      `SELECT u.*, COALESCE(
         json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.id)
           FILTER (WHERE g.id IS NOT NULL),
         '[]'
       ) AS groups
       FROM users u
       LEFT JOIN "userGroups" ug ON ug."userId" = u.id
       LEFT JOIN groups g ON g.id = ug."groupId"
       GROUP BY u.id
       ORDER BY u.id`,
      [],
      PostgresSourceConnector.USER_BATCH_SIZE
    )
  }

  groups(): AsyncIterable<SourceRecord> {
    return this.paginatedQuery(`SELECT * FROM groups ORDER BY id`, [], 100)
  }

  /**
   * Runs `sql` (with a trailing `LIMIT`/`OFFSET` this appends) repeatedly, batch by batch, so a large
   * table is never held in memory all at once — `docs/migration/2.5x-export-bundle-format.md`'s
   * "Implications" note to mirror the exporter's own batch sizes applies here too, even though this is
   * the live-Postgres path rather than a bundle. `sql` must not itself end in a semicolon or already
   * contain `LIMIT`/`OFFSET`, and its `$n` placeholders must line up with `params`. `sql`'s `ORDER BY`
   * must also be total (unique per row) — this method re-issues `sql` once per batch as separate
   * statements with different `OFFSET`s, so a tied `ORDER BY` lets Postgres break ties differently
   * between them, silently duplicating or dropping rows across the batch boundary.
   */
  private async *paginatedQuery(
    sql: string,
    params: unknown[],
    batchSize: number
  ): AsyncGenerator<SourceRecord> {
    if (!this.client) {
      throw new Error('Entity generator called before a successful connect().')
    }
    const client = this.client
    let offset = 0
    for (;;) {
      const res = await client.query<SourceRecord>(
        `${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, batchSize, offset]
      )
      for (const row of res.rows) yield row
      if (res.rows.length < batchSize) return
      offset += batchSize
    }
  }

  /** Batch size mirrors the exporter's own `pages`/`history` batching (`2.5x-export-bundle-format.md`:
   * "Batch size is 10 for `pages`/`history`"), for the same reason: a workable unit of rows to hold in
   * memory at a time without buffering a whole table. */
  private static readonly PAGE_BATCH_SIZE = 10

  pages(): AsyncIterable<SourceRecord> {
    // Tags are resolved here via a join+aggregate rather than exposed as a separate generator to walk
    // against `tags()`/`pageTags` — the `SourceConnector` interface has no `pageTags()` generator at
    // all, so a caller has nothing else to join `pages()` rows against; this mirrors the export
    // bundle's own `pages.json.gz` shape (`tags: [{tag, title}]` inline on each row), so
    // `content-staging.ts`'s tag resolution works identically against either connector kind.
    return this.paginatedQuery(
      `SELECT p.*, COALESCE(
         json_agg(json_build_object('tag', t.tag, 'title', t.title) ORDER BY t.tag)
           FILTER (WHERE t.id IS NOT NULL),
         '[]'
       ) AS tags
       FROM pages p
       LEFT JOIN "pageTags" pt ON pt."pageId" = p.id
       LEFT JOIN tags t ON t.id = pt."tagId"
       GROUP BY p.id
       ORDER BY p.id`,
      [],
      PostgresSourceConnector.PAGE_BATCH_SIZE
    )
  }

  pageHistory(): AsyncIterable<SourceRecord> {
    // Same tag-resolution rationale as pages() above, joined through pageHistoryTags instead of
    // pageTags — note the naming trap 2.5x-source-schema.md flags: pageHistoryTags."pageId" targets
    // "pageHistory".id, not pages.id, which is exactly what this join does.
    return this.paginatedQuery(
      `SELECT ph.*, COALESCE(
         json_agg(json_build_object('tag', t.tag, 'title', t.title) ORDER BY t.tag)
           FILTER (WHERE t.id IS NOT NULL),
         '[]'
       ) AS tags
       FROM "pageHistory" ph
       LEFT JOIN "pageHistoryTags" pht ON pht."pageId" = ph.id
       LEFT JOIN tags t ON t.id = pht."tagId"
       GROUP BY ph.id
       ORDER BY ph."pageId", ph."versionDate", ph.id`,
      [],
      PostgresSourceConnector.PAGE_BATCH_SIZE
    )
  }

  tags(): AsyncIterable<SourceRecord> {
    return this.paginatedQuery(`SELECT * FROM tags ORDER BY id`, [], 100)
  }

  navigation(): AsyncIterable<SourceRecord> {
    return this.paginatedQuery(`SELECT * FROM navigation ORDER BY key`, [], 100)
  }

  settings(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('settings', 'Task 420 (Settings/Auth/Storage importer)')
  }

  comments(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('comments', 'Task 9 (this plan)')
  }

  assets(): AsyncIterable<SourceAssetFile> {
    throw new NotYetImplementedError('assets', 'Task 418 (Assets/Comments importer)')
  }
}
