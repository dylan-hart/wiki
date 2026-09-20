import { and, asc, desc, eq, exists, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import { randomUUID } from 'node:crypto'
import { chunk } from 'es-toolkit/array'
import type { WikiDbOrTx } from '../core/db.ts'
import { assets as assetsTable, pages as pagesTable, tree as treeTable } from '../db/schema.ts'
import {
  CustomError,
  decodeTreePath,
  encodeTreePath,
  generatePathHash,
  isUniqueViolation,
  normalizePagePath
} from '../helpers/common.ts'
import { announce } from './hooks.ts'
import type { CreatedPageRows, PageActor, PageInput } from './pages.ts'

export const TREE_UPDATE_CHUNK_SIZE = 200

/** Mirrors the `treeType` enum in the schema. */
export type TreeItemType = 'folder' | 'page' | 'asset'

export const TREE_ORDER_BY = ['createdAt', 'fileName', 'title', 'updatedAt'] as const

export type TreeOrderBy = (typeof TREE_ORDER_BY)[number]

/**
 * One shape for all three kinds rather than three: a folder listing interleaves them, and the type
 * field is what tells them apart.
 */
export interface TreeItem {
  id: string
  type: TreeItemType
  /** Folders deep from the site root, not from the folder being listed. */
  depth: number
  /** Slash-separated, without a leading or trailing slash. Empty at the root. */
  folderPath: string
  fileName: string
  title: string
  tags: string[]
  createdAt: Date
  updatedAt: Date
  /** Folders only. */
  childrenCount?: number
  /** Folders only — an ancestor of the folder being listed, not an entry in it. */
  isAncestor?: boolean
  /** Assets only. */
  fileSize?: number
  fileExt?: string
  mimeType?: string
  /** Pages only. */
  editor?: string
  description?: string
  /** Pages only, for `visibleTreeItems`' permission filter (`helpers/pageAccess.ts`). Never reaches
   *  the client: no API schema declares it, so Fastify's response serialization drops it. */
  classification?: string | null
}

/**
 * A page and a folder can sit at the very same path — `/foo/bar` the page, `/foo/bar/…` the folder of
 * pages under it — and a reader thinks of those as one thing with two ways in, so they come back as
 * one entry carrying both flags rather than as two rows with the same name.
 */
export interface BrowseItem {
  /** Slash-separated: the page's own URL, and the folder to list on the way down. */
  path: string
  fileName: string
  title: string
  /** Iconify reference. Null for a folder with no page at its path. */
  icon: string | null
  isPage: boolean
  isFolder: boolean
  /** For the reader-permission filter layered on top of this listing. Never reaches the client: no
   *  API schema declares it, so Fastify's response serialization drops it. */
  classification: string | null
  /** For the same filter -- a TAG/TAGALL rule needs tags to decide `read:pages` the same as a path
   *  rule needs the path. Never reaches the client either. */
  tags: string[]
}

export interface BrowseLevel {
  /** Slash-separated. Empty at the site root. */
  path: string
  /** Empty at the site root, which is not a folder and has no row of its own. */
  title: string
  items: BrowseItem[]
  /** More than `MAX_BROWSE` entries; the rest were dropped. */
  truncated: boolean
}

export interface ListedPage {
  id: string
  path: string
  title: string
  description: string
  /** Iconify reference. Empty when the page has none. */
  icon: string
  /** The book-vs-file signal a nested tree view draws off of. Judged by the same `pageIsVisible`
   *  rule as the listing itself, so a caller never learns of a child it could not otherwise see. */
  hasChildren: boolean
  /** Folders below the listed `path`, 0 being directly inside it -- relative to the query, not the
   *  site root, so a block listing `/docs/tools` reports 0/1/2 there rather than 2/3/4. */
  depth: number
  /** For the reader-permission filter layered on top of this listing. Never reaches the client: no
   *  API schema declares it, so Fastify's response serialization drops it. */
  classification: string | null
  /** For the same filter -- a TAG/TAGALL rule needs tags to decide `read:pages`. Never reaches the
   *  client either. */
  tags: string[]
}

export interface DeletedEntry {
  id: string
  /** Slash-separated, without the file name. Empty at the site root. */
  folderPath: string
  fileName: string
  locale: string
}

export interface DescendantPage {
  id: string
  path: string
  locale: string
  tags: string[]
  /** Joined from `pages` -- `tree` carries no classification column of its own. */
  classification: string | null
}

export interface DescendantAsset {
  id: string
  /** What an asset `read:assets`/`manage:assets` ref is built from. */
  path: string
  /** What `mayOnAsset` (`helpers/pageAccess.ts`) takes alongside `fileName`, rather than the
   *  combined `path` above. Empty at the site root. */
  folderPath: string
  fileName: string
  locale: string
}

/** `page` is the full post-update row, which is what `search.renamed` expects. */
export interface MovedDescendantPage {
  page: typeof pagesTable.$inferSelect
  previousPath: string
  previousLocale: string
}

/**
 * `kind`/`fileSize` travel along because `Storage#targetCoversEvent` classifies an asset event by
 * them; neither lives on `tree`, so they are joined in from `assets`.
 */
export interface MovedDescendantAsset {
  id: string
  fileName: string
  /** Slash-separated, without the file name -- post-rename. */
  folderPath: string
  previousFolderPath: string
  kind: string
  fileSize: number | null
}

export interface DuplicatedFolder {
  folder: TreeRow
  folders: number
  pages: number
  assets: number
}

export interface TreeRow {
  id: string
  folderPath: string | null
  fileName: string
  type: TreeItemType
  locale: string
  title: string
  tags: string[]
  meta: Record<string, any>
  siteId: string
  createdAt: Date
  updatedAt: Date
}

/** Folders are addressed by URL, so their file name is restricted to what reads well in one. */
const rePathName = /^[a-z0-9-]+$/
const reTitle = /^[^<>"]+$/

const MAX_LIMIT = 1000
/** Recursion ceiling here and in `Navigation.generateFromTree`, which reuses it. */
export const MAX_DEPTH = 10

const MAX_BROWSE = 500

/** How many `name-1`, `name-2`… variants an upload tries. Exported so
 * `migration/importers/page-import.ts`'s own numeric-suffix dedupe retries against the same cap. */
export const MAX_NAME_ATTEMPTS = 100

/**
 * An `EXISTS` correlated to the outer `tree` row being tested, not a standalone query. A folder is
 * created for whatever is put in it, so it can end up holding only assets, only drafts, or nothing at
 * all — descending into one of those lands on an empty menu, so callers drop a folder answering false.
 *
 * @param encodedParentPath The ltree path of the folder being listed. A child's own path is built as
 *   `<prefix>.<name>` by text concatenation rather than an ltree operator, since the prefix is a
 *   parameter and the name is a column.
 * @param aliasSuffix Must differ per call site: two `EXISTS` clauses in one statement cannot share an
 *   alias name.
 */
export function holdsVisiblePagesUnder(
  encodedParentPath: string,
  publicOnly: boolean,
  aliasSuffix: string
): SQL {
  const descendant = alias(treeTable, `descendantTree${aliasSuffix}`)
  const descendantPage = alias(pagesTable, `descendantPage${aliasSuffix}`)
  const childPathPrefix = encodedParentPath ? `${encodedParentPath}.` : ''
  return exists(
    CARDINAL.db
      .select({ one: sql`1` })
      .from(descendant)
      .innerJoin(descendantPage, eq(descendantPage.id, descendant.id))
      .where(
        and(
          eq(descendant.siteId, treeTable.siteId),
          eq(descendant.locale, treeTable.locale),
          eq(descendant.type, 'page'),
          sql`${descendant.folderPath} <@ (${childPathPrefix}::text || ${treeTable.fileName})::ltree`,
          ...pageIsVisible(descendantPage, publicOnly)
        )
      )
  )
}

/**
 * `holdsVisiblePagesUnder` for a PAGE rather than a folder, correlated per row: `listPages()` returns
 * rows sitting at different depths in one result set, so each row's own path is built from its
 * `folderPath`/`fileName` COLUMNS. Hence the `ltree || ltree` operator rather than the sibling's
 * text-then-cast idiom, which relies on knowing ahead of time whether the parent path is empty (to
 * omit the joining dot) — impossible per row. Concatenating the root path with `||` is a no-op.
 *
 * @param aliasSuffix Must differ per call site: two `EXISTS` clauses in one statement cannot share an
 *   alias name.
 */
export function holdsVisibleChildPages(publicOnly: boolean, aliasSuffix: string): SQL {
  const descendant = alias(treeTable, `childTree${aliasSuffix}`)
  const descendantPage = alias(pagesTable, `childPage${aliasSuffix}`)
  return exists(
    CARDINAL.db
      .select({ one: sql`1` })
      .from(descendant)
      .innerJoin(descendantPage, eq(descendantPage.id, descendant.id))
      .where(
        and(
          eq(descendant.siteId, treeTable.siteId),
          eq(descendant.locale, treeTable.locale),
          eq(descendant.type, 'page'),
          sql`${descendant.folderPath} <@ (${treeTable.folderPath} || ${treeTable.fileName}::ltree)`,
          ...pageIsVisible(descendantPage, publicOnly)
        )
      )
  )
}

/**
 * One refusal shared by the pre-insert probes and by the `isUniqueViolation` catches that close the
 * race those probes cannot, so a client sees the same actionable error whichever won.
 */
function duplicateEntryError(): CustomError {
  return new CustomError('treeEntryDuplicate', 'Something with this name already exists here.', 409)
}

/** The ltree path of a folder's *contents*, i.e. the value its children carry in `folderPath`. */
function childPathOf(folder: { folderPath?: string | null; fileName: string }): string {
  return folder.folderPath ? `${folder.folderPath}.${folder.fileName}` : folder.fileName
}

/**
 * Exported so `Navigation.generateFromTree` reuses `browse()`'s order: an auto-generated menu reads
 * the same way the folder it was built from does.
 */
export function compareFoldersFirst(
  a: { isFolder: boolean; title: string },
  b: { isFolder: boolean; title: string }
): number {
  return a.isFolder === b.isFolder ? a.title.localeCompare(b.title) : a.isFolder ? -1 : 1
}

export function splitPath(path: string): { folderPath: string; fileName: string } {
  const parts = path.split('.')
  return {
    folderPath: parts.slice(0, -1).join('.'),
    fileName: parts.at(-1) ?? ''
  }
}

function toTreeItem(
  row: TreeRow,
  depth: number,
  parentPath: string,
  classification: string | null
): TreeItem {
  const folderPath = row.folderPath ?? ''
  return {
    id: row.id,
    type: row.type,
    depth,
    folderPath: decodeTreePath(folderPath) ?? '',
    fileName: row.fileName,
    title: row.title,
    tags: row.tags ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.type === 'folder' && {
      childrenCount: row.meta?.children ?? 0,
      // -> Shorter than the folder being listed means it sits above it, i.e. it came from
      //    `includeAncestors` / `includeRootFolders` rather than from the listing itself
      isAncestor: folderPath.length < parentPath.length
    }),
    ...(row.type === 'asset' && {
      fileSize: row.meta?.fileSize ?? 0,
      fileExt: row.meta?.fileExt ?? '',
      mimeType: row.meta?.mimeType ?? ''
    }),
    ...(row.type === 'page' && {
      editor: row.meta?.editor ?? '',
      description: row.meta?.description ?? '',
      classification
    })
  }
}

/**
 * Deliberately the same rule the page view itself applies (`pages.getPage`'s `publicOnly`), so a menu
 * never offers a page that would answer 404 — nor hides one that would open. A password-protected
 * page is listed: locked rather than hidden, and its title is metadata, not protected content.
 *
 * The columns come in one by one rather than as a table, because this is applied both to `pages` and
 * to an alias of it, and an alias is a different type.
 *
 * @param publicOnly Restrict to what a reader with no session may see. `isBrowsable` applies either
 *                   way: it is the author saying "not in the tree", not an access rule.
 */
export function pageIsVisible(
  columns: { isBrowsable: PgColumn; publishState: PgColumn },
  publicOnly: boolean
): (SQL | undefined)[] {
  return [
    eq(columns.isBrowsable, true),
    ...(publicOnly ? [eq(columns.publishState, 'published')] : [])
  ]
}

/**
 * The single index of everything addressable in a site — folders, pages and assets alike — keyed by
 * an ltree `folderPath`. Pages and assets keep their own rows elsewhere and join back on the same ID;
 * the tree row is what gives them a place and a name.
 *
 * Paths are slashes on the way in and out (`foo/bar`) and dots inside the database (`foo.bar`), which
 * is what `encodeTreePath` / `decodeTreePath` convert between. Nothing outside this model should have
 * to know about the dotted form.
 */
class Tree {
  /**
   * @param parentId Takes precedence over `parentPath`.
   * @param parentPath The site root when both are absent.
   * @param depth 0, the default, is the folder itself.
   * @param includeAncestors Also return the folders above the one being listed, so a caller opening a
   *                         deep folder gets the branch it hangs off in one request.
   * @param includeRootFolders Also return every folder at the root, for the same reason.
   * @param locale Required — a caller with no locale opinion of its own resolves one before calling
   *               in, rather than this method merging every locale together.
   * @param publicOnly Hide, from a page-type entry only, exactly what `pageIsVisible` hides from an
   *                   anonymous reader, so a guest session holding `read:pages` cannot enumerate
   *                   drafts through a tree listing — the one thing `visibleTreeItems`' page-rule
   *                   filter in `helpers/pageAccess.ts` does not check.
   */
  async getTree({
    siteId,
    parentId,
    parentPath,
    locale,
    types,
    tags,
    limit = MAX_LIMIT,
    offset = 0,
    orderBy = 'title',
    orderByDirection = 'asc',
    depth = 0,
    includeAncestors = false,
    includeRootFolders = false,
    publicOnly = false
  }: {
    siteId: string
    parentId?: string | null
    parentPath?: string | null
    locale: string
    types?: TreeItemType[] | null
    tags?: string[] | null
    limit?: number
    offset?: number
    orderBy?: TreeOrderBy
    orderByDirection?: 'asc' | 'desc'
    depth?: number
    includeAncestors?: boolean
    includeRootFolders?: boolean
    publicOnly?: boolean
  }): Promise<TreeItem[]> {
    if (offset < 0) {
      throw new CustomError('treeInvalidOffset', 'The offset cannot be negative.')
    }
    if (limit < 1 || limit > MAX_LIMIT) {
      throw new CustomError('treeInvalidLimit', `The limit must be between 1 and ${MAX_LIMIT}.`)
    }
    if (depth < 0 || depth > MAX_DEPTH) {
      throw new CustomError('treeInvalidDepth', `The depth must be between 0 and ${MAX_DEPTH}.`)
    }

    let path = ''
    if (parentId) {
      const parent = await this.getFolderById(parentId, siteId)
      if (parent) {
        path = childPathOf(parent)
      }
    } else if (parentPath) {
      path = encodeTreePath(parentPath)
    }

    const levels = depth > 0 ? `*{,${depth}}` : '*{0}'
    const pathQuery = path ? `${path}.${levels}` : levels

    const locations: SQL[] = [sql`${treeTable.folderPath} ~ ${pathQuery}::lquery`]
    if (includeAncestors && path) {
      // -> Matches on `folderPath` alone (no `fileName` filter) so every folder AT that level comes
      //    back, not just the one ancestor node on the chain -- a caller opening a deep folder sees
      //    its siblings at every intermediate level too, not only an unbroken ancestor chain.
      const parts = path.split('.')
      for (let i = 0; i < parts.length; i++) {
        locations.push(
          and(
            eq(treeTable.folderPath, parts.slice(0, parts.length - 1 - i).join('.')),
            eq(treeTable.type, 'folder')
          )!
        )
      }
    }
    if (includeRootFolders) {
      locations.push(and(eq(treeTable.folderPath, ''), eq(treeTable.type, 'folder'))!)
    }

    const conditions: (SQL | undefined)[] = [
      eq(treeTable.siteId, siteId),
      or(...locations),
      eq(treeTable.locale, locale)
    ]
    if (types && types.length > 0) {
      conditions.push(inArray(treeTable.type, types))
    }
    if (tags && tags.length > 0) {
      // -> `sql.param`, because a bare array in a template is read as a parameter *list* — the
      //    comma-separated form `inArray` needs — and `@>` wants one array-typed parameter
      conditions.push(sql`${treeTable.tags} @> ${sql.param(tags)}`)
    }
    if (publicOnly) {
      // -> `pagesTable` is left-joined in below purely for a page row's `classification`, so a
      //    folder or asset row carries every `pagesTable` column as null -- applying `pageIsVisible`
      //    unguarded would filter those out along with the page rows it is meant to hide.
      conditions.push(or(ne(treeTable.type, 'page'), and(...pageIsVisible(pagesTable, true))))
    }

    const direction = orderByDirection === 'desc' ? desc : asc
    const rows = await CARDINAL.db
      .select({
        row: treeTable,
        depth: sql<number>`nlevel(${treeTable.folderPath})`.mapWith(Number),
        // -> Only a `page`-type row's id ever matches `pagesTable.id`; a folder or asset row leaves
        //    this null, which is the "no classification" `toTreeItem` already treats them as
        classification: pagesTable.classification
      })
      .from(treeTable)
      .leftJoin(pagesTable, eq(pagesTable.id, treeTable.id))
      .where(and(...conditions))
      .orderBy(asc(sql`nlevel(${treeTable.folderPath})`), direction(treeTable[orderBy]))
      .limit(limit)
      .offset(offset)

    return rows.map(({ row, depth: rowDepth, classification }) =>
      toTreeItem(row as TreeRow, rowDepth, path, classification ?? null)
    )
  }

  /**
   * Between `getTree()` and `browse()`: it recurses and sorts like the first and hides like the
   * second. Folders are left out entirely — an index block draws a list of pages, not a file browser
   * — and so is any page the reader may not open, by the same rule the page view applies.
   *
   * @param path The site root when empty.
   * @param depth 0, the default, is the path itself.
   * @param tags Only pages carrying every one of these tags.
   */
  async listPages({
    siteId,
    path,
    locale,
    tags,
    limit = 10,
    orderBy = 'title',
    orderByDirection = 'asc',
    depth = 0,
    publicOnly = true
  }: {
    siteId: string
    path?: string | null
    locale: string
    tags?: string[] | null
    limit?: number
    orderBy?: TreeOrderBy
    orderByDirection?: 'asc' | 'desc'
    depth?: number
    publicOnly?: boolean
  }): Promise<ListedPage[]> {
    if (limit < 1 || limit > MAX_LIMIT) {
      throw new CustomError('treeInvalidLimit', `The limit must be between 1 and ${MAX_LIMIT}.`)
    }
    if (depth < 0 || depth > MAX_DEPTH) {
      throw new CustomError('treeInvalidDepth', `The depth must be between 0 and ${MAX_DEPTH}.`)
    }

    const encodedPath = encodeTreePath(path)
    const levels = depth > 0 ? `*{,${depth}}` : '*{0}'
    const pathQuery = encodedPath ? `${encodedPath}.${levels}` : levels

    const direction = orderByDirection === 'desc' ? desc : asc
    const hasChildren = holdsVisibleChildPages(publicOnly, '')
    const rows = await CARDINAL.db
      .select({
        id: treeTable.id,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName,
        title: treeTable.title,
        description: pagesTable.description,
        icon: pagesTable.icon,
        classification: pagesTable.classification,
        tags: treeTable.tags,
        hasChildren: sql<boolean>`${hasChildren}`.mapWith(Boolean)
      })
      .from(treeTable)
      .innerJoin(pagesTable, eq(pagesTable.id, treeTable.id))
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.type, 'page'),
          sql`${treeTable.folderPath} ~ ${pathQuery}::lquery`,
          ...(tags && tags.length > 0 ? [sql`${treeTable.tags} @> ${sql.param(tags)}`] : []),
          ...pageIsVisible(pagesTable, publicOnly)
        )
      )
      .orderBy(direction(treeTable[orderBy]))
      .limit(limit)

    // -> `row.folderPath` is still the raw dot-separated ltree form, so its segment count IS its
    //    nlevel -- computed here in JS rather than via SQL `nlevel()` since every row is already in
    //    hand. `depth` is relative to `encodedPath`, the folder being listed, not the site root.
    const baseDepth = encodedPath ? encodedPath.split('.').length : 0
    return rows.map((row) => {
      const folderPath = decodeTreePath(row.folderPath ?? '') ?? ''
      const rowDepth = row.folderPath ? row.folderPath.split('.').length : 0
      return {
        id: row.id,
        path: folderPath ? `${folderPath}/${row.fileName}` : row.fileName,
        title: row.title,
        description: row.description ?? '',
        icon: row.icon ?? '',
        hasChildren: row.hasChildren,
        depth: rowDepth - baseDepth,
        classification: row.classification,
        tags: row.tags
      }
    })
  }

  /**
   * Not a variant of `getTree()`. That one is the file manager's view — every entry of every kind,
   * for someone with permission to manage them. This is the reader's: assets have no place in it,
   * a page nobody may see must not appear even as a name, and a folder whose whole contents are
   * invisible is a dead end rather than something to offer.
   *
   * @param path The site root when empty.
   * @returns Null when there is no such folder — which an empty folder is not.
   */
  async browse({
    siteId,
    path,
    locale,
    publicOnly = true
  }: {
    siteId: string
    path?: string | null
    locale: string
    publicOnly?: boolean
  }): Promise<BrowseLevel | null> {
    const encodedPath = encodeTreePath(path)
    const basePath = decodeTreePath(encodedPath) ?? ''

    // -> The root is not a folder, so it has no row and no title of its own — and a path that is not
    //    a folder is nothing this can list.
    let title = ''
    if (encodedPath) {
      const location = splitPath(encodedPath)
      const folder = await CARDINAL.db
        .select({ title: treeTable.title })
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, siteId),
            eq(treeTable.locale, locale),
            eq(treeTable.folderPath, location.folderPath),
            eq(treeTable.fileName, location.fileName),
            eq(treeTable.type, 'folder')
          )
        )
        .limit(1)
      if (!folder[0]) {
        return null
      }
      title = folder[0].title
    }

    const holdsVisiblePages = holdsVisiblePagesUnder(encodedPath, publicOnly, '')

    /*
      Ordered by file name rather than by title, so that a page and the folder at the same path are
      adjacent: the row after `MAX_BROWSE` is dropped, and only a pair straddling that boundary can
      lose half of itself. Display order is settled below, once the pairs are merged.
    */
    const rows = await CARDINAL.db
      .select({
        type: treeTable.type,
        fileName: treeTable.fileName,
        title: treeTable.title,
        icon: pagesTable.icon,
        classification: pagesTable.classification,
        tags: treeTable.tags,
        holdsVisiblePages: sql<boolean>`${holdsVisiblePages}`.mapWith(Boolean)
      })
      .from(treeTable)
      .leftJoin(pagesTable, eq(pagesTable.id, treeTable.id))
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.folderPath, encodedPath),
          or(
            eq(treeTable.type, 'folder'),
            and(eq(treeTable.type, 'page'), ...pageIsVisible(pagesTable, publicOnly))
          )
        )
      )
      .orderBy(asc(treeTable.fileName))
      .limit(MAX_BROWSE + 1)

    const merged = new Map<string, BrowseItem>()
    for (const row of rows.slice(0, MAX_BROWSE)) {
      if (row.type === 'folder' && !row.holdsVisiblePages) {
        continue
      }
      const entry = merged.get(row.fileName) ?? {
        path: basePath ? `${basePath}/${row.fileName}` : row.fileName,
        fileName: row.fileName,
        title: row.title,
        icon: null,
        isPage: false,
        isFolder: false,
        classification: null,
        tags: []
      }
      if (row.type === 'folder') {
        entry.isFolder = true
      } else {
        entry.isPage = true
        // -> The page is the thing a reader clicks, so it names the row when both exist
        entry.title = row.title
        entry.icon = row.icon
        entry.classification = row.classification
        entry.tags = row.tags
      }
      merged.set(row.fileName, entry)
    }

    return {
      path: basePath,
      title,
      truncated: rows.length > MAX_BROWSE,
      items: [...merged.values()].sort(compareFoldersFirst)
    }
  }

  /**
   * Private on purpose: the one lookup here that takes no `siteId`, so a caller outside this model
   * could reach another site's row with an id alone. Internal callers pair it with their own site
   * check.
   */
  private async getById(id: string, db: WikiDbOrTx = CARDINAL.db): Promise<TreeRow | null> {
    const results = await db.select().from(treeTable).where(eq(treeTable.id, id)).limit(1)
    return (results[0] as TreeRow) ?? null
  }

  /**
   * Null when the id is not a folder OR belongs to a different site: `siteId` is required, with no
   * optional-argument fallback, so a caller cannot look a folder up by id alone and skip checking
   * whose site it belongs to.
   */
  async getFolderById(
    id: string,
    siteId: string,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<TreeRow | null> {
    const results = await db
      .select()
      .from(treeTable)
      .where(and(eq(treeTable.id, id), eq(treeTable.siteId, siteId), eq(treeTable.type, 'folder')))
      .limit(1)
    return (results[0] as TreeRow) ?? null
  }

  /**
   * The nullable `getFolderById` stays public: some callers genuinely want to know whether a folder
   * is there without a 404 being raised for them.
   *
   * @throws CustomError `treeInvalidFolder` (404)
   */
  private async requireFolderById(
    id: string,
    siteId: string,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<TreeRow> {
    const folder = await this.getFolderById(id, siteId, db)
    if (!folder) {
      throw new CustomError('treeInvalidFolder', 'This folder does not exist.', 404)
    }
    return folder
  }

  /**
   * A page here is not in the way: a folder alongside it is how `/guide` gets to be both a page and
   * the way into `/guide/…`. An asset is, since it is served at that URL itself — the same rule
   * `resolveName` applies coming the other way.
   *
   * @param exceptId The row allowed to already hold the name.
   * @throws CustomError `treeFolderDuplicate` (409)
   */
  private async assertFolderNameFree(
    siteId: string,
    locale: string,
    folderPath: string,
    name: string,
    exceptId?: string,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<void> {
    const conditions = [
      eq(treeTable.siteId, siteId),
      eq(treeTable.locale, locale),
      eq(treeTable.folderPath, folderPath),
      eq(treeTable.fileName, name),
      ne(treeTable.type, 'page')
    ]
    if (exceptId) {
      conditions.unshift(ne(treeTable.id, exceptId))
    }
    const existing = await db
      .select({ type: treeTable.type })
      .from(treeTable)
      .where(and(...conditions))
      .limit(1)
    if (existing.length > 0) {
      throw new CustomError(
        'treeFolderDuplicate',
        existing[0].type === 'folder'
          ? 'A folder with this path name already exists.'
          : 'A file with this path name already exists here.',
        409
      )
    }
  }

  /**
   * A folder that does not exist holds nothing, so an unresolvable destination answers null rather
   * than raising: the caller is about to create it.
   *
   * @param parentId Takes precedence over `parentPath`; the site root when both are absent.
   */
  async getEntryAt({
    siteId,
    locale,
    parentId,
    parentPath,
    fileName
  }: {
    siteId: string
    locale: string
    parentId?: string | null
    parentPath?: string | null
    fileName: string
  }): Promise<TreeRow | null> {
    let path = ''
    if (parentId || parentPath) {
      let folder: TreeRow
      try {
        folder = await this.getFolder({ id: parentId, path: parentPath, locale, siteId })
      } catch {
        return null
      }
      path = childPathOf(folder)
    }

    const results = await CARDINAL.db
      .select()
      .from(treeTable)
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.folderPath, path),
          eq(treeTable.fileName, fileName)
        )
      )
      .limit(1)
    return (results[0] as TreeRow) ?? null
  }

  /**
   * @param createIfMissing Creates any missing ancestor too. Only applies when resolving by path — an
   *                        id that matches nothing is an error either way.
   */
  async getFolder({
    id,
    path,
    locale,
    siteId,
    createIfMissing = false,
    db = CARDINAL.db
  }: {
    id?: string | null
    path?: string | null
    locale?: string
    siteId: string
    createIfMissing?: boolean
    /** A batch import passes its own transaction, so a folder this has to create is rolled back
     *  with the rest of the batch rather than surviving as an orphan. */
    db?: WikiDbOrTx
  }): Promise<TreeRow> {
    if (id) {
      return this.requireFolderById(id, siteId, db)
    }

    const { folderPath, fileName } = splitPath(encodeTreePath(path))
    const results = await db
      .select()
      .from(treeTable)
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale!),
          eq(treeTable.folderPath, folderPath),
          eq(treeTable.fileName, fileName),
          eq(treeTable.type, 'folder')
        )
      )
      .limit(1)
    if (results[0]) {
      return results[0] as TreeRow
    }
    if (!createIfMissing) {
      throw new CustomError('treeInvalidFolder', 'This folder does not exist.', 404)
    }
    return this.createFolder({
      parentPath: folderPath,
      pathName: fileName,
      title: fileName,
      locale: locale!,
      siteId,
      db
    })
  }

  /**
   * @param parentId Takes precedence over `parentPath`.
   * @param parentPath The site root when both are absent.
   * @param pathName Normalized, so what the folder ends up called may differ from what was asked for.
   */
  async createFolder({
    parentId,
    parentPath,
    pathName,
    title,
    locale,
    siteId,
    db = CARDINAL.db
  }: {
    parentId?: string | null
    parentPath?: string | null
    pathName: string
    title: string
    locale: string
    siteId: string
    db?: WikiDbOrTx
  }): Promise<TreeRow> {
    // -> A folder name is a segment of every page path under it, so it is normalized the same way a
    //    page path is before it is held to what a segment may contain
    const name = normalizePagePath(pathName)
    if (!rePathName.test(name)) {
      throw new CustomError(
        'treeInvalidPath',
        'A folder path name may only contain lowercase alphanumeric and hyphen characters.'
      )
    }
    if (!reTitle.test(title)) {
      throw new CustomError('treeInvalidTitle', 'The folder title contains invalid characters.')
    }

    let path = encodeTreePath(parentPath)
    let effectiveLocale = locale
    if (parentId) {
      const parent = await this.getFolderById(parentId, siteId, db)
      if (!parent) {
        throw new CustomError('treeInvalidParent', 'The parent folder does not exist.', 404)
      }
      path = childPathOf(parent)
      // -> A folder cannot be in a different locale than the one holding it
      effectiveLocale = parent.locale
    }

    // -> Only a root-level folder can shadow a locale prefix: a nested `fr/` never collides with the
    //    URL parser, which only strips a locale code off the FIRST path segment
    if (path === '' && (await CARDINAL.models.locales.isReservedLocaleCode(name))) {
      throw new CustomError(
        'treeReservedLocaleSegment',
        `"${name}" is an installed locale code and cannot name a root folder.`,
        400
      )
    }

    await this.assertFolderNameFree(siteId, effectiveLocale, path, name, undefined, db)

    // -> A path can be created from the middle out — by an upload into a folder nobody made yet, or by
    //    a rename that left a gap — so every level above the new folder is filled in first
    if (path) {
      const parts = path.split('.')
      const expected = parts.map((_, i) => ({
        folderPath: parts.slice(0, i).join('.'),
        fileName: parts[i]
      }))
      const found = await db
        .select({ folderPath: treeTable.folderPath, fileName: treeTable.fileName })
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, siteId),
            eq(treeTable.locale, effectiveLocale),
            eq(treeTable.type, 'folder'),
            or(
              ...expected.map((ancestor) =>
                and(
                  eq(treeTable.folderPath, ancestor.folderPath),
                  eq(treeTable.fileName, ancestor.fileName)
                )!
              )
            )
          )
        )
      const missing = expected.filter(
        (ancestor) =>
          !found.some(
            (row) =>
              (row.folderPath ?? '') === ancestor.folderPath && row.fileName === ancestor.fileName
          )
      )
      // -> Shallowest first, so that each one's own parent is already there to be counted against
      for (const ancestor of missing) {
        CARDINAL.logger.debug('pages', 'creating a missing parent folder', {
          folder: ancestor.fileName,
          path: `/${decodeTreePath(ancestor.folderPath)}`
        })
        try {
          await db.insert(treeTable).values({
            folderPath: ancestor.folderPath,
            fileName: ancestor.fileName,
            type: 'folder',
            title: ancestor.fileName,
            locale: effectiveLocale,
            siteId,
            meta: { children: 0 }
          })
        } catch (err: any) {
          // -> The check above already covers the common case; this catches the race it cannot close --
          //    two requests both filling in the same missing ancestor folder
          if (isUniqueViolation(err)) {
            throw duplicateEntryError()
          }
          throw err
        }
        await this.countTowardsFolderAt(siteId, effectiveLocale, ancestor.folderPath, 1, db)
      }
    }

    let inserted
    try {
      inserted = await db
        .insert(treeTable)
        .values({
          folderPath: path,
          fileName: name,
          type: 'folder',
          title,
          locale: effectiveLocale,
          siteId,
          meta: { children: 0 }
        })
        .returning()
    } catch (err: any) {
      // -> The check above already covers the common case; this catches the race it cannot close --
      //    two requests both creating the same folder
      if (isUniqueViolation(err)) {
        throw duplicateEntryError()
      }
      throw err
    }

    await this.countTowardsFolderAt(siteId, effectiveLocale, path, 1, db)

    // -> A new folder can hold visible pages, either now or once populated, which changes what any
    //    ancestor `auto`/`mixed` menu's cached tree walk would return
    CARDINAL.models.navigation.invalidateCache(siteId)

    CARDINAL.logger.debug('pages', 'created folder', { folder: inserted[0].id })
    return inserted[0] as TreeRow
  }

  /**
   * Renames everything under the folder along with it.
   *
   * @param siteId Required so this model method is itself closed to a foreign `folderId`, rather
   *               than relying solely on the API handler's own separate check.
   * @param pathName Unchanged from the current segment when only the title differs, which leaves
   *                 every descendant's path untouched.
   */
  async renameFolder({
    folderId,
    siteId,
    pathName,
    title
  }: {
    folderId: string
    siteId: string
    pathName: string
    title: string
  }): Promise<TreeRow> {
    const folder = await this.requireFolderById(folderId, siteId)
    // -> Normalized as it is on the way in, since this renames the segment every page path under the
    //    folder is built from
    const name = normalizePagePath(pathName)
    if (!rePathName.test(name)) {
      throw new CustomError(
        'treeInvalidPath',
        'A folder path name may only contain lowercase alphanumeric and hyphen characters.'
      )
    }
    if (!reTitle.test(title)) {
      throw new CustomError('treeInvalidTitle', 'The folder title contains invalid characters.')
    }

    if (name === folder.fileName) {
      const updated = await CARDINAL.db
        .update(treeTable)
        .set({ title, updatedAt: sql`now()` })
        .where(eq(treeTable.id, folder.id))
        .returning()
      // -> The title alone feeds a generated menu item's label
      CARDINAL.models.navigation.invalidateCache(folder.siteId)
      return updated[0] as TreeRow
    }

    // -> Same root-only rule as `createFolder`: a folder already nested cannot collide with the
    //    locale-prefix parser regardless of what it is renamed to. Checked only once the segment is
    //    actually changing, so a title-only edit of a grandfathered root folder is not blocked.
    if (!folder.folderPath && (await CARDINAL.models.locales.isReservedLocaleCode(name))) {
      throw new CustomError(
        'treeReservedLocaleSegment',
        `"${name}" is an installed locale code and cannot name a root folder.`,
        400
      )
    }

    await this.assertFolderNameFree(
      folder.siteId,
      folder.locale,
      folder.folderPath ?? '',
      name,
      folder.id
    )

    const oldPath = childPathOf(folder)
    const newPath = folder.folderPath ? `${folder.folderPath}.${name}` : name

    CARDINAL.logger.debug('pages', 'renaming folder', {
      folder: folder.id,
      from: oldPath,
      path: newPath
    })

    let movedPages: MovedDescendantPage[] = []
    let movedAssets: MovedDescendantAsset[] = []

    // -> One logical move: failing partway would leave some descendants renamed and others not, or a
    //    folder row moved but its descendants' paths unrefreshed
    const updated = await CARDINAL.db.transaction(async (tx) => {
      // -> Direct children carry the old path verbatim; deeper ones carry it as a prefix, and keep
      //    whatever they had below it. Scoped to this folder's own locale -- otherwise a same-named
      //    folder in another locale, sharing the same path, would be dragged along with it.
      await tx
        .update(treeTable)
        .set({ folderPath: newPath })
        .where(
          and(
            eq(treeTable.siteId, folder.siteId),
            eq(treeTable.locale, folder.locale),
            eq(treeTable.folderPath, oldPath)
          )
        )
      await tx
        .update(treeTable)
        .set({
          folderPath: sql`${newPath}::ltree || subpath(${treeTable.folderPath}, nlevel(${newPath}::ltree))`
        })
        .where(
          and(
            eq(treeTable.siteId, folder.siteId),
            eq(treeTable.locale, folder.locale),
            sql`${treeTable.folderPath} <@ ${oldPath}::ltree`
          )
        )

      const renamed = await tx
        .update(treeTable)
        .set({ fileName: name, title, updatedAt: sql`now()` })
        .where(eq(treeTable.id, folder.id))
        .returning()

      movedPages = await this.refreshDescendantPaths(folder.siteId, folder.locale, newPath, tx)
      movedAssets = await this.refreshDescendantAssetFolders(
        folder.siteId,
        folder.locale,
        oldPath,
        newPath,
        tx
      )

      return renamed
    })

    // -> Every asset under it is served from a different path, and nothing about the assets
    //    themselves changed for the file cache to notice
    CARDINAL.models.assetServing.forgetAllPaths()

    // -> Never inside `tx`: writes inside, I/O outside, the same boundary `movePage` draws.
    //    `glossary.invalidateCache` is per-site, so it fires once for the batch, not once per page.
    for (const moved of movedPages) {
      await this.fireDescendantMoveSideEffects(folder.siteId, moved)
    }
    if (movedPages.length > 0) {
      CARDINAL.models.glossary.invalidateCache(folder.siteId)
    }
    // -> No search reindex or glossary invalidation for these: neither indexes assets.
    for (const moved of movedAssets) {
      await this.fireDescendantAssetMoveSideEffects(folder.siteId, moved)
    }

    // -> The renamed folder's own path segment, and its own title, both feed a generated menu item --
    //    the segment through every descendant's `target` too
    CARDINAL.models.navigation.invalidateCache(folder.siteId)

    CARDINAL.logger.debug('pages', 'renamed folder', { folder: folder.id })
    return updated[0] as TreeRow
  }

  /**
   * A page keeps a second copy of its path on `pages` -- the `path` itself and the `hash` a reader's
   * request is actually resolved through -- so leaving it after a folder move would keep serving the
   * page from where it used to sit. Folders and assets need nothing here: the bulk ltree `UPDATE` in
   * the caller already rewrote every descendant's `folderPath`, and neither has a path beyond that.
   *
   * `generatePathHash` does not exist in postgres, so each page's new path and hash are computed here
   * in JS. `updatedAt` is deliberately not touched: the folder moved, the pages under it did not
   * change. The write-back is chunked so a folder with a couple thousand descendants is not that many
   * sequential round trips holding row locks on `pages`, and each chunk is read back with a typed
   * `.select()` rather than parsed out of the raw `UPDATE`, so drizzle guarantees the row shape.
   *
   * @returns Every page repathed, with where it used to live, for the caller to fire move side
   *          effects once the transaction this runs inside has committed.
   */
  private async refreshDescendantPaths(
    siteId: string,
    locale: string,
    path: string,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<MovedDescendantPage[]> {
    const rows = await db
      .select({
        id: treeTable.id,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName
      })
      .from(treeTable)
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.type, 'page'),
          sql`${treeTable.folderPath} <@ ${path}::ltree`
        )
      )

    // -> Read before anything below overwrites it: this is the only point at which `pages.path`
    //    still holds the pre-rename value.
    const pageIds = rows.map((row) => row.id)
    const previousPaths = new Map<string, string>()
    if (pageIds.length > 0) {
      const previousRows = await db
        .select({ id: pagesTable.id, path: pagesTable.path })
        .from(pagesTable)
        .where(inArray(pagesTable.id, pageIds))
      for (const row of previousRows) {
        previousPaths.set(row.id, row.path)
      }
    }

    const pageUpdates: { id: string; path: string; hash: string }[] = []
    for (const row of rows) {
      const folderPath = decodeTreePath(row.folderPath ?? '')
      const fullPath = folderPath ? `${folderPath}/${row.fileName}` : row.fileName
      pageUpdates.push({ id: row.id, path: fullPath, hash: generatePathHash(fullPath) })
    }

    const movedPages: MovedDescendantPage[] = []
    for (const batch of chunk(pageUpdates, TREE_UPDATE_CHUNK_SIZE)) {
      await db.execute(sql`
        UPDATE pages AS p
        SET path = v.path, hash = v.hash
        FROM (VALUES ${sql.join(
          batch.map((u) => sql`(${u.id}::uuid, ${u.path}, ${u.hash})`),
          sql`, `
        )}) AS v(id, path, hash)
        WHERE p.id = v.id
      `)
      const updatedRows = await db
        .select()
        .from(pagesTable)
        .where(
          inArray(
            pagesTable.id,
            batch.map((u) => u.id)
          )
        )
      for (const updatedRow of updatedRows) {
        const previousPath = previousPaths.get(updatedRow.id)
        if (previousPath !== undefined) {
          movedPages.push({ page: updatedRow, previousPath, previousLocale: locale })
        }
      }
    }

    if (rows.length > 0) {
      CARDINAL.logger.debug('pages', 'refreshed the path of moved pages', { pages: rows.length })
    }
    return movedPages
  }

  /**
   * History and watcher notifications are deliberately not fired here: both need a real authoring
   * actor, and a folder-level rename has none to give them. `glossary.invalidateCache` is per-site
   * rather than per-page, so the caller fires it once for the whole batch instead.
   */
  private async fireDescendantMoveSideEffects(
    siteId: string,
    { page, previousPath, previousLocale }: MovedDescendantPage
  ): Promise<void> {
    await CARDINAL.models.search.renamed(siteId, page, previousPath, previousLocale)
    await CARDINAL.models.storage.dispatch('page:rename', {
      id: page.id,
      path: page.path,
      previousPath,
      locale: page.locale,
      previousLocale,
      siteId
    })
  }

  /**
   * Unlike a page, an asset carries no second copy of its path outside `tree` for this to read a
   * "before" value back from, so this runs *after* `renameFolder`'s bulk ltree `UPDATE`s have already
   * rewritten every descendant's `folderPath` and derives each one's pre-rename `folderPath` by
   * replacing the `newPath` prefix with `oldPath` -- the exact inverse of the SQL
   * `newPath::ltree || subpath(folderPath, nlevel(newPath::ltree))` rewrite those `UPDATE`s ran.
   *
   * @param oldPath Dot-encoded ltree, before the rename.
   * @param newPath The same after it -- what every descendant already carries by the time this runs.
   */
  private async refreshDescendantAssetFolders(
    siteId: string,
    locale: string,
    oldPath: string,
    newPath: string,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<MovedDescendantAsset[]> {
    const rows = await db
      .select({
        id: treeTable.id,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName,
        kind: assetsTable.kind,
        fileSize: assetsTable.fileSize
      })
      .from(treeTable)
      .innerJoin(assetsTable, eq(assetsTable.id, treeTable.id))
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.type, 'asset'),
          sql`${treeTable.folderPath} <@ ${newPath}::ltree`
        )
      )

    const movedAssets: MovedDescendantAsset[] = rows.map((row) => {
      const folderPathLtree = row.folderPath ?? ''
      const previousFolderPathLtree = oldPath + folderPathLtree.slice(newPath.length)
      return {
        id: row.id,
        fileName: row.fileName,
        folderPath: decodeTreePath(folderPathLtree) ?? '',
        previousFolderPath: decodeTreePath(previousFolderPathLtree) ?? '',
        kind: row.kind,
        fileSize: row.fileSize
      }
    })

    if (movedAssets.length > 0) {
      CARDINAL.logger.debug('pages', 'refreshed the folder of moved assets', {
        assets: movedAssets.length
      })
    }
    return movedAssets
  }

  /**
   * No webhook half, unlike `assets.ts#moveAsset`'s own `announce()` call: a folder-level rename has
   * no per-move actor to give a webhook subscriber.
   */
  private async fireDescendantAssetMoveSideEffects(
    siteId: string,
    { id, fileName, folderPath, previousFolderPath, kind, fileSize }: MovedDescendantAsset
  ): Promise<void> {
    await CARDINAL.models.storage.dispatch('asset:move', {
      id,
      fileName,
      folderPath,
      previousFolderPath,
      siteId,
      kind,
      fileSize
    })
  }

  /**
   * Exactly the set `deleteFolder` deletes and `renameFolder` moves, scoped by `siteId` and the
   * folder's own `locale` the same way, so their callers can authorize every descendant before
   * committing to the mutation.
   *
   * @param db Runs against this instead of the ambient `CARDINAL.db`, so a caller can authorize inside
   *           the same transaction that will go on to mutate.
   */
  async listDescendants(
    folderId: string,
    siteId: string,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<{ pages: DescendantPage[]; assets: DescendantAsset[] }> {
    const folder = await this.requireFolderById(folderId, siteId, db)
    const path = childPathOf(folder)

    const rows = await db
      .select({
        id: treeTable.id,
        type: treeTable.type,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName,
        locale: treeTable.locale,
        tags: treeTable.tags,
        classification: pagesTable.classification
      })
      .from(treeTable)
      .leftJoin(pagesTable, eq(pagesTable.id, treeTable.id))
      .where(
        and(
          eq(treeTable.siteId, folder.siteId),
          eq(treeTable.locale, folder.locale),
          sql`${treeTable.folderPath} <@ ${path}::ltree`
        )
      )

    const pages: DescendantPage[] = []
    const assets: DescendantAsset[] = []
    for (const row of rows) {
      const folderPath = decodeTreePath(row.folderPath ?? '') ?? ''
      const fullPath = folderPath ? `${folderPath}/${row.fileName}` : row.fileName
      if (row.type === 'page') {
        pages.push({
          id: row.id,
          path: fullPath,
          locale: row.locale,
          tags: row.tags ?? [],
          classification: row.classification ?? null
        })
      } else if (row.type === 'asset') {
        assets.push({
          id: row.id,
          path: fullPath,
          folderPath,
          fileName: row.fileName,
          locale: row.locale
        })
      }
    }

    return { pages, assets }
  }

  async duplicateFolder({
    id,
    siteId,
    folderId,
    parentPath,
    pathName,
    title,
    actor
  }: {
    id: string
    siteId: string
    folderId?: string | null
    parentPath?: string | null
    pathName?: string
    title?: string
    actor: PageActor
  }): Promise<DuplicatedFolder> {
    const source = await this.requireFolderById(id, siteId)
    const sourcePath = childPathOf(source)

    CARDINAL.logger.debug('pages', 'duplicating folder', { folder: source.id, path: sourcePath })

    const createdPages: { rows: CreatedPageRows; input: PageInput }[] = []
    const createdAssets: {
      id: string
      fileName: string
      folderPath: string
      kind: string
      fileSize: number | null
    }[] = []
    let folderCount = 0

    const copy = await CARDINAL.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: treeTable.id,
          type: treeTable.type,
          folderPath: treeTable.folderPath,
          fileName: treeTable.fileName,
          title: treeTable.title,
          tags: treeTable.tags,
          meta: treeTable.meta,
          assetId: assetsTable.id,
          assetKind: assetsTable.kind,
          assetFileSize: assetsTable.fileSize
        })
        .from(treeTable)
        .leftJoin(assetsTable, eq(assetsTable.id, treeTable.id))
        .where(
          and(
            eq(treeTable.siteId, source.siteId),
            eq(treeTable.locale, source.locale),
            sql`${treeTable.folderPath} <@ ${sourcePath}::ltree`
          )
        )

      const root = await this.createFolder({
        parentId: folderId,
        parentPath: folderId ? undefined : parentPath,
        pathName: pathName ?? source.fileName,
        title: title ?? source.title,
        locale: source.locale,
        siteId,
        db: tx
      })
      folderCount++
      const rootPath = childPathOf(root)

      const relocate = (folderPath: string | null): string =>
        `${rootPath}${(folderPath ?? '').slice(sourcePath.length)}`
      const depthOf = (folderPath: string | null): number => (folderPath ?? '').split('.').length

      const folders = rows
        .filter((row) => row.type === 'folder')
        .toSorted((a, b) => depthOf(a.folderPath) - depthOf(b.folderPath))
      for (const row of folders) {
        await this.createFolder({
          parentPath: decodeTreePath(relocate(row.folderPath)),
          pathName: row.fileName,
          title: row.title,
          locale: root.locale,
          siteId,
          db: tx
        })
        folderCount++
      }

      for (const row of rows.filter((entry) => entry.type === 'page')) {
        const pageRow = (
          await tx.select().from(pagesTable).where(eq(pagesTable.id, row.id)).limit(1)
        )[0]
        if (!pageRow) {
          CARDINAL.logger.warn('pages', 'skipped a tree page with no page row while duplicating', {
            page: row.id
          })
          continue
        }
        const config = (pageRow.config ?? {}) as Record<string, any>
        const input: PageInput = {
          path: `${decodeTreePath(relocate(row.folderPath))}/${row.fileName}`,
          title: pageRow.title,
          editor: pageRow.editor,
          content: pageRow.content ?? '',
          ...(pageRow.render ? { render: pageRow.render } : {}),
          locale: root.locale,
          description: pageRow.description ?? '',
          icon: pageRow.icon ?? '',
          publishState: pageRow.publishState,
          publishStartDate: pageRow.publishStartDate?.toISOString() ?? null,
          publishEndDate: pageRow.publishEndDate?.toISOString() ?? null,
          isBrowsable: pageRow.isBrowsable,
          isSearchable: pageRow.isSearchable,
          relations: pageRow.relations as any[],
          tags: pageRow.tags,
          classification: pageRow.classification,
          allowComments: config.allowComments,
          allowContributions: config.allowContributions,
          showSidebar: config.showSidebar,
          showTags: config.showTags,
          showToc: config.showToc,
          tocDepth: config.tocDepth
        }
        const created = await CARDINAL.models.pages.insertPageRows(siteId, input, actor, {
          tx,
          passwordHash: pageRow.password
        })
        createdPages.push({ rows: created, input })
      }

      for (const row of rows.filter((entry) => entry.type === 'asset')) {
        if (!row.assetId) {
          CARDINAL.logger.warn(
            'assets',
            'skipped a tree asset with no asset row while duplicating',
            {
              asset: row.id
            }
          )
          continue
        }
        const folderPath = decodeTreePath(relocate(row.folderPath)) ?? ''
        const entry = await this.addAsset({
          id: randomUUID(),
          parentPath: folderPath,
          fileName: row.fileName,
          title: row.title,
          locale: root.locale,
          siteId,
          tags: row.tags ?? [],
          meta: row.meta as Record<string, any>,
          db: tx
        })
        await tx.execute(sql`
          INSERT INTO ${assetsTable} (
            "id", "fileName", "fileExt", "isSystem", "kind", "mimeType", "fileSize", "meta",
            "data", "preview", "authorId", "siteId"
          )
          SELECT
            ${entry.id}::uuid, ${entry.fileName}, "fileExt", "isSystem", "kind", "mimeType",
            "fileSize", "meta", "data", "preview", ${actor.id}::uuid, "siteId"
          FROM ${assetsTable}
          WHERE "id" = ${row.assetId}::uuid
        `)
        createdAssets.push({
          id: entry.id,
          fileName: entry.fileName,
          folderPath,
          kind: row.assetKind ?? 'other',
          fileSize: row.assetFileSize ?? null
        })
      }

      return root
    })

    CARDINAL.models.navigation.invalidateCache(siteId)

    for (const { rows, input } of createdPages) {
      try {
        await CARDINAL.models.pages.completePageCreate(siteId, rows, input, actor)
      } catch (err: any) {
        CARDINAL.logger.warn('pages', 'finishing a duplicated page failed', {
          page: rows.page.id,
          error: err
        })
      }
    }
    for (const asset of createdAssets) {
      try {
        await announce(
          'asset:upload',
          siteId,
          {
            id: asset.id,
            fileName: asset.fileName,
            folderPath: asset.folderPath,
            siteId,
            authorId: actor.id
          },
          {
            metadata: { fileSize: asset.fileSize, kind: asset.kind },
            dispatchExtra: { kind: asset.kind, fileSize: asset.fileSize }
          }
        )
      } catch (err: any) {
        CARDINAL.logger.warn('assets', 'announcing a duplicated asset failed', {
          asset: asset.id,
          error: err
        })
      }
    }

    CARDINAL.logger.info('pages', 'duplicated folder', {
      site: siteId,
      from: source.id,
      to: copy.id,
      folders: folderCount,
      pages: createdPages.length,
      assets: createdAssets.length,
      user: actor.id
    })

    return {
      folder: copy,
      folders: folderCount,
      pages: createdPages.length,
      assets: createdAssets.length
    }
  }

  /**
   * Delete a folder and everything under it.
   *
   * @param siteId Required so this model method is itself closed to a foreign `folderId`, rather
   *               than relying solely on the API handler's own separate check.
   * @returns Where each deleted entry sat comes back with it: the tree row was the only record of
   *          that, and it is gone by then.
   */
  async deleteFolder(
    folderId: string,
    siteId: string
  ): Promise<{ pages: DeletedEntry[]; assets: DeletedEntry[] }> {
    const folder = await this.requireFolderById(folderId, siteId)
    const path = childPathOf(folder)
    CARDINAL.logger.debug('pages', 'deleting folder', { folder: folder.id, path })

    // -> The two deletes and the parent's child-count update are one logical delete: a failure
    //    partway through must not leave descendants gone but the folder row (or its parent's count)
    //    still there, or vice versa.
    const deleted = await CARDINAL.db.transaction(async (tx) => {
      // -> `<@` is "at or below", and the folder itself is not under its own child path, so this takes
      //    the descendants and leaves the row that owns them. Scoped to this folder's own locale --
      //    otherwise a same-named folder in another locale, sharing the same path, would be deleted
      //    right along with it.
      const removed = await tx
        .delete(treeTable)
        .where(
          and(
            eq(treeTable.siteId, folder.siteId),
            eq(treeTable.locale, folder.locale),
            sql`${treeTable.folderPath} <@ ${path}::ltree`
          )
        )
        .returning({
          id: treeTable.id,
          type: treeTable.type,
          folderPath: treeTable.folderPath,
          fileName: treeTable.fileName,
          locale: treeTable.locale
        })

      await tx.delete(treeTable).where(eq(treeTable.id, folder.id))

      await this.countTowardsFolderAt(folder.siteId, folder.locale, folder.folderPath ?? '', -1, tx)

      return removed
    })

    // -> Any of them may have owned a sidebar menu keyed by its own id, the folder included
    await CARDINAL.models.navigation.deleteNavForEntries(folder.siteId, [
      ...deleted.map((n) => n.id),
      folder.id
    ])

    CARDINAL.logger.debug('pages', 'deleted folder', {
      folder: folder.id,
      descendants: deleted.length
    })

    const asEntry = (row: (typeof deleted)[number]): DeletedEntry => ({
      id: row.id,
      folderPath: decodeTreePath(row.folderPath ?? '') ?? '',
      fileName: row.fileName,
      locale: row.locale
    })
    return {
      pages: deleted.filter((n) => n.type === 'page').map(asEntry),
      assets: deleted.filter((n) => n.type === 'asset').map(asEntry)
    }
  }

  /**
   * @param parentId Takes precedence over `parentPath`.
   * @param parentPath Created if it does not exist.
   */
  async addPage({
    id,
    parentId,
    parentPath,
    fileName,
    title,
    locale,
    siteId,
    tags = [],
    meta = {},
    db = CARDINAL.db
  }: {
    id?: string
    parentId?: string | null
    parentPath?: string | null
    fileName: string
    title: string
    locale: string
    siteId: string
    tags?: string[]
    meta?: Record<string, any>
    /** A page move passes its own transaction, so this entry shares fate with the `pages` row
     *  update alongside it. */
    db?: WikiDbOrTx
  }): Promise<TreeRow> {
    const entry = await this.addEntry({
      id,
      type: 'page',
      parentId,
      parentPath,
      fileName,
      title,
      locale,
      siteId,
      tags,
      meta,
      // -> A page's file name is its URL, chosen deliberately by whoever wrote it, so a clash is
      //    something to report rather than something to work around
      onConflict: 'error',
      db
    })
    // -> A new page can change whether an ancestor folder even has visible descendants, which any
    //    ancestor `auto`/`mixed` menu's cached tree walk depends on. Only here, not in
    //    `addAsset`/`addEntry` -- an asset entry is never considered by `generateFromTree`.
    CARDINAL.models.navigation.invalidateCache(siteId)
    return entry
  }

  /**
   * @param parentId Takes precedence over `parentPath`.
   * @param parentPath Created if it does not exist.
   */
  async addAsset({
    id,
    parentId,
    parentPath,
    fileName,
    title,
    locale,
    siteId,
    tags = [],
    meta = {},
    db = CARDINAL.db
  }: {
    id?: string
    parentId?: string | null
    parentPath?: string | null
    fileName: string
    title: string
    locale: string
    siteId: string
    tags?: string[]
    meta?: Record<string, any>
    /** A batch import passes its own transaction, so this asset's tree row shares fate with the
     *  `assets` row written alongside it. */
    db?: WikiDbOrTx
  }): Promise<TreeRow> {
    return this.addEntry({
      id,
      type: 'asset',
      parentId,
      parentPath,
      fileName,
      title,
      locale,
      siteId,
      tags,
      meta,
      // -> Whatever the site's upload conflict behavior is, a name that is taken by the time the row
      //    is written takes the next free `name-1.ext`: the assets model settled the collisions it
      //    could see, and a file that appeared since must not fail the upload on something the
      //    uploader did not choose and cannot see
      onConflict: 'suffix',
      db
    })
  }

  async renameEntry({
    id,
    fileName,
    title
  }: {
    id: string
    fileName: string
    title?: string
  }): Promise<TreeRow | null> {
    const entry = await this.getById(id)
    if (!entry) {
      return null
    }
    if (entry.fileName !== fileName) {
      const existing = await CARDINAL.db
        .select({ id: treeTable.id })
        .from(treeTable)
        .where(
          and(
            ne(treeTable.id, entry.id),
            eq(treeTable.siteId, entry.siteId),
            eq(treeTable.locale, entry.locale),
            eq(treeTable.folderPath, entry.folderPath ?? ''),
            eq(treeTable.fileName, fileName),
            // -> A page may take the name of the folder holding the pages below it
            ...(entry.type === 'page' ? [ne(treeTable.type, 'folder')] : [])
          )
        )
        .limit(1)
      if (existing.length > 0) {
        throw duplicateEntryError()
      }
    }

    const updated = await CARDINAL.db
      .update(treeTable)
      .set({
        fileName,
        title: title ?? entry.title,
        updatedAt: sql`now()`
      })
      .where(eq(treeTable.id, entry.id))
      .returning()
    return updated[0] as TreeRow
  }

  /**
   * The destination resolves as `addEntry`'s does, missing ancestors included. A move into the folder
   * the entry is already in is a no-op, so a caller is never told a move happened when nothing did.
   *
   * @param siteId Required so this method is itself closed to a foreign entry or `folderId`, rather
   *               than relying solely on the caller.
   * @returns Null if there is no such entry on this site.
   * @throws CustomError `treeInvalidFolder` (404) for an unresolvable `folderId`,
   *         `treeEntryDuplicate` (409) if the destination already holds this name — the same
   *         asymmetric page/folder exception `renameEntry` applies: a page does not block a folder
   *         taking its name, everything else does.
   */
  async moveEntry({
    id,
    siteId,
    folderId,
    parentPath
  }: {
    id: string
    siteId: string
    folderId?: string | null
    parentPath?: string | null
  }): Promise<TreeRow | null> {
    const entry = await this.getById(id)
    if (!entry || entry.siteId !== siteId) {
      return null
    }

    const destination = folderId
      ? await this.requireFolderById(folderId, siteId)
      : parentPath
        ? await this.getFolder({
            path: parentPath,
            locale: entry.locale,
            siteId,
            createIfMissing: true
          })
        : null
    const newPath = destination ? childPathOf(destination) : ''
    const oldPath = entry.folderPath ?? ''

    if (newPath === oldPath) {
      return entry
    }

    const collision = await CARDINAL.db
      .select({ id: treeTable.id })
      .from(treeTable)
      .where(
        and(
          ne(treeTable.id, entry.id),
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, entry.locale),
          eq(treeTable.folderPath, newPath),
          eq(treeTable.fileName, entry.fileName),
          ...(entry.type === 'page' ? [ne(treeTable.type, 'folder')] : [])
        )
      )
      .limit(1)
    if (collision.length > 0) {
      throw duplicateEntryError()
    }

    const updated = await CARDINAL.db.transaction(async (tx) => {
      const moved = await tx
        .update(treeTable)
        .set({ folderPath: newPath, updatedAt: sql`now()` })
        .where(eq(treeTable.id, entry.id))
        .returning()
      await this.countTowardsFolderAt(siteId, entry.locale, oldPath, -1, tx)
      await this.countTowardsFolderAt(siteId, entry.locale, newPath, 1, tx)
      return moved
    })

    // -> A moved entry changes what an ancestor `auto`/`mixed` menu's cached tree walk returns
    CARDINAL.models.navigation.invalidateCache(siteId)

    CARDINAL.logger.debug('pages', 'moved entry', { entry: entry.id, path: newPath })
    return updated[0] as TreeRow
  }

  async deleteEntry(id: string, db: WikiDbOrTx = CARDINAL.db): Promise<boolean> {
    const entry = await this.getById(id, db)
    if (!entry) {
      return false
    }
    await db.delete(treeTable).where(eq(treeTable.id, id))
    await this.countTowardsFolderAt(entry.siteId, entry.locale, entry.folderPath ?? '', -1, db)
    // -> Removing any entry can change whether its former parent folder still holds a visible page,
    //    which an ancestor `auto`/`mixed` menu's cached tree walk depends on. Unconditional rather
    //    than branching on `entry.type`: over-invalidating on an asset delete is harmless.
    CARDINAL.models.navigation.invalidateCache(entry.siteId)
    return true
  }

  private async addEntry({
    id,
    type,
    parentId,
    parentPath,
    fileName,
    title,
    locale,
    siteId,
    tags,
    meta,
    onConflict,
    db = CARDINAL.db
  }: {
    id?: string
    type: Exclude<TreeItemType, 'folder'>
    parentId?: string | null
    parentPath?: string | null
    fileName: string
    title: string
    locale: string
    siteId: string
    tags: string[]
    meta: Record<string, any>
    onConflict: 'error' | 'suffix'
    db?: WikiDbOrTx
  }): Promise<TreeRow> {
    const folder =
      parentId || parentPath
        ? await this.getFolder({
            id: parentId,
            path: parentPath,
            locale,
            siteId,
            createIfMissing: true,
            db
          })
        : null
    const path = folder ? childPathOf(folder) : ''

    // -> A page inherits the nearest ancestor folder's override/hide menu, falling back to the
    //    locale's site-wide menu when nothing above it says otherwise (`ancestorNavId`). An asset
    //    has no sidebar of its own, so it gets no `navigationId` at all.
    const navigationId =
      type === 'page' ? await CARDINAL.models.navigation.ancestorNavId(siteId, locale, path) : null

    const name = await this.resolveName({ siteId, locale, path, type, fileName, onConflict, db })
    const fullPath = path ? `${decodeTreePath(path)}/${name}` : name

    CARDINAL.logger.debug('pages', 'adding an entry to the tree', { type, path: fullPath })

    let inserted
    try {
      inserted = await db
        .insert(treeTable)
        .values({
          ...(id ? { id } : {}),
          folderPath: path,
          fileName: name,
          type,
          // -> A title that was only ever the file name follows it when the name had to change, so that
          //    two uploads of `photo.png` do not both show up called `photo.png`
          title: title === fileName ? name : title,
          locale,
          siteId,
          tags,
          meta,
          ...(navigationId ? { navigationId } : {})
        })
        .returning()
    } catch (err: any) {
      // -> `resolveName` already covers the common case; this catches the race it cannot close -- two
      //    requests that both resolve the same free name before either inserts
      if (isUniqueViolation(err)) {
        throw duplicateEntryError()
      }
      throw err
    }

    await this.countTowardsFolderAt(siteId, locale, path, 1, db)

    return inserted[0] as TreeRow
  }

  /**
   * Two entries with the same name in one folder would share a path — the second shadowing the first
   * everywhere it is looked up by URL. An upload takes the next free `name-1.ext`, the way a file
   * manager is expected to; anything else says so instead.
   *
   * A page is the exception: a page and the folder of the pages below it are *meant* to share a name
   * (`/guide` is both a page and the way into `/guide/…`), and nothing shadows anything, because a
   * folder is only ever resolved as a folder and the page is found in `pages` by its own path hash.
   * An asset stays held to the whole folder, since it is served at that URL like a page would be.
   */
  private async resolveName({
    siteId,
    locale,
    path,
    type,
    fileName,
    onConflict,
    db = CARDINAL.db
  }: {
    siteId: string
    locale: string
    path: string
    type: Exclude<TreeItemType, 'folder'>
    fileName: string
    onConflict: 'error' | 'suffix'
    db?: WikiDbOrTx
  }): Promise<string> {
    const taken = async (name: string) =>
      (
        await db
          .select({ id: treeTable.id })
          .from(treeTable)
          .where(
            and(
              eq(treeTable.siteId, siteId),
              eq(treeTable.locale, locale),
              eq(treeTable.folderPath, path),
              eq(treeTable.fileName, name),
              ...(type === 'page' ? [ne(treeTable.type, 'folder')] : [])
            )
          )
          .limit(1)
      ).length > 0

    if (!(await taken(fileName))) {
      return fileName
    }
    if (onConflict === 'error') {
      throw duplicateEntryError()
    }

    const dot = fileName.lastIndexOf('.')
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName
    const ext = dot > 0 ? fileName.slice(dot) : ''
    for (let i = 1; i <= MAX_NAME_ATTEMPTS; i++) {
      const candidate = `${stem}-${i}${ext}`
      if (!(await taken(candidate))) {
        return candidate
      }
    }
    throw new CustomError(
      'treeEntryDuplicate',
      'Too many files in this folder are already named this.',
      409
    )
  }

  /**
   * The count lives on the folder rather than being counted on read, so whoever adds or removes
   * something has to keep it straight. The arithmetic is done in postgres rather than
   * read-then-write so that two concurrent uploads into the same folder cannot lose one another's
   * increment. An empty path is the site root, which is not a folder and has nothing to count.
   */
  private async countTowardsFolderAt(
    siteId: string,
    locale: string,
    path: string,
    delta: number,
    db: WikiDbOrTx = CARDINAL.db
  ): Promise<void> {
    if (!path) {
      return
    }
    const location = splitPath(path)
    await db
      .update(treeTable)
      .set({
        meta: sql`jsonb_set(${treeTable.meta}, '{children}', to_jsonb(GREATEST(0, COALESCE((${treeTable.meta}->>'children')::int, 0) + ${delta})))`
      })
      .where(
        and(
          eq(treeTable.siteId, siteId),
          eq(treeTable.locale, locale),
          eq(treeTable.folderPath, location.folderPath),
          eq(treeTable.fileName, location.fileName),
          eq(treeTable.type, 'folder')
        )
      )
  }
}

export const tree = new Tree()
