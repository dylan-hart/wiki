import { pages as pagesTable, tree as treeTable } from '../db/schema.ts'
import { decodeTreePath, generatePathHash } from '../helpers/common.ts'

export interface HashDriftEntry {
  id: string
  siteId: string
  locale: string
  path: string
  storedHash: string
  expectedHash: string
}

/**
 * `tree.id` is set to the originating `pages.id` (`models/tree.ts#addPage`), but nothing enforces
 * it: there is no FK either way — `pages.id` cannot reference a polymorphic `tree` row, and
 * `tree.id` covers folders and assets too — so a crash partway through a delete leaves one side
 * behind. The id is the real, if unenforced, link between the two.
 */
export interface TreeDivergenceEntry {
  direction: 'orphanTreeEntry' | 'orphanPageRow'
  id: string
  siteId: string
  locale: string
  path: string
}

export interface DuplicatePathEntry {
  siteId: string
  locale: string
  path: string
  pageIds: string[]
}

/**
 * A relation carries no page id — only a `target`, which is `/some/path` for a page of this wiki or
 * an arbitrary URL for anything else. "Broken" therefore means no page in the same site has that
 * path once the leading slash is stripped.
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
 * A `pages` or `tree` row whose path's first segment names an installed locale — grandfathered in
 * from before that segment was reserved (`models/locales.ts#isReservedLocaleCode`), or written by
 * an import or migration bypassing the model layer. A page and its own tree entry show up here
 * independently, same as the other checks.
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
 * Five integrity checks across `pages` and `tree` that nothing in the normal write path guarantees
 * stays true. Instance-wide rather than per-site — a drifted hash on one site is no more worth
 * surfacing than on another — and queued as a background job
 * (`tasks/simple/scan-page-problems.ts`) because a full scan of both tables is not instant on a
 * large wiki. Reporting only: nothing here writes, and auto-repair is deliberately out of scope.
 */
class PageProblemsModel {
  async scan(): Promise<PageProblemsReport> {
    const pageRows = await CARDINAL.db
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
    // -> Site-scoped: a relation's `target` is a bare path with no site of its own, so it can only
    //    ever mean a page of the site the relation lives on
    const pathsBySite = new Map<string, Set<string>>()
    for (const p of pageRows) {
      let paths = pathsBySite.get(p.siteId)
      if (!paths) {
        paths = new Set()
        pathsBySite.set(p.siteId, paths)
      }
      paths.add(p.path)
    }

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

    const brokenRelations: BrokenRelationEntry[] = []
    for (const p of pageRows) {
      const relations = Array.isArray(p.relations) ? (p.relations as RelationEntry[]) : []
      for (const relation of relations) {
        const target = relation?.target
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

    // -> Every tree row type, not just `page`: the locale-collision pass below reuses this rather
    //    than reading the table twice, and a root folder shadows a locale prefix as a page does.
    const treeRows = await CARDINAL.db
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

    // -> Every code ever installed, not just those active on a given site: a row shadowed by a
    //    later activation is exactly the case this guards.
    const installedLocales = await CARDINAL.models.locales.getLocales()
    // -> Matching is case-insensitive, but the value keeps the installed casing so a report names
    //    the real offender (`FR`) rather than an artifact of the matching (`fr`).
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
