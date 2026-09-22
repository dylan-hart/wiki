import { loadReadablePage, requireActorId } from '../helpers/pageAccess.ts'
import type { UserPageMarkKind } from '../models/userPages.ts'
import type { FastifyInstance } from 'fastify'

const USER_PAGES_REQUIRED = 'Recent, favorite and pinned pages require a logged in user.'

type PageParams = { siteId: string; pageId: string }

function markRoutes(
  app: FastifyInstance,
  {
    segment,
    kind,
    flag,
    noun
  }: { segment: string; kind: UserPageMarkKind; flag: 'isFavorite' | 'isPinned'; noun: string }
) {
  const url = `/sites/:siteId/pages/:pageId/${segment}`

  app.put<{ Params: PageParams }>(
    url,
    {
      schema: {
        summary: `Add a page to ${noun}s`,
        description: `Adds the page to the caller's ${noun}s. A page already there answers 200 and changes nothing, so the button can be pressed twice. A page the caller cannot read answers 404 as though it did not exist. A password-protected page is not refused: the caller may already see its title and path, which is all the list carries.`,
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: `The page is one of the caller's ${noun}s`,
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              [flag]: { type: 'boolean' }
            }
          },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, USER_PAGES_REQUIRED)
      if (!userId) {
        return reply
      }
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      await CARDINAL.models.userPages.add({
        siteId: req.params.siteId,
        userId,
        pageId: page.id,
        kind
      })
      return { ok: true, [flag]: true }
    }
  )

  app.delete<{ Params: PageParams }>(
    url,
    {
      schema: {
        summary: `Remove a page from ${noun}s`,
        description: `Removes the page from the caller's ${noun}s. A page that was not there answers the same way, since the outcome asked for already holds. The page is not loaded, so a page that has since become unreadable can still be removed.`,
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: `The page is no longer one of the caller's ${noun}s`,
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              [flag]: { type: 'boolean' }
            }
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, USER_PAGES_REQUIRED)
      if (!userId) {
        return reply
      }
      await CARDINAL.models.userPages.remove({ userId, pageId: req.params.pageId, kind })
      return { ok: true, [flag]: false }
    }
  )
}

async function routes(app: FastifyInstance) {
  app.put<{ Params: PageParams }>(
    '/sites/:siteId/pages/:pageId/visit',
    {
      schema: {
        summary: 'Record a visit to a page',
        description:
          "Moves the page to the top of the caller's recent pages, trimming the oldest past the cap. Repeating it only refreshes the visit time. A page the caller cannot read answers 404 as though it did not exist. A password-protected page is not refused: the caller may already see its title and path, which is all the list carries.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: 'The visit is recorded',
            type: 'object',
            properties: { ok: { type: 'boolean' } }
          },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, USER_PAGES_REQUIRED)
      if (!userId) {
        return reply
      }
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      await CARDINAL.models.userPages.touchRecent({
        siteId: req.params.siteId,
        userId,
        pageId: page.id
      })
      return { ok: true }
    }
  )

  markRoutes(app, { segment: 'favorite', kind: 'favorite', flag: 'isFavorite', noun: 'favorite' })
  markRoutes(app, { segment: 'pin', kind: 'pinned', flag: 'isPinned', noun: 'pinned page' })

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/user-pages',
    {
      schema: {
        summary: "List the caller's recent, favorite and pinned pages",
        description:
          'All three lists on this site in one response. Pages the caller can no longer read are left out, and titles and paths come from the pages themselves, so a renamed or moved page is listed where it is now.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: "The caller's pages",
            $ref: 'UserPagesList#'
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, USER_PAGES_REQUIRED)
      if (!userId) {
        return reply
      }
      const { siteId } = req.params
      const [recent, favorites, pinned] = await Promise.all([
        CARDINAL.models.userPages.list({ siteId, userId, kind: 'recent' }),
        CARDINAL.models.userPages.list({ siteId, userId, kind: 'favorite' }),
        CARDINAL.models.userPages.list({ siteId, userId, kind: 'pinned' })
      ])
      return { recent, favorites, pinned }
    }
  )
}

export default routes
