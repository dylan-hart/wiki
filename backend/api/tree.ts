import type { FastifyInstance } from 'fastify'
import { TREE_ORDER_BY, type TreeItemType, type TreeOrderBy } from '../models/tree.ts'
import { CustomError, decodeTreePath, normalizePagePath } from '../helpers/common.ts'
import { defaultLocale } from '../helpers/localeRouting.ts'
import {
  actorFrom,
  mayOnAsset,
  mayOnFolder,
  mayOnPage,
  splitList,
  unlockedFor,
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

interface FolderDuplicateBody {
  folderId?: string | null
  parentPath?: string | null
  pathName?: string
  title?: string
}

function folderPathOf(folder: { folderPath?: string | null; fileName: string }): string {
  const parent = decodeTreePath(folder.folderPath ?? '') ?? ''
  return parent ? `${parent}/${folder.fileName}` : folder.fileName
}

/**
 * The tree interleaves folders, pages and assets in one listing. Folders are the only kind created
 * here — a page or an asset gets its tree entry from whatever created it.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string }; Querystring: TreeQuery }>(
    '/sites/:siteId/tree',
    {
      /*
        No route-level `permissions`: page permissions come from a group's RULES, and every entry is
        filtered against them below — a caller allowed nowhere gets an empty listing, not a refusal.
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
      const types = splitList(q.types)
      const tags = splitList(q.tags)
      const items = await CARDINAL.models.tree.getTree({
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
      // -> `siteEnabledPreHandler` has already answered 404 for an unknown `:siteId`.
      const site = CARDINAL.sites[req.params.siteId]
      if (!site.config?.features?.browse) {
        return reply.forbidden('Browsing is disabled on this site.')
      }
      const locale = req.query.locale ?? defaultLocale(req.params.siteId)
      const level = await CARDINAL.models.tree.browse({
        siteId: req.params.siteId,
        path: req.query.path,
        locale,
        publicOnly: !req.session?.authenticated
      })
      if (!level) {
        return reply.notFound('This folder does not exist.')
      }
      /*
        A browse row stands for a page, a folder, or both at once, and is judged on its path either
        way: for a folder that path is the branch, which is what a rule over the branch addresses.
      */
      const actor = CARDINAL.models.groups.actorForRequest(req)
      return {
        ...level,
        items: level.items.filter((item) =>
          CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
            path: item.path,
            siteId: req.params.siteId,
            locale,
            // -> Both empty for a folder-only entry, which no CLASSIFICATION or TAG rule matches
            classification: item.classification,
            tags: item.tags
          })
        )
      }
    }
  )

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
      const tags = splitList(req.query.tags)
      const pages = await CARDINAL.models.tree.listPages({
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
      const actor = CARDINAL.models.groups.actorForRequest(req)
      return pages.filter((page) =>
        CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
          path: page.path,
          siteId: req.params.siteId,
          locale,
          classification: page.classification,
          tags: page.tags
        })
      )
    }
  )

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
      const folder = await CARDINAL.models.tree.getFolderById(
        req.params.folderId,
        req.params.siteId
      )
      if (!folder) {
        return reply.notFound('This folder does not exist.')
      }
      const folderPath = folderPathOf(folder)
      // -> Not visible is the same as not there, so it answers as if the id had matched nothing
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

  app.post<{ Params: { siteId: string }; Body: FolderBody }>(
    '/sites/:siteId/tree/folders',
    {
      // -> No route-level `permissions`: page permissions are path-bound, checked in the handler
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
        Judged against where the folder is going. A `parentId` that does not resolve in this site is
        refused rather than falling through to the request's own `parentPath`, which would run the
        permission check against the wrong path.
      */
      let parentPath = req.body.parentPath ?? ''
      let parent: Awaited<ReturnType<typeof CARDINAL.models.tree.getFolderById>> = null
      if (req.body.parentId) {
        parent = await CARDINAL.models.tree.getFolderById(req.body.parentId, req.params.siteId)
        if (!parent) {
          return reply.notFound('The parent folder does not exist.')
        }
        parentPath = folderPathOf(parent)
      }
      const target = [parentPath, req.body.pathName].filter(Boolean).join('/')
      // -> Mirrors `createFolder()`'s parent-wins locale rule: a folder cannot be in a different
      //    locale than the one holding it
      const locale = req.body.parentId
        ? (parent?.locale ?? req.body.locale ?? defaultLocale(req.params.siteId))
        : (req.body.locale ?? defaultLocale(req.params.siteId))
      if (!mayOnFolder(req, 'manage:pages', req.params.siteId, target, locale)) {
        return reply.forbidden('You are not allowed to create a folder here.')
      }
      const folder = await CARDINAL.models.tree.createFolder({
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

  app.patch<{ Params: { siteId: string; folderId: string }; Body: FolderBody }>(
    '/sites/:siteId/tree/folders/:folderId',
    {
      // -> No route-level `permissions`: page permissions are path-bound, checked in the handler
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
      const existing = await CARDINAL.models.tree.getFolderById(
        req.params.folderId,
        req.params.siteId
      )
      if (!existing) {
        return reply.notFound('This folder does not exist.')
      }
      const currentPath = folderPathOf(existing)
      if (!mayOnFolder(req, 'manage:pages', req.params.siteId, currentPath, existing.locale)) {
        return reply.forbidden('You are not allowed to rename this folder.')
      }
      // -> A title-only edit moves nothing, so there is no destination to authorize. Normalized as
      //    `renameFolder()` normalizes it, so both agree on whether the segment changed.
      const newName = normalizePagePath(req.body.pathName)
      if (newName !== existing.fileName) {
        const parentPath = decodeTreePath(existing.folderPath ?? '') ?? ''
        const destPath = parentPath ? `${parentPath}/${newName}` : newName
        // -> Authorized like a page move: rules match on path, so `manage:pages` at the current
        //    path says nothing about the destination, and landing something there is a write there.
        if (!mayOnFolder(req, 'write:pages', req.params.siteId, destPath, existing.locale)) {
          return reply.forbidden('You are not allowed to rename this folder there.')
        }
        // -> Every descendant page moves too and needs the same two-sided check, on its own tags
        //    and classification: an ALLOW at the folder plus a narrower DENY below it would
        //    otherwise drag the denied branch to a path the DENY no longer matches.
        const { pages: descendants } = await CARDINAL.models.tree.listDescendants(
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
      const folder = await CARDINAL.models.tree.renameFolder({
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

  app.delete<{ Params: { siteId: string; folderId: string } }>(
    '/sites/:siteId/tree/folders/:folderId',
    {
      // -> No route-level `permissions`: page permissions are path-bound, checked in the handler
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
      // -> Every page going with the folder is recorded against whoever deleted it, so there has to
      //    be somebody to record
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Deleting a folder requires a logged in user.')
      }
      const existing = await CARDINAL.models.tree.getFolderById(
        req.params.folderId,
        req.params.siteId
      )
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
      // -> Checked before anything mutates: `deleteFolder` cascades, and managing the folder's own
      //    path must not take along a page under a `delete:pages` DENY or an asset out of reach.
      const descendants = await CARDINAL.models.tree.listDescendants(
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
      const removed = await CARDINAL.models.tree.deleteFolder(
        req.params.folderId,
        req.params.siteId
      )
      // -> `deleteFolder` removed only the tree entries; these are the rows behind them
      await CARDINAL.models.pages.deleteOrphaned(req.params.siteId, removed.pages, actor)
      await CARDINAL.models.assets.deleteOrphaned(req.params.siteId, removed.assets, {
        authorId: actor.id
      })
      return reply.code(204).send()
    }
  )

  app.post<{ Params: { siteId: string; folderId: string }; Body: FolderDuplicateBody }>(
    '/sites/:siteId/tree/folders/:folderId/duplicate',
    {
      schema: {
        summary: 'Duplicate a folder',
        description:
          "Copies the folder and everything under it: sub-folders, pages and assets. `folderId` and `parentPath` both address the folder to put the copy in, the ID winning when both are given; neither means the site root. A `parentPath` that does not exist yet is created along with the copy. `pathName` and `title` rename the copy itself, which is how a folder is duplicated into the folder it already sits in: without one the copy keeps the source's name and collides (409).\n\nAll-or-nothing: the caller needs `read:pages` on the folder's own path, `read:pages` on every descendant page (and, for a password-protected one, to have unlocked it or hold `write:pages`/`manage:pages` on it), `read:assets` on every descendant asset, `manage:pages` on the copy's own path and on any destination folder that has to be created, and `write:pages` / `write:assets` on the path each copied page / asset will land at, judged on that path and on the page's own tags and classification. A single unauthorized descendant refuses the whole request (403) and copies nothing. A destination inside the folder being copied is refused (400).",
        tags: ['Tree'],
        params: { $ref: 'SiteFolderParams#' },
        body: {
          allOf: [
            { $ref: 'FolderInput#' },
            {
              type: 'object',
              properties: {
                folderId: {
                  type: ['string', 'null'],
                  format: 'uuid',
                  description: 'The folder to put the copy in. Wins over `parentPath`.'
                },
                parentPath: {
                  type: ['string', 'null'],
                  maxLength: 2048,
                  description: 'Slash-separated path of the folder to put the copy in.'
                }
              }
            }
          ]
        },
        response: {
          200: {
            description: 'Folder duplicated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              folder: { $ref: 'Folder#' },
              folders: {
                type: 'integer',
                description: 'How many folders were created, the copy itself included.'
              },
              pages: {
                type: 'integer',
                description: 'How many pages were copied.'
              },
              assets: {
                type: 'integer',
                description: 'How many assets were copied.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const siteId = req.params.siteId
      const body = req.body ?? {}
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Duplicating a folder requires a logged in user.')
      }
      const source = await CARDINAL.models.tree.getFolderById(req.params.folderId, siteId)
      const sourcePath = source ? folderPathOf(source) : ''
      if (!source || !mayOnFolder(req, 'read:pages', siteId, sourcePath, source.locale)) {
        return reply.notFound('This folder does not exist.')
      }

      let destParent: string
      let destLocale = source.locale
      if (body.folderId) {
        const destination = await CARDINAL.models.tree.getFolderById(body.folderId, siteId)
        if (!destination) {
          return reply.notFound('The destination folder does not exist.')
        }
        destParent = folderPathOf(destination)
        destLocale = destination.locale
      } else {
        destParent = (body.parentPath ?? '')
          .split('/')
          .map((segment) => normalizePagePath(segment))
          .filter(Boolean)
          .join('/')
      }
      const destRoot = [destParent, body.pathName ?? source.fileName].filter(Boolean).join('/')

      // -> Compared on whole segments, so copying `a` into `ab` is not copying it into itself
      if (
        destLocale === source.locale &&
        (destParent === sourcePath || destParent.startsWith(`${sourcePath}/`))
      ) {
        return reply.badRequest('A folder cannot be duplicated into itself or a folder inside it.')
      }

      // -> The model creates whatever part of `parentPath` is missing, and a rule matches on path, so
      //    each folder it would create is a write of its own
      if (!body.folderId && destParent) {
        const parts = destParent.split('/')
        for (let depth = 1; depth <= parts.length; depth++) {
          const ancestorPath = parts.slice(0, depth).join('/')
          let exists = true
          try {
            await CARDINAL.models.tree.getFolder({ path: ancestorPath, locale: destLocale, siteId })
          } catch (err: any) {
            if (!(err instanceof CustomError) || err.name !== 'treeInvalidFolder') {
              throw err
            }
            exists = false
          }
          if (!exists && !mayOnFolder(req, 'manage:pages', siteId, ancestorPath, destLocale)) {
            return reply.forbidden(`You are not allowed to create the folder "${ancestorPath}".`)
          }
        }
      }
      if (!mayOnFolder(req, 'manage:pages', siteId, destRoot, destLocale)) {
        return reply.forbidden('You are not allowed to duplicate this folder here.')
      }

      // -> Everything is judged before the one model call: it does no permission check of its own
      //    and copies in a single transaction, so nothing partial is left behind
      const descendants = await CARDINAL.models.tree.listDescendants(source.id, siteId)
      for (const page of descendants.pages) {
        const sourceRef = {
          id: page.id,
          path: page.path,
          locale: source.locale,
          tags: page.tags,
          classification: page.classification
        }
        if (!mayOnPage(req, 'read:pages', siteId, sourceRef)) {
          return reply.forbidden(
            `You are not allowed to duplicate this folder: you may not read the page at "${page.path}".`
          )
        }
        // -> A locked page's body is withheld from anyone who has not entered its password, and the
        //    copy would hand it over
        if (!unlockedFor(req, siteId, sourceRef)) {
          const locked = await CARDINAL.models.pages.getPage({
            siteId,
            id: page.id,
            unlocked: false,
            withPassword: false
          })
          if (locked?.isLocked) {
            return reply.forbidden(
              `You are not allowed to duplicate this folder: the page at "${page.path}" is password protected.`
            )
          }
        }
        const destPath = destRoot + page.path.slice(sourcePath.length)
        if (
          !mayOnPage(req, 'write:pages', siteId, {
            path: destPath,
            locale: destLocale,
            tags: page.tags,
            classification: page.classification
          })
        ) {
          return reply.forbidden(
            `You are not allowed to duplicate this folder: you may not write a page at "${destPath}".`
          )
        }
      }
      for (const asset of descendants.assets) {
        if (!mayOnAsset(req, 'read:assets', siteId, asset)) {
          return reply.forbidden(
            `You are not allowed to duplicate this folder: you may not read the asset at "${asset.path}".`
          )
        }
        const destAsset = {
          folderPath: destRoot + asset.folderPath.slice(sourcePath.length),
          fileName: asset.fileName,
          locale: destLocale
        }
        if (!mayOnAsset(req, 'write:assets', siteId, destAsset)) {
          return reply.forbidden(
            `You are not allowed to duplicate this folder: you may not write an asset at "${[destAsset.folderPath, destAsset.fileName].filter(Boolean).join('/')}".`
          )
        }
      }

      const result = await CARDINAL.models.tree.duplicateFolder({
        id: source.id,
        siteId,
        folderId: body.folderId,
        parentPath: body.folderId ? undefined : destParent,
        pathName: body.pathName,
        title: body.title,
        actor
      })
      return {
        ok: true,
        message: 'Folder duplicated successfully.',
        folder: {
          ...result.folder,
          folderPath: decodeTreePath(result.folder.folderPath ?? '') ?? '',
          childrenCount: result.folder.meta?.children ?? 0
        },
        folders: result.folders,
        pages: result.pages,
        assets: result.assets
      }
    }
  )
}

export default routes
