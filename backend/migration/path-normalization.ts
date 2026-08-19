/**
 * Path/locale normalization into a 3.0 tree location (Feature 416 / Task 736)
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
 * Folding is lossy — `FooBar` and `foobar` both fold to `foobar` — so this also detects and reports
 * every collision the fold can cause, rather than silently letting one page's row overwrite another's.
 * Two kinds of collision exist:
 *
 *   - a **sibling collision**: two distinct 2.x pages (different `oldId`) that fold to the same
 *     `(locale, parentPath, fileName)`. Both are reported as failures; neither is imported as a winner
 *     picked out of the pair, since which of two arbitrarily-cased paths "should" win is not this
 *     module's call to make.
 *   - an **existing-entry collision**: a fold that lands on a `(locale, parentPath, fileName)` already
 *     occupied by a pre-existing 3.0 tree entry in the target site. Checked through the injected
 *     `existingEntry` callback rather than a direct db query — this module has no db access of its
 *     own, matching `content-staging.ts`'s "stages, never writes" contract. Task 738 (`createPage()`
 *     import) is expected to wire the real lookup against `WIKI.models.tree`.
 *
 * A `(locale, parentPath, fileName)` combination is **not** a collision when only the `locale` differs
 * — that is how locale variants of "the same" 2.x page (same `path`, different `localeCode`) are meant
 * to land: as distinct 3.0 rows sharing a `folderPath`/`fileName`, exactly the scoping
 * `tree.addPage`'s `resolveName` uses (`taken()` filters on `siteId` + `locale` + `folderPath` +
 * `fileName` together — see `backend/models/tree.ts`).
 *
 * A 2.x page's `contentType` (e.g. a redirect-type page) plays no part here: every page occupies a
 * path in the tree the same way regardless of what its content means, so this module normalizes and
 * collision-checks every page identically. Nothing about `contentType` is read.
 */

/** Mirrors `rePathName` in `backend/models/tree.ts` — the exact rule `tree.createFolder`/`addEntry`
 * hold a segment to. Duplicated rather than imported because `tree.ts` keeps its copy module-private;
 * if that rule ever changes, this one must change with it. */
const RE_FOLDER_SEGMENT = /^[a-z0-9-]+$/

/** The minimal shape this module reads off a staged page — deliberately a subset of
 * `StagedPage` (see `content-staging.ts`) rather than importing it, so this module stays a plain
 * consumer of any `{oldId, path, locale}`-shaped row instead of coupling to that module's full type. */
export interface PathAssignmentInput {
  /** The 2.x `pages.id` this row came from — carried through so a failure can be reported per page. */
  oldId: number
  path: string
  locale: string
}

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

export type PathAssignmentFailureReason =
  | 'empty-path'
  | 'invalid-segment'
  | 'sibling-collision'
  | 'existing-entry-collision'

/** Why one 2.x page could not be placed in the 3.0 tree — reported per page rather than thrown, so one
 * bad or colliding path fails only that page's import, never the run. */
export interface PathAssignmentFailure {
  oldId: number
  /** The original, un-normalized 2.x path, for the operator report. */
  path: string
  locale: string
  reason: PathAssignmentFailureReason
  message: string
}

export interface PathAssignmentResult {
  /** In the same relative order as the input array. */
  assignments: TreePathAssignment[]
  /** In the same relative order as the input array. */
  failures: PathAssignmentFailure[]
}

export interface PathAssignmentOptions {
  /** The 3.0 site being imported into — the scope an existing-entry collision is checked within. */
  siteId: string
  /** Whether `(locale, parentPath, fileName)` is already occupied by a pre-existing 3.0 tree entry in
   * `siteId`'s tree. Injected rather than queried directly: this module has no db access of its own,
   * matching `content-staging.ts`'s "stages, never writes" contract. Task 738 wires the real lookup
   * against `WIKI.models.tree`; tests pass a plain function. */
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
 * entry needs — or a `PathNormalizationFailure` describing why it can't be. Locale plays no part here;
 * `assignTreePaths` is what folds locale into the collision key.
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

function locationKey(locale: string, parentPath: string, fileName: string): string {
  return `${locale} ${parentPath} ${fileName}`
}

/**
 * Normalize a batch of 2.x pages' `path` + `locale` into 3.0 tree locations, detecting every
 * collision the case/underscore fold can cause plus any collision with a pre-existing 3.0 entry in the
 * target site. Never throws for a bad or colliding individual page — each becomes a `PathAssignmentFailure`
 * instead, so one page's bad data cannot abort the run.
 */
export async function assignTreePaths(
  pages: PathAssignmentInput[],
  options: PathAssignmentOptions
): Promise<PathAssignmentResult> {
  const assignmentByOldId = new Map<number, TreePathAssignment>()
  const failureByOldId = new Map<number, PathAssignmentFailure>()
  const byLocation = new Map<string, TreePathAssignment[]>()

  const fail = (
    input: Pick<PathAssignmentInput, 'oldId' | 'path' | 'locale'>,
    reason: PathAssignmentFailureReason,
    message: string
  ) => {
    failureByOldId.set(input.oldId, {
      oldId: input.oldId,
      path: input.path,
      locale: input.locale,
      reason,
      message
    })
  }

  // -> Normalize each page on its own first, and bucket the survivors by the tree location they landed
  //    on, so a sibling collision is visible as soon as a bucket holds more than one page
  for (const page of pages) {
    const normalized = normalizeMigratedPath(page.path)
    if ('reason' in normalized) {
      fail(page, normalized.reason, normalized.message)
      continue
    }
    const assignment: TreePathAssignment = {
      oldId: page.oldId,
      locale: page.locale,
      parentPath: normalized.parentPath,
      fileName: normalized.fileName,
      path: normalized.path
    }
    assignmentByOldId.set(page.oldId, assignment)
    const key = locationKey(page.locale, normalized.parentPath, normalized.fileName)
    const bucket = byLocation.get(key)
    if (bucket) {
      bucket.push(assignment)
    } else {
      byLocation.set(key, [assignment])
    }
  }

  // -> Every page sharing a bucket loses: which of two arbitrarily-cased 2.x paths "should" win is not
  //    this module's call, so both/all are reported and neither is imported silently overwriting the
  //    other.
  for (const bucket of byLocation.values()) {
    if (bucket.length <= 1) continue
    for (const assignment of bucket) {
      assignmentByOldId.delete(assignment.oldId)
      const others = bucket
        .filter((other) => other.oldId !== assignment.oldId)
        .map((other) => other.oldId)
      fail(
        assignment,
        'sibling-collision',
        `page ${assignment.oldId} at "${assignment.path}" (locale "${assignment.locale}") normalizes to the same tree location as page(s) ${others.join(', ')} — both would land on the same 3.0 entry, so neither was imported.`
      )
    }
  }

  // -> Only survivors of the sibling check are worth an existing-entry lookup
  for (const [oldId, assignment] of assignmentByOldId) {
    const exists = await options.existingEntry(
      options.siteId,
      assignment.locale,
      assignment.parentPath,
      assignment.fileName
    )
    if (!exists) continue
    assignmentByOldId.delete(oldId)
    fail(
      assignment,
      'existing-entry-collision',
      `page ${oldId} at "${assignment.path}" (locale "${assignment.locale}") already exists in the target site's tree — import failed for this page.`
    )
  }

  // -> Rebuild in input order rather than Map iteration order, so results are deterministic and easy
  //    to correlate back against the pages that were passed in
  const assignments: TreePathAssignment[] = []
  const failures: PathAssignmentFailure[] = []
  for (const page of pages) {
    const assignment = assignmentByOldId.get(page.oldId)
    if (assignment) {
      assignments.push(assignment)
      continue
    }
    const failure = failureByOldId.get(page.oldId)
    if (failure) failures.push(failure)
  }

  return { assignments, failures }
}
