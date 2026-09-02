/**
 * Path/locale normalization into a 3.0 tree location
 *
 * A 2.x `pages.path` is a flat, slash-separated string held to 2.x's looser `rePagePath`
 * (`/^[a-zA-Z0-9-_/]*$/` — see `docs/migration/2.5x-source-schema.md`), while 3.0 addresses a page
 * through the `tree` table's per-segment ltree `folderPath` + `fileName`, each segment held to
 * `backend/models/tree.ts`'s stricter `rePathName` (`/^[a-z0-9-]+$/` — lowercase alphanumeric and
 * hyphen only, duplicated below as `RE_FOLDER_SEGMENT` since `tree.ts` keeps its copy private). This
 * module is the read-only, db-free translation between the two: given a 2.x `path` + `localeCode`, it
 * produces the `parentPath`/`fileName` pair `tree.createFolder`/`tree.addPage` expect, folding case
 * and underscores the way 2.x paths were free to use but 3.0 segments are not.
 *
 * Folding is lossy — `FooBar` and `foobar` both fold to `foobar` — so a fold can land two distinct
 * 2.x pages on the same `(locale, parentPath, fileName)`, or land one on a location a pre-existing
 * 3.0 tree entry already occupies. Detecting either is **not** this module's job:
 * `importers/page-import.ts`'s
 * `createPageImporter()` owns it, per page as the corpus streams through it, since only the importer
 * knows which locations this run has already claimed and can ask the destination tree about the rest.
 * This module answers exactly one question — what `parentPath`/`fileName` does this 2.x path fold to,
 * or why can't it fold at all — with no db access and no whole-corpus state.
 *
 * A `(locale, parentPath, fileName)` combination is **not** a collision when only the `locale` differs
 * — that is how locale variants of "the same" 2.x page (same `path`, different `localeCode`) are meant
 * to land: as distinct 3.0 rows sharing a `folderPath`/`fileName`, exactly the scoping
 * `tree.addPage`'s `resolveName` uses (`taken()` filters on `siteId` + `locale` + `folderPath` +
 * `fileName` together — see `backend/models/tree.ts`).
 *
 * A 2.x page's `contentType` (e.g. a redirect-type page) plays no part here: every page occupies a
 * path in the tree the same way regardless of what its content means, so this module normalizes every
 * page identically. Nothing about `contentType` is read.
 */

/** Mirrors `rePathName` in `backend/models/tree.ts` — the exact rule `tree.createFolder`/`addEntry`
 * hold a segment to. Duplicated rather than imported because `tree.ts` keeps its copy module-private;
 * if that rule ever changes, this one must change with it. */
const RE_FOLDER_SEGMENT = /^[a-z0-9-]+$/

/** The 3.0 tree location one 2.x page's `path` + `locale` resolves to, in exactly the argument shape
 * `tree.createFolder`/`tree.addPage` take: `parentPath` is slash-separated and does not include the
 * final segment, `fileName` is that final segment. Both already folded to `RE_FOLDER_SEGMENT`. */
export interface TreePathAssignment {
  oldId: number
  locale: string
  /** Slash-separated, without a leading or trailing slash. Empty string at the site root — feed
   * straight to `tree.addPage`'s `parentPath` / `tree.createFolder`'s `parentPath`. */
  parentPath: string
  /** The final path segment — feed straight to `tree.addPage`'s `fileName`. */
  fileName: string
  /** `parentPath` + `/` + `fileName` (or just `fileName` at the root) — the full normalized,
   * slash-separated path, for messages and as the human-readable half of the collision key. */
  path: string
}

export interface PathAssignmentOptions {
  /** Whether `(locale, parentPath, fileName)` is already occupied by a pre-existing 3.0 tree entry in
   * `siteId`'s tree. Injected rather than queried directly: this module has no db access of its own,
   * matching `content-staging.ts`'s "stages, never writes" contract. `phases/content.ts` wires the
   * real lookup against `WIKI.models.tree`; tests pass a plain function. */
  existingEntry: (
    siteId: string,
    locale: string,
    parentPath: string,
    fileName: string
  ) => boolean | Promise<boolean>
}

interface NormalizedPathFields {
  parentPath: string
  fileName: string
  path: string
}

interface PathNormalizationFailure {
  reason: 'empty-path' | 'invalid-segment'
  message: string
}

/**
 * Fold one path segment down to 3.0's folder-segment rule: lowercase, and underscore — the one
 * character 2.x's `rePagePath` allows in a segment that 3.0's `rePathName` does not — mapped to a
 * hyphen. Returns `null` if what is left still does not satisfy `RE_FOLDER_SEGMENT` (empty, or a
 * character outside 2.x's own allowed set to begin with — not reachable through a well-formed 2.x
 * `pages.path`, but this module does not assume its input was well-formed).
 */
export function normalizeSegment(segment: string): string | null {
  const folded = segment.toLowerCase().replaceAll('_', '-')
  return RE_FOLDER_SEGMENT.test(folded) ? folded : null
}

/**
 * Normalize one 2.x page path (without its locale) into the `parentPath`/`fileName`/`path` a 3.0 tree
 * entry needs — or a `PathNormalizationFailure` describing why it can't be. Locale plays no part
 * here; `importers/page-import.ts` is what folds locale into the collision key.
 */
export function normalizeMigratedPath(
  rawPath: string
): NormalizedPathFields | PathNormalizationFailure {
  const trimmed = (rawPath ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed) {
    return {
      reason: 'empty-path',
      message: `page path "${rawPath}" is empty once trimmed of slashes and whitespace — nothing to import.`
    }
  }

  const segments: string[] = []
  for (const raw of trimmed.split('/')) {
    if (raw.length === 0) {
      return {
        reason: 'invalid-segment',
        message: `page path "${rawPath}" has an empty segment (consecutive slashes) — cannot be placed in the tree.`
      }
    }
    const normalized = normalizeSegment(raw)
    if (normalized === null) {
      return {
        reason: 'invalid-segment',
        message: `page path "${rawPath}" segment "${raw}" is not a valid 3.0 folder name even after lowercasing and folding underscores to hyphens.`
      }
    }
    segments.push(normalized)
  }

  return {
    parentPath: segments.slice(0, -1).join('/'),
    fileName: segments.at(-1)!,
    path: segments.join('/')
  }
}
