import type { Readable } from 'node:stream'

/**
 * `'postgres'` is a live connection to a 2.x install already running on Postgres; `'export-bundle'`
 * is a 2.x Export-to-Disk bundle read from disk, the only supported path for a source on
 * MySQL/MariaDB/MSSQL/SQLite (`docs/migration/decision-source-scope.md`).
 */
export type SourceKind = 'postgres' | 'export-bundle'

/** What was actually found at the source, not what the connector was configured to expect. */
export interface SourceDescription {
  kind: SourceKind
  /** e.g. `host:port/db`, or a directory path. */
  location: string
  version?: string
  notes: string[]
}

/**
 * Deliberately untyped beyond "a plain object": every entity's column set is already recorded
 * column-by-column in `docs/migration/2.5x-source-schema.md` and mapped onto 3.0 in
 * `docs/migration/2.5x-to-3.0-mapping.md`, and a duplicate TypeScript shape here would drift from
 * those the moment either changes.
 */
export type SourceRecord = Record<string, unknown>

/** Carries a stream, never the full bytes, so an importer never buffers a whole asset in memory. */
export interface SourceAssetFile {
  /** Relative to the source's asset root (`folder/sub/image.png`) — both connector kinds normalize
   * onto the bundle format's own `assets/{folderPath}/{filename}` layout. */
  relativePath: string
  filename: string
  size?: number
  stream: Readable
  /** Postgres-direct only: an Export-to-Disk bundle writes raw bytes with no per-asset metadata
   * sidecar. Absent means "resolve to the operator running the import", the same fallback
   * `id-map.ts#resolveActorId` gives an unmapped page or comment author. */
  authorId?: number
  /** Postgres-direct only, same reason as `authorId`. Absent means "derive it from the filename
   * extension", which `models/assets.ts#upload()` already does for an upload with no declared type. */
  mimeType?: string
  /** Postgres-direct only, same reason as `authorId`; absent leaves the destination row on
   * `upload()`'s ordinary `now()` default rather than the source's real date. */
  createdAt?: Date
  updatedAt?: Date
}

export class NotYetImplementedError extends Error {
  constructor(method: string, task: string) {
    super(`${method}() is not implemented yet — deferred to ${task}.`)
    this.name = 'NotYetImplementedError'
  }
}

/**
 * The two implementations are not equally complete. `PostgresSourceConnector` implements every
 * generator for real; `ExportBundleSourceConnector` implements only the entities a bundle actually
 * carries and throws `NotYetImplementedError` from the rest. Both the phase harness
 * (`phases/define-phase.ts`) and the verifier (`verify.ts`) treat that error as a per-entity "not
 * implemented" rather than a run-ending fault.
 *
 * Every generator is an async iterable so an importer can stream rows/files rather than buffer an
 * entire table or bundle in memory.
 */
export interface SourceConnector {
  readonly kind: SourceKind

  /**
   * Confirms the source actually looks like a 2.5.x one before returning.
   *
   * @throws When the source cannot be reached, or does not look like a 2.5.x source.
   */
  connect(): Promise<void>

  /** Safe to call even if `connect()` was never called. */
  disconnect(): Promise<void>

  /** @throws If called before a successful `connect()`. */
  describe(): Promise<SourceDescription>

  /** Each row carries its group membership denormalized, so both connector kinds yield the same
   * shape. */
  users(): AsyncIterable<SourceRecord>
  groups(): AsyncIterable<SourceRecord>
  /** Current content only — revisions come from `pageHistory()`. */
  pages(): AsyncIterable<SourceRecord>
  pageHistory(): AsyncIterable<SourceRecord>
  tags(): AsyncIterable<SourceRecord>
  /** A bundle's `{key: config}` object is re-expanded into rows, matching the 2.x table. */
  navigation(): AsyncIterable<SourceRecord>
  /** The core `settings` table plus the per-module config tables (`authentication`, `storage`,
   * `renderers`, ...), which a bundle source keeps separate rather than collapsing onto one flat
   * table — `2.5x-export-bundle-format.md`'s "Implications" section has why. */
  settings(): AsyncIterable<SourceRecord>
  comments(): AsyncIterable<SourceRecord>
  assets(): AsyncIterable<SourceAssetFile>
}
