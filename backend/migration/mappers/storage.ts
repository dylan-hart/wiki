import { pickDefined, transformConfig } from './shared.ts'
import type { SourceRecord } from '../connector.ts'
import type { ConfigTransform } from './shared.ts'

/**
 * `mapStorageRow(s)` (task 767 — "Storage-target mapper, scoped per created site")
 *
 * A pure transform: no DB access, no side effects. Takes 2.5.x `storage` table rows
 * (`docs/migration/2.5x-source-schema.md`'s `## storage` section) and produces 3.0 `storage` row
 * **UPDATE** payloads — per `docs/migration/2.5x-to-3.0-mapping.md`'s `## storage` column mapping
 * and `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 3 module inventory.
 *
 * ## Update, never insert
 *
 * Unlike `authentication` (which has no seeded rows to land on), every site already owns exactly one
 * `storage` row per installed module the moment it exists: `Storage.syncSite`
 * (`backend/models/storage.ts:227-260`) inserts one row per definition on disk at site-creation
 * time, and `(siteId, module)` is a unique index (`backend/db/schema.ts:671`). So this mapper never
 * produces an insert — its output is a `{ siteId, module, values }` **patch**, meant to be applied as
 * `UPDATE storage SET ... WHERE siteId = ? AND module = ?` (or the equivalent
 * `WIKI.models.storage.updateTarget` call, once the caller has that site's already-synced
 * `StorageTarget` row in hand) against a row that is guaranteed to already exist. Producing an insert
 * here would either race `syncSite` or violate the unique index outright.
 *
 * `config` is checked and completed the same way the live admin API does it
 * (`backend/api/storage.ts`'s update route): `Storage.validateConfig(module, incoming)` first — a row
 * whose config doesn't fit the target module's declared prop types is never silently miscoerced, it
 * comes back `flagged` — then `Storage.buildConfig(module, incoming, {})` to fill in every declared
 * prop (module defaults for anything 2.x never had). This module never constructs its own copy of
 * that logic; it takes a `StorageModuleResolver` (the real `WIKI.models.storage` singleton satisfies
 * it structurally) so the mapper and the model can never drift apart on what a "valid" config is.
 *
 * ## Explicit module-directory enumeration, not assumed 1:1 parity
 *
 * 3.0 ships exactly seven storage modules — `KNOWN_3_0_STORAGE_MODULES` below enumerates them
 * (`azure`, `db`, `disk`, `gcs`, `git`, `s3`, `sftp`), matching `backend/modules/storage/`'s actual
 * directory listing (cross-checked live via `readdirSync` in this module's test, mirroring Feature
 * 412's/task 763's precedent). 2.x shipped eleven; per
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 3, six of those eleven 2.x keys
 * have no `modules/storage/<key>/` directory here at all — `box`, `digitalocean`, `dropbox`,
 * `gdrive`, `onedrive`, `s3generic` — and are confirmed **NO DESTINATION**. This mapper checks every
 * source row's `key` against the enumerated list explicitly (not merely "whatever
 * `resolver.getDefinition()` happens to return today"), so a module quietly removed from disk without
 * this list being updated fails loudly in the enumeration cross-check test rather than silently
 * degrading into "resolver said no, so it must be fine". A row whose key isn't on the list — or is
 * on the list but the resolver has no definition loaded for it — comes back `status: 'unsupported'`,
 * no row written, mirroring the `authentication` mapper's (task 765) `getModule()`-returns-`null`
 * precedent and Feature 414's provider-fallback precedent before that.
 *
 * `db` and `gcs` are on the enumerated list but never actually matched by a 2.x row: `db` (content
 * straight in Postgres) and `gcs` (Google Cloud Storage) are new 3.0-only capabilities with no 2.x
 * counterpart at all, confirmed by the field-mapping doc. `digitalocean`/`s3generic` are S3-compatible
 * targets that a naive reading might assume fold into 3.0's `s3` module's `mode: 'do'|'custom'`
 * selector — per the field-mapping doc, they do not: 2.x stored them as entirely separate module
 * `key`s with their own row, so folding one into a site's `s3` row would be a genuine cross-row merge
 * (and only safe if that row doesn't already have its own separate `s3` config), which is out of this
 * mapper's per-row scope and left as the NO DESTINATION case the doc already calls it.
 *
 * ## `mode` / `syncInterval`, now mapped
 *
 * `StorageTarget.sync.mode` and `sync.scheduleOverride` (`backend/models/storage.ts`) gave these two
 * a real 3.0 destination, closing the gap `docs/variances.md` used to track. `mode` copies straight
 * across as `syncMode` when the source value is one of the target module's own declared
 * `supportedModes` (`disk`/`s3`/`sftp`/`azure`/`gcs`/`db` only ever support `push`; `git` supports
 * `sync`/`push`/`pull`, matching what 2.x itself constrained the field to be in practice, per
 * `docs/migration/2.5x-source-schema.md`'s note on the `mode` column). `syncInterval` needs an actual
 * conversion, not a rename: 2.x stored it as a raw five-field cron expression (confirmed by
 * `migration/mappers/fixtures/2.5x-storage.json`'s real-shaped sample, e.g. `*\/15 * * * *`), while
 * 3.0's `scheduleOverride` is a plain ISO-8601 duration (`PT15M`) — a repeating interval, not a full
 * cron trigger. `convertSyncInterval` below converts the two cron shapes that have a lossless
 * duration equivalent ("every N minutes", "every N hours"); anything else a cron expression can
 * express (a specific minute/hour, a day-of-week restriction, …) has no duration equivalent at all.
 *
 * Either conversion can still come up empty — an unsupported `mode`, or a `syncInterval` cron shape
 * outside the two convertible ones — and that source value genuinely has nowhere to go. Rather than
 * the `authentication` mapper's precedent for its own unmapped column (`order`, silently never read
 * at all — see that module's doc), this mapper reports whichever of the two remain unconverted:
 * `droppedFields.mode` and/or `droppedFields.syncInterval` are set only for a field that had a source
 * value but could not be mapped, so a caller building a migration report (Feature 421) can still
 * surface exactly what was lost instead of it silently vanishing. `state` is left untouched by this
 * mapper for the same "no clean transform" reason: 2.x's `state` was module-defined free-form json
 * with no setup-wizard concept, whereas 3.0 pins the shape to `{ setup:
 * 'notconfigured'|'pendinginstall'|'configured' }` — there is no source value that means anything in
 * that shape, so the row's already-synced `state` (set by `syncSite`) is left as-is rather than
 * guessing at a mapping that doesn't exist.
 *
 * ## Per-site replay, no cross-call state
 *
 * `(siteId, module)` is already the table's own uniqueness boundary, so two calls with different
 * `siteId`s can never collide with each other — there is nothing to thread across calls. `siteId` is
 * simply a required parameter on every call (not a caller-shared mutable object), and the same source
 * row can be replayed against as many target sites as needed by calling this mapper once per target
 * site with the same source rows.
 */

// ---------------------------------------------------------------------------
// Source row shape
// ---------------------------------------------------------------------------

/**
 * One row as read from a 2.5.x `storage` table (`docs/migration/2.5x-source-schema.md`'s `## storage`
 * section). Unlike `authentication`, `storage.key` doubles directly as the module directory name —
 * there is no separate `strategyKey`/`key` split to resolve.
 */
export interface SourceStorageRow extends SourceRecord {
  key: string
  isEnabled: boolean
  /** `'sync' | 'push' | 'pull'` in practice, but the 2.x column was never a checked enum (see the
   * source-schema doc) — mapped to `syncMode` when it is one of the target module's own
   * `supportedModes`, reported in `droppedFields.mode` otherwise. */
  mode: unknown
  config: unknown
  /** A raw five-field cron expression in practice (see the module doc) — converted to an ISO-8601
   * `scheduleOverride` where the shape allows it, reported in `droppedFields.syncInterval`
   * otherwise. */
  syncInterval: unknown
  /** Left untouched by this mapper — see the module doc's "mode / syncInterval" section. */
  state: unknown
}

// ---------------------------------------------------------------------------
// Model dependency — the real `WIKI.models.storage` singleton satisfies this structurally. Kept as a
// narrow interface (rather than importing the class) so this mapper is unit-testable without a live
// DB: none of `getDefinition`/`buildConfig`/`validateConfig` touch `WIKI.db`, only
// `WIKI.models.storage.definitions` (populated from disk by `refreshFromDisk()`), mirroring the
// `authentication` mapper's `AuthModuleResolver` precedent exactly.
// ---------------------------------------------------------------------------

export interface StorageModuleResolver {
  /** `null` when no module on disk declares this key — the unsupported-module signal this mapper
   * reports on rather than guessing at. `supportedModes` is what `mode` is validated against. */
  getDefinition(key: string): { title: string; supportedModes: string[] } | null
  buildConfig(
    moduleKey: string,
    incoming?: Record<string, any>,
    existing?: Record<string, any>
  ): Record<string, any>
  /** The reason `incoming` doesn't fit the module's declared props, or `null` when it's fine. */
  validateConfig(moduleKey: string, incoming?: Record<string, any>): string | null
}

// ---------------------------------------------------------------------------
// Explicit 3.0 module-directory enumeration — see the module doc's "Explicit module-directory
// enumeration" section for why this exists alongside `resolver.getDefinition()` rather than instead
// of it.
// ---------------------------------------------------------------------------

export const KNOWN_3_0_STORAGE_MODULES = [
  'azure',
  'db',
  'disk',
  'gcs',
  'git',
  's3',
  'sftp'
] as const

// ---------------------------------------------------------------------------
// Per-module config remap — the "key-by-key remap required, module by module" step
// `2.5x-to-3.0-mapping.md` calls for. Everything not picked here is simply absent from `incoming`;
// `buildConfig` fills it from the module's own default, and `validateConfig` skips undeclared keys
// entirely, so there is no need to explicitly strip a 2.x-only prop like git's `alwaysNamespace`
// (confirmed NO DESTINATION by the mapping doc) — it is simply never picked, so it never reaches
// either function. `db` and `gcs` have no transform because no 2.x row can ever carry that key (see
// the module doc).
// ---------------------------------------------------------------------------

const CONFIG_TRANSFORMS: Record<string, ConfigTransform> = {
  disk: (raw) => pickDefined(raw, ['path', 'createDailyBackups']),
  sftp: (raw) =>
    pickDefined(raw, [
      'host',
      'port',
      'authMode',
      'username',
      'privateKey',
      'passphrase',
      'password',
      'basePath'
    ]),
  /**
   * Prop names are identical on both sides, but `storageTier`'s enum **values** are not:
   * 2.x stores `'Hot'`/`'Cool'` (title-cased, no value/label split); 3.0 declares
   * `hot|Hot`/`cool|Cool` — the value half is lower-case. A 2.x `config.storageTier: 'Cool'` copied
   * verbatim fails `validateConfig`'s enum check (which compares against the pre-`|` value half), so
   * it is lower-cased here rather than copied straight across.
   */
  azure: (raw) => {
    const result = pickDefined(raw, ['accountName', 'accountKey', 'containerName'])
    if (typeof raw.storageTier === 'string' && raw.storageTier.length > 0) {
      result.storageTier = raw.storageTier.toLowerCase()
    }
    return result
  },
  /**
   * `sshPrivateKeyMode`'s enum **values** were renamed, not just relabeled: 2.x uses
   * `'path'`/`'contents'`; 3.0 uses `'path'`/`'inline'`. `alwaysNamespace` has no 3.0 prop with that
   * name or an equivalent (confirmed NO DESTINATION) and is simply never picked. `branch`'s default
   * changed (`'master'` -> `'main'`) but that only matters for a row that never had one set, and an
   * explicit value copies straight across either way, so no transform is needed for it.
   */
  git: (raw) => {
    const result = pickDefined(raw, [
      'authType',
      'repoUrl',
      'branch',
      'sshPrivateKeyPath',
      'sshPrivateKeyContent',
      'verifySSL',
      'basicUsername',
      'basicPassword',
      'defaultEmail',
      'defaultName',
      'localRepoPath',
      'gitBinaryPath'
    ])
    if (raw.sshPrivateKeyMode === 'contents') {
      result.sshPrivateKeyMode = 'inline'
    } else if (typeof raw.sshPrivateKeyMode === 'string' && raw.sshPrivateKeyMode.length > 0) {
      result.sshPrivateKeyMode = raw.sshPrivateKeyMode
    }
    return result
  },
  /**
   * 2.x has a single flat, free-text `region` string (AWS-only — the module never supported anything
   * else). 3.0 splits this into a `mode` selector plus per-mode region props; a 2.x row's `region`
   * maps to 3.0's `awsRegion` **and** requires synthesizing `mode: 'aws'` explicitly, since 2.x never
   * recorded a mode and 3.0 has no default that infers one.
   */
  s3: (raw) => {
    const result = pickDefined(raw, ['bucket', 'accessKeyId', 'secretAccessKey'])
    result.mode = 'aws'
    if (typeof raw.region === 'string' && raw.region.length > 0) {
      result.awsRegion = raw.region
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type StorageRowStatus = 'updated' | 'unsupported' | 'flagged'

/** What this mapper's output is applied with — an `UPDATE ... WHERE siteId = ? AND module = ?`, never
 * an insert. `values` names `isEnabled`/`config` unconditionally, plus `syncMode`/`scheduleOverride`
 * when `mode`/`syncInterval` actually converted (see the module doc) — omitted, not written as
 * `undefined`, when they didn't, so an unconvertible source value leaves the row's existing/default
 * sync settings alone rather than clobbering them with nothing. Deliberately not derived from
 * `typeof storageTable.$inferInsert` — the `jsonb()` `config` column has no declared shape there
 * (it infers as `{}`), which is far narrower than the `Record<string, any>` a module's actual props
 * produce. */
export interface StorageUpdatePayload {
  siteId: string
  module: string
  values: {
    isEnabled: boolean
    config: Record<string, any>
    syncMode?: string
    scheduleOverride?: string
  }
}

export interface StorageRowResult {
  /** The source row's 2.x `key`, which is also the module directory name — `storage` has no separate
   * strategy/module split the way `authentication` does. */
  sourceKey: string
  module: string
  siteId: string
  status: StorageRowStatus
  /** Present only when `status === 'updated'`. */
  update?: StorageUpdatePayload
  /** Only the field(s) that had a source value but could not be converted — an unsupported `mode`, or
   * a `syncInterval` cron shape outside the two convertible ones (see the module doc). Absent
   * entirely once both convert cleanly, and always absent for `unsupported`/`flagged` rows, since
   * nothing about that row transferred at all. */
  droppedFields?: { mode?: unknown; syncInterval?: unknown }
  /** Required for every non-`updated` status. */
  message?: string
}

export interface StorageMappingResult {
  /** One entry per source row, in read order, whatever its outcome. */
  results: StorageRowResult[]
}

export interface MapStorageRowOptions {
  resolver: StorageModuleResolver
  /** The 3.0 site this source row's config is being replayed against. Required, and carries no
   * cross-call state — see the module doc's "Per-site replay, no cross-call state" section. */
  siteId: string
}

// ---------------------------------------------------------------------------
// mode / syncInterval conversion — see the module doc's "mode / syncInterval, now mapped" section
// ---------------------------------------------------------------------------

/** `mode` maps straight across, but only when the target module actually declares it — an
 * unsupported value (or a module that only ever runs one mode) is left unmapped. */
function convertSyncMode(value: unknown, supportedModes: readonly string[]): string | null {
  return typeof value === 'string' && supportedModes.includes(value) ? value : null
}

const EVERY_N_MINUTES = /^\*\/(\d+) \* \* \* \*$/
const EVERY_N_HOURS = /^0 \*\/(\d+) \* \* \*$/

/**
 * Converts 2.x's cron-shaped `syncInterval` into the ISO-8601 duration `scheduleOverride` expects.
 * Only "every N minutes" (`*\/N * * * *`) and "every N hours" (`0 *\/N * * *`) have a lossless
 * duration equivalent — anything else a cron expression can express (a pinned minute/hour, a
 * day-of-week restriction, …) has none, and is left unconverted. An already-ISO-8601 value passes
 * through as-is (verified with the same `Temporal.Duration.from()` parse `models/storage.ts` itself
 * validates `scheduleOverride` with), in case a source ever holds one directly.
 */
function convertSyncInterval(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  try {
    Temporal.Duration.from(trimmed)
    return trimmed
  } catch {
    // -> Not already an ISO-8601 duration; fall through to the cron-shape check below
  }
  const everyNMinutes = EVERY_N_MINUTES.exec(trimmed)
  if (everyNMinutes) {
    return `PT${everyNMinutes[1]}M`
  }
  const everyNHours = EVERY_N_HOURS.exec(trimmed)
  if (everyNHours) {
    return `PT${everyNHours[1]}H`
  }
  return null
}

/** Maps one 2.x `storage` row. See the module doc for the full policy; `mapStorageRows` is the usual
 * entry point, this is exposed for a caller that wants to stream rows one at a time. */
export function mapStorageRow(
  row: SourceStorageRow,
  options: MapStorageRowOptions
): StorageRowResult {
  const { resolver, siteId } = options
  const module = typeof row.key === 'string' ? row.key : String(row.key ?? '?')

  const isKnownModule = (KNOWN_3_0_STORAGE_MODULES as readonly string[]).includes(module)
  const definition = isKnownModule ? resolver.getDefinition(module) : null
  if (!isKnownModule || !definition) {
    return {
      sourceKey: module,
      module,
      siteId,
      status: 'unsupported',
      message: isKnownModule
        ? `module '${module}' is on the enumerated 3.0 module list but has no definition loaded — check that backend/modules/storage/${module}/definition.yml exists and parses`
        : `source storage key '${module}' has no matching 3.0 module directory (checked against the explicit enumeration azure/db/disk/gcs/git/s3/sftp) — see docs/migration/2.5x-settings-auth-storage-field-mapping.md's Part 3 module inventory`
    }
  }

  const incoming = transformConfig(CONFIG_TRANSFORMS, module, row.config)
  const validationError = resolver.validateConfig(module, incoming)
  if (validationError) {
    return {
      sourceKey: module,
      module,
      siteId,
      status: 'flagged',
      message: `config for module '${module}' failed validation after remapping: ${validationError}`
    }
  }

  const syncMode = convertSyncMode(row.mode, definition.supportedModes)
  const scheduleOverride = convertSyncInterval(row.syncInterval)

  const values: StorageUpdatePayload['values'] = {
    isEnabled: !!row.isEnabled,
    config: resolver.buildConfig(module, incoming, {})
  }
  if (syncMode !== null) {
    values.syncMode = syncMode
  }
  if (scheduleOverride !== null) {
    values.scheduleOverride = scheduleOverride
  }

  const droppedFields: { mode?: unknown; syncInterval?: unknown } = {}
  if (syncMode === null && row.mode !== undefined && row.mode !== null) {
    droppedFields.mode = row.mode
  }
  if (scheduleOverride === null && row.syncInterval !== undefined && row.syncInterval !== null) {
    droppedFields.syncInterval = row.syncInterval
  }

  const update: StorageUpdatePayload = { siteId, module, values }

  return {
    sourceKey: module,
    module,
    siteId,
    status: 'updated',
    update,
    ...(Object.keys(droppedFields).length > 0 ? { droppedFields } : {})
  }
}

/** Maps every row from one source against one target site. Call once per target site — with the
 * same source rows — to replay a 2.5.x storage config against multiple sites for the
 * multi-source-consolidation scenario; see the module doc. */
export async function mapStorageRows(
  rows: Iterable<SourceStorageRow> | AsyncIterable<SourceStorageRow>,
  options: MapStorageRowOptions
): Promise<StorageMappingResult> {
  const results: StorageRowResult[] = []
  for await (const row of rows) {
    results.push(mapStorageRow(row, options))
  }
  return { results }
}
