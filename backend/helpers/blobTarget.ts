import type { AssetKind } from '../models/assets.ts'

/**
 * The object key, "is this large" and "does it belong here" rules every storage target shares, so
 * they cannot drift apart per SDK.
 *
 * Deliberately free of any cloud SDK import — only an erased type from `models/assets.ts` — so
 * importing this never pulls in `@aws-sdk/*`, `@azure/*` or `@google-cloud/*`.
 */

const SIZE_UNIT_BYTES = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4
} as const

type SizeUnit = keyof typeof SIZE_UNIT_BYTES

/**
 * The one parser every `largeThreshold` reader shares. Its accepted format has to stay identical to
 * `models/storage.ts#validateTarget()`'s validation regex — decimal amount and optional space
 * included — or the admin API saves thresholds this silently falls back on.
 */
export function parseLargeThreshold(value: unknown, fallback: number): number {
  const match = /^(\d+(?:\.\d+)?)\s?(b|kb|mb|gb|tb)$/i.exec(String(value ?? '').trim())
  if (!match) {
    return fallback
  }
  const unit = match[2]!.toLowerCase() as SizeUnit
  const bytes = Number.parseFloat(match[1]!) * SIZE_UNIT_BYTES[unit]
  return bytes > 0 ? bytes : fallback
}

export interface BlobTargetAssetLocation {
  siteId: string
  /** Slash-separated, no leading or trailing slash, empty at the site root. */
  folderPath: string
  fileName: string
  pathPrefix?: unknown
}

export function normalizePathPrefix(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value
    .trim()
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/')
}

/**
 * The `<siteId>/` prefix is what stops two sites colliding on an identical folder and file name.
 * Every target computes the key this way, so an asset moved between targets keeps it.
 */
export function objectKeyFor({
  siteId,
  folderPath,
  fileName,
  pathPrefix
}: BlobTargetAssetLocation): string {
  const prefix = normalizePathPrefix(pathPrefix)
  const segments = [
    ...(prefix ? [prefix] : []),
    siteId,
    ...folderPath.split('/').filter(Boolean),
    fileName
  ]
  return segments.join('/')
}

/**
 * `CONTENT_TYPES` in `models/storage.ts` minus `pages`: a storage target filters assets here, not
 * page content.
 */
export type AssetContentCategory = 'images' | 'documents' | 'others' | 'large'

const KIND_TO_CATEGORY: Record<AssetKind, AssetContentCategory> = {
  image: 'images',
  document: 'documents',
  other: 'others'
}

export interface BlobTargetContentTypesConfig {
  activeTypes: string[]
  largeThreshold: string
}

export interface BlobTargetAssetInfo {
  kind: AssetKind
  fileSize: number
}

/**
 * Size takes priority over kind: the `large` bucket exists to route outsized files as a group,
 * whatever they are.
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
 * Every storage module gates on this rather than re-deriving the category math, so an admin's
 * `contentTypes` choice behaves identically whichever target holds the asset.
 */
export function belongsInTarget(
  asset: BlobTargetAssetInfo,
  config: BlobTargetContentTypesConfig
): boolean {
  const thresholdBytes = parseLargeThreshold(config.largeThreshold, Number.POSITIVE_INFINITY)
  return config.activeTypes.includes(categoryOf(asset, thresholdBytes))
}
