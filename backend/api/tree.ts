import type { FastifyInstance } from 'fastify'
import { TREE_ORDER_BY, type TreeItemType, type TreeOrderBy } from '../models/tree.ts'
import { decodeTreePath, normalizePagePath } from '../helpers/common.ts'
import { defaultLocale } from '../helpers/localeRouting.ts'
import {
  actorFrom,
  mayOnAsset,
  mayOnFolder,
  mayOnPage,
  splitList,
  visibleTreeItems
} from '../helpers/pageAccess.ts'

interface TreeQuery {
  parentId?: string
  parentPath?: string
  locale?: string
  types?: string
  tags?: string
  limit?: number
  offset?: number
  orderBy?: TreeOrderBy
  orderByDirection?: 'asc' | 'desc'
  depth?: number
  includeAncestors?: boolean
  includeRootFolders?: boolean
}

interface FolderBody {
  parentId?: string | null
  parentPath?: string | null
  pathName: string
  title: string
  locale?: string
}

/** A folder's own slash-separated path, which is what a rule over that branch addresses. */
function folderPathOf(folder: { folderPath?: string | null; fileName: string }): string {
  const parent = decodeTreePath(folder.folderPath ?? '') ?? ''
  return parent ? `${parent}/${folder.fileName}` : folder.fileName
}

/**
 * Tree API Routes
 *
 * The tree is what the file manager and the navigation browse: one listing that interleaves folders,
 * pages and assets. Folders are the only kind created here — a page or an asset gets its tree entry
 * from whatever created it.
 */
async function routes(app: FastifyInstance) {
  /**
   * BROWSE THE TREE
   */
  app.get<{ Params: { siteId: string }; Querystring: TreeQuery }>(
    '/sites/:siteId/tree',
    {
      /*
        No route-level `permissions`: page permissions come from a group's RULES, and every entry is
        filtered against them below — a caller allowed nowhere gets an empty listing rather than a
        refusal, which is the same thing the tree would look like if the pages were not there.
      */
      schema: {
        summary: 'Browse the tree',
        description:
          'Lists the contents of one folder. `parentId` and `parentPath` both address the folder to list, the ID winning when both are given; neither means the site root. `includeAncestors` and `includeRootFolders` add the folders above the one being listed, so that a client opening a deep folder can draw the whole branch from a single request — those entries come back with `isAncestor` set.',
        tags: ['Tree'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            parentId: {
              type: 'string',
              format: 'uuid'
            },
            parentPath: {
              type: 'string',
              maxLength: 2048,
              description: 'Slash-separated path of the folder to list.'
            },
            locale: {
              type: 'string',
              maxLength: 10,
              description: "Only entries in this locale. Defaults to the site's primary locale."
            },
            types: {
              type: 'string',
              pattern: '^(folder|page|asset)(,(folder|page|asset))*$',
              description: 'Comma-separated list of kinds to include, e.g. `folder,page`.'
            },
            tags: {
              type: 'string',
              description: 'Comma-separated list of tags an entry must carry all of.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 1000
            },
            offset: {
              type: 'integer',
              minimum: 0,
              default: 0
            },
            orderBy: {
              type: 'string',
              enum: TREE_ORDER_BY,
              default: 'title'
            },
            orderByDirection: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: 'asc'
            },
            depth: {
              type: 'integer',
              minimum: 0,
              maximum: 10,
              default: 0,
              description: 'How many levels below the folder to include. 0 is the folder itself.'
            },
            includeAncestors: {
              type: 'boolean',
              default: false
            },
            includeRootFolders: {
              type: 'boolean',
              default: false
            }
          }
        },
        response: {
          200: {
            description: 'Tree entries, shallowest first',
            type: 'array',
            items: { $ref: 'TreeItem#' }
          }
        }
      }
    },
    async (req) => {
      const q = req.query
      const locale = q.locale ?? defaultLocale(req.params.siteId)
      // -> `null` rather than `[]` for an absent filter: the model reads an empty array as "match
      //    nothing", so the two are not interchangeable here the way they are in `api/pages.ts`.
      const types = splitList(q.types)
      const tags = splitList(q.tags)
      const items = await WIKI.models.tree.getTree({
        siteId: req.params.siteId,
        parentId: q.parentId,
        parentPath: q.parentPath,
        locale,
        types: (types.length ? types : null) as TreeItemType[] | null,
        tags: tags.length ? tags : null,
        limit: q.limit,
        offset: q.offset,
        orderBy: q.orderBy,
        orderByDirection: q.orderByDirection,
        depth: q.depth,
        includeAncestors: q.includeAncestors,
        includeRootFolders: q.includeRootFolders,
        publicOnly: !req.session?.authenticated
      })
      return visibleTreeItems(req, req.params.siteId, locale, items)
    }
  )

  /**
   * BROWSE THE TREE AS A READER
   */
  app.get<{ Params: { siteId: string }; Querystring: { path?: string; locale?: string } }>(
    '/sites/:siteId/tree/browse',
    {
      schema: {
        summary: 'Browse the tree as a reader',
        description:
          "Lists one folder for the sidebar's browse menu: the pages a reader may open and the folders holding some, with assets, hidden pages and dead-end folders left out.\n\nA page and a folder can share a path — `/foo/bar` alongside the folder of pages under it — and such a pair comes back as a single entry with both `isPage` and `isFolder` set, since a reader sees one name with two ways in.\n\nReadable without a session, because a wiki is browsed by people who are not logged in — an anonymous request sees only published pages with no password on them, which is exactly what the page view itself would serve them. Requires the site's `browse` feature to be on.",
        tags: ['Tree'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              maxLength: 2048,
              description: 'Slash-separated path of the folder to list. The site root when absent.'
            },
            locale: {
              type: 'string',
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          }
        },
        response: {
          200: {
            description: 'One level of the tree',
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'The folder that was listed. Empty at the site root.'
              },
              title: {
                type: 'string',
                description: "The folder's title. Empty at the site root, which is not a folder."
              },
              truncated: {
                type: 'boolean',
                description: 'Whether the folder holds more entries than were returned.'
              },
              items: {
                type: 'array',
                items: { $ref: 'BrowseItem#' }
              }
            }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> `siteEnabledPreHandler` (`helpers/common.ts`) has already answered 404 for an unknown
      //    `:siteId` before any handler here runs, so this is the site, not a maybe.
      const site = WIKI.sites[req.params.siteId]
      // -> The same setting that hides the sidebar's Browse button, enforced where it counts: with
      //    browsing off, the tree is not something to hand out one folder at a time either
      if (!site.config?.features?.browse) {
        return reply.forbidden('Browsing is disabled on this site.')
      }
      const locale = req.query.locale ?? defaultLocale(req.params.siteId)
      const level = await WIKI.models.tree.browse({
        siteId: req.params.siteId,
        path: req.query.path,
        locale,
        publicOnly: !req.session?.authenticated
      })
      if (!level) {
        return reply.notFound('This folder does not exist.')
      }
      /*
        A browse row carries a whole path rather than a folder/name pair, and stands for a page, a
        folder, or both at once. Judged on that path either way: for the page it IS the page, and for
        a folder it is the branch, which is what a rule over the branch is talking about.
      */
      const actor = WIKI.models.groups.actorForRequest(req)
      return {
        ...level,
        items: level.items.filter((item) =>
          WIKI.models.groups.checkAccess(actor, 'read:pages', {
            path: item.path,
            siteId: req.params.siteId,
            locale,
            // -> `tree.browse()` (OpenProject #1128) joins `pages.classification` in for a page at
            //    this path; a folder-only entry carries none, same "no CLASSIFICATION rule matches"
            //    null it always had.
            classification: item.classification
          })
        )
      }
    }
  )

  /**
   * LIST PAGES AS A READER
   */
  app.get<{
    Params: { siteId: string }
    Querystring: {
      path?: string
      locale?: string
      tags?: string
      limit?: number
      orderBy?: TreeOrderBy
      orderByDirection?: 'asc' | 'desc'
      depth?: number
    }
  }>(
    '/sites/:siteId/tree/pages',
    {
      schema: {
        summary: 'List pages as a reader',
        description:
          "Lists the pages under a path, ordered and limited, for an index block drawn inside a page. Folders are not part of the answer — this is a list of pages, at `depth` folders below the path when asked for.\n\nReadable without a session, because the page holding the block is: an anonymous request sees only published pages, the same set the page view would serve it. Unlike `/tree/browse` it is not gated on the site's `browse` feature, which governs the sidebar's browse menu rather than what a page may render.",
        tags: ['Tree'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              maxLength: 2048,
              description: 'Slash-separated path to list. The site root when absent.'
            },
            locale: {
              type: 'string',
              maxLength: 10,
              description: "The site's primary locale when absent."
            },
            tags: {
              type: 'string',
              description: 'Comma-separated list of tags a page must carry all of.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 10
            },
            orderBy: {
              type: 'string',
              enum: TREE_ORDER_BY,
              default: 'title'
            },
            orderByDirection: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: 'asc'
            },
            depth: {
              type: 'integer',
              minimum: 0,
              maximum: 10,
              default: 0,
              description: 'How many folders below the path to include. 0 is the path itself.'
            }
          }
        },
        response: {
          200: {
            description: 'The pages found',
            type: 'array',
            items: { $ref: 'ListedPage#' }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const locale = req.query.locale ?? defaultLocale(req.params.siteId)
      // -> `null` rather than `[]` for an absent filter, same as BROWSE THE TREE above
      const tags = splitList(req.query.tags)
      const pages = await WIKI.models.tree.listPages({
        siteId: req.params.siteId,
        path: req.query.path,
        locale,
        tags: tags.length ? tags : null,
        limit: req.query.limit,
        orderBy: req.query.orderBy,
        orderByDirection: req.query.orderByDirection,
        depth: req.query.depth,
        publicOnly: !req.session?.authenticated
      })
      // -> An index block is drawn inside a page, but it lists other pages: each one still has to be
      //    the reader's to see
      const actor = WIKI.models.groups.actorForRequest(req)
      return pages.filter((page) =>
        WIKI.models.groups.checkAccess(actor, 'read:pages', {
          path: page.path,
          siteId: req.params.siteId,
          locale,
          // -> `tree.listPages()` (OpenProject #1128) now joins `pages.classification` in directly.
          classification: page.classification
        })
      )
    }
  )

  /**
   * GET FOLDER
   */
  app.get<{ Params: { siteId: string; folderId: string } }>(
    '/sites/:siteId/tree/folders/:folderId',
    {
      // -> Checked against the folder's own path below, not against the group-wide list
      schema: {
        summary: 'Get a single folder',
        tags: ['Tree'],
        params: { $ref: 'SiteFolderParams#' },
        response: {
          200: { $ref: 'Folder#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const folder = await WIKI.models.tree.getFolderById(req.params.folderId, req.params.siteId)
      if (!folder) {
        return reply.notFound('This folder does not exist.')
      }
      const folderPath = folderPathOf(folder)
      // -> Not visible is the same as not there, so it answers as the id had matched nothing
      if (!mayOnFolder(req, 'read:pages', req.params.siteId, folderPath, folder.locale)) {
        return reply.notFound('This folder does not exist.')
      }
      return {
        ...folder,
        folderPath: decodeTreePath(folder.folderPath ?? '') ?? '',
        childrenCount: folder.meta?.children ?? 0
      }
    }
  )

  /**
   * CREATE FOLDER
   */
  app.post<{ Params: { siteId: string }; Body: FolderBody }>(
    '/sites/:siteId/tree/folders',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions come
        from a group's RULES. Checked against the folder's own path below.
      */
      schema: {
        summary: 'Create a folder',
        description:
          'Any folder missing between the site root and the new one is created along with it, so a path can be filled in from the middle out.',
        tags: ['Tree'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          allOf: [
            { $ref: 'FolderInput#' },
            { type: 'object', required: ['pathName', 'title'] },
            {
              type: 'object',
              properties: {
                parentId: {
                  type: ['string', 'null'],
                  format: 'uuid',
                  description: 'The folder to create it in. Wins over `parentPath`.'
                },
                parentPath: {
                  type: ['string', 'null'],
                  maxLength: 2048,
                  description: 'Slash-separated path of the folder to create it in.'
                },
                locale: {
                  type: 'string',
                  maxLength: 10,
                  description: "The site's primary locale when absent."
                }
              }
            }
          ]
        },
        response: {
          200: {
            description: 'Folder created successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              folder: { $ref: 'Folder#' }
            }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      /*
        Against where the folder is going. `parentPath` is the slash-separated path when given; with
        `parentId` the parent has to be looked up and scoped to this site — a `parentId` naming a
        folder in another site is refused here rather than silently falling through to the request's
        own `parentPath`/`locale` (OpenProject #2131), which would leak neither its identity nor
        create anything, but would compute the permission check against the wrong path.
      */
      let parentPath = req.body.parentPath ?? ''
      let parent: Awaited<ReturnType<typeof WIKI.models.tree.getFolderById>> = null
      if (req.body.parentId) {
        parent = await WIKI.models.tree.getFolderById(req.body.parentId, req.params.siteId)
        if (!parent) {
          return reply.notFound('The parent folder does not exist.')
        }
        parentPath = folderPathOf(parent)
      }
      const target = [parentPath, req.body.pathName].filter(Boolean).join('/')
      // -> Mirrors createFolder's own parent-wins locale rule (models/tree.ts:750-751): a folder
      //    cannot be in a different locale than the one holding it
      const locale = req.body.parentId
        ? (parent?.locale ?? req.body.locale ?? defaultLocale(req.params.siteId))
        : (req.body.locale ?? defaultLocale(req.params.siteId))
      if (!mayOnFolder(req, 'manage:pages', req.params.siteId, target, locale)) {
        return reply.forbidden('You are not allowed to create a folder here.')
      }
      const folder = await WIKI.models.tree.createFolder({
        siteId: req.params.siteId,
        locale,
        parentId: req.body.parentId,
        parentPath: req.body.parentPath,
        pathName: req.body.pathName,
        title: req.body.title
      })
      return {
        ok: true,
        message: 'Folder created successfully.',
        folder: {
          ...folder,
          folderPath: decodeTreePath(folder.folderPath ?? '') ?? '',
          childrenCount: folder.meta?.children ?? 0
        }
      }
    }
  )

  /**
   * RENAME FOLDER
   */
  app.patch<{ Params: { siteId: string; folderId: string }; Body: FolderBody }>(
    '/sites/:siteId/tree/folders/:folderId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions come
        from a group's RULES. Checked against the folder's own path below.
      */
      schema: {
        summary: 'Rename a folder',
        description:
          'Everything under the folder moves with it. Sending the current path name back changes only the title, and leaves every descendant untouched.',
        tags: ['Tree'],
        params: { $ref: 'SiteFolderParams#' },
        body: {
          allOf: [{ $ref: 'FolderInput#' }, { type: 'object', required: ['pathName', 'title'] }]
        },
        response: {
          200: {
            description: 'Folder renamed successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              folder: { $ref: 'Folder#' }
            }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const existing = await WIKI.models.tree.getFolderById(req.params.folderId, req.params.siteId)
      if (!existing) {
        return reply.notFound('This folder does not exist.')
      }
      const currentPath = folderPathOf(existing)
      if (!mayOnFolder(req, 'manage:pages', req.params.siteId, currentPath, existing.locale)) {
        return reply.forbidden('You are not allowed to rename this folder.')
      }
      // -> A title-only edit -- sending the current path segment back -- leaves every descendant's
      //    path untouched (`renameFolder()`'s own short-circuit below), so there is nothing at a new
      //    location to authorize. Normalized the same way the model normalizes it, so this agrees
      //    with the model's own "did the segment actually change" check.
      const newName = normalizePagePath(req.body.pathName)
      if (newName !== existing.fileName) {
        const parentPath = decodeTreePath(existing.folderPath ?? '') ?? ''
        const destPath = parentPath ? `${parentPath}/${newName}` : newName
        // -> Authorize like a move, the way `PATCH .../pages/:pageId/move` already does for a single
        //    page (OpenProject #2102): `manage:pages` at the current path is not an opinion about the
        //    destination, since rules are matched on path. Checked against `write:pages`, not
        //    `manage:pages`, for the same reason the single-page move is -- see that route's own
        //    comment.
        if (!mayOnFolder(req, 'write:pages', req.params.siteId, destPath, existing.locale)) {
          return reply.forbidden('You are not allowed to rename this folder there.')
        }
        // -> Everything under the folder moves with it, so every descendant page needs the same
        //    two-sided check: `manage:pages` at where it sits now, `write:pages` at where the rename
        //    would land it. A rule addressed at the folder's own path (e.g. an ALLOW at the site root
        //    plus a narrower DENY on one descendant branch) would otherwise pass at the folder and
        //    silently drag the denied branch to a path where the DENY no longer matches. Real `tags`
        //    and `classification` travel with each descendant page, not `classification: null` --
        //    that hardcoded null is only correct for the folder entry itself, which is not a page.
        const { pages: descendants } = await WIKI.models.tree.listDescendants(
          req.params.folderId,
          req.params.siteId
        )
        for (const descendant of descendants) {
          const newDescendantPath = destPath + descendant.path.slice(currentPath.length)
          const sourceRef = {
            path: descendant.path,
            locale: existing.locale,
            tags: descendant.tags,
            classification: descendant.classification
          }
          const destRef = {
            path: newDescendantPath,
            locale: existing.locale,
            tags: descendant.tags,
            classification: descendant.classification
          }
          if (
            !mayOnPage(req, 'manage:pages', req.params.siteId, sourceRef) ||
            !mayOnPage(req, 'write:pages', req.params.siteId, destRef)
          ) {
            return reply.forbidden(
              'You are not allowed to rename this folder: it would move a page you may not.'
            )
          }
        }
      }
      const folder = await WIKI.models.tree.renameFolder({
        siteId: req.params.siteId,
        folderId: req.params.folderId,
        pathName: req.body.pathName,
        title: req.body.title
      })
      return {
        ok: true,
        message: 'Folder renamed successfully.',
        folder: {
          ...folder,
          folderPath: decodeTreePath(folder.folderPath ?? '') ?? '',
          childrenCount: folder.meta?.children ?? 0
        }
      }
    }
  )

  /**
   * DELETE FOLDER
   */
  app.delete<{ Params: { siteId: string; folderId: string } }>(
    '/sites/:siteId/tree/folders/:folderId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions come
        from a group's RULES. Checked against the folder's own path below.
      */
      schema: {
        summary: 'Delete a folder',
        description:
          "Everything under the folder goes with it, pages and assets included. Each deleted page is recorded in its history first, so the branch can be recovered from there.\n\nAll-or-nothing, the same shape the page move route's `includeTranslations` uses: the caller needs `manage:pages` on the folder's own path, `delete:pages` on every descendant page (judged on its own real path, tags and classification, not the folder's), and `manage:assets` on every descendant asset. A single unauthorized descendant refuses the whole request (403) and deletes nothing.",
        tags: ['Tree'],
        params: { $ref: 'SiteFolderParams#' },
        response: {
          204: {
            description: 'Folder deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> As deleting a single page does: every page going with the folder is recorded against
      //    whoever deleted it, so there has to be somebody to record
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Deleting a folder requires a logged in user.')
      }
      const existing = await WIKI.models.tree.getFolderById(req.params.folderId, req.params.siteId)
      if (!existing) {
        return reply.notFound('This folder does not exist.')
      }
      if (
        !mayOnFolder(
          req,
          'manage:pages',
          req.params.siteId,
          folderPathOf(existing),
          existing.locale
        )
      ) {
        return reply.forbidden('You are not allowed to delete this folder.')
      }
      // -> All-or-nothing, checked before anything is mutated: `deleteFolder` cascades to every
      //    descendant page and asset, so a caller who may only reorganise THIS folder's own path must
      //    not be able to drag along a page under a `delete:pages` DENY, or an asset outside their
      //    `manage:assets` reach, just because the folder itself was theirs to manage (OpenProject
      //    #2100). Judged on each descendant's own real path/tags/classification -- never the
      //    folder's -- the same way this handler's own `mayOnFolder` check (`helpers/pageAccess.ts`)
      //    is judged on the folder's.
      const descendants = await WIKI.models.tree.listDescendants(
        req.params.folderId,
        req.params.siteId
      )
      for (const page of descendants.pages) {
        if (!mayOnPage(req, 'delete:pages', req.params.siteId, page)) {
          return reply.forbidden(
            `You are not allowed to delete the page at "${page.path}" (${page.locale}).`
          )
        }
      }
      for (const asset of descendants.assets) {
        if (!mayOnAsset(req, 'manage:assets', req.params.siteId, asset)) {
          const assetPath = asset.folderPath
            ? `${asset.folderPath}/${asset.fileName}`
            : asset.fileName
          return reply.forbidden(
            `You are not allowed to delete the asset at "${assetPath}" (${asset.locale}).`
          )
        }
      }
      const removed = await WIKI.models.tree.deleteFolder(req.params.folderId, req.params.siteId)
      // -> The tree entries are gone; these are the rows behind them, which is where a page and an
      //    asset actually live
      await WIKI.models.pages.deleteOrphaned(req.params.siteId, removed.pages, actor)
      await WIKI.models.assets.deleteOrphaned(req.params.siteId, removed.assets)
      return reply.code(204).send()
    }
  )
}

export default routes
