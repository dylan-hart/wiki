/**
 * Path/locale normalization into a 3.0 tree location
 *
 * A 2.x `pages.path` is a flat, slash-separated string held to 2.x's looser `rePagePath`
 * (`/^[a-zA-Z0-9-_/]*$/`), while 3.0 addresses a page through the `tree` table's per-segment ltree
 * `folderPath` + `fileName`, each segment held to `models/tree.ts`'s stricter `rePathName`. This
 * module is the read-only, db-free translation between the two: given a 2.x `path` + `localeCode`, it
 * produces the `parentPath`/`fileName` pair `tree.createFolder`/`tree.addPage` expect, folding case
 * and every character 2.x paths were free to use but 3.0 segments are not (underscores, spaces,
 * punctuation, unicode, …) down to hyphens.
 *
 * Folding is lossy — `FooBar` and `foobar` both fold to `foobar` — so it can land two distinct 2.x
 * pages on the same `(locale, parentPath, fileName)`, or land one where a pre-existing 3.0 tree entry
 * already sits. Detecting either is **not** this module's job: `importers/page-import.ts` owns it,
 * per page as the corpus streams through, since only the importer knows which locations this run has
 * already claimed and can ask the destination tree about the rest.
 *
 * A `(locale, parentPath, fileName)` combination is **not** a collision when only the `locale`
 * differs — that is how locale variants of "the same" 2.x page are meant to land, as distinct 3.0
 * rows sharing a `folderPath`/`fileName`, exactly the scoping `tree.addPage`'s `resolveName` uses.
 */

/** Mirrors `rePathName` in `models/tree.ts`, duplicated rather than imported because `tree.ts` keeps
 * its copy module-private: if that rule changes, this one must change with it. */
const RE_FOLDER_SEGMENT = /^[a-z0-9-]+$/

/** The 3.0 tree location one 2.x page's `path` + `locale` resolves to, in the argument shape
 * `tree.createFolder`/`tree.addPage` take. Every part is already folded to `RE_FOLDER_SEGMENT`. */
export interface TreePathAssignment {
  oldId: number
  locale: string
  /** Slash-separated, without a leading or trailing slash; the empty string at the site root. */
  parentPath: string
  fileName: string
  /** `parentPath` and `fileName` joined — for messages, and the human-readable half of the collision
   * key. */
  path: string
}

export interface PathAssignmentOptions {
  /** Whether `(locale, parentPath, fileName)` is already occupied by a pre-existing entry in
   * `siteId`'s tree. Injected rather than queried directly so this module keeps no db access of its
   * own; `phases/content.ts` wires the real lookup against `CARDINAL.models.tree`. */
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
 * Fold one path segment down to 3.0's folder-segment rule. Returns `null` only when nothing usable
 * remains — a segment made entirely of disallowed characters (`'!!!'`) folds to the empty string.
 */
export function normalizeSegment(segment: string): string | null {
  const folded = segment
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  return folded.length > 0 && RE_FOLDER_SEGMENT.test(folded) ? folded : null
}

/**
 * Normalize one 2.x page path into the `parentPath`/`fileName`/`path` a 3.0 tree entry needs, or a
 * failure describing why it can't be. Locale plays no part here — `importers/page-import.ts` is what
 * folds locale into the collision key.
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
        message: `page path "${rawPath}" segment "${raw}" is not a valid 3.0 folder name even after lowercasing and folding disallowed characters to hyphens.`
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
