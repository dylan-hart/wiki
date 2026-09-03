import { and, asc, desc, eq, exists, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import { chunk } from 'es-toolkit/array'
import type { WikiDbOrTx } from '../core/db.ts'
import { pages as pagesTable, tree as treeTable } from '../db/schema.ts'
import {
  CustomError,
  decodeTreePath,
  encodeTreePath,
  generatePathHash,
  isUniqueViolation,
  normalizePagePath
} from '../helpers/common.ts'

/**
 * How many descendant rows `refreshDescendantPaths` writes back per `UPDATE ... FROM (VALUES ...)`
 * statement (OpenProject #1865). Exported so its test can size a fixture off the real production
 * value instead of a magic number duplicated between the two files.
 */
export const TREE_UPDATE_CHUNK_SIZE = 200

/** What a tree entry can be. Mirrors the `treeType` enum in the schema. */
export type TreeItemType = 'folder' | 'page' | 'asset'

/** The fields a tree listing can be sorted on. */
export const TREE_ORDER_BY = ['createdAt', 'fileName', 'title', 'updatedAt'] as const

export type TreeOrderBy = (typeof TREE_ORDER_BY)[number]

/**
 * A tree entry as exposed by the API.
 *
 * One shape for all three kinds rather than three: a folder listing interleaves them, and the type
 * field is what tells them apart. The kind-specific fields are absent on the kinds they do not apply
 * to.
 */
export interface TreeItem {
  id: string
  type: TreeItemType
  /** How many folders deep the entry sits, 0 being the root. */
  depth: number
  /** Slash-separated, without a leading or trailing slash. Empty at the root. */
  folderPath: string
  fileName: string
  title: string
  tags: string[]
  createdAt: Date
  updatedAt: Date
  /** Folders only — how many entries the folder holds. */
  childrenCount?: number
  /** Folders only — whether this folder is a parent of the one being listed, not a child of it. */
  isAncestor?: boolean
  /** Assets only. */
  fileSize?: number
  fileExt?: string
  mimeType?: string
  /** Pages only. */
  editor?: string
  description?: string
  /** Pages only — classification level id (OpenProject #1079), for the permission filter layered on
   *  top of this listing (see `visibleTreeItems` in `helpers/pageAccess.ts`). Never returned to the client: no
   *  API schema declares this field, so Fastify's response serialization drops it. */
  classification?: string | null
}

/**
 * One row of a browse listing.
 *
 * A page and a folder can sit at the very same path — `/foo/bar` the page, `/foo/bar/…` the folder of
 * pages under it — and a reader thinks of those as one thing with two ways in, so they come back as
 * one entry carrying both flags rather than as two rows with the same name.
 */
export interface BrowseItem {
  /** Slash-separated path of the entry: the page's own URL, and the folder to list on the way down. */
  path: string
  fileName: string
  title: string
  /** The page's icon, as an Iconify reference. Null for a folder with no page at its path. */
  icon: string | null
  isPage: boolean
  isFolder: boolean
  /** The page's classification level id (OpenProject #1079), for the reader-permission filter layered
   *  on top of this listing. Null for a folder with no page at its path. Never returned to the
   *  client: no API schema declares this field, so Fastify's response serialization drops it. */
  classification: string | null
}

/** One level of a browse listing: what a folder holds, plus what the folder itself is called. */
export interface BrowseLevel {
  /** The folder that was listed, slash-separated. Empty at the site root. */
  path: string
  /** The folder's title. Empty at the site root, which is not a folder and has no row of its own. */
  title: string
  items: BrowseItem[]
  /** Whether the folder holds more than `MAX_BROWSE` entries, the rest of which were dropped. */
  truncated: boolean
}

/** One page of a reader-facing listing, as the index block draws it. */
export interface ListedPage {
  id: string
  /** Slash-separated path of the page, i.e. its URL within the site. */
  path: string
  title: string
  description: string
  /** The page's icon, as an Iconify reference. Empty when it has none. */
  icon: string
  /** Classification level id (OpenProject #1079), for the reader-permission filter layered on top of
   *  this listing (see `api/tree.ts`'s "LIST PAGES AS A READER" route). Never returned to the client:
   *  no API schema declares this field, so Fastify's response serialization drops it. */
  classification: string | null
}

/**
 * An entry that went with a deleted folder, and where it used to sit.
 *
 * What the caller needs to finish the job: the row behind it to delete, and enough to say what was
 * deleted once nothing in the database records that any more.
 */
export interface DeletedEntry {
  id: string
  /** Slash-separated, without the file name. Empty at the site root. */
  folderPath: string
  fileName: string
  locale: string
}

/**
 * A descendant page, as returned by `listDescendants` for a caller to authorize before it mutates
 * (OpenProject #2098).
 */
export interface DescendantPage {
  id: string
  /** Slash-separated path of the page. */
  path: string
  locale: string
  tags: string[]
  /** Classification level id (OpenProject #1079), joined from `pages` -- `tree` carries none of its
   *  own (the same gap as OpenProject #1128). */
  classification: string | null
}

/**
 * A descendant asset, as returned by `listDescendants` for a caller to authorize before it mutates
 * (OpenProject #2098).
 */
export interface DescendantAsset {
  id: string
  /** Slash-separated path of the asset, built from its tree row's `folderPath`/`fileName` -- what an
   *  asset `read:assets`/`manage:assets` ref is built from. */
  path: string
  /** Slash-separated, without the file name. Empty at the site root -- what `mayOnAsset` (`helpers/pageAccess.ts`)
   *  takes alongside `fileName` to build the same ref, rather than the combined `path` above. */
  folderPath: string
  fileName: string
  locale: string
}

/**
 * One page `refreshDescendantPaths` repathed, for the caller to fire the move side effects
 * `pages.ts#recordMoveSideEffects` fires for a direct `movePage` (search index, storage dispatch) --
 * see `renameFolder`. `page` is the full post-update row, matching what `search.renamed` expects.
 */
export interface MovedDescendantPage {
  page: typeof pagesTable.$inferSelect
  previousPath: string
  previousLocale: string
}

/** A raw `tree` row, as the model passes it around internally. */
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

/** Ceiling on how many entries one listing returns, and how deep it may recurse. */
const MAX_LIMIT = 1000
/** Also the recursion ceiling `Navigation.generateFromTree` enforces for the same reason. */
export const MAX_DEPTH = 10

/** Ceiling on how many entries one browse level returns. */
const MAX_BROWSE = 500

/** How many `name-1`, `name-2`… variants an upload will try before giving up on the name. */
const MAX_NAME_ATTEMPTS = 100

/**
 * Whether a folder holds a page a reader may open, at any depth below it — as an `EXISTS` correlated
 * to the outer `tree` row being tested.
 *
 * A folder is created for whatever is put in it, so it can end up holding only assets, only drafts,
 * or nothing at all — descending into any of those lands on an empty menu, which is why both places
 * that list a folder's contents (`tree.browse()` and `navigation.generateFromTree()`) drop a folder
 * that answers false. `EXISTS` stops at the first hit, so this costs an index lookup per folder in
 * the level rather than a count.
 *
 * @param encodedParentPath The ltree path of the folder being listed, so a child's own path is built
 *   as `<prefix>.<name>` from a bound string and the row's own name — text concatenation rather than
 *   an ltree operator, since the prefix is a parameter and the name is a column
 * @param publicOnly Passed straight to `pageIsVisible`: true restricts to what an anonymous reader
 *   may see, which is what a generated menu always asks for
 * @param aliasSuffix Names the two table aliases this subquery introduces. Each call site needs its
 *   own, since two `EXISTS` clauses in one statement cannot share an alias name.
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
    WIKI.db
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
 * The one refusal for "a tree row already sits at this name in this folder".
 *
 * Five sites raise it: the pre-insert probe in `addEntry`, `resolveName`'s `onConflict: 'error'`
 * branch, and the three `isUniqueViolation` catches that close the race those probes cannot — the
 * constraint, not the probe, is the arbiter of who won. Written once so all five stay the same error
 * a client can act on. (`resolveName`'s "too many files are already named this" is deliberately not
 * this one: it names a different problem.)
 */
function duplicateEntryError(): CustomError {
  return new CustomError('treeEntryDuplicate', 'Something with this name already exists here.', 409)
}

/**
 * The ltree path of a folder's *contents*, i.e. the value its children carry in `folderPath`.
 */
function childPathOf(folder: { folderPath?: string | null; fileName: string }): string {
  return folder.folderPath ? `${folder.folderPath}.${folder.fileName}` : folder.fileName
}

/**
 * Folders before pages, alphabetical by title within each — the sort order `browse()` uses for a
 * folder listing, and `Navigation.generateFromTree` reuses for the same reason: an auto-generated menu
 * should read the same way the folder it was built from does.
 */
export function compareFoldersFirst(
  a: { isFolder: boolean; title: string },
  b: { isFolder: boolean; title: string }
): number {
  return a.isFolder === b.isFolder ? a.title.localeCompare(b.title) : a.isFolder ? -1 : 1
}

/**
 * Split an ltree path into the (folderPath, fileName) pair that addresses the entry itself.
 */
function splitPath(path: string): { folderPath: string; fileName: string } {
  const parts = path.split('.')
  return {
    folderPath: parts.slice(0, -1).join('.'),
    fileName: parts.at(-1) ?? ''
  }
}

/**
 * Turn a row into the shape the API returns.
 */
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
      // -> Shorter than the folder being listed means it sits above it, so it came from
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
 * What a page has to be for a reader to be shown that it exists.
 *
 * Deliberately the same rule the page view itself applies (see `pages.getPage`'s `publicOnly`), so
 * that a menu never offers a page that would answer 404 — nor hides one that would open.
 *
 * A password-protected page is listed. It is not hidden but locked: opening it puts the reader in
 * front of the unlock prompt, which is exactly where someone who has the password wants to end up,
 * and its title is metadata rather than protected content.
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
 * Tree model
 *
 * The tree is the single index of everything addressable in a site — folders, pages and assets alike
 * — keyed by an ltree `folderPath`. Pages and assets keep their own rows elsewhere and join back on
 * the same ID; the tree row is what gives them a place and a name.
 *
 * Paths are slashes on the way in and out (`foo/bar`) and dots inside the database (`foo.bar`), which
 * is what `encodeTreePath` / `decodeTreePath` convert between. Nothing outside this model should have
 * to know about the dotted form.
 */
class Tree {
  /**
   * List the contents of a folder.
   *
   * @param parentId UUID of the folder to list. Takes precedence over `parentPath`.
   * @param parentPath Slash-separated path of the folder to list. The site root when both are absent.
   * @param depth How many levels below the folder to include. 0, the default, is the folder itself.
   * @param includeAncestors Also return every folder between the root and the one being listed, so a
   *                         caller opening a deep folder gets the branch it hangs off in one request.
   * @param includeRootFolders Also return every folder at the root, for the same reason.
   * @param locale Required — every listing is scoped to exactly one locale. A caller with no locale
   *               opinion of its own (an HTTP request that left the query param off) resolves one
   *               before calling in, rather than this method merging every locale together.
   * @param publicOnly Hide, from a page-type entry only, exactly what `pageIsVisible` hides from an
   *                   anonymous reader — a draft/scheduled page, or one marked `isBrowsable: false` —
   *                   so BROWSE THE TREE (OpenProject #1587 §2) cannot enumerate them to a guest
   *                   session holding `read:pages`, the one thing `visibleTreeItems`' page-RULE
   *                   filter in `helpers/pageAccess.ts` never checked. `false` (an authenticated caller, and
   *                   every other current caller of this method) keeps every entry, same as before
   *                   this parameter existed — a folder or asset entry is never affected either way.
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
    /** Restrict page rows to what a reader with no session may see. See `pageIsVisible`. */
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

    // -> Resolve what to list into the ltree path its children carry
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
      // -> Each iteration drops one level off the end, walking the branch back up to the root
      const parts = path.split('.')
      for (let i = 0; i < parts.length; i++) {
        locations.push(
          and(
            eq(treeTable.folderPath, parts.slice(0, parts.length - 1 - i).join('.')),
            eq(treeTable.fileName, parts[parts.length - 1 - i]),
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
      //    folder or asset row carries every `pagesTable` column as null -- applying
      //    `pageIsVisible` unguarded would filter those out too, along with the page rows it is
      //    actually meant to hide. Restricting the predicate to `type = 'page'` rows is what
      //    keeps folders and assets listed exactly as before.
      conditions.push(or(ne(treeTable.type, 'page'), and(...pageIsVisible(pagesTable, true))))
    }

    const direction = orderByDirection === 'desc' ? desc : asc
    const rows = await WIKI.db
      .select({
        row: treeTable,
        depth: sql<number>`nlevel(${treeTable.folderPath})`.mapWith(Number),
        // -> Only a `page`-type row's id ever matches `pagesTable.id`; a folder or asset row leaves
        //    this null, which is exactly the "no classification" `toTreeItem` already treats those
        //    kinds as (OpenProject #1128).
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
   * List the pages under a path, the way an index block on a page lists them.
   *
   * Between `getTree()` and `browse()`: it recurses and sorts like the first and hides like the
   * second. Folders are left out entirely — the block draws a list of pages, not a file browser —
   * and so is any page the reader may not open, by the same rule the page view applies.
   *
   * @param path Slash-separated path to list. The site root when empty.
   * @param depth How many folders below the path to include. 0, the default, is the path itself.
   * @param tags Only pages carrying every one of these tags.
   * @param publicOnly Restrict to what a reader with no session may see. See `pageIsVisible`.
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
    const rows = await WIKI.db
      .select({
        id: treeTable.id,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName,
        title: treeTable.title,
        description: pagesTable.description,
        icon: pagesTable.icon,
        classification: pagesTable.classification
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

    return rows.map((row) => {
      const folderPath = decodeTreePath(row.folderPath ?? '') ?? ''
      return {
        id: row.id,
        path: folderPath ? `${folderPath}/${row.fileName}` : row.fileName,
        title: row.title,
        description: row.description ?? '',
        icon: row.icon ?? '',
        classification: row.classification
      }
    })
  }

  /**
   * List one folder the way a reader browses it: the pages they may open and the folders worth
   * opening, and nothing else.
   *
   * Not a variant of `getTree()`. That one is the file manager's view — every entry of every kind,
   * for someone with permission to manage them. This is the reader's: assets have no place in it,
   * a page nobody may see must not appear even as a name, and a folder whose whole contents are
   * invisible is a dead end rather than something to offer.
   *
   * @param path Slash-separated path of the folder to list. The site root when empty.
   * @param publicOnly Restrict pages to what a reader with no session may see. See `pageIsVisible`.
   * @returns The level, or null when there is no such folder
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

    // -> What the level is called. The root is not a folder, so it has no row and no title of its own
    //    — and a path that is not a folder is nothing this can list.
    let title = ''
    if (encodedPath) {
      const location = splitPath(encodedPath)
      const folder = await WIKI.db
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
    const rows = await WIKI.db
      .select({
        type: treeTable.type,
        fileName: treeTable.fileName,
        title: treeTable.title,
        icon: pagesTable.icon,
        classification: pagesTable.classification,
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
        classification: null
      }
      if (row.type === 'folder') {
        entry.isFolder = true
      } else {
        entry.isPage = true
        // -> The page is the thing a reader clicks, so it names the row when both exist
        entry.title = row.title
        entry.icon = row.icon
        entry.classification = row.classification
      }
      merged.set(row.fileName, entry)
    }

    return {
      path: basePath,
      title,
      truncated: rows.length > MAX_BROWSE,
      // -> Folders first, as a file browser lists them; an entry that is both belongs with them
      items: [...merged.values()].sort(compareFoldersFirst)
    }
  }

  /**
   * A single tree row by ID, or null if there is no such row.
   *
   * Private on purpose: it is the one lookup here that takes no `siteId`, so a caller outside this
   * model could reach another site's row with an id alone -- exactly the leak `getFolderById`'s
   * required `siteId` closes (OpenProject #2127/#2131). Internal callers pair it with their own
   * site check.
   */
  private async getById(id: string, db: WikiDbOrTx = WIKI.db): Promise<TreeRow | null> {
    const results = await db.select().from(treeTable).where(eq(treeTable.id, id)).limit(1)
    return (results[0] as TreeRow) ?? null
  }

  /**
   * A single folder by ID, or null if the ID is not a folder OR belongs to a different site
   * (OpenProject #2127/#2131) — `siteId` is required, with no optional-argument fallback, so a
   * caller can no longer look a folder up by id alone and forget to check whose site it belongs
   * to. The folder-create handler in `api/tree.ts` used to do exactly that with a caller-supplied
   * `parentId`, leaking another site's folder path and locale to whoever already held
   * `manage:pages` on their OWN site.
   */
  async getFolderById(
    id: string,
    siteId: string,
    db: WikiDbOrTx = WIKI.db
  ): Promise<TreeRow | null> {
    const results = await db
      .select()
      .from(treeTable)
      .where(and(eq(treeTable.id, id), eq(treeTable.siteId, siteId), eq(treeTable.type, 'folder')))
      .limit(1)
    return (results[0] as TreeRow) ?? null
  }

  /**
   * `getFolderById`, but refusing rather than answering null — what the six callers that cannot carry
   * on without the folder each wrote out by hand. The nullable form stays public: `api/tree.ts` and
   * `api/assets.ts` genuinely want to know whether a folder is there without a 404 being raised for
   * them.
   *
   * @throws CustomError `treeInvalidFolder` (404)
   */
  private async requireFolderById(
    id: string,
    siteId: string,
    db: WikiDbOrTx = WIKI.db
  ): Promise<TreeRow> {
    const folder = await this.getFolderById(id, siteId, db)
    if (!folder) {
      throw new CustomError('treeInvalidFolder', 'This folder does not exist.', 404)
    }
    return folder
  }

  /**
   * Refuse a folder name something that is not a page already occupies, inside one folder path.
   *
   * A page here is not in the way: a folder alongside it is how `/guide` gets to be both a page and
   * the way into `/guide/…`. An asset is, since it is served at that URL itself — the same rule
   * `resolveName` applies coming the other way. Asked identically on the way in (`createFolder`) and
   * on a rename, which only adds "except myself".
   *
   * @param exceptId The row allowed to already hold the name — the folder being renamed
   * @throws CustomError `treeFolderDuplicate` (409)
   */
  private async assertFolderNameFree(
    siteId: string,
    locale: string,
    folderPath: string,
    name: string,
    exceptId?: string,
    db: WikiDbOrTx = WIKI.db
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
   * Whatever already sits at a name inside a folder, or null if the name is free.
   *
   * The question an upload has to ask before it writes anything, since what is there decides whether
   * the file replaces it, is refused, or takes the next free name. A folder that does not exist holds
   * nothing, so an unresolvable destination answers null rather than raising: the caller is about to
   * create it.
   *
   * @param parentId UUID of the folder to look in. Takes precedence over `parentPath`; the site root
   *                 when both are absent.
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

    const results = await WIKI.db
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
   * Resolve a folder, either by ID or by path.
   *
   * @param createIfMissing Create the folder, and any ancestor it needs, when the path has none. Only
   *                        applies when resolving by path — an ID that matches nothing is an error
   *                        either way.
   */
  async getFolder({
    id,
    path,
    locale,
    siteId,
    createIfMissing = false,
    db = WIKI.db
  }: {
    id?: string | null
    path?: string | null
    locale?: string
    // -> Required (OpenProject #2127), not just for the path branch below: the id branch now
    //    scopes `getFolderById()` by it too, both callers already pass it.
    siteId: string
    createIfMissing?: boolean
    /** Runs against this instead of the ambient `WIKI.db` — a batch import passes its own
     *  transaction here so a folder it has to create is rolled back along with everything else in
     *  the batch, rather than surviving as an orphan when a later item in the batch fails. */
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
   * Create a folder, and any of its ancestors that do not exist yet.
   *
   * @param parentId UUID of the folder to create it in. Takes precedence over `parentPath`.
   * @param parentPath Slash-separated path of the folder to create it in. The root when both are absent.
   * @param pathName The folder's own path segment. Normalized the way a page path is, so what the
   *                 folder ends up called may differ from what was asked for.
   */
  async createFolder({
    parentId,
    parentPath,
    pathName,
    title,
    locale,
    siteId,
    db = WIKI.db
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

    // -> Resolve where it goes, as the ltree path the new folder will carry
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
    if (path === '' && (await WIKI.models.locales.isReservedLocaleCode(name))) {
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
        WIKI.logger.debug(
          `Creating missing parent folder ${ancestor.fileName} at path /${decodeTreePath(ancestor.folderPath)}...`
        )
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
    //    ancestor `auto`/`mixed` menu's cached tree walk would return (OpenProject #1825)
    WIKI.models.navigation.invalidateCache(siteId)

    WIKI.logger.debug(`Created folder ${inserted[0].id} successfully.`)
    return inserted[0] as TreeRow
  }

  /**
   * Rename a folder, moving everything under it along with it.
   *
   * @param siteId Required (OpenProject #2127) so this model method is itself closed to a foreign
   *               `folderId`, rather than relying solely on the API handler's own separate check.
   * @param pathName The new path segment, normalized as on the way in. Unchanged from the current
   *                 one when only the title differs, which leaves every descendant's path untouched.
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
      const updated = await WIKI.db
        .update(treeTable)
        .set({ title, updatedAt: sql`now()` })
        .where(eq(treeTable.id, folder.id))
        .returning()
      // -> The title alone feeds a generated menu item's label (OpenProject #1825)
      WIKI.models.navigation.invalidateCache(folder.siteId)
      return updated[0] as TreeRow
    }

    // -> Same root-only rule as `createFolder`: a folder already nested cannot collide with the
    //    locale-prefix parser regardless of what it is renamed to. Checked only once the segment is
    //    actually changing (above), so a title-only edit of an already-grandfathered root folder
    //    (one that predates this rule) is not itself blocked.
    if (!folder.folderPath && (await WIKI.models.locales.isReservedLocaleCode(name))) {
      throw new CustomError(
        'treeReservedLocaleSegment',
        `"${name}" is an installed locale code and cannot name a root folder.`,
        400
      )
    }

    // -> As on the way in: a page may share the name, an asset may not
    await this.assertFolderNameFree(
      folder.siteId,
      folder.locale,
      folder.folderPath ?? '',
      name,
      folder.id
    )

    const oldPath = childPathOf(folder)
    const newPath = folder.folderPath ? `${folder.folderPath}.${name}` : name

    WIKI.logger.debug(`Renaming folder ${folder.id} from ${oldPath} to ${newPath}...`)

    // -> Populated inside the transaction below, fired after it resolves -- see
    //    `fireDescendantMoveSideEffects`'s own comment for why history/watchers stay out of this.
    let movedPages: MovedDescendantPage[] = []

    // -> Everything below is one logical move: partway through would leave some descendants renamed
    //    and others not, or a folder row moved but its descendants' paths unrefreshed
    const updated = await WIKI.db.transaction(async (tx) => {
      // -> Direct children carry the old path verbatim; deeper ones carry it as a prefix, and keep
      //    whatever they had below it. Scoped to this folder's own locale -- otherwise a same-named
      //    folder in another locale, sharing the same path, would be dragged along with it (bug #932)
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

      return renamed
    })

    // -> Every asset under it is served from a different path now, and nothing about the assets
    //    themselves changed for the file cache to notice
    WIKI.models.assetServing.forgetAllPaths()

    // -> Fired after the transaction resolves, never inside `tx` -- `movePage`'s own boundary (writes
    //    inside, I/O outside) is the reference. One `search.renamed`/`storage.dispatch` per descendant
    //    page, but `glossary.invalidateCache` only once for the whole batch (see
    //    `fireDescendantMoveSideEffects`).
    for (const moved of movedPages) {
      await this.fireDescendantMoveSideEffects(folder.siteId, moved)
    }
    if (movedPages.length > 0) {
      WIKI.models.glossary.invalidateCache(folder.siteId)
    }

    // -> The renamed folder's own path segment, and its own title, both feed a generated menu item --
    //    the segment through every descendant's `target` too (OpenProject #1825)
    WIKI.models.navigation.invalidateCache(folder.siteId)

    WIKI.logger.debug(`Renamed folder ${folder.id} successfully.`)
    return updated[0] as TreeRow
  }

  /**
   * Rewrite every page's stored path after a folder move.
   *
   * A page keeps a second copy of its path on `pages` -- the `path` itself and the `hash` a reader's
   * request is actually resolved through -- so leaving it after a folder move would keep serving the
   * page from where it used to sit, not where it now is. The tree row itself needs no further work
   * here: the bulk ltree `UPDATE` just above the caller of this method already rewrote every
   * descendant's `folderPath`, folders and assets included, and neither of those has a path of its
   * own beyond that.
   *
   * `generatePathHash` does not exist in postgres, so each page's new path and hash are computed here
   * in JS, row by row. What is deliberately not touched is `updatedAt`: the folder moved, the pages
   * under it did not change, and marking a few hundred of them as freshly edited would say otherwise.
   *
   * The computation is genuinely row-by-row, but the write-back is not: every page row's new
   * `path`/`hash` is batched into chunks of `TREE_UPDATE_CHUNK_SIZE` and written with one
   * `UPDATE ... FROM (VALUES ...)` per chunk rather than one `UPDATE` per row (OpenProject #1865) --
   * a folder with a couple thousand descendants used to be that many sequential round trips with row
   * locks held on `pages` throughout. The updated rows are then read back with one typed `.select()`
   * per chunk, rather than parsed out of the raw `UPDATE`'s own return, so the full row shape
   * `movedPages` needs stays guaranteed by drizzle rather than by hand.
   *
   * @returns Every page this call repathed -- its full post-update row plus where it used to live, for
   *          `renameFolder` to fire the move side effects (search reindex, storage dispatch) once the
   *          transaction this runs inside has committed. A folder or asset row carries no side effect
   *          of its own here, so only pages are returned.
   */
  private async refreshDescendantPaths(
    siteId: string,
    locale: string,
    path: string,
    db: WikiDbOrTx = WIKI.db
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

    // -> Read before anything below overwrites it: `pages.path` is a second, independent copy of
    //    where the page sits (see the class comment above), and this is the only place its
    //    pre-rename value is still around to read. Every row here is already a page (the select
    //    above filters on it), so no per-row type check is needed.
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
      WIKI.logger.debug(`Refreshed the path of ${rows.length} moved page(s).`)
    }
    return movedPages
  }

  /**
   * The move side effects one descendant page owes once `renameFolder`'s transaction has committed --
   * the same reindex/dispatch pair `pages.ts#recordMoveSideEffects` fires for a direct `movePage`.
   * History and watcher notifications are deliberately not fired here: both need a real authoring
   * actor, and `renameFolder` (a folder-level operation with no such actor today) has none to give
   * them. `glossary.invalidateCache` is likewise not fired here -- it is per-site, not per-page, so
   * `renameFolder` fires it once for the whole batch instead of once per descendant.
   */
  private async fireDescendantMoveSideEffects(
    siteId: string,
    { page, previousPath, previousLocale }: MovedDescendantPage
  ): Promise<void> {
    await WIKI.models.search.renamed(siteId, page, previousPath, previousLocale)
    await WIKI.models.storage.dispatch('page:rename', {
      id: page.id,
      path: page.path,
      previousPath,
      locale: page.locale,
      previousLocale,
      siteId
    })
  }

  /**
   * List every page and asset at or below a folder, without mutating anything.
   *
   * The same set `deleteFolder` deletes and `renameFolder` moves under it -- `<@` is "at or below",
   * scoped by `siteId` and the folder's own `locale` the same way (bug #932) -- so `deleteFolder` and
   * `renameFolder`'s callers (`api/tree.ts`'s DELETE/PATCH folder handlers) can authorize every
   * descendant before committing to the mutation (OpenProject #2098, #2100). Each descendant page
   * carries its real `tags` and `classification` (joined from `pages`, since `tree` carries no
   * classification column of its own -- the same root cause as OpenProject #1128); each descendant
   * asset carries both its combined `path` and the separate `folderPath`/`fileName` pair `mayOnAsset`
   * (`helpers/pageAccess.ts`) builds its own ref from.
   *
   * @param folderId UUID of the folder whose descendants to list.
   * @param siteId The site the folder must belong to (OpenProject #2131) -- passed straight to
   *               `getFolderById`.
   * @param db Runs against this instead of the ambient `WIKI.db`, so a caller can authorize inside the
   *           same transaction that will go on to mutate.
   */
  async listDescendants(
    folderId: string,
    siteId: string,
    db: WikiDbOrTx = WIKI.db
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
        // -> Only a `page`-type row's id ever matches `pagesTable.id`; a folder or asset row leaves
        //    this null, the same "no classification" treatment `getTree()` (OpenProject #1128) gives.
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

  /**
   * Delete a folder and everything under it.
   *
   * @param siteId Required (OpenProject #2127) so this model method is itself closed to a foreign
   *               `folderId`, rather than relying solely on the API handler's own separate check.
   * @returns The deleted pages and assets, for the caller to clean up after. Where each one sat comes
   *          back with it: the tree row is the only record of that, and it is gone by then — but what
   *          was deleted is exactly what a webhook subscriber is owed.
   */
  async deleteFolder(
    folderId: string,
    siteId: string
  ): Promise<{ pages: DeletedEntry[]; assets: DeletedEntry[] }> {
    const folder = await this.requireFolderById(folderId, siteId)
    const path = childPathOf(folder)
    WIKI.logger.debug(`Deleting folder ${folder.id} at path ${path}...`)

    // -> The two deletes and the parent's child-count update are one logical delete; wrapped in a
    //    transaction so a failure partway through cannot leave descendants gone but the folder row (or
    //    its parent's count) still there, or vice versa.
    const deleted = await WIKI.db.transaction(async (tx) => {
      // -> `<@` is "at or below", and the folder itself is not under its own child path, so this takes
      //    the descendants and leaves the row that owns them. Scoped to this folder's own locale --
      //    otherwise a same-named folder in another locale, sharing the same path, would be deleted
      //    right along with it (bug #932)
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
    await WIKI.models.navigation.deleteNavForEntries(folder.siteId, [
      ...deleted.map((n) => n.id),
      folder.id
    ])

    WIKI.logger.debug(`Deleted folder ${folder.id} and ${deleted.length} descendant(s).`)

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
   * Add a page entry to the tree.
   *
   * @param parentId UUID of the folder to add it to. Takes precedence over `parentPath`.
   * @param parentPath Slash-separated path of the folder to add it to, created if it does not exist.
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
    db = WIKI.db
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
    /** Runs the folder resolution and the entry insert against this instead of the ambient
     *  `WIKI.db` — a page move passes its own transaction so this entry shares fate with the
     *  `pages` row update alongside it. */
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
    //    ancestor `auto`/`mixed` menu's cached tree walk depends on (OpenProject #1825). Only here,
    //    not in `addAsset`/`addEntry` -- an asset entry is never considered by `generateFromTree`.
    WIKI.models.navigation.invalidateCache(siteId)
    return entry
  }

  /**
   * Add an asset entry to the tree.
   *
   * @param parentId UUID of the folder to add it to. Takes precedence over `parentPath`.
   * @param parentPath Slash-separated path of the folder to add it to, created if it does not exist.
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
    db = WIKI.db
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
    /** Runs the folder resolution and the entry insert against this instead of the ambient
     *  `WIKI.db` — a batch import passes its own transaction so this asset's tree row shares fate
     *  with the `assets` row written alongside it. */
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
      //    could see, and a file that appeared since must not fail on something the uploader did not
      //    choose and cannot see
      onConflict: 'suffix',
      db
    })
  }

  /**
   * Rename a page or asset entry within its folder.
   *
   * @returns The updated row, or null if there is no such entry
   */
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
      const existing = await WIKI.db
        .select({ id: treeTable.id })
        .from(treeTable)
        .where(
          and(
            ne(treeTable.id, entry.id),
            eq(treeTable.siteId, entry.siteId),
            eq(treeTable.locale, entry.locale),
            eq(treeTable.folderPath, entry.folderPath ?? ''),
            eq(treeTable.fileName, fileName),
            // -> A page may take the name of the folder holding the pages below it; see `resolveName`
            ...(entry.type === 'page' ? [ne(treeTable.type, 'folder')] : [])
          )
        )
        .limit(1)
      if (existing.length > 0) {
        throw duplicateEntryError()
      }
    }

    const updated = await WIKI.db
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
   * Move a page or asset entry into another folder, keeping its name, locale and contents.
   *
   * The destination is resolved the same way `addEntry`/an upload resolves where to land:
   * `folderId` wins over `parentPath` when both are given, `parentPath` is created (with any missing
   * ancestor) if it does not exist yet, and neither given means the site root. Moving an entry into
   * the folder it is already in is a no-op — it returns the entry unchanged rather than touching
   * anything, so a caller cannot be told a move happened when nothing did.
   *
   * @param siteId Required (OpenProject #2127 precedent) so this method is itself closed to a
   *               foreign entry or `folderId`, rather than relying solely on the caller.
   * @returns The updated row, or null if there is no such entry on this site
   * @throws CustomError `treeInvalidFolder` (404) for an unresolvable `folderId`,
   *         `treeEntryDuplicate` (409) if the destination already holds this name — the same
   *         asymmetric page/folder exception `renameEntry` applies above, reused rather than
   *         re-derived: a page does not block a folder taking its name, everything else does.
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

    const collision = await WIKI.db
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

    const updated = await WIKI.db.transaction(async (tx) => {
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
    //    (OpenProject #1825), the same invalidation `deleteEntry`/`createFolder` already fire.
    WIKI.models.navigation.invalidateCache(siteId)

    WIKI.logger.debug(`Moved entry ${entry.id} to folder "${newPath}" successfully.`)
    return updated[0] as TreeRow
  }

  /**
   * Remove a page or asset entry from the tree, keeping its folder's count straight.
   */
  async deleteEntry(id: string, db: WikiDbOrTx = WIKI.db): Promise<boolean> {
    const entry = await this.getById(id, db)
    if (!entry) {
      return false
    }
    await db.delete(treeTable).where(eq(treeTable.id, id))
    await this.countTowardsFolderAt(entry.siteId, entry.locale, entry.folderPath ?? '', -1, db)
    // -> Removing any entry -- page or asset -- can change whether its (former) parent folder still
    //    holds a visible page, which any ancestor `auto`/`mixed` menu's cached tree walk depends on
    //    (OpenProject #1825). Unconditional rather than branching on `entry.type`: an asset delete
    //    invalidates a cache that never depended on it, but that is harmless over-invalidation, not a
    //    correctness gap worth a type check here.
    WIKI.models.navigation.invalidateCache(entry.siteId)
    return true
  }

  /**
   * Insert a page or asset row, resolving its folder first and counting it against that folder.
   */
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
    db = WIKI.db
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
      type === 'page' ? await WIKI.models.navigation.ancestorNavId(siteId, locale, path) : null

    const name = await this.resolveName({ siteId, locale, path, type, fileName, onConflict, db })
    const fullPath = path ? `${decodeTreePath(path)}/${name}` : name

    WIKI.logger.debug(`Adding ${type} ${fullPath} to tree...`)

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
   * Settle on a file name that nothing in the folder is already using.
   *
   * Two entries with the same name in the same folder would share a path — the second one would
   * shadow the first everywhere it is looked up by URL. An upload takes the next free `name-1.ext`,
   * the way a file manager is expected to; anything else says so instead.
   *
   * A page is the exception: a page and the folder of the pages below it are *meant* to share a name,
   * which is what `/guide` being both a page and the way into `/guide/…` is. Nothing shadows anything
   * there, because the two are never looked up the same way — a folder is only ever resolved as a
   * folder (`getFolder` asks for the type), and the page is found in `pages` by its own path hash.
   * An asset stays held to the whole folder, since it is served at that URL like a page would be and
   * `assets.upload` refuses the mirror image of this for the same reason.
   */
  private async resolveName({
    siteId,
    locale,
    path,
    type,
    fileName,
    onConflict,
    db = WIKI.db
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
   * Move the children count of the folder sitting at an ltree path.
   *
   * The count lives on the folder rather than being counted on read, so it has to be kept straight by
   * whoever adds or removes something. The arithmetic is done in postgres rather than read-then-write
   * so that two concurrent uploads into the same folder cannot lose one another's increment.
   *
   * An empty path is the site root, which is not a folder and has nothing to count.
   */
  private async countTowardsFolderAt(
    siteId: string,
    locale: string,
    path: string,
    delta: number,
    db: WikiDbOrTx = WIKI.db
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
