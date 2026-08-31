import { pages as pagesTable, tree as treeTable } from '../db/schema.ts'
import { decodeTreePath, generatePathHash } from '../helpers/common.ts'

/** A page whose stored `hash` no longer matches `generatePathHash(path)` — see `models/pages.ts`. */
export interface HashDriftEntry {
  id: string
  siteId: string
  locale: string
  path: string
  storedHash: string
  expectedHash: string
}

/**
 * A `tree` row of type `page` with no matching `pages` row, or vice-versa, matched by id.
 *
 * `tree.id` is set to the originating `pages.id` at creation time (`models/tree.ts#addPage`), and
 * `models/pages.ts#getPage` already joins the two tables on that equality — but nothing enforces it:
 * there is no FK either way (`pages.id` cannot reference a polymorphic `tree` row, and `tree.id`
 * covers folders and assets too), so a crash or a bug partway through a delete can leave one side
 * behind. The id is the real, if unenforced, link between the two.
 */
export interface TreeDivergenceEntry {
  /** `orphanTreeEntry`: a tree page row with no page. `orphanPageRow`: a page with no tree entry. */
  direction: 'orphanTreeEntry' | 'orphanPageRow'
  id: string
  siteId: string
  locale: string
  path: string
}

/** More than one `pages` row sharing the same `(siteId, locale, path)` — should be impossible. */
export interface DuplicatePathEntry {
  siteId: string
  locale: string
  path: string
  pageIds: string[]
}

/**
 * A relation whose `target` points at a page of this wiki that no longer exists.
 *
 * A relation is stored as `{ id, position, label, icon, target, ... }` (see
 * `frontend/src/components/PageRelationDialog.vue`), where `target` is whatever
 * `LinkPickerDialog` produced: `/some/path` for a page of this wiki, or an arbitrary URL for
 * anything else. There is no `pageId` on a relation to look up — the path is all it carries — so
 * "the page id it references" (as this check is sometimes described) means the page, if any, whose
 * `path` matches once the leading slash is stripped, within the same site.
 */
export interface BrokenRelationEntry {
  pageId: string
  siteId: string
  locale: string
  path: string
  relationId: string
  target: string
}

/**
 * A `pages` or `tree` row whose path's first segment names an INSTALLED locale — grandfathered in
 * from before that segment was reserved (`models/locales.ts#isReservedLocaleCode`), or a row an
 * import/migration/direct write bypassed the model layer to create. `table` is which one it lives
 * in; a page and its own tree entry both show up here independently, same as the other checks.
 */
export interface LocaleCollisionEntry {
  table: 'pages' | 'tree'
  id: string
  siteId: string
  locale: string
  path: string
  collidingCode: string
}

export interface PageProblemsReport {
  hashDrift: { count: number; entries: HashDriftEntry[] }
  treeDivergence: { count: number; entries: TreeDivergenceEntry[] }
  duplicatePaths: { count: number; entries: DuplicatePathEntry[] }
  brokenRelations: { count: number; entries: BrokenRelationEntry[] }
  localeCollisions: { count: number; entries: LocaleCollisionEntry[] }
  /** RFC 3339 Date Time, millisecond precision. */
  scannedAt: string
}

interface RelationEntry {
  id?: string
  target?: string
  [key: string]: unknown
}

/**
 * Page problems model
 *
 * Five integrity checks across `pages` and `tree` that nothing in the normal write path guarantees
 * stays true, run as one instance-wide scan (`scan()`) rather than per-site — there is no reason a
 * drifted hash or a dangling tree row on one site is more or less worth surfacing than on another.
 * Queued as a background job (`tasks/simple/scan-page-problems.ts`) rather than run inline: a full
 * scan of `pages` and `tree` on a large wiki is not instant.
 *
 * Every check only reports — nothing here writes to the database. An admin reviews the report and
 * decides what, if anything, to fix; auto-repair is deliberately out of scope (see task 586).
 */
class PageProblemsModel {
  async scan(): Promise<PageProblemsReport> {
    const pageRows = await WIKI.db
      .select({
        id: pagesTable.id,
        siteId: pagesTable.siteId,
        locale: pagesTable.locale,
        path: pagesTable.path,
        hash: pagesTable.hash,
        relations: pagesTable.relations
      })
      .from(pagesTable)

    const pageIdSet = new Set(pageRows.map((p) => p.id))
    // -> Site-scoped, not global: a relation's `target` is a bare path with no site of its own, so
    //    it can only ever mean a page of the same site the relation lives on
    const pathsBySite = new Map<string, Set<string>>()
    for (const p of pageRows) {
      let paths = pathsBySite.get(p.siteId)
      if (!paths) {
        paths = new Set()
        pathsBySite.set(p.siteId, paths)
      }
      paths.add(p.path)
    }

    // -> Check 1: hash drift
    const hashDrift: HashDriftEntry[] = []
    for (const p of pageRows) {
      const expectedHash = generatePathHash(p.path)
      if (expectedHash !== p.hash) {
        hashDrift.push({
          id: p.id,
          siteId: p.siteId,
          locale: p.locale,
          path: p.path,
          storedHash: p.hash,
          expectedHash
        })
      }
    }

    // -> Check 3: duplicate (siteId, locale, path) tuples
    const groups = new Map<string, DuplicatePathEntry>()
    for (const p of pageRows) {
      const key = `${p.siteId} ${p.locale} ${p.path}`
      let group = groups.get(key)
      if (!group) {
        group = { siteId: p.siteId, locale: p.locale, path: p.path, pageIds: [] }
        groups.set(key, group)
      }
      group.pageIds.push(p.id)
    }
    const duplicatePaths = [...groups.values()].filter((group) => group.pageIds.length > 1)

    // -> Check 4: relations pointing at a page that no longer exists
    const brokenRelations: BrokenRelationEntry[] = []
    for (const p of pageRows) {
      const relations = Array.isArray(p.relations) ? (p.relations as RelationEntry[]) : []
      for (const relation of relations) {
        const target = relation?.target
        // -> Only an internal page link (`/some/path`) is a page reference; anything else (a full
        //    URL, or malformed data) is not this check's concern
        if (typeof target !== 'string' || !target.startsWith('/')) {
          continue
        }
        const targetPath = target.slice(1)
        if (!pathsBySite.get(p.siteId)?.has(targetPath)) {
          brokenRelations.push({
            pageId: p.id,
            siteId: p.siteId,
            locale: p.locale,
            path: p.path,
            relationId: relation?.id ?? '',
            target
          })
        }
      }
    }

    // -> Check 2: tree/page divergence, matched by id (see `TreeDivergenceEntry`'s doc comment).
    //    Fetched for every tree row type (not just `page`), so check 5 below can reuse it rather than
    //    reading the whole table a second time — a root-level FOLDER shadows a locale prefix exactly
    //    as a page does, so it belongs in that check too.
    const treeRows = await WIKI.db
      .select({
        id: treeTable.id,
        siteId: treeTable.siteId,
        locale: treeTable.locale,
        type: treeTable.type,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName
      })
      .from(treeTable)

    const treePageRows = treeRows.filter((t) => t.type === 'page')
    const treeIdSet = new Set(treePageRows.map((t) => t.id))
    const treeDivergence: TreeDivergenceEntry[] = []
    for (const t of treePageRows) {
      if (!pageIdSet.has(t.id)) {
        const folderPath = decodeTreePath(t.folderPath) ?? ''
        treeDivergence.push({
          direction: 'orphanTreeEntry',
          id: t.id,
          siteId: t.siteId,
          locale: t.locale,
          path: folderPath ? `${folderPath}/${t.fileName}` : t.fileName
        })
      }
    }
    for (const p of pageRows) {
      if (!treeIdSet.has(p.id)) {
        treeDivergence.push({
          direction: 'orphanPageRow',
          id: p.id,
          siteId: p.siteId,
          locale: p.locale,
          path: p.path
        })
      }
    }

    // -> Check 5: rows grandfathered in before locale codes were reserved as first path segments
    //    (see `models/locales.ts#isReservedLocaleCode`, `models/pages.ts#createPage`/`movePage`,
    //    `models/tree.ts#createFolder`/`renameFolder`) — every code ever installed, not just active
    //    on a given site, since a row shadowed by activation later is exactly the case this guards.
    const installedLocales = await WIKI.models.locales.getLocales()
    // -> Keyed by lowercased code (matching is case-insensitive -- a path segment collides
    //    regardless of how it's cased) but valued with the code exactly as installed, so a report
    //    names the real offender (`FR`) rather than an artifact of the matching (`fr`).
    const codes = new Map(
      installedLocales.map((lc: any) => [String(lc.code).toLowerCase(), String(lc.code)])
    )
    const localeCollisions: LocaleCollisionEntry[] = []
    for (const p of pageRows) {
      const firstSegment = (p.path.split('/')[0] ?? '').toLowerCase()
      const collidingCode = codes.get(firstSegment)
      if (collidingCode) {
        localeCollisions.push({
          table: 'pages',
          id: p.id,
          siteId: p.siteId,
          locale: p.locale,
          path: p.path,
          collidingCode
        })
      }
    }
    for (const t of treeRows) {
      const folderPath = decodeTreePath(t.folderPath) ?? ''
      const firstSegment = (folderPath ? folderPath.split('/')[0]! : t.fileName).toLowerCase()
      const collidingCode = codes.get(firstSegment)
      if (collidingCode) {
        localeCollisions.push({
          table: 'tree',
          id: t.id,
          siteId: t.siteId,
          locale: t.locale,
          path: folderPath ? `${folderPath}/${t.fileName}` : t.fileName,
          collidingCode
        })
      }
    }

    return {
      hashDrift: { count: hashDrift.length, entries: hashDrift },
      treeDivergence: { count: treeDivergence.length, entries: treeDivergence },
      duplicatePaths: { count: duplicatePaths.length, entries: duplicatePaths },
      brokenRelations: { count: brokenRelations.length, entries: brokenRelations },
      localeCollisions: { count: localeCollisions.length, entries: localeCollisions },
      scannedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
    }
  }
}

export const pageProblems = new PageProblemsModel()
