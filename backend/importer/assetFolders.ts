import { normalizePagePath } from '../helpers/common.ts'

/**
 * Mirrors `tree.ts`'s own (module-private) `rePathName` — a folder path segment may only be
 * lowercase alphanumeric and hyphens. Kept in sync by hand: `tree.ts` does not export it, and this
 * module has no reason to reach into that model just to read a regex literal.
 */
const rePathName = /^[a-z0-9-]+$/

/** One row of 2.x's `assetFolders` self-referential adjacency list. */
export interface SourceAssetFolder {
  id: number
  name: string
  slug: string
  parentId: number | null
}

export type AssetFolderPathWarningReason =
  | 'sanitized-slug'
  | 'case-collision'
  | 'orphaned-parent'
  | 'cycle-detected'

export interface AssetFolderPathWarning {
  sourceFolderId: number
  originalSlug: string
  resolvedSegment: string
  reason: AssetFolderPathWarningReason
}

export interface AssetFolderPathResolution {
  /** `assetFolders.id` -> the resolved, slash-separated, 3.0-legal `folderPath`. */
  paths: Map<number, string>
  /** One entry per folder whose resolved segment isn't a plain carry-over of its source `slug` —
   *  because the slug had to be sanitized, or because it collided with an already-resolved sibling
   *  once normalized. Nothing in here failed the run; every folder still got a path. */
  warnings: AssetFolderPathWarning[]
}

/**
 * Turn a raw 2.x slug into a segment `tree.ts`'s `rePathName` will accept, without ever producing an
 * empty string: `normalizePagePath` first (the same trim/lowercase/whitespace-to-hyphen every page
 * path goes through), then strip anything else `rePathName` doesn't allow, collapsing runs of it to
 * one hyphen. A slug that sanitizes to nothing (all-punctuation, or genuinely empty) falls back to
 * `folder-<id>` rather than leaving the folder unaddressable.
 */
function sanitizeSlug(slug: string, folderId: number): { segment: string; wasSanitized: boolean } {
  const normalized = normalizePagePath(slug)
  if (rePathName.test(normalized)) {
    return { segment: normalized, wasSanitized: false }
  }
  const stripped = normalized
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return { segment: stripped || `folder-${folderId}`, wasSanitized: true }
}

/**
 * Settle on a path segment nothing else already resolved to under the same parent, appending
 * `-1`, `-2`, … the same way `tree.ts`'s own `resolveName` settles a same-folder name conflict on a
 * live upload.
 */
function dedupeSegment(segment: string, usedByParent: Set<string>): string {
  if (!usedByParent.has(segment)) {
    return segment
  }
  let i = 1
  let candidate = `${segment}-${i}`
  while (usedByParent.has(candidate)) {
    i++
    candidate = `${segment}-${i}`
  }
  return candidate
}

/**
 * Walk 2.x's `assetFolders` adjacency list (`id`/`name`/`slug`/`parentId`) into the slash-separated
 * `folderPath` each imported asset needs — the same full-slug join `assetFolders.js`'s own
 * `getAllPaths()` builds upstream (ancestor **slugs**, root to leaf, joined by `/`), except:
 *
 * - Every segment is put through `sanitizeSlug` first, since 2.x never validated `slug` against
 *   anything as strict as 3.0's `rePathName` — a slug that doesn't survive it is sanitized rather
 *   than aborting the run, and recorded as a `'sanitized-slug'` warning.
 * - Once normalized, two sibling slugs that only differed by case (2.x folder names weren't
 *   case-normalized; 3.0's are) would resolve to the exact same `tree.folderPath`+`fileName` and
 *   silently collapse into one 3.0 folder — `dedupeSegment` renames the second one instead, recorded
 *   as a `'case-collision'` warning.
 * - A dangling `parentId` (points at nothing in this same list) or a `parentId` cycle is treated as a
 *   root rather than thrown on, each recorded with its own warning reason — neither should occur in a
 *   real export (the FK has no `onDelete`, so this guards manual DB surgery more than a real migration
 *   path), but a batch import should not abort over one malformed row.
 *
 * Deliberately does not touch the database: nothing here creates a `tree` row. The caller hands the
 * resolved path to `WIKI.models.tree.addAsset`/`getFolder({ createIfMissing: true })` per asset, which
 * already creates whatever ancestor folders are missing — see `writeImportedAsset` in `./assets.ts`.
 */
export function resolveAssetFolderPaths(folders: SourceAssetFolder[]): AssetFolderPathResolution {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const paths = new Map<number, string>()
  const usedByParentPath = new Map<string, Set<string>>()
  const warnings: AssetFolderPathWarning[] = []
  const visiting = new Set<number>()

  function resolveParentPath(folder: SourceAssetFolder): string {
    if (folder.parentId == null) {
      return ''
    }
    const parent = byId.get(folder.parentId)
    if (!parent) {
      warnings.push({
        sourceFolderId: folder.id,
        originalSlug: folder.slug,
        resolvedSegment: '',
        reason: 'orphaned-parent'
      })
      WIKI.logger?.warn?.(
        `Asset folder ${folder.id} (${folder.slug}) references missing parent ${folder.parentId}; importing it at the root instead.`
      )
      return ''
    }
    if (visiting.has(parent.id)) {
      warnings.push({
        sourceFolderId: folder.id,
        originalSlug: folder.slug,
        resolvedSegment: '',
        reason: 'cycle-detected'
      })
      WIKI.logger?.warn?.(
        `Asset folder ${folder.id} (${folder.slug}) sits in a parentId cycle; importing it at the root instead.`
      )
      return ''
    }
    return resolve(parent)
  }

  function resolve(folder: SourceAssetFolder): string {
    const cached = paths.get(folder.id)
    if (cached !== undefined) {
      return cached
    }

    visiting.add(folder.id)
    const parentPath = resolveParentPath(folder)
    visiting.delete(folder.id)

    const { segment: sanitized, wasSanitized } = sanitizeSlug(folder.slug, folder.id)
    const usedByParent = usedByParentPath.get(parentPath) ?? new Set<string>()
    const segment = dedupeSegment(sanitized, usedByParent)
    usedByParent.add(segment)
    usedByParentPath.set(parentPath, usedByParent)

    if (segment !== sanitized) {
      warnings.push({
        sourceFolderId: folder.id,
        originalSlug: folder.slug,
        resolvedSegment: segment,
        reason: 'case-collision'
      })
      WIKI.logger?.warn?.(
        `Asset folder ${folder.id} (${folder.slug}) collides, once normalized, with a sibling folder already imported as "${sanitized}"; importing it as "${segment}" instead.`
      )
    } else if (wasSanitized) {
      warnings.push({
        sourceFolderId: folder.id,
        originalSlug: folder.slug,
        resolvedSegment: segment,
        reason: 'sanitized-slug'
      })
      WIKI.logger?.warn?.(
        `Asset folder ${folder.id}'s slug "${folder.slug}" is not a valid 3.0 folder path name; importing it as "${segment}" instead.`
      )
    }

    const path = parentPath ? `${parentPath}/${segment}` : segment
    paths.set(folder.id, path)
    return path
  }

  for (const folder of folders) {
    resolve(folder)
  }

  return { paths, warnings }
}
