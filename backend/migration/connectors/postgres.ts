import { Client } from 'pg'
import type { ClientConfig } from 'pg'
import Cursor from 'pg-cursor'
import { Readable } from 'node:stream'
import {
  type SourceAssetFile,
  type SourceConnector,
  type SourceDescription,
  type SourceRecord
} from '../connector.ts'

/** Mirrors `config.sample.yml`'s `db:` block, minus `schema`: 2.x always used Postgres's default
 * `public` schema. */
export interface PostgresSourceConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl?: ClientConfig['ssl']
}

/**
 * Includes a column added late in the 2.5.x line (`groups.redirectOnLogin`, 2.5.12), so an install
 * below the supported floor is rejected at connect rather than deep inside a later import step.
 */
const EXPECTED_COLUMNS: Record<string, string[]> = {
  pages: ['id', 'path', 'hash', 'authorId', 'creatorId', 'contentType'],
  users: ['id', 'email', 'providerKey', 'tfaIsActive'],
  groups: ['id', 'name', 'permissions', 'pageRules', 'redirectOnLogin']
}

/**
 * Read-only connection to a 2.5.x install running on Postgres. `connect()` confirms the 2.5.x shape
 * by schema introspection only — never a row read. `docs/migration/decision-source-scope.md` has why
 * Postgres is the only live-database source supported.
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
      // Defense in depth: this connection must never be able to write to the 2.x source.
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

  /** Best-effort: an unreadable `knex_migrations` just leaves `describe()` without a version. */
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

  /** Matches the 2.x exporter's own batch size for `users.json.gz`. */
  private static readonly USER_BATCH_SIZE = 50

  users(): AsyncIterable<SourceRecord> {
    // Group membership is embedded (`groups: [{id, name}]`) as the export bundle's users.json.gz
    // does, so both connector kinds yield identically-shaped rows.
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
   * Appends `LIMIT`/`OFFSET` to `sql`, so `sql` must not end in a semicolon or carry its own. Its
   * `ORDER BY` must be total (unique per row): each batch is a separate statement, and Postgres may
   * break a tie differently between them, silently duplicating or dropping rows at a batch boundary.
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

  /** Matches the 2.x exporter's own batch size for `pages`/`history`. */
  private static readonly PAGE_BATCH_SIZE = 10

  pages(): AsyncIterable<SourceRecord> {
    // Tags are aggregated inline (`tags: [{tag, title}]`), mirroring the export bundle's
    // pages.json.gz rows: `SourceConnector` has no `pageTags()` generator to join against, and this
    // keeps `content-staging.ts`'s tag resolution identical across connector kinds.
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
    // Naming trap: pageHistoryTags."pageId" targets "pageHistory".id, not pages.id.
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

  /** `SourceConnector` has one settings() generator for 2.x's three config tables, so each row is
   * tagged with `entity` for the caller to route to the matching mapper. Unpaginated: each table
   * holds one small row per key. */
  async *settings(): AsyncIterable<SourceRecord> {
    if (!this.client) {
      throw new Error('Entity generator called before a successful connect().')
    }
    const settingsRes = await this.client.query<SourceRecord>(`SELECT * FROM settings ORDER BY key`)
    for (const row of settingsRes.rows) {
      yield { entity: 'settings', ...row }
    }

    const authRes = await this.client.query<SourceRecord>(
      `SELECT * FROM authentication ORDER BY key`
    )
    for (const row of authRes.rows) {
      yield { entity: 'authentication', ...row }
    }

    const storageRes = await this.client.query<SourceRecord>(`SELECT * FROM storage ORDER BY key`)
    for (const row of storageRes.rows) {
      yield { entity: 'storage', ...row }
    }
  }

  comments(): AsyncIterable<SourceRecord> {
    return this.paginatedQuery(`SELECT * FROM comments ORDER BY id`, [], 100)
  }

  /** folderId -> full relative path, the equivalent of what the 2.x exporter's `getAllPaths()`
   * computes. `assetFolders` is small enough to read whole. */
  private async buildAssetFolderPaths(): Promise<Map<number, string>> {
    if (!this.client) {
      throw new Error('Entity generator called before a successful connect().')
    }
    const res = await this.client.query<{ id: number; name: string; parentId: number | null }>(
      `SELECT id, name, "parentId" FROM "assetFolders"`
    )
    const byId = new Map(res.rows.map((row) => [row.id, row]))
    const pathCache = new Map<number, string>()

    const resolve = (id: number): string => {
      const cached = pathCache.get(id)
      if (cached !== undefined) return cached
      const folder = byId.get(id)
      if (!folder) return ''
      const path = folder.parentId ? `${resolve(folder.parentId)}/${folder.name}` : folder.name
      pathCache.set(id, path)
      return path
    }

    for (const id of byId.keys()) resolve(id)
    return pathCache
  }

  async *assets(): AsyncIterable<SourceAssetFile> {
    if (!this.client) {
      throw new Error('Entity generator called before a successful connect().')
    }
    const folderPaths = await this.buildAssetFolderPaths()

    // A streaming cursor read one row at a time, as the 2.x exporter does: asset bytes are too large
    // to buffer a batch of.
    const cursor = this.client.query(
      new Cursor(
        `SELECT a.id, a.filename, a.mime, a."authorId", a."createdAt", a."updatedAt", a."folderId",
                d.data
         FROM assets a
         JOIN "assetData" d ON d.id = a.id
         ORDER BY a.id`
      )
    )
    try {
      for (;;) {
        const rows = await new Promise<any[]>((resolve, reject) => {
          cursor.read(1, (err: Error | undefined, rows: any[]) =>
            err ? reject(err) : resolve(rows)
          )
        })
        if (rows.length === 0) break
        const row = rows[0]
        const folderPath = row.folderId ? folderPaths.get(row.folderId) : undefined
        const relativePath = folderPath ? `${folderPath}/${row.filename}` : row.filename
        yield {
          relativePath,
          filename: row.filename,
          size: row.data?.length,
          stream: Readable.from(row.data ? [row.data] : []),
          authorId: row.authorId ?? undefined,
          mimeType: row.mime ?? undefined,
          createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
          updatedAt: row.updatedAt ? new Date(row.updatedAt) : undefined
        }
      }
    } finally {
      await new Promise<void>((resolve) => cursor.close(() => resolve()))
    }
  }
}
