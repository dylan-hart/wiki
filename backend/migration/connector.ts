import type { Readable } from 'node:stream'

/**
 * Which kind of 2.x source a connector reads from.
 *
 * Exactly these two, per `docs/migration/decision-source-scope.md`: a live Postgres connection to a
 * 2.x install that already runs on Postgres, or a 2.x Export-to-Disk bundle read from disk (the only
 * supported path for MySQL/MariaDB/MSSQL/SQLite).
 */
export type SourceKind = 'postgres' | 'export-bundle'

/**
 * What `describe()` reports once `connect()` has succeeded: what was actually found at the source,
 * not what the connector was configured to expect.
 */
export interface SourceDescription {
  kind: SourceKind
  /** Human-readable identification of the concrete source, e.g. `host:port/db` or a directory path. */
  location: string
  /** The 2.x version detected, when the source carries enough signal to determine one. */
  version?: string
  /** Free-form notes on what was checked and found — surfaced to an administrator running the migration. */
  notes: string[]
}

/**
 * A source row/record for an entity a later importer task will map onto a 3.0 table.
 *
 * Deliberately untyped beyond "a plain object": the exact column set for every entity this interface
 * exposes is already recorded column-by-column in `docs/migration/2.5x-source-schema.md` and mapped
 * onto 3.0 in `docs/migration/2.5x-to-3.0-mapping.md`. Pinning a duplicate TypeScript shape here would
 * drift from those docs the moment either changes, for no benefit — the generator bodies that
 * actually read and transform rows (Tasks 414/416/418/420) are what needs the real shape, and they
 * read it directly off the source connector's own query/file result.
 */
export type SourceRecord = Record<string, unknown>

/**
 * One file entry under an `assets` export — the connector hands back a stream, never the full bytes,
 * so an importer never has to buffer a whole asset (potentially large) in memory.
 */
export interface SourceAssetFile {
  /** Path relative to the source's asset root, e.g. `folder/sub/image.png` — see `folderPath` in
   * `docs/migration/2.5x-export-bundle-format.md`'s `assets/{folderPath}/{filename}` layout, which
   * both connector kinds normalize onto. */
  relativePath: string
  filename: string
  /** Byte size when known up front (Postgres: from the row; export bundle: from `fs.stat`). */
  size?: number
  stream: Readable
  /** The 2.x integer `authorId`, when the connector kind can supply it. Postgres-direct reads it
   * straight off the source `assets` row; export-bundle cannot — per
   * `docs/migration/2.5x-export-bundle-format.md`, an Export-to-Disk bundle writes only raw bytes at
   * a file path, with no per-asset metadata sidecar at all. Absent means "resolve to the operator
   * running the import," the same fallback `id-map.ts`'s `resolveActorId` already gives an
   * unmapped/missing page or comment author. */
  authorId?: number
  /** Declared MIME type from the source row, when available (Postgres-direct only — same reasoning
   * as `authorId`). Absent means "derive it from the filename extension," the same fallback
   * `models/assets.ts#upload()` already applies to any upload with no declared type. */
  mimeType?: string
  /** Source `createdAt`/`updatedAt`, when available (Postgres-direct only). Absent means the
   * destination row gets today's date — a documented, accepted gap (see
   * `docs/variances.md`'s asset-import-timestamps entry, Task 17). */
  createdAt?: Date
  updatedAt?: Date
}

/**
 * Thrown by a generator method whose body a later task (named in the message) owns implementing.
 *
 * `connect()` / `disconnect()` / `describe()` are real on every connector below; the entity
 * generators are not, until the task that owns that entity implements them against this interface —
 * see the task-by-task deferral this error names.
 */
export class NotYetImplementedError extends Error {
  constructor(method: string, task: string) {
    super(`${method}() is not implemented yet — deferred to ${task}.`)
    this.name = 'NotYetImplementedError'
  }
}

/**
 * SourceConnector
 *
 * The thin interface every later importer feature (414 Users/Groups, 416 Content, 418
 * Assets/Comments, 420 Settings/Auth/Storage) reads a 2.5.x source through, regardless of which of
 * the two supported source kinds it is (`docs/migration/decision-source-scope.md`): a live Postgres
 * connection, or a 2.x Export-to-Disk bundle read from disk.
 *
 * The two implementations are not equally complete. `PostgresSourceConnector` implements every
 * generator for real. `ExportBundleSourceConnector` implements only the entities a bundle actually
 * carries — `pages()`, `pageHistory()`, `tags()`, `navigation()` — and throws
 * `NotYetImplementedError` from `users()`, `groups()`, `settings()`, `comments()` and `assets()`;
 * bundle write support for those is out of scope, and both the phase harness
 * (`phases/define-phase.ts`) and the verifier (`verify.ts`) treat that error as a per-entity
 * "not implemented" rather than a run-ending fault.
 *
 * Every generator is an async iterable so an importer can stream rows/files rather than buffer an
 * entire table or bundle in memory — the same lesson `2.5x-export-bundle-format.md` draws from the
 * upstream exporter's own unbounded batch-fetch loop, applied to the read side this time.
 */
export interface SourceConnector {
  readonly kind: SourceKind

  /**
   * Open the connection/handle to the source (a `pg` connection, or a directory handle) and confirm
   * it actually looks like a 2.5.x source before returning.
   *
   * @throws When the source cannot be reached, or does not look like a 2.5.x source.
   */
  connect(): Promise<void>

  /** Release whatever `connect()` opened. Safe to call even if `connect()` was never called. */
  disconnect(): Promise<void>

  /**
   * What was found at the source once connected: kind, location, detected version and any notes.
   *
   * @throws If called before a successful `connect()`.
   */
  describe(): Promise<SourceDescription>

  /** `users` table rows, denormalized group membership included per Task 414's own design. */
  users(): AsyncIterable<SourceRecord>
  /** `groups` table rows. */
  groups(): AsyncIterable<SourceRecord>
  /** `pages` table rows (current content only — see `pageHistory` for revisions). */
  pages(): AsyncIterable<SourceRecord>
  /** `pageHistory` table rows, one per historical revision. */
  pageHistory(): AsyncIterable<SourceRecord>
  /** `tags` table rows. */
  tags(): AsyncIterable<SourceRecord>
  /** `navigation` table rows (or, for a bundle, its `{key: config}` object re-expanded into rows). */
  navigation(): AsyncIterable<SourceRecord>
  /** Settings-adjacent records: the core `settings` table plus the per-module config tables
   * (`authentication`, `storage`, `renderers`, ...) — see the "Implications" section of
   * `2.5x-export-bundle-format.md` for why these do not collapse onto one flat table for a bundle
   * source. The exact grouping is Task 420's to decide when it implements this generator's body. */
  settings(): AsyncIterable<SourceRecord>
  /** `comments` table rows. */
  comments(): AsyncIterable<SourceRecord>
  /** One entry per asset file, each carrying a readable stream rather than the file's full bytes. */
  assets(): AsyncIterable<SourceAssetFile>
}
