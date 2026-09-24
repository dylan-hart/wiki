import { loadReadablePage, requireActorId, requireReadablePage } from '../helpers/pageAccess.ts'
import type { WatchNotifyPreference } from '../models/pageWatching.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Watching belongs to an account: a row has to point at a person for a notification to have a
 * recipient. Beyond being logged in, anybody who may read a page may watch it.
 */
const WATCHER_REQUIRED = 'Watching a page requires a logged in user.'

/**
 * Generous enough that no realistic caller has to page, small enough that omitting `limit` cannot
 * turn a heavily-watched page into a huge response.
 */
const DEFAULT_WATCHER_LIMIT = 25

async function routes(app: FastifyInstance) {
  app.put<{ Params: { siteId: string; pageId: string }; Body: WatchNotifyPreference | undefined }>(
    '/sites/:siteId/pages/:pageId/watch',
    {
      /*
        No route-level `permissions`: this is decided per page, by whether the caller may read it —
        which comes from a group's rules and not from the group-wide list that hook consults.
      */
      schema: {
        summary: 'Watch a page',
        description:
          'Records that the caller wants to hear about changes to this page. Watching a page already watched changes nothing and still answers 200, so the button can be pressed twice without it meaning anything different — including a preference in the body of a repeat call is therefore also a no-op; use PATCH on this same route to change the preference of a watch that already exists.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        body: { $ref: 'WatchPreferenceInput#' },
        response: {
          200: {
            description: 'The page is being watched',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              isWatching: { type: 'boolean' },
              preference: { $ref: 'WatchPreference#' }
            }
          },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, WATCHER_REQUIRED)
      if (!userId) {
        return reply
      }
      /*
        An unreadable page answers as though it were not there. `isLocked` goes unchecked on purpose:
        the watcher is asking to be told when the page changes, not to read what it says.
      */
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      await CARDINAL.models.pageWatching.watch({
        siteId: req.params.siteId,
        pageId: page.id,
        userId,
        ...req.body
      })
      const preference = await CARDINAL.models.pageWatching.getPreference(page.id, userId)
      return { ok: true, isWatching: true, preference }
    }
  )

  app.patch<{ Params: { siteId: string; pageId: string }; Body: WatchNotifyPreference }>(
    '/sites/:siteId/pages/:pageId/watch',
    {
      // -> Only the caller's own watch row is touched, so being logged in is the whole of the check
      schema: {
        summary: "Change a watch's delivery preference",
        description:
          'Sets how the caller wants to hear about changes to a page they are already watching. Fields left out of the body are left as they were. There is nothing to set a preference ON for a page the caller is not watching, so this answers 404 rather than creating a watch as a side effect — call PUT first.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        body: { $ref: 'WatchPreferenceInput#' },
        response: {
          200: {
            description: 'The preference now in effect for this watch',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              preference: { $ref: 'WatchPreference#' }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, WATCHER_REQUIRED)
      if (!userId) {
        return reply
      }
      const existed = await CARDINAL.models.pageWatching.setPreference({
        pageId: req.params.pageId,
        userId,
        ...req.body
      })
      if (!existed) {
        return reply.notFound('You are not watching this page.')
      }
      const preference = await CARDINAL.models.pageWatching.getPreference(req.params.pageId, userId)
      return { ok: true, preference }
    }
  )

  app.delete<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/watch',
    {
      schema: {
        summary: 'Stop watching a page',
        description:
          'Forgets that the caller wanted to hear about this page. A page that was not being watched answers the same way, since the outcome asked for — no longer watching it — already holds.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: 'The page is no longer being watched',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              isWatching: { type: 'boolean' }
            }
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, WATCHER_REQUIRED)
      if (!userId) {
        return reply
      }
      /*
        The page is NOT loaded first: unwatching has to keep working for a page that has since become
        unreadable, or the row would be stuck with nothing able to remove it. There is nothing to
        protect anyway: this only ever deletes the caller's own row.
      */
      await CARDINAL.models.pageWatching.unwatch({ pageId: req.params.pageId, userId })
      return { ok: true, isWatching: false }
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/watching',
    {
      // -> Everything it returns is the caller's own, so being logged in is the whole of the check
      schema: {
        summary: 'List the pages the caller is watching',
        description:
          'The watch list of the caller on this site, most recently watched first. Titles and paths come from the pages themselves, so a page that has been renamed or moved is listed where it is now.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Watched pages',
            type: 'array',
            items: { $ref: 'WatchedPage#' }
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply, WATCHER_REQUIRED)
      if (!userId) {
        return reply
      }
      // -> The request's own actor, so an API key's scope and classification narrowing hold here
      //    as they do on the page reads the list links to.
      return CARDINAL.models.pageWatching.listForUser(
        req.params.siteId,
        userId,
        CARDINAL.models.groups.actorForRequest(req)
      )
    }
  )

  app.get<{ Params: { siteId: string; pageId: string }; Querystring: { limit?: number } }>(
    '/sites/:siteId/pages/:pageId/watchers',
    {
      /*
        No route-level `permissions`: `read:pages` is granted by a group's rules, not the group-wide
        list that hook consults. `requireReadablePage` below is the whole gate, the same one the page
        view passes through, so a page the reader cannot open answers before a watcher's name is read.

        No `requireActorId`, unlike the routes above: watching is something an account does, but
        reading who watches is not — the rail draws this section for a signed-out visitor too.
      */
      schema: {
        summary: "List a page's watchers",
        description:
          "Who is watching this page, oldest watcher first, with the total across all of them. Intended for the page metadata rail, which draws a few initial plates and a `+N` remainder — how many plates is the caller's decision, so ask for as many as will be drawn and read `total` for the remainder. Readable by anybody who may read the page, signed in or not.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: DEFAULT_WATCHER_LIMIT,
              description:
                'How many watchers to return. `total` is counted over every watcher regardless.'
            }
          }
        },
        response: {
          200: {
            description: "The page's watchers, oldest first",
            $ref: 'PageWatchers#'
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply
      }
      return CARDINAL.models.pageWatching.listForPage(page.id, {
        // -> The schema's `default` already fills this in; the `??` keeps the model's `limit`
        //    non-optional.
        limit: req.query.limit ?? DEFAULT_WATCHER_LIMIT
      })
    }
  )
}

export default routes
