import type { AssetKind } from '../models/assets.ts'

/**
 * Shared logic for the cloud blob storage targets (S3, Azure Blob Storage, GCS).
 *
 * Each module lives in its own `modules/storage/<key>/storage.ts` and pulls in its own SDK, but the
 * three questions every one of them has to answer — where does this asset live in the bucket, is this
 * file "large", and does it belong in this target at all — are identical regardless of which SDK is
 * doing the writing. This file answers all three so the modules stay in step with each other instead
 * of each growing its own copy.
 *
 * Deliberately dependency-free of any cloud SDK: it imports only a type from `models/assets.ts`
 * (erased at runtime, so it costs nothing), so importing this file never pulls in `@aws-sdk/*`,
 * `@azure/*` or `@google-cloud/*` for a module that doesn't need them.
 */

/** Byte multiplier for each unit `largeThreshold` may be written with. See `parseLargeThreshold`. */
const SIZE_UNIT_BYTES = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4
} as const

type SizeUnit = keyof typeof SIZE_UNIT_BYTES

/**
 * Parse a `largeThreshold` config string (e.g. `5MB`, `512KB`) into a byte count.
 *
 * Mirrors `durationToSeconds` in `helpers/common.ts`: one whole number and one unit, no decimals or
 * internal spaces, case-insensitive. `contentTypes.largeThreshold` on a storage target
 * (`models/storage.ts`) is the only place this format is configured.
 *
 * @param fallback Returned for anything unparseable, so one bad setting cannot silently reclassify
 *   every asset as large (or none of them)
 */
export function parseLargeThreshold(value: unknown, fallback: number): number {
  const match = /^(\d+)\s*(b|kb|mb|gb|tb)$/i.exec(String(value ?? '').trim())
  if (!match) {
    return fallback
  }
  const unit = match[2]!.toLowerCase() as SizeUnit
  const bytes = Number(match[1]) * SIZE_UNIT_BYTES[unit]
  return bytes > 0 ? bytes : fallback
}

/** What identifies an asset's place for the purposes of building its object key. */
export interface BlobTargetAssetLocation {
  siteId: string
  /** Slash-separated, no leading or trailing slash, empty at the site root — see `Asset.folderPath`. */
  folderPath: string
  fileName: string
}

/**
 * The object key/path a blob target should store an asset under.
 *
 * Every target scopes its bucket/container by site (`<siteId>/...`), so two sites can never collide
 * on the same key even when they happen to name a file and folder identically. Computed the same way
 * for every target so an asset moved from one blob target to another lands at the same key.
 */
export function objectKeyFor({ siteId, folderPath, fileName }: BlobTargetAssetLocation): string {
  const segments = [siteId, ...folderPath.split('/').filter(Boolean), fileName]
  return segments.join('/')
}

/** The `contentTypes` categories an asset can be filed under. Mirrors `CONTENT_TYPES` in `models/storage.ts`, minus `pages` — a blob target filters assets, not page content. */
export type AssetContentCategory = 'images' | 'documents' | 'others' | 'large'

const KIND_TO_CATEGORY: Record<AssetKind, AssetContentCategory> = {
  image: 'images',
  document: 'documents',
  other: 'others'
}

/** The `contentTypes` half of a configured `StorageTarget`, i.e. what `belongsInTarget` filters against. */
export interface BlobTargetContentTypesConfig {
  activeTypes: string[]
  largeThreshold: string
}

/** The two facts about an asset that deciding its category needs — nothing else. */
export interface BlobTargetAssetInfo {
  kind: AssetKind
  fileSize: number
}

/**
 * The content category an asset falls into, for target-membership purposes.
 *
 * An asset at or above the threshold is filed as `large` regardless of its kind — the point of that
 * bucket is routing outsized files as a group irrespective of what they are — so size takes priority
 * over the kind-based mapping.
 */
export function categoryOf(
  asset: BlobTargetAssetInfo,
  largeThresholdBytes: number
): AssetContentCategory {
  if (asset.fileSize >= largeThresholdBytes) {
    return 'large'
  }
  return KIND_TO_CATEGORY[asset.kind]
}

/**
 * Whether an asset belongs in a target, per its `contentTypes` config.
 *
 * Every module's `exportAll` filters through this before writing, so "images only", "everything
 * except large files", etc. as configured in the admin area is honored identically across S3, Azure
 * and GCS rather than each target re-implementing the same category math.
 */
export function belongsInTarget(
  asset: BlobTargetAssetInfo,
  config: BlobTargetContentTypesConfig
): boolean {
  const thresholdBytes = parseLargeThreshold(config.largeThreshold, Number.POSITIVE_INFINITY)
  return config.activeTypes.includes(categoryOf(asset, thresholdBytes))
}
