import { CronExpressionParser } from 'cron-parser'
import { isIsoDuration } from '../../models/storage.ts'
import { pickDefined, transformConfig } from './shared.ts'
import type { SourceRecord } from '../connector.ts'
import type { ConfigTransform } from './shared.ts'

/**
 * `mapStorageRow(s)` — storage targets, scoped per created site
 *
 * A pure transform: no DB access, no side effects. Takes 2.5.x `storage` table rows and produces 3.0
 * `storage` row **UPDATE** payloads, never inserts: every site already owns exactly one `storage` row
 * per installed module the moment it exists — `Storage.syncSite` inserts one per definition on disk
 * at site-creation time, and `(siteId, module)` is a unique index — so an insert here would either
 * race `syncSite` or violate that index. That same `(siteId, module)` boundary is why there is no
 * cross-call state to thread: replaying the same source rows against another site is another call
 * with a different `siteId`.
 *
 * `config` is checked and completed the way the live admin API does it: `validateConfig` first, so a
 * config that doesn't fit the target module's declared prop types comes back `flagged` rather than
 * silently miscoerced, then `buildConfig` to fill in every declared prop 2.x never had. Both come
 * from the injected `StorageModuleResolver` rather than being reimplemented here, so the mapper and
 * the model cannot drift apart on what a valid config is.
 *
 * `KNOWN_3_0_STORAGE_MODULES` enumerates the 3.0 modules explicitly rather than trusting whatever
 * `resolver.getDefinition()` happens to return, so a module removed from `backend/modules/storage/`
 * without this list being updated fails loudly in the enumeration cross-check test instead of
 * degrading into "the resolver said no, so it must be fine". A source key off the list — or on it
 * with no definition loaded — comes back `status: 'unsupported'`, nothing written. Six 2.x keys
 * (`box`, `digitalocean`, `dropbox`, `gdrive`, `onedrive`, `s3generic`) have no 3.0 module at all;
 * `digitalocean`/`s3generic` in particular do NOT fold into 3.0's `s3` module's `mode: 'do'|'custom'`
 * selector, since 2.x stored them as separate module keys with their own rows — folding one in would
 * be a cross-row merge, outside this per-row mapper's scope.
 *
 * `mode` copies across as `syncMode` only when the source value is one of the target module's own
 * declared `supportedModes`; `syncInterval` needs a real conversion rather than a rename (see
 * `convertSyncInterval`). Whichever of the two has a source value that cannot be converted is
 * reported in `droppedFields` rather than vanishing, so a caller building a migration report can name
 * what was lost. `state` is never mapped: it is a 2.x-only column that 3.0 has no counterpart for.
 */

/**
 * One row as read from a 2.5.x `storage` table. Unlike `authentication`, `storage.key` doubles
 * directly as the module directory name — there is no separate `strategyKey`/`key` split to resolve.
 */
export interface SourceStorageRow extends SourceRecord {
  key: string
  isEnabled: boolean
  /** `'sync' | 'push' | 'pull'` in practice, but the 2.x column was never a checked enum. */
  mode: unknown
  config: unknown
  /** A raw five-field cron expression in practice; the 2.x column constrained nothing. */
  syncInterval: unknown
  /** Never mapped: 3.0 has no `storage.state` column. */
  state: unknown
}

/**
 * Structurally satisfied by the real `CARDINAL.models.storage` singleton. A narrow interface rather
 * than an import of the class so this mapper is unit-testable without a live DB: none of the three
 * methods touch `CARDINAL.db`, only the module definitions loaded from disk.
 */
export interface StorageModuleResolver {
  /** `null` when no module on disk declares this key. */
  getDefinition(key: string): { title: string; supportedModes: string[] } | null
  buildConfig(
    moduleKey: string,
    incoming?: Record<string, any>,
    existing?: Record<string, any>
  ): Record<string, any>
  /** The reason `incoming` doesn't fit the module's declared props, or `null` when it's fine. */
  validateConfig(moduleKey: string, incoming?: Record<string, any>): string | null
}

export const KNOWN_3_0_STORAGE_MODULES = [
  'azure',
  'db',
  'disk',
  'gcs',
  'git',
  's3',
  'sftp'
] as const

/**
 * Per-module, key-by-key `config` remap. Anything not picked here is simply absent from `incoming`:
 * `buildConfig` fills it from the module's own default and `validateConfig` ignores undeclared keys,
 * so a 2.x-only prop like git's `alwaysNamespace` needs no explicit stripping. `db` and `gcs` have no
 * transform because no 2.x row can carry either key.
 */
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
   * Prop names match on both sides, but `storageTier`'s enum **values** do not: 2.x stores
   * `'Hot'`/`'Cool'`, while 3.0 declares `hot|Hot`/`cool|Cool` and `validateConfig` checks the
   * lower-case value half, so a verbatim copy would fail the enum check.
   */
  azure: (raw) => {
    const result = pickDefined(raw, ['accountName', 'accountKey', 'containerName'])
    if (typeof raw.storageTier === 'string' && raw.storageTier.length > 0) {
      result.storageTier = raw.storageTier.toLowerCase()
    }
    return result
  },
  /**
   * `sshPrivateKeyMode`'s enum **values** differ, not just their labels: 2.x spells them
   * `'path'`/`'contents'`, 3.0 `'path'`/`'inline'`.
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
   * 2.x has a single flat, AWS-only `region` string; 3.0 splits that into a `mode` selector plus
   * per-mode region props. `mode: 'aws'` has to be synthesized — 2.x never recorded a mode and 3.0
   * infers no default for it.
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

export type StorageRowStatus = 'updated' | 'unsupported' | 'flagged'

/** `syncMode`/`scheduleOverride` are omitted rather than written as `undefined` when their source
 * value did not convert, so an unconvertible value leaves the row's existing sync settings alone
 * instead of clobbering them with nothing. Deliberately not derived from
 * `typeof storageTable.$inferInsert`: the `jsonb()` `config` column has no declared shape there (it
 * infers as `{}`), far narrower than the props a module actually produces. */
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
  sourceKey: string
  module: string
  siteId: string
  status: StorageRowStatus
  /** Present only when `status === 'updated'`. */
  update?: StorageUpdatePayload
  /** Only the field(s) that had a source value but could not be converted. Absent once both convert
   * cleanly, and always absent for `unsupported`/`flagged` rows, where nothing transferred at all. */
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
  siteId: string
}

function convertSyncMode(value: unknown, supportedModes: readonly string[]): string | null {
  return typeof value === 'string' && supportedModes.includes(value) ? value : null
}

const EVERY_N_MINUTES = /^\*\/(\d+) \* \* \* \*$/
const EVERY_N_HOURS = /^0 \*\/(\d+) \* \* \*$/

/**
 * Converts 2.x's cron-shaped `syncInterval` into what 3.0's `scheduleOverride` accepts — either an
 * ISO-8601 duration or a cron expression. The two "every N minutes"/"every N hours" shapes convert
 * to the equivalent duration, which reads better than the cron it came from; any other valid cron
 * passes through verbatim, confirmed with the same `cron-parser` `models/storage.ts` validates
 * `scheduleOverride` with. A value that parses as neither is left unconverted.
 */
function convertSyncInterval(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  if (isIsoDuration(trimmed)) {
    return trimmed
  }
  const everyNMinutes = EVERY_N_MINUTES.exec(trimmed)
  if (everyNMinutes) {
    return `PT${everyNMinutes[1]}M`
  }
  const everyNHours = EVERY_N_HOURS.exec(trimmed)
  if (everyNHours) {
    return `PT${everyNHours[1]}H`
  }
  try {
    CronExpressionParser.parse(trimmed)
    return trimmed
  } catch {
    return null
  }
}

/** Maps one 2.x `storage` row. `mapStorageRows` is the usual entry point; this is exported for a
 * caller that wants to stream rows one at a time. */
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

/** Maps every row from one source against one target site. Replaying a 2.5.x storage config against
 * several sites is one call per site with the same source rows. */
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
