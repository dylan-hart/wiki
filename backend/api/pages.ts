import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import type { PageInput } from '../models/pages.ts'
import {
  detectImportFormat,
  MAX_IMPORT_BATCH_BYTES,
  MAX_IMPORT_BATCH_FILES,
  MAX_IMPORT_SIZE,
  SUPPORTED_IMPORT_FORMATS
} from '../models/import.ts'
import { SEARCH_ORDER_BY, type SearchOrderBy } from '../models/search.ts'
import { CustomError, generatePathHash, isValidUuid, normalizePagePath } from '../helpers/common.ts'
import { defaultLocale } from '../helpers/localeRouting.ts'
import { limitAuthAttempts, limitRenders } from '../helpers/rateLimit.ts'
import {
  actorFrom,
  mayBypassPassword,
  mayOnPage,
  pagePermissionsFor,
  requireReadablePage,
  splitList,
  unlockedFor
} from '../helpers/pageAccess.ts'
import { sessionCookieName } from '../helpers/security.ts'
import { actorFromRequest } from '../models/auditLog.ts'

/**
 * A safe filename stem for a page export, from its path.
 *
 * A path is directories joined by `/`; a downloaded file only wants the page's own name, the way
 * `docs/getting-started` becomes `getting-started.pdf` rather than a name with slashes in it. The home
 * page's path is empty, so that falls back to `home`. Shared by every `.../export*` route — PDF,
 * Markdown and HTML alike all name their download off the same rule.
 */
function exportFilenameStem(path: string): string {
  const segment = path.split('/').filter(Boolean).pop() || 'home'
  return segment.replaceAll(/[^a-z0-9-]+/gi, '-')
}

/**
 * `ensureCanRender()` (`models/renderQueue.ts`) throws these two named errors -- via `createPage()`/
 * `updatePage()` (OpenProject #1716) -- when a render-less write can't be safely accepted: an editor
 * this server has no renderer for, or a markdown page with no Puppeteer extension to render it. Maps
 * each to a `@fastify/sensible` error carrying `ensureCanRender()`'s own message (which names the
 * editor or the missing extension), reusing the exact wording the existing recovery route
 * (`POST …/pages/:pageId/render`, below) already 503s with rather than inventing a second one
 * (OpenProject #1720). Returns the sent reply once handled, or `null` for any other error so the
 * caller rethrows it for the generic `setErrorHandler` in `index.ts` to shape.
 */
function replyForRenderRefusal(err: any, reply: FastifyReply): FastifyReply | null {
  if (!(err instanceof CustomError)) {
    return null
  }
  if (err.name === 'renderPuppeteerMissing') {
    return reply.serviceUnavailable(err.message)
  }
  if (err.name === 'renderUnsupportedEditor') {
    return reply.badRequest(err.message)
  }
  return null
}

/**
 * Logs a best-effort pageview for the page-read route below (OpenProject #1238) -- the REST half of
 * the two write paths #1140's graph sizing needs; `mcp/tools/getPage.ts`'s `get_page` tool is the
 * other. Never throws: `models/pageviews.ts#record()` swallows its own failures and no-ops entirely
 * while the admin opt-out is off, so this can be called unconditionally without guarding the read it
 * rides along with.
 *
 * `req.apiKey` set means a bearer key called this route directly (not through MCP, which never reaches
 * here), so it counts as `api` rather than `browser` — hashing the key's own id, exactly the way
 * `mcp/tools/getPage.ts` hashes `ctx.keyId` for the same reason: two different keys are two different
 * visitors, the same key reused is one.
 *
 * A `browser` visitor is identified by its own session id, which only survives past this one request if
 * something writes to the session (`saveUninitialized: false` in `index.ts`) — the same gap
 * `POST .../unlock`'s own doc comment describes ("unlocking one is what first gives an anonymous reader
 * a session"). Setting `pageViewed` is what closes it here: without it, an anonymous reader with no
 * other reason to touch their session would look like a brand new visitor on every single view.
 *
 * That write is gated on the same `WIKI.config.pageviews.isEnabled` opt-out `record()` itself checks
 * (OpenProject #2251): with tracking off there is no visitor identity worth preserving across requests,
 * so forcing a session (and the `Set-Cookie` + permanent `sessions` row that comes with it) for every
 * anonymous read would only defeat `saveUninitialized: false` for nothing in return.
 */
function recordPageview(req: FastifyRequest, siteId: string, pageId: string): void {
  if (req.apiKey) {
    void WIKI.models.pageviews.record({
      siteId,
      pageId,
      clientType: 'api',
      visitorRawId: req.apiKey.id
    })
    return
  }
  if (req.session && WIKI.config.pageviews?.isEnabled === true) {
    req.session.pageViewed = true
    void WIKI.models.pageviews.record({
      siteId,
      pageId,
      clientType: 'browser',
      visitorRawId: req.session.sessionId
    })
  }
}

/**
 * The page permissions that make a page's password irrelevant to the holder — asked of
 * `WIKI.models.groups.mayHoldPermissionSomewhere()` rather than any one page's rule.
 *
 * Used only by search, which spans many pages that may each carry a different rule, so there is no
 * single page here to ask `mayOnPage()` about. This is deliberately coarser than `mayBypassPassword()`
 * (`helpers/pageAccess.ts`): search either hides every protected excerpt from this searcher or none of
 * them, rather than deciding page by page. (`manage:system` needs no entry here —
 * `mayHoldPermissionSomewhere()` already short-circuits on it.)
 */
const PAGE_PASSWORD_BYPASS_ROLES = ['write:pages', 'manage:pages']

/**
 * Records a `page.classificationChanged` audit log entry (OpenProject #1081) -- called from every
 * site a page's classification actually changes: the PATCH route (an explicit set, raise or lower),
 * the move route (an auto-bump onto a stricter parent), and the classification-conflicts resolve
 * route (a bulk bump). A no-op when `from === to`, so a caller does not have to re-check that itself.
 */
async function recordClassificationChange(
  req: FastifyRequest,
  siteId: string,
  page: { id: string; path: string },
  from: string,
  to: string
): Promise<void> {
  if (from === to) {
    return
  }
  await WIKI.models.auditLog.record({
    event: 'page.classificationChanged',
    actor: actorFromRequest(req),
    targetType: 'page',
    targetId: page.id,
    targetLabel: page.path,
    detail: { from, to },
    siteId
  })
}

/**
 * Batched form of `recordClassificationChange`, for a caller that already knows every (from, to)
 * pair up front and wants one INSERT instead of N — the classification-conflicts resolve route
 * (OpenProject #1902), bumping many pages in one request. `from === to` entries are dropped rather
 * than written, the same no-op `recordClassificationChange` documents.
 */
async function recordClassificationChanges(
  req: FastifyRequest,
  siteId: string,
  changes: { page: { id: string; path: string }; from: string; to: string }[]
): Promise<void> {
  const actor = actorFromRequest(req)
  const entries = changes
    .filter(({ from, to }) => from !== to)
    .map(({ page, from, to }) => ({
      event: 'page.classificationChanged' as const,
      actor,
      targetType: 'page' as const,
      targetId: page.id,
      targetLabel: page.path,
      detail: { from, to },
      siteId
    }))
  await WIKI.models.auditLog.recordMany(entries)
}

/**
 * Pages API Routes
 */
async function routes(app: FastifyInstance) {
  // -> IMPORT PAGE's body is the uploaded file's raw bytes, not a multipart form or JSON — the same
  //    approach `api/assets.ts` uses for asset uploads. The catch-all only claims content types
  //    nothing else in this file parses, so the JSON routes above and below are unaffected.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: MAX_IMPORT_SIZE },
    (req, body, done) => {
      done(null, body)
    }
  )

  // -> IMPORT PAGES (BATCH)'s body carries several files in one request, which the raw-bytes approach
  //    above has no room for — `@fastify/multipart` claims `multipart/form-data` specifically, which
  //    Fastify matches ahead of the generic `'*'` parser above regardless of registration order.
  //    `throwFileSizeLimit: false` (OpenProject #849 fix): the default `true` makes an oversized
  //    file's `toBuffer()` reject as documented below, but the plugin ALSO latches that rejection as
  //    `lastError` and replays it out of `req.files()`'s own iterator on the very next `for await`
  //    step — even one that only advances past files already handled — which turned "one bad file
  //    fails independently" into "one oversized file 413s the whole batch, however many files came
  //    after it converted fine". Disabled, a stream still stops accepting bytes past the limit and
  //    `file.file.truncated` still flips true; the route below reads that flag itself instead of
  //    trusting `toBuffer()` to throw.
  //    `fields: MAX_IMPORT_BATCH_FILES` (OpenProject #1209): one optional `formats` text field per
  //    `files` entry, interleaved file-then-its-format by the frontend, lets a caller override a
  //    single file's autodetected format without giving every field in the batch one.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_IMPORT_SIZE,
      files: MAX_IMPORT_BATCH_FILES,
      fields: MAX_IMPORT_BATCH_FILES
    },
    throwFileSizeLimit: false
  })

  /**
   * SEARCH PAGES
   */
  app.get<{
    Params: { siteId: string }
    Querystring: {
      query?: string
      path?: string
      locales?: string
      tags?: string
      editor?: string
      publishState?: string
      orderBy?: SearchOrderBy
      orderByDirection?: 'asc' | 'desc'
      offset?: number
      limit?: number
    }
  }>(
    '/sites/:siteId/pages/search',
    {
      schema: {
        summary: 'Search pages',
        description:
          'Postgres full-text search over the pages of a site, ranked by relevance. `query` may be left out, in which case the filters alone decide the results — which is what a search for nothing but tags is.\n\nReadable without a session, for the same reason reading a page is: an anonymous request only matches published pages. Drafts are included only for someone who may write pages. A page marked as not searchable never appears, whoever is asking.\n\nA password-protected page is listed like any other — its title and description are not what the password covers — but for a searcher who would have to enter that password it can only be matched on those two, never on the text behind the lock, and it comes back with no `highlight`.\n\n`highlight` is an excerpt with the matched terms wrapped in `<b>`, and is the only field carrying markup — the excerpt is escaped before those are added. It is absent unless term highlighting is enabled in the search settings.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              maxLength: 2048,
              description: 'Free text. Understands quoted phrases, `or` and `-exclusions`.'
            },
            path: {
              type: 'string',
              maxLength: 2048,
              description: 'Only pages whose path starts with this.'
            },
            locales: {
              type: 'string',
              maxLength: 255,
              description: 'Comma-separated locale codes. Every locale when absent.'
            },
            tags: {
              type: 'string',
              maxLength: 2048,
              description: 'Comma-separated tags a page must carry all of.'
            },
            editor: {
              type: 'string',
              maxLength: 255
            },
            publishState: {
              type: 'string',
              enum: ['draft', 'published', 'scheduled']
            },
            orderBy: {
              type: 'string',
              enum: SEARCH_ORDER_BY,
              default: 'relevancy'
            },
            orderByDirection: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: 'desc'
            },
            offset: {
              type: 'integer',
              minimum: 0,
              default: 0
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 25
            }
          }
        },
        response: {
          200: {
            description: 'Matching pages, plus how many there are in total',
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    path: { type: 'string' },
                    locale: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: ['string', 'null'] },
                    icon: { type: ['string', 'null'] },
                    tags: { type: 'array', items: { type: 'string' } },
                    updatedAt: { type: 'string', format: 'date-time' },
                    relevancy: { type: 'number' },
                    highlight: {
                      type: ['string', 'null'],
                      description: 'Excerpt with matched terms in `<b>`, everything else escaped.'
                    }
                  }
                }
              },
              totalHits: {
                type: 'integer',
                description:
                  "How many pages match and are visible to you, ignoring `limit` and `offset`. Counted only from rows you may actually read — a page you have no access to is never included, even at `limit=1`. Exact up to the search engine's own scan cap; beyond that cap it is a floor (at least this many), not a precise total."
              },
              totalHitsApproximate: {
                type: 'boolean',
                description:
                  "`true` when `totalHits` is not exact: this searcher's page rules dropped one or more matching rows, so the real total they could ever see is a floor, not the number shown."
              },
              suggestion: {
                type: ['string', 'null'],
                description:
                  'The closest page title to `query`, for a "did you mean" prompt. Only ever set when `totalHits` is 0 and a `query` was given, and only when one title is close enough to be worth suggesting.'
              }
            }
          }
        }
      }
    },
    async (req) => {
      const actor = actorFrom(req)
      const accessActor = WIKI.models.groups.actorForRequest(req)
      // -> "May write pages somewhere on this site" and "may read a locked page's text anywhere on
      //    this site" are the same question here — both amount to holding `write:pages`/
      //    `manage:pages` via SOME rule scoped to this site, not the (unrelated) group-wide
      //    permission list. See `mayHoldPermissionSomewhere()`'s own doc for why DENY is ignored,
      //    why the site is threaded through (OpenProject #2146/#2162), and why this can't be asked
      //    per page the way `mayOnPage()` is elsewhere.
      const maySeeEverything = WIKI.models.groups.mayHoldPermissionSomewhere(
        accessActor,
        PAGE_PASSWORD_BYPASS_ROLES,
        req.params.siteId
      )
      return WIKI.models.search.query({
        siteId: req.params.siteId,
        query: req.query.query,
        path: req.query.path,
        locales: splitList(req.query.locales),
        tags: splitList(req.query.tags),
        editor: req.query.editor,
        publishState: req.query.publishState,
        orderBy: req.query.orderBy,
        orderByDirection: req.query.orderByDirection,
        offset: req.query.offset,
        limit: req.query.limit,
        publicOnly: !actor,
        // -> So that a page the caller could not open never shows up as a result
        actor: accessActor,
        // -> An unpublished page is only of interest to someone who could have written it
        includeDrafts: maySeeEverything,
        // -> Same rule as the page view: a protected page's text is for whoever holds the password, and
        //    a search excerpt is that text. Its title and description are not covered, so the page is
        //    still listed. Global rather than per page — since a search spans many pages at once.
        hideProtectedContent: !maySeeEverything
      })
    }
  )

  /**
   * GET PAGE FOR INCLUSION
   */
  app.get<{ Params: { siteId: string }; Querystring: { path: string; locale?: string } }>(
    '/sites/:siteId/pages/include',
    {
      schema: {
        summary: 'Get a page for inclusion',
        description:
          "What an include block needs to draw another page inside the one being read: its title and its stored render, addressed by path rather than by ID, since a path is what an author writes into the page.\n\nThe reader's own access decides the answer, exactly as it would if they opened the page themselves — an anonymous request only ever sees published pages, and a password-protected page comes back with `isLocked: true` and no body unless this session has already unlocked it. So an include can never show content its reader could not have reached on their own.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              maxLength: 2048,
              description: 'Slash-separated path of the page to include. The home page when empty.'
            },
            locale: {
              type: 'string',
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          }
        },
        response: {
          200: { $ref: 'IncludedPage#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      // -> The stored form of whatever the including page wrote, since that is what it is looked up
      //    by. The site root is the `home` page.
      const path = normalizePagePath(req.query.path)
      const page = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        hash: generatePathHash(path || 'home'),
        locale: req.query.locale,
        publicOnly: !actor,
        // -> Only ever needs the body's presence/absence, which `isLocked` already answers below, so
        //    the password value itself is never read back here.
        unlocked: (page) => unlockedFor(req, req.params.siteId, page),
        withPassword: false
      })
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:pages', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to read this page.')
      }
      return {
        path: page.path,
        locale: page.locale,
        title: page.title,
        isLocked: page.isLocked,
        render: page.render
      }
    }
  )

  /**
   * GET PAGE
   */
  app.get<{
    Params: { siteId: string; pageIdOrHash: string }
    Querystring: { withContent?: boolean; locale?: string }
  }>(
    '/sites/:siteId/pages/:pageIdOrHash',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. `read:pages` is checked against this page below, and — only when
        `withContent` actually asked for the source — `read:source` on top of it.
      */
      schema: {
        summary: 'Get a single page',
        description:
          "Addressed either by ID or by the hash of its path, which is how a page view asks for one. A hash only identifies a page within a locale, so `locale` picks between translations — the site's primary one when absent.\n\nReadable without a session, because a wiki is read by people who are not logged in — but an anonymous request only ever sees published pages, and never their source. Access is enforced per page against the requester's group rules (`mayOnPage()`), not against a group-wide permission list, so who may read a given page can differ path by path. `withContent` needs `read:source` ON THIS PAGE on top of `read:pages`, granted by a group rule.\n\nA password-protected page answers with its metadata and `isLocked: true`, its body withheld, until the session satisfies `POST …/unlock` — or unless the requester holds `write:pages` or `manage:pages` ON THIS PAGE, for whom the password is not a barrier.",
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            pageIdOrHash: {
              type: 'string',
              oneOf: [{ format: 'uuid' }, { pattern: '^[a-f0-9]+$' }]
            }
          },
          required: ['siteId', 'pageIdOrHash']
        },
        querystring: {
          type: 'object',
          properties: {
            withContent: {
              type: 'boolean',
              default: false,
              description: 'Include the source, which only an editor needs.'
            },
            locale: {
              type: 'string',
              maxLength: 10
            }
          }
        },
        response: {
          200: { $ref: 'Page#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> A site-scoped key may not reach a site it isn't scoped to -- now enforced globally by
      //    `apiKeySitePinHook` in `index.ts` for every `/sites/:siteId/...` route, this one
      //    included; see `helpers/apiKeySite.ts`.
      const isId = isValidUuid(req.params.pageIdOrHash)
      const actor = actorFrom(req)
      // -> The source is what an editor loads, and editing is not something an anonymous reader does
      const wantsContent = Boolean(req.query.withContent) && Boolean(actor)
      const page = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        ...(isId ? { id: req.params.pageIdOrHash } : { hash: req.params.pageIdOrHash }),
        locale: req.query.locale,
        withContent: wantsContent,
        publicOnly: !actor,
        // -> Both answered once the page is known, since a hash does not say which page it is yet, and
        //    the bypass is decided per page (`mayOnPage()`), not from a group-wide permission list.
        unlocked: (page) => unlockedFor(req, req.params.siteId, page),
        withPassword: (page) => mayBypassPassword(req, req.params.siteId, page)
      })
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:pages', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to read this page.')
      }
      // -> A separate permission from `read:pages`: reading the rendered page is not reading its source
      if (wantsContent && !mayOnPage(req, 'read:source', req.params.siteId, page)) {
        return reply.forbidden("You are not allowed to read this page's source.")
      }
      // -> Best-effort, never awaited: see `recordPageview()`'s own doc comment.
      recordPageview(req, req.params.siteId, page.id)
      /*
        The reader's own standing on this page, carried back with it.

        Three questions the page view used to ask as three more requests — what may I do here, may I
        suggest an edit, do I review this page — each of which had to load the page again to answer.
        They are answered here from the page already in hand, against rules already in memory, which
        is what makes a page view one request instead of four.
      */
      const actorId = actor?.id ?? null
      const [approvalState, isWatching, commentsCount] = await Promise.all([
        WIKI.models.approvals.pageViewerState(req, req.params.siteId, {
          id: page.id,
          path: page.path,
          locale: page.locale,
          tags: page.tags ?? [],
          allowContributions: page.allowContributions,
          classification: page.classification
        }),
        // -> One indexed lookup on (pageId, userId), and none at all for a reader with no account
        WIKI.models.pageWatching.isWatching(page.id, actorId),
        WIKI.models.comments.countForPage(page.id)
      ])
      /*
        Who else already has this page open, on this instance — a cheap "someone else has this open"
        hint for before a collab session starts, drawn straight from whatever room `core/collab.ts`
        already has for the page. No query: it is in memory or it is nothing. Left at zero on a site
        without the feature, since a room can never exist there and the number would be misleading if
        the feature were re-enabled and disabled again while a stale one lingered.
      */
      const activeEditors = WIKI.sites[req.params.siteId]?.config?.features?.collaborativeEditing
        ? WIKI.collab.participantInfo(page.id)
        : { count: 0, names: [] }
      return {
        ...page,
        commentsCount,
        viewer: {
          permissions: pagePermissionsFor(req, req.params.siteId, page),
          ...approvalState,
          isWatching,
          activeEditors
        }
      }
    }
  )

  /**
   * UNLOCK PAGE
   */
  app.post<{
    Params: { siteId: string; pageIdOrHash: string }
    Querystring: { locale?: string }
    Body: { password: string }
  }>(
    '/sites/:siteId/pages/:pageIdOrHash/unlock',
    {
      // -> A password endpoint like the ones in `api/authentication.ts`, and limited with them
      onRequest: limitAuthAttempts,
      schema: {
        summary: 'Unlock a password-protected page',
        description:
          'Answers with the page, body included, when the password matches — and records the unlock on the session, so that reading the page again does not ask a second time. A wrong password is a 401 and says nothing more; a page with no password on it answers the same way, so that this cannot be used to find out which pages are protected.\n\nCallable without a session, because a protected page is written for readers who have the password rather than an account. Unlocking one is what first gives an anonymous reader a session.\n\nWhoever may edit the page never needs this: they can read the source and remove the password, so `GET` already hands them the body.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            pageIdOrHash: {
              type: 'string',
              oneOf: [{ format: 'uuid' }, { pattern: '^[a-f0-9]+$' }]
            }
          },
          required: ['siteId', 'pageIdOrHash']
        },
        querystring: {
          type: 'object',
          properties: {
            locale: {
              type: 'string',
              maxLength: 10
            }
          }
        },
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            password: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            }
          }
        },
        response: {
          200: { $ref: 'Page#' },
          401: { $ref: 'ApiError#', description: 'The password is wrong, or the page has none.' }
        }
      }
    },
    async (req, reply) => {
      const isId = isValidUuid(req.params.pageIdOrHash)
      const actor = actorFrom(req)
      const page = await WIKI.models.pages.unlockPage({
        siteId: req.params.siteId,
        ...(isId ? { id: req.params.pageIdOrHash } : { hash: req.params.pageIdOrHash }),
        locale: req.query.locale,
        password: req.body.password,
        publicOnly: !actor
      })
      if (!page) {
        return reply.unauthorized('Incorrect password.')
      }
      /*
        Recorded per page rather than as a blanket "this session may read protected pages": each
        password is a separate secret, and knowing one says nothing about the others.

        Writing to the session is what creates one for an anonymous reader — `saveUninitialized` is
        off, so no row exists until this point. That is the intent: the unlock has to outlive the
        request, and it is the reader's own deliberate action that starts it.
      */
      req.session.unlockedPages = [...new Set([...(req.session.unlockedPages ?? []), page.id])]
      return page
    }
  )

  /**
   * CREATE PAGE
   */
  app.post<{ Params: { siteId: string }; Body: PageInput }>(
    '/sites/:siteId/pages',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Create a page',
        description:
          'The content is the source and `render` is the HTML the editor produced from it. The render is sanitized against what the author may embed, stripped of editor scaffolding, given heading anchors, and reduced to a table of contents and search text — so read the response rather than assuming what was sent is what was stored.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          allOf: [
            { $ref: 'PageInput#' },
            { type: 'object', required: ['path', 'title', 'editor', 'content'] }
          ]
        },
        response: {
          200: {
            description: 'Page created successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: { $ref: 'Page#' }
            }
          },
          400: {
            $ref: 'ApiError#',
            description:
              'The declared editor has no server-side renderer, and this write carried content with no explicit render for it to fall back on.'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          503: {
            $ref: 'ApiError#',
            description:
              'This write carried content with no explicit render, and the instance has no Puppeteer extension installed to produce one server-side.'
          }
        }
      }
    },
    async (req, reply) => {
      // -> A site-scoped key may not reach a site it isn't scoped to -- now enforced globally by
      //    `apiKeySitePinHook` in `index.ts` for every `/sites/:siteId/...` route, this one
      //    included; see `helpers/apiKeySite.ts`.
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Saving a page requires a logged in user.')
      }
      // -> Against where the page is going: there is no page to ask about yet, and specifically no
      //    `tags` (feature 357, task 446 audit) — a page being created has none until it is saved,
      //    so there is nothing for a tag-scoped rule to match on here. `locale` is known up front
      //    from the request body and is passed.
      if (
        !mayOnPage(req, 'write:pages', req.params.siteId, {
          path: req.body.path,
          locale: req.body.locale ?? defaultLocale(req.params.siteId)
        })
      ) {
        return reply.forbidden('You are not allowed to create a page here.')
      }
      let page
      try {
        page = await WIKI.models.pages.createPage(req.params.siteId, req.body, actor)
      } catch (err: any) {
        const refusal = replyForRenderRefusal(err, reply)
        if (refusal) {
          return refusal
        }
        throw err
      }
      return {
        ok: true,
        message: 'Page created successfully.',
        page
      }
    }
  )

  /**
   * IMPORT PAGE CONTENT
   */
  app.post<{
    Params: { siteId: string }
    Querystring: { fileName: string; format?: string; path: string; locale?: string }
  }>(
    '/sites/:siteId/pages/import',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES, addressed by the path the converted content would be saved to.
        Checked against that path below, exactly like CREATE PAGE above.
      */
      schema: {
        summary: 'Convert an uploaded file to Markdown',
        description: `The body is the file itself, not a multipart form — send the bytes with their \`Content-Type\`. At most ${Math.round(MAX_IMPORT_SIZE / 1024 / 1024)} MB. \`fileName\`'s extension decides the format (OpenProject #1209) unless \`format\` overrides it; the result is GitHub-flavored Markdown, ready to hand to the markdown editor or POST as a new page's \`content\` — this endpoint only converts, it does not save anything.\n\n\`format: 'markdown'\` (OpenProject #1092) is a pass-through — the file's own bytes, with a leading YAML front-matter block (if any) split off into \`title\`/\`description\`/\`tags\` — and needs no Pandoc extension. Every other format still needs Pandoc, and answers 503 without it. \`path\` is not written to, only checked: converting content requires \`write:pages\` on wherever the caller says they intend to save it.`,
        tags: ['Pages'],
        consumes: ['*/*'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            fileName: {
              type: 'string',
              minLength: 1,
              description:
                "The uploaded file's own name, used to detect its format from its extension (OpenProject #1209)."
            },
            format: {
              type: 'string',
              enum: [...SUPPORTED_IMPORT_FORMATS],
              description:
                'Overrides the format detected from `fileName`. Only needed when detection got it wrong or the extension is ambiguous.'
            },
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$',
              description:
                'Where the converted content would be saved. Used only to check permission — nothing is written here.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          },
          required: ['fileName', 'path']
        },
        response: {
          200: { $ref: 'PageImportResult#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Importing a page requires a logged in user.')
      }
      if (
        !mayOnPage(req, 'write:pages', req.params.siteId, {
          path: req.query.path,
          locale: req.query.locale ?? defaultLocale(req.params.siteId)
        })
      ) {
        return reply.forbidden('You are not allowed to write a page here.')
      }
      const data = req.body
      if (!Buffer.isBuffer(data) || data.length < 1) {
        return reply.badRequest('No file was sent.')
      }
      const format = req.query.format || detectImportFormat(req.query.fileName)
      if (!format) {
        return reply.badRequest(
          `Could not detect an import format from '${req.query.fileName}'. Pass 'format' explicitly.`
        )
      }
      const result = await WIKI.models.pageImport.convertToMarkdown({
        format,
        data
      })
      return {
        ok: true,
        message: 'File converted successfully.',
        markdown: result.markdown,
        title: result.title,
        description: result.description,
        tags: result.tags
      }
    }
  )

  /**
   * IMPORT PAGES (BATCH)
   */
  app.post<{
    Params: { siteId: string }
    Querystring: { path: string; locale?: string }
  }>(
    '/sites/:siteId/pages/import/batch',
    {
      /*
        No route-level `permissions`: same reasoning as IMPORT PAGE CONTENT above — `write:pages` is
        granted by a group's page RULES, checked in the handler against the declared `path`.
      */
      schema: {
        summary: 'Convert several uploaded files to Markdown in one request',
        description: `A \`multipart/form-data\` sibling of \`POST .../pages/import\` (OpenProject #849): several files in one request (field name \`files\`, repeated), each file's format autodetected from its own extension (OpenProject #1209; field name \`formats\`, repeated in the same order as \`files\`, overrides a single file's detection when non-empty). At most ${MAX_IMPORT_BATCH_FILES} files, each at most ${Math.round(MAX_IMPORT_SIZE / 1024 / 1024)} MB, and at most ${Math.round(MAX_IMPORT_BATCH_BYTES / 1024 / 1024)} MB combined (OpenProject #2204) — a batch over that aggregate ceiling is refused outright (400), not partially converted. The response carries one result per file, in the order they were sent — a bad file in the batch does not stop the rest from converting, so check each entry's own \`ok\`. Convert-only, exactly like the single-file endpoint: nothing is saved here, which is what lets the caller assign each result its own destination and review it before saving.\n\n\`format: 'markdown'\` (OpenProject #1092) is a pass-through and needs no Pandoc extension — every other format still does, and answers 503 without it. A file whose extension is not recognized fails only its own entry, same as any other per-file conversion failure. \`path\` is not written to, only checked: converting content requires \`write:pages\` on wherever the caller says they intend to save it.`,
        tags: ['Pages'],
        consumes: ['multipart/form-data'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$',
              description:
                'Where the converted content would be saved. Used only to check permission — nothing is written here.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          },
          required: ['path']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              results: {
                type: 'array',
                items: { $ref: 'PageImportBatchItem#' }
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Importing a page requires a logged in user.')
      }
      if (
        !mayOnPage(req, 'write:pages', req.params.siteId, {
          path: req.query.path,
          locale: req.query.locale ?? defaultLocale(req.params.siteId)
        })
      ) {
        return reply.forbidden('You are not allowed to write a page here.')
      }

      /*
        Read every part off the request before converting any file: `req.parts()` is a streaming
        iterator over the one multipart body, and its next part is only available once the current
        one has been consumed (`@fastify/busboy`'s own constraint) — so buffering has to happen one
        part at a time, in the order they arrived, before conversion can run in parallel below.
        `req.files()` won't do here since it skips field parts entirely, and a per-file format
        override (OpenProject #1209) travels as a `formats` field the frontend interleaves right
        after its own file — the last-pushed upload is always the one it belongs to. A file's
        oversize is checked via `file.truncated` after `toBuffer()` resolves, not by catching a
        throw — see the `throwFileSizeLimit: false` comment on the plugin registration above for why
        letting an oversized file throw here would still fail the whole batch anyway.

        `MAX_IMPORT_BATCH_BYTES` bounds the total across every file combined (OpenProject #2204):
        `fileSize`/`MAX_IMPORT_SIZE` above only cap ONE file, so nothing previously stopped
        `MAX_IMPORT_BATCH_FILES` maximum-size files (~500 MB) from all being resident as `Buffer`s at
        once. Tripping it discards whatever had been buffered so far and stops accepting more —
        atomically refusing the whole request rather than converting the files that fit before the
        ceiling was crossed, which is what keeps this a hard cap rather than a soft one an attacker
        could still push past by spreading a large batch across many small file reads. The rest of
        the body is still drained (each further file read and immediately discarded, never buffered)
        rather than abandoned mid-stream, which would otherwise leave the connection holding
        unconsumed bytes.
      */
      const uploads: (
        | { fileName: string; data: Buffer; formatOverride: string }
        | { fileName: string; error: string }
      )[] = []
      let totalBytes = 0
      let overBudget = false
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const data = await part.toBuffer()
          if (overBudget) {
            continue
          }
          totalBytes += data.length
          if (totalBytes > MAX_IMPORT_BATCH_BYTES) {
            overBudget = true
            uploads.length = 0
            continue
          }
          if (part.file.truncated) {
            uploads.push({
              fileName: part.filename,
              error: 'This file is larger than the import limit.'
            })
          } else {
            uploads.push({ fileName: part.filename, data, formatOverride: '' })
          }
          continue
        }
        const last = uploads.at(-1)
        if (
          !overBudget &&
          part.fieldname === 'formats' &&
          last &&
          !('error' in last) &&
          typeof part.value === 'string'
        ) {
          last.formatOverride = part.value
        }
      }
      if (overBudget) {
        return reply.badRequest(
          `This batch is larger than the ${Math.round(MAX_IMPORT_BATCH_BYTES / 1024 / 1024)} MB aggregate limit for one import request.`
        )
      }
      if (uploads.length < 1) {
        return reply.badRequest('No files were sent.')
      }

      const results = await Promise.all(
        uploads.map(async (upload) => {
          if ('error' in upload) {
            return { fileName: upload.fileName, ok: false, message: upload.error }
          }
          const format = upload.formatOverride || detectImportFormat(upload.fileName)
          if (!format) {
            return {
              fileName: upload.fileName,
              ok: false,
              message: `Could not detect an import format from '${upload.fileName}'.`
            }
          }
          try {
            const result = await WIKI.models.pageImport.convertToMarkdown({
              format,
              data: upload.data
            })
            return {
              fileName: upload.fileName,
              ok: true,
              markdown: result.markdown,
              title: result.title,
              description: result.description,
              tags: result.tags
            }
          } catch (err: any) {
            return {
              fileName: upload.fileName,
              ok: false,
              message: err.message || 'This file could not be converted.'
            }
          }
        })
      )

      return {
        ok: true,
        message: `${results.filter((r) => r.ok).length} of ${results.length} file(s) converted successfully.`,
        results
      }
    }
  )

  /**
   * UPDATE PAGE
   */
  app.patch<{
    Params: { siteId: string; pageId: string }
    Body: Partial<PageInput> & {
      /**
       * The page's `updatedAt` as the editor last saw it. Checked against the stored value below —
       * see the optimistic-concurrency comment further down — rather than being passed into
       * `updatePage()`, since it describes the save's precondition rather than a field of the page.
       */
      expectedUpdatedAt?: string
    }
  }>(
    '/sites/:siteId/pages/:pageId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Update a page',
        description:
          'Accepts any subset of the fields. Sending `render` replaces the stored HTML, its table of contents and its search text; sending `content` without it leaves the previous render in place, which is what a source-only edit means.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        body: { $ref: 'PageInput#' },
        response: {
          200: {
            description: 'Page updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: { $ref: 'Page#' },
              classificationConflicts: {
                type: 'array',
                description:
                  "Present only when this save raised the page's own classification and left one or more descendants below the new floor (OpenProject #1080) -- not cascaded automatically. Resolve via POST …/classification-conflicts/resolve.",
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    path: { type: 'string' },
                    title: { type: 'string' },
                    classification: { type: 'string', format: 'uuid' }
                  }
                }
              }
            }
          },
          400: {
            $ref: 'ApiError#',
            description:
              'The page has no server-side renderer for its editor, and this write carried content with no explicit render for it to fall back on.'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            description:
              "The page changed since `expectedUpdatedAt` was read; the write was refused rather than overwriting somebody else's save.",
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: {
                type: 'object',
                description:
                  'The page as it is stored right now, for a diff or an overwrite prompt.',
                properties: {
                  updatedAt: { type: 'string', format: 'date-time' },
                  title: { type: 'string' },
                  content: { type: 'string' },
                  authorName: { type: 'string' }
                }
              }
            }
          },
          503: {
            $ref: 'ApiError#',
            description:
              'This write carried content with no explicit render, and the instance has no Puppeteer extension installed to produce one server-side.'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Saving a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId,
        withContent: true
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to edit this page.')
      }
      /*
        Declassification guardrail (OpenProject #1080): lowering a page's classification (making it
        MORE open) is not covered by `write:pages`/`manage:pages` alone -- it needs `manage:classification`
        ON THIS PAGE too, so an editor who can write the page cannot silently declassify it by editing
        metadata. Raising it needs nothing beyond the ordinary write permission already checked above;
        the floor-invariant/level-exists validation itself happens in `updatePage()`.
      */
      if (
        req.body.classification !== undefined &&
        req.body.classification !== target.classification &&
        WIKI.models.classificationLevels.isLowerThan(
          req.body.classification,
          target.classification
        ) &&
        !mayOnPage(req, 'manage:classification', req.params.siteId, target)
      ) {
        return reply.forbidden(
          'Lowering this page’s classification requires the manage:classification permission on it.'
        )
      }
      /*
        Optimistic concurrency: `expectedUpdatedAt` is the `updatedAt` the editor's save started from.
        A collab-connected editor's next save naturally carries the post-save timestamp its own
        collaborators' saves already advanced it to (`applySave()` in `composables/collab.js`), so this
        never false-positives against them — it only catches a save that began before somebody else's
        landed. Millisecond precision, since that is what the API hands back and what a client round-
        trips; comparing `Temporal.Instant` values directly with `<` throws, so this compares
        `epochMilliseconds` instead.
      */
      /*
        Escape-hatch guarantee (OpenProject #838, upstream requarks/wiki #2256): a 409 here is a
        REFUSAL, not a dead end. The response below always carries the row's current `updatedAt`,
        which is everything a caller needs to make its next request succeed — resubmit the same body
        with that value as `expectedUpdatedAt` and this check passes, because by then it once again
        matches what is stored. There is no state this route can put a page into where a save is
        permanently unsavable; a caller can always either adopt what's on the server or force its own
        content through as the new version. `PageSaveConflictDialog.vue` /
        `EditorMarkdown.vue#resolveSaveConflict` is the frontend consumer of that guarantee ("Save
        Anyway" issues exactly this resubmission); `pages.test.ts` proves the round trip end to end.
      */
      if (
        req.body.expectedUpdatedAt &&
        Temporal.Instant.from(req.body.expectedUpdatedAt).epochMilliseconds !==
          target.updatedAt.toTemporalInstant().epochMilliseconds
      ) {
        return reply.code(409).send({
          ok: false,
          message: 'This page was changed since you started editing it.',
          page: {
            updatedAt: target.updatedAt
              .toTemporalInstant()
              .toString({ smallestUnit: 'millisecond' }),
            title: target.title,
            content: target.content,
            authorName: target.authorName
          }
        })
      }
      let page
      try {
        page = await WIKI.models.pages.updatePage(
          req.params.siteId,
          req.params.pageId,
          req.body,
          actor
        )
      } catch (err: any) {
        const refusal = replyForRenderRefusal(err, reply)
        if (refusal) {
          return refusal
        }
        throw err
      }
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      /*
        Anyone else editing this page right now is looking at the text that was just stored, so their
        editor should stop calling it unsaved. Told through the collaboration room rather than answered
        here, since they are on their own requests — and, quite possibly, on another instance.
      */
      WIKI.collab.pageSaved(page.id, {
        versionDate: page.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' }),
        authorId: actor.id,
        authorName: page.authorName ?? ''
      })
      await recordClassificationChange(
        req,
        req.params.siteId,
        page,
        target.classification,
        page.classification
      )
      /*
        Retroactive parent classification raise (OpenProject #1080): raising THIS page's own
        classification does not cascade to its descendants -- some may now sit below the new floor.
        Rather than silently leaving them there, or silently bumping them, this surfaces the list for
        an admin to resolve explicitly (`ClassificationResolutionDialog.vue`), via
        `POST …/classification-conflicts/resolve`. Only computed when the classification actually got
        stricter -- a lower/unchanged classification can only ever WIDEN what the old floor already
        permitted, so there is nothing new to surface.
      */
      const classificationConflicts =
        req.body.classification !== undefined &&
        req.body.classification !== target.classification &&
        WIKI.models.classificationLevels.isLowerThan(target.classification, req.body.classification)
          ? await WIKI.models.pages.descendantsBelowFloor(
              req.params.siteId,
              page.locale,
              page.path,
              page.classification
            )
          : []
      return {
        ok: true,
        message: 'Page updated successfully.',
        page,
        ...(classificationConflicts.length > 0 ? { classificationConflicts } : {})
      }
    }
  )

  /**
   * RESOLVE CLASSIFICATION CONFLICTS
   *
   * The other half of the retroactive-parent-raise flow above: bumps the named descendants to a
   * classification an admin chose (typically the new parent floor `classificationConflicts` reported,
   * but not required to be — see the dialog's own doc comment for why leaving that open is deliberate).
   *
   * The dialog only ever asks for a raise, but this endpoint takes an arbitrary target level from the
   * request body and only gates it on `write:pages` — a caller is not the dialog, so both guarantees
   * `updatePage`'s own PATCH route enforces have to be checked here too, per page, rather than assumed:
   * the floor invariant against EACH target's own immediate parent (a bulk write does not get to skip
   * the check a single one would have to pass), and the declassification guardrail
   * (`manage:classification`) whenever the chosen level is actually more open than a given target's
   * current one. `bulkSetClassification` itself still does neither -- this is what makes that safe to
   * call afterwards.
   */
  app.post<{
    Params: { siteId: string }
    Body: { pageIds: string[]; classification: string }
  }>(
    '/sites/:siteId/pages/classification-conflicts/resolve',
    {
      // -> No route-level permissions: page-rule permissions, checked per page below.
      schema: {
        summary: 'Bump a set of pages to a classification level',
        description:
          "Resolves the descendants a classification-resolution-dialog conflict listed, by setting each to the chosen level. Every id must belong to this site and the caller must hold write:pages on each; lowering one below its current level also needs manage:classification on it, the same declassification guardrail the PATCH route enforces. The chosen level may never leave a page below its own immediate parent's floor.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['pageIds', 'classification'],
          properties: {
            pageIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              minItems: 1,
              maxItems: 500
            },
            classification: { type: 'string', format: 'uuid' }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, updated: { type: 'integer' } }
          },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Resolving a classification conflict requires a logged in user.')
      }
      if (!WIKI.models.classificationLevels.byId(req.body.classification)) {
        return reply.badRequest('This classification level does not exist.')
      }
      // -> De-duplicate before processing: a repeated id would otherwise be fetched, permission-checked
      //    and audit-logged once per occurrence instead of once per page.
      const pageIds = [...new Set(req.body.pageIds)]
      // -> ONE batched select instead of a per-id `getPage` loop (OpenProject #1902): `getPage`'s
      //    full two-LEFT-JOIN select pulls `content`, `render`, `searchContent` and the tsvector,
      //    none of which `mayOnPage`/`meetsFloor` below need -- `getPagesByIds` projects only the
      //    five columns that do.
      const pageMap = await WIKI.models.pages.getPagesByIds(req.params.siteId, pageIds)
      const missingId = pageIds.find((pageId) => !pageMap.has(pageId))
      if (missingId) {
        return reply.notFound('One of these pages does not exist.')
      }
      // -> Preserves `pageIds`' own (de-duplicated) order exactly the way the original per-id loop
      //    iterated -- the per-page checks below still run one target at a time, in this same order,
      //    and bail on the same first violation. Only the READS moved: what each check evaluates is
      //    unchanged.
      const orderedTargets = pageIds.map((pageId) => pageMap.get(pageId)!)
      // -> ONE batched parent-classification lookup instead of one `parentClassification` call per
      //    target, over the distinct (locale, parent path) pairs among them.
      const floorByTarget = await WIKI.models.pages.parentClassifications(
        req.params.siteId,
        orderedTargets.map((target) => ({ locale: target.locale, path: target.path }))
      )
      const targets: { id: string; path: string; classification: string }[] = []
      for (const target of orderedTargets) {
        if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
          return reply.forbidden('You are not allowed to edit one of these pages.')
        }
        // -> Same declassification guardrail as the PATCH route: bringing a page UP needs nothing
        //    extra, but this endpoint is not restricted to raises the way the dialog that drives it
        //    is -- a caller asking for an actual lowering still needs manage:classification on it.
        if (
          WIKI.models.classificationLevels.isLowerThan(
            req.body.classification,
            target.classification
          ) &&
          !mayOnPage(req, 'manage:classification', req.params.siteId, target)
        ) {
          return reply.forbidden(
            'Lowering this page’s classification requires the manage:classification permission on it.'
          )
        }
        // -> Same floor invariant every other classification write enforces: this bulk write does
        //    not get to leave a page below its own immediate parent's floor just because it arrived
        //    through the resolve flow rather than a single PATCH.
        const floorId = floorByTarget.get(`${target.locale}\0${target.path}`) ?? null
        if (
          floorId &&
          !WIKI.models.classificationLevels.meetsFloor(req.body.classification, floorId)
        ) {
          return reply.badRequest(
            "A page's classification cannot be more open than its parent page's."
          )
        }
        targets.push(target)
      }
      const updated = await WIKI.models.pages.bulkSetClassification(
        req.params.siteId,
        pageIds,
        req.body.classification
      )
      // -> ONE multi-row audit INSERT instead of one `record()` call per target.
      await recordClassificationChanges(
        req,
        req.params.siteId,
        targets.map((target) => ({
          page: target,
          from: target.classification,
          to: req.body.classification
        }))
      )
      return { ok: true, updated }
    }
  )

  /**
   * CLASSIFICATION REPORT (OpenProject #1081)
   *
   * "Everything currently classified as X", instance-wide by default -- the coverage half of the
   * epic's auditability goal, alongside the `page.classificationChanged` events now feeding OpenProject
   * #989's audit log. `manage:system` only: this deliberately bypasses every page rule (it exists to
   * show an administrator what the rules are protecting, not to be gated by them), the same reasoning
   * `api/auditLog.ts` uses for its own listing.
   */
  app.get<{ Querystring: { siteId?: string } }>(
    '/pages/classification-report',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'How many pages currently carry each classification level',
        description:
          'Every configured level is included, even at zero, in level order. Instance-wide unless siteId narrows it to one site.',
        tags: ['Pages'],
        querystring: {
          type: 'object',
          properties: { siteId: { type: 'string', format: 'uuid' } }
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                levelId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                sortOrder: { type: 'integer' },
                count: { type: 'integer' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return WIKI.models.pages.classificationReport(req.query.siteId)
    }
  )

  /**
   * CLASSIFICATION REPORT — DRILL DOWN (OpenProject #1081)
   */
  app.get<{
    Params: { levelId: string }
    Querystring: { siteId?: string; limit?: number; offset?: number }
  }>(
    '/pages/classification-report/:levelId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List every page currently at one classification level',
        description: 'Paginated, newest-updated first. Instance-wide unless siteId narrows it.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: { levelId: { type: 'string', format: 'uuid' } },
          required: ['levelId']
        },
        querystring: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    path: { type: 'string' },
                    locale: { type: 'string' },
                    title: { type: 'string' },
                    siteId: { type: 'string', format: 'uuid' }
                  }
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return WIKI.models.pages.listByClassification(req.params.levelId, {
        siteId: req.query.siteId,
        limit: req.query.limit,
        offset: req.query.offset
      })
    }
  )

  /**
   * MOVE / RENAME PAGE
   */
  app.put<{
    Params: { siteId: string; pageId: string }
    Body: { path: string; title?: string; locale?: string; includeTranslations?: boolean }
  }>(
    '/sites/:siteId/pages/:pageId/path',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Move a page to another path',
        description:
          "Also renames it when a title is given, and re-homes it into another locale of the same site when one is given. The tree entry moves with it, and any folder the new path needs is created. A destination another page already occupies -- including one that wins a race against this same request -- answers `pageDuplicatePath` (409), the same JSON error shape every other page-creation failure uses, not a generic 500; a locale the site does not have enabled answers `pageInvalidLocale` (400).\n\nThe caller needs `manage:pages` on the page as it is now AND `write:pages` on where it is going -- the same destination check `POST .../deleted/:versionId/recover` makes, since arriving somewhere is a write there whether the page came from a fresh create or from moving out of another branch.\n\n`includeTranslations` cascades the path change to every other locale's page sharing this page's current path (its translations -- see docs/decisions/locale-translation-linking.md). All-or-nothing: the caller needs `manage:pages` on each twin's own path AND `write:pages` on the shared destination, and a 409 or 403 on any single translation aborts the whole batch, naming which locale it was.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        body: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$'
            },
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            locale: {
              type: 'string',
              maxLength: 10,
              description: 'Move the page into this locale. Unchanged when absent.'
            },
            includeTranslations: {
              type: 'boolean',
              description:
                "Move every other locale's page sharing this page's current path along with it. Ignored when the path is not actually changing -- a locale-only move has no translations to carry, since they are found by path."
            }
          }
        },
        response: {
          200: {
            description: 'Page moved successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: { $ref: 'Page#' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description: 'A page already exists at the destination path (`pageDuplicatePath`).'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Moving a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'manage:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to move this page.')
      }
      // -> Where it is going is its own question: rules are matched on path AND locale, so being
      //    allowed to manage a page where it sits now says nothing about the destination. Checked
      //    against `write:pages`, not `manage:pages` -- the group editor's own hint for `manage:pages`
      //    promises "other locations the user has WRITE ACCESS to", and `write:pages` is exactly the
      //    permission `POST .../deleted/:versionId/recover` already checks against its own target
      //    path for the same reason: landing a page somewhere is a write there, whatever put it in
      //    motion (OpenProject #937). The ref carries the page's tags because they travel with it, so
      //    a rule that grants by tag applies at the destination exactly as it does at the source; the
      //    path is normalized the way `movePage` will store it, so that a leading slash in the body
      //    cannot make a rule miss.
      const destPath = normalizePagePath(req.body.path)
      const destLocale = req.body.locale ?? target.locale
      if (destPath !== target.path || destLocale !== target.locale) {
        const destRef = { path: destPath, locale: destLocale, tags: target.tags }
        if (!mayOnPage(req, 'write:pages', req.params.siteId, destRef)) {
          return reply.forbidden('You are not allowed to move this page there.')
        }
      }
      // -> `includeTranslations` cascades to every other locale's page sharing this page's CURRENT
      //    path -- checked here, before the model is asked to do anything, because a batch move is
      //    "everyone involved may go" or nothing: a rule that lets this caller manage `en` but not
      //    `fr` must not let them drag the `fr` translation along for the ride just because they may
      //    manage the primary page. Each twin still needs `manage:pages` to be moved away from its OWN
      //    path, same as the primary; the shared destination needs `write:pages`, same reasoning as
      //    above.
      if (req.body.includeTranslations && destPath !== target.path) {
        const translations = await WIKI.models.pages.getTranslations(
          req.params.siteId,
          target.path,
          target.id
        )
        for (const translation of translations) {
          const sourceRef = {
            path: translation.path,
            locale: translation.locale,
            tags: translation.tags
          }
          const destRef = { path: destPath, locale: translation.locale, tags: translation.tags }
          if (
            !mayOnPage(req, 'manage:pages', req.params.siteId, sourceRef) ||
            !mayOnPage(req, 'write:pages', req.params.siteId, destRef)
          ) {
            return reply.forbidden(
              `You are not allowed to move the "${translation.locale}" translation of this page.`
            )
          }
        }
      }
      const page = await WIKI.models.pages.movePage(
        req.params.siteId,
        req.params.pageId,
        req.body,
        actor
      )
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      // -> Only ever fires from the floor-invariant auto-bump (OpenProject #1080): an ordinary move
      //    (or a title/locale-only one) never touches classification, so `from === to` there and
      //    `recordClassificationChange` is a no-op. Covers the primary page only -- `movePage()`
      //    returns just that one, not an `includeTranslations` twin also auto-bumped in the same
      //    call, so a twin's own bump goes unlogged here. Narrow, documented gap rather than
      //    threading the whole batch back out through the model for this alone.
      await recordClassificationChange(
        req,
        req.params.siteId,
        page,
        target.classification,
        page.classification
      )
      return {
        ok: true,
        message: 'Page moved successfully.',
        page
      }
    }
  )

  /**
   * PAGE TRANSLATIONS
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/translations',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `manage:pages` here is
        a page permission granted by a rule. Checked against this page below instead.
      */
      schema: {
        summary: "Get a page's translations",
        description:
          "Other locales' pages sharing this page's path -- the translation link this data model uses (see docs/decisions/locale-translation-linking.md). What the move/rename dialog queries to offer `includeTranslations`, and what that option cascades a path change to.\n\nNeeds `manage:pages` on this page, the same permission moving it needs.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: "This page's translations, one entry per other locale sharing its path",
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                locale: { type: 'string' },
                path: { type: 'string' },
                title: { type: 'string' }
              }
            }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'manage:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to manage this page.')
      }
      const translations = await WIKI.models.pages.getTranslations(
        req.params.siteId,
        target.path,
        target.id
      )
      return translations.map((translation) => ({
        id: translation.id,
        locale: translation.locale,
        path: translation.path,
        title: translation.title
      }))
    }
  )

  /**
   * RE-RENDER PAGE
   */
  app.post<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/render',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      // -> Bounds how fast one client can fill the queue; see `helpers/rateLimit.ts`
      preHandler: limitRenders,
      schema: {
        summary: 'Queue a page to be rendered again from its source',
        description:
          'For when a stored render has gone stale and nobody has the page open to re-save it. The markdown pipeline lives in the frontend, so the server drives it in a headless browser and the result matches what the editor would produce — which means this needs the Puppeteer extension, and answers 503 without it.\n\nAnswers 202: a browser is far too heavy to hold a request open for, so the page joins a queue that is drained one page at a time and its render is replaced when its turn comes. Asking twice for the same page is one render of whatever the content has become by then. Rate limited, to bound how fast the queue can be filled.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          202: {
            description: 'Page queued for rendering',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Rendering a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      // -> Rewrites what the page shows, so it is an edit and takes the same permission as one
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to edit this page.')
      }
      const queued = await WIKI.models.pages.queueRerender(
        req.params.siteId,
        req.params.pageId,
        actor
      )
      if (!queued) {
        return reply.notFound('This page does not exist.')
      }
      return reply.code(202).send({
        ok: true,
        message: 'Page queued for rendering.'
      })
    }
  )

  /**
   * BULK ACTION (OpenProject #1882)
   *
   * The row-selection/bulk-actions half of the admin page inventory: delete, re-render or retag a
   * set of pages in one request. Each id is checked and acted on independently — a page the caller
   * may not act on is reported as `skipped` rather than failing the whole batch, which is the
   * opposite of `POST …/classification-conflicts/resolve` just above (that route `forbidden()`s the
   * entire request on the first denied page). Both are correct for what each one is: the
   * classification-conflicts flow is a single all-or-nothing bump an admin already knows they may
   * make on every listed descendant, while a bulk action here starts from an arbitrary, admin-picked
   * selection that may well mix pages the actor can and cannot act on — the whole point of reporting
   * per-page outcomes instead of refusing outright.
   *
   * Retag is add/remove-RELATIVE per page, not a blanket overwrite: a mixed selection can carry
   * different existing tag sets, so "add x, remove y" is applied against each page's own tags rather
   * than a client-supplied full list clobbering whatever else a page already carried.
   */
  app.post<{
    Params: { siteId: string }
    Body: {
      pageIds: string[]
      action: 'delete' | 'render' | 'retag'
      addTags?: string[]
      removeTags?: string[]
    }
  }>(
    '/sites/:siteId/pages/bulk',
    {
      // -> No route-level `permissions`: page-rule permissions, checked per page below.
      // -> Only the `render` action drives Puppeteer; the same throttle the single-page render route
      //    uses, since a bulk request can still queue many browser renders from one call.
      preHandler: async (req, reply) => {
        if ((req.body as { action?: string } | undefined)?.action === 'render') {
          await limitRenders(req, reply)
        }
      },
      schema: {
        summary: 'Delete, re-render or retag a set of pages',
        description:
          "For the admin page inventory's row selection. Every id is looked up and permission-checked on its own — `delete:pages` for `delete`, `write:pages` for `render`/`retag` — so a page the caller may not act on is reported back as `skipped` rather than refusing the whole request. An id that does not exist on this site comes back `notFound`; an action that threw while running (e.g. re-rendering a page this instance cannot render) comes back `error` with its message. `retag` needs at least one of `addTags`/`removeTags`, applied against each page's own existing tags rather than replacing them outright.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['pageIds', 'action'],
          properties: {
            pageIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              minItems: 1,
              maxItems: 500
            },
            action: {
              type: 'string',
              enum: ['delete', 'render', 'retag']
            },
            addTags: {
              type: 'array',
              items: { type: 'string', maxLength: 255 },
              maxItems: 100,
              description: '`retag` only: tags to add to every page that is not skipped.'
            },
            removeTags: {
              type: 'array',
              items: { type: 'string', maxLength: 255 },
              maxItems: 100,
              description: '`retag` only: tags to remove from every page that is not skipped.'
            }
          }
        },
        response: {
          200: {
            description: 'Every id, with what happened to it',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              action: { type: 'string' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    path: { type: ['string', 'null'] },
                    status: {
                      type: 'string',
                      enum: ['done', 'skipped', 'notFound', 'error']
                    },
                    message: { type: 'string' }
                  }
                }
              },
              counts: {
                type: 'object',
                description: 'How many ids landed in each `status`, keyed the same way.',
                additionalProperties: { type: 'integer' }
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('A bulk page action requires a logged in user.')
      }
      const { action } = req.body
      const addTags = (req.body.addTags ?? []).map((t) => t.trim()).filter(Boolean)
      const removeTags = (req.body.removeTags ?? []).map((t) => t.trim()).filter(Boolean)
      if (action === 'retag' && addTags.length < 1 && removeTags.length < 1) {
        return reply.badRequest('Provide at least one tag to add or remove.')
      }
      // -> De-duplicated, same reasoning as the classification-conflicts-resolve route just above: a
      //    repeated id would otherwise be looked up, permission-checked and acted on once per
      //    occurrence instead of once per page.
      const pageIds = [...new Set(req.body.pageIds)]
      // -> ONE batched select instead of a per-id `getPage` loop -- the same `getPagesByIds` the
      //    classification-conflicts-resolve route already uses, projecting only what `mayOnPage`
      //    (and, for `retag`, the page's own current tags) actually needs.
      const pageMap = await WIKI.models.pages.getPagesByIds(req.params.siteId, pageIds)
      const permission = action === 'delete' ? 'delete:pages' : 'write:pages'
      const results: {
        id: string
        path: string | null
        status: 'done' | 'skipped' | 'notFound' | 'error'
        message?: string
      }[] = []
      for (const pageId of pageIds) {
        const target = pageMap.get(pageId)
        if (!target) {
          results.push({ id: pageId, path: null, status: 'notFound' })
          continue
        }
        if (!mayOnPage(req, permission, req.params.siteId, target)) {
          results.push({
            id: pageId,
            path: target.path,
            status: 'skipped',
            message: 'Not permitted.'
          })
          continue
        }
        try {
          if (action === 'delete') {
            const deleted = await WIKI.models.pages.deletePage(req.params.siteId, pageId, actor)
            results.push({
              id: pageId,
              path: target.path,
              status: deleted ? 'done' : 'notFound'
            })
          } else if (action === 'render') {
            const queued = await WIKI.models.pages.queueRerender(req.params.siteId, pageId, actor)
            results.push({
              id: pageId,
              path: target.path,
              status: queued ? 'done' : 'notFound'
            })
          } else {
            const removeSet = new Set(removeTags)
            const nextTags = [
              ...new Set([...target.tags.filter((t) => !removeSet.has(t)), ...addTags])
            ]
            const updated = await WIKI.models.pages.updatePage(
              req.params.siteId,
              pageId,
              { tags: nextTags },
              actor
            )
            results.push({
              id: pageId,
              path: target.path,
              status: updated ? 'done' : 'notFound'
            })
          }
        } catch (err: any) {
          results.push({ id: pageId, path: target.path, status: 'error', message: err.message })
        }
      }
      const counts: Record<string, number> = {}
      for (const result of results) {
        counts[result.status] = (counts[result.status] ?? 0) + 1
      }
      return { ok: true, action, results, counts }
    }
  )

  /**
   * EXPORT PAGE AS PDF
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/export/pdf',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead, the same
        `read:pages` the page view itself needs — exporting shows nothing a reader could not already
        see.
      */
      // -> Same cost as re-rendering a page — a headless browser per request — so it shares that
      //    route's throttle; see `helpers/rateLimit.ts`
      preHandler: limitRenders,
      schema: {
        summary: 'Export a page as PDF',
        description:
          "Drives Puppeteer against this instance's own live page view — not the stored render — so the PDF matches what a reader sees: theme, layout and block components (Mermaid diagrams, PlantUML, …) included, once their own async drawing has settled. Needs the Puppeteer extension, and answers 503 without it.\n\nNeeds `read:pages` ON THIS PAGE, on the same terms as reading it: a password-protected page answers only once the session has satisfied `POST …/unlock`. Requires a logged in user (session or personal access token) on top of that, the same rule the page re-render route above and `POST /diagrams/render` already apply to every other route that launches a headless browser — an anonymous request never reaches Puppeteer, however readable the page itself is (OpenProject #2258/#2262; see `docs/variances.md`). The export runs as whoever asked for it — nothing more.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: 'The page as a PDF file',
            content: {
              'application/pdf': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Exporting a page as PDF requires a logged in user.')
      }
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply
      }

      const pdf = await WIKI.models.pdfExport.exportPdf({
        hostname: req.hostname,
        port: WIKI.config.port,
        path: page.path,
        // -> The raw, still-signed cookie value exactly as the browser sent it — see the AUTH comment
        //    on `PdfExport.exportPdf` for why forwarding it is safe and sufficient
        sessionCookie: req.cookies?.[sessionCookieName()] ?? null
      })

      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(page.path || 'home')}.pdf"`
      )
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Length', pdf.length)
      return reply.type('application/pdf').send(pdf)
    }
  )

  /**
   * DELETE PAGE
   */
  app.delete<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Delete a page',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          204: {
            description: 'Page deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Deleting a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'delete:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to delete this page.')
      }
      if (!(await WIKI.models.pages.deletePage(req.params.siteId, req.params.pageId, actor))) {
        return reply.notFound('This page does not exist.')
      }
      return reply.code(204).send()
    }
  )

  /**
   * PAGE HISTORY
   */
  app.get<{
    Params: { siteId: string; pageId: string }
    Querystring: { limit?: number; cursor?: string }
  }>(
    '/sites/:siteId/pages/:pageId/history',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `read:history` is a
        page permission granted by a rule. Checked against this page below instead.
      */
      schema: {
        summary: "Get a page's version history",
        description:
          "One page of recorded versions of the page, newest first — the first entry of the first page is the page as it stands now.\n\nKeyset-paginated on `versionDate` rather than offset-based, so a deep history stays cheap to page through: pass the previous response's `nextCursor` back as `cursor` to fetch the next page, and stop once `nextCursor` comes back null. Needs `read:history` ON THIS PAGE, granted by a group rule — the permission that says who may see what a page used to contain. Reading the page itself is required on top, so a page the caller could not open answers 404 and a password-protected one answers only once the session has satisfied `POST …/unlock`.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: 50,
              description: 'Versions per page.'
            },
            cursor: {
              type: 'string',
              description:
                "Opaque cursor from a previous response's `nextCursor`, to fetch the next page."
            }
          }
        },
        response: {
          200: { $ref: 'PageHistoryList#' },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'read:history',
        forbiddenMessage: "You are not allowed to read this page's history."
      })
      if (!page) {
        return reply
      }
      return WIKI.models.pageHistory.list(req.params.siteId, req.params.pageId, {
        limit: req.query.limit,
        cursor: req.query.cursor
      })
    }
  )

  /**
   * PAGE HISTORY VERSION
   */
  app.get<{ Params: { siteId: string; pageId: string; versionId: string } }>(
    '/sites/:siteId/pages/:pageId/history/:versionId',
    {
      // -> Checked per page below, for the same reason as the history list above
      schema: {
        summary: 'Get a single version of a page',
        description:
          'One version in full, source included — one side of a comparison. Needs `read:history` and the ability to read the page, on the same terms as the history list.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            pageId: {
              type: 'string',
              format: 'uuid'
            },
            versionId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'pageId', 'versionId']
        },
        response: {
          200: { $ref: 'PageHistoryVersion#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'read:history',
        forbiddenMessage: "You are not allowed to read this page's history."
      })
      if (!page) {
        return reply
      }
      const version = await WIKI.models.pageHistory.getVersion(
        req.params.siteId,
        req.params.pageId,
        req.params.versionId
      )
      if (!version) {
        return reply.notFound('This version does not exist.')
      }
      return version
    }
  )

  /**
   * PAGE BACKLINKS (OpenProject #1914)
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/backlinks',
    {
      /*
        No route-level `permissions`: `read:pages` is a page permission granted by a group's
        RULES. Checked against the target page via `requireReadablePage` (folded into 404 when
        missing or unreadable), and again per candidate row below -- exactly as `api/graph.ts`'s
        edge assembly filters graph nodes.
      */
      schema: {
        summary: 'Pages linking to this page',
        description:
          'Every page on this site whose content links to this one, as extracted from the rendered HTML on save (`models/rendering.ts#extractInternalLinks`, stored in `pages.links`). Needs `read:pages` on the target page to see the list at all; each row in the response also needs `read:pages` ON THAT PAGE -- a linking page the caller may not read is silently dropped rather than counted.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: 'Pages linking to this one, filtered to what the caller may read',
            type: 'array',
            items: { $ref: 'PageBacklink#' }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> `allowLocked`: a backlinks listing reveals no part of this page's body, so a password
      //    still standing between the caller and the text is not a reason to refuse it.
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        allowLocked: true
      })
      if (!page) {
        return reply
      }
      const rows = await WIKI.models.pages.listBacklinks(req.params.siteId, page.path)
      return rows
        .filter((row) => mayOnPage(req, 'read:pages', req.params.siteId, row))
        .map((row) => ({
          id: row.id,
          path: row.path,
          locale: row.locale,
          title: row.title,
          icon: row.icon
        }))
    }
  )

  /**
   * EXPORT PAGE AS MARKDOWN OR HTML
   */
  app.get<{
    Params: { siteId: string; pageId: string }
    Querystring: { format: 'markdown' | 'html' }
  }>(
    '/sites/:siteId/pages/:pageId/export',
    {
      /*
        No route-level `permissions`: `read:pages` is a page permission granted by a group's RULES,
        checked against this page below (through `requireReadablePage`). `format=markdown` sends back the
        raw stored `content` — the same thing `withContent=true` on the GET route above returns — so it
        needs `read:source` ON TOP of `read:pages`, checked the same way. `format=html` sends back the
        already-rendered, already-sanitized `render` a reader sees anyway, so it needs only `read:pages`,
        exactly matching the PDF export above.
      */
      schema: {
        summary: 'Export a page as Markdown or HTML',
        description:
          'The page as a file download rather than JSON, so a plain link to this URL is all a client needs — no client-side Blob assembly.\n\n`format=markdown` is the raw stored source and needs `read:source` on top of `read:pages`. `format=html` is the stored `render` HTML and needs only `read:pages`, on the same terms as the PDF export. Either way a password-protected page answers 403 until the session has satisfied `POST …/unlock`.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        querystring: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['markdown', 'html'],
              description: 'Which representation of the page to download.'
            }
          },
          required: ['format']
        },
        response: {
          200: {
            description: 'The page content in the requested format',
            content: {
              'text/markdown': { schema: { type: 'string' } },
              'text/html': { schema: { type: 'string' } }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const wantsMarkdown = req.query.format === 'markdown'
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        withContent: wantsMarkdown,
        // -> A separate permission from `read:pages`, exactly as it is on the GET route above --
        //    and only for `format=markdown`, which is the format that hands back the raw source
        permission: wantsMarkdown ? 'read:source' : undefined,
        forbiddenMessage: "You are not allowed to read this page's source."
      })
      if (!page) {
        return reply
      }
      const stem = exportFilenameStem(page.path)
      if (wantsMarkdown) {
        reply.header('Content-Disposition', `attachment; filename="${stem}.md"`)
        return reply.type('text/markdown; charset=utf-8').send(page.content ?? '')
      }
      reply.header('Content-Disposition', `attachment; filename="${stem}.html"`)
      return reply.type('text/html; charset=utf-8').send(page.render ?? '')
    }
  )

  /**
   * DELETED PAGES (RECOVERABLE)
   */
  app.get<{ Params: { siteId: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/sites/:siteId/pages/deleted',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `read:history` is a
        page permission granted by a rule. Checked per row below instead, against the path, locale,
        tags and classification each deletion happened at — a caller sees only the deletions they
        could have read the history of; the rest are left out rather than answered as a whole-list
        403. `author.email` is never populated on these rows: `read:history` here is granted per row
        by whatever the caller could read, not `read:users`/`manage:users`, so it must not double as
        a way to learn another user's address.
      */
      schema: {
        summary: 'List recoverable deletions',
        description:
          'One row per deleted path still recoverable: the most recent `deleted` version at a path with no live page there now. A path that was recovered, or reused by an unrelated new page, drops off this list on its own — there is no flag to set or clear.\n\nEach row needs `read:history` at the path and locale it was deleted from, using the tags and classification the deleted version itself carried — so a TAG/TAGALL/CLASSIFICATION-scoped rule narrows this listing the same way it would a live page — granted by a group rule. Rows the caller may not read are dropped from `items` after each page is fetched, which can make `items` shorter than `limit` even mid-list; only `nextCursor` says whether more remain, so keep paging while it is non-null regardless of how many rows came back on any one page.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: 50,
              description: 'Rows to scan per page, before the per-row permission filter is applied.'
            },
            cursor: {
              type: 'string',
              description: 'Opaque `nextCursor` from a previous page. Omit for the first page.'
            }
          }
        },
        response: {
          200: { $ref: 'PageHistoryRecoverablePage#' }
        }
      }
    },
    async (req) => {
      const { items, nextCursor } = await WIKI.models.pageHistory.listRecoverable(
        req.params.siteId,
        {
          limit: req.query.limit,
          cursor: req.query.cursor
        }
      )
      // -> Built once per request rather than once per row -- `mayOnPage()` rebuilds it internally
      //    on every call. See `graph.ts`'s graph route and `tree.ts`'s `visibleTreeItems()` for the
      //    same shape.
      const actor = WIKI.models.groups.actorForRequest(req)
      return {
        items: items.filter((row) =>
          WIKI.models.groups.checkAccess(actor, 'read:history', {
            path: row.path,
            locale: row.locale,
            tags: row.tags,
            classification: row.classification,
            siteId: req.params.siteId
          })
        ),
        nextCursor
      }
    }
  )

  /**
   * RECOVER DELETED PAGE
   */
  app.post<{
    Params: { siteId: string; versionId: string }
    Body: { path?: string; locale?: string }
  }>(
    '/sites/:siteId/pages/deleted/:versionId/recover',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `write:pages`/
        `read:pages`/`read:source` are page permissions granted by a rule. Checked in the handler
        against TWO refs: the SOURCE path/locale the version was deleted from (must be readable, since
        `recoverDeletedPage` rebuilds title, content, tags, relations and scripts from it) and the
        TARGET path/locale — the override when given, otherwise the same source path/locale — which
        must be writable.
      */
      schema: {
        summary: 'Recover a deleted page',
        description:
          'Recreates the page from one specific deleted version, found by its history id rather than "the latest deletion at this path" — so a caller acting on a `GET …/pages/deleted` row recovers exactly the version it showed.\n\nRequires `read:pages` and `read:source` at the path the version was deleted from — the version is rebuilding title, content, tags, relations and scripts, so recovering it must not hand those back to someone who could not have read them there — and `write:pages` at the target path (the override below, or the same deleted path when none is given).\n\n`path` and/or `locale` in the body steer the recreated page around a conflict the plain restore would hit: a path a newer page has since taken answers `pageDuplicatePath` (409), and a locale the site no longer serves answers `pageInvalidLocale` (400) — both as the same JSON error shape every other page-creation failure uses, not a generic 500.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            versionId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'versionId']
        },
        body: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$',
              description: 'Recreate at this path instead of the one the page was deleted from.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: 'Recreate in this locale instead of the one the page was deleted from.'
            }
          }
        },
        response: {
          200: { $ref: 'PageHistoryRecoverResponse#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Recovering a page requires a logged in user.')
      }
      const version = await WIKI.models.pageHistory.getDeletedVersion(
        req.params.siteId,
        req.params.versionId
      )
      if (!version) {
        return reply.notFound('No deleted version exists with this id.')
      }
      // -> OpenProject #2168: a source-side check, ahead of the destination one below. Holding
      //    `write:pages` on where the page is going back to says nothing about being allowed to read
      //    what it actually contained -- without this, a caller who was denied `read:pages`/
      //    `read:source` at the path it was deleted from could still recover it into anywhere they
      //    hold `write:pages`, reading and republishing source they were never allowed to read.
      //    Checked against the version's OWN tags/classification, not the target's: what is being
      //    read here is the deleted content itself, at the path/locale it actually lived at.
      const source = {
        path: version.path,
        locale: version.locale,
        tags: version.tags,
        classification: version.classification
      }
      if (
        !mayOnPage(req, 'read:pages', req.params.siteId, source) ||
        !mayOnPage(req, 'read:source', req.params.siteId, source)
      ) {
        return reply.forbidden(
          'You are not allowed to read the page this version was deleted from.'
        )
      }
      const overrides = req.body ?? {}
      const target = {
        path: overrides.path ?? version.path,
        locale: overrides.locale ?? version.locale
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to recover a page here.')
      }
      const page = await WIKI.models.pageHistory.recoverDeletedPage(
        req.params.siteId,
        req.params.versionId,
        actor,
        overrides
      )
      return {
        ok: true,
        message: 'Page recovered successfully.',
        page
      }
    }
  )

  /**
   * RESOLVE ALIAS
   */
  app.get<{ Params: { siteId: string; alias: string } }>(
    '/sites/:siteId/pages/alias/:alias',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Resolve a page alias to its path',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            alias: {
              type: 'string',
              maxLength: 255,
              pattern: '^[a-zA-Z0-9-_]+$'
            }
          },
          required: ['siteId', 'alias']
        },
        response: {
          200: {
            description: 'The page the alias points at',
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              path: { type: 'string' },
              locale: { type: 'string' }
            }
          },
          404: {
            $ref: 'ApiError#',
            description: 'No page uses this alias, or the requester may not read it.'
          }
        }
      }
    },
    async (req, reply) => {
      const target = await WIKI.models.pages.getPathFromAlias(req.params.siteId, req.params.alias)
      if (!target) {
        return reply.notFound('No page uses this alias.')
      }
      // -> Resolving an alias tells the caller a page exists and where it is, which is only theirs
      //    to know if they may read it. Locale and tags come along too, so a locale- or tag-scoped
      //    rule is evaluated here exactly as it would be for the same page reached by its own path.
      if (
        !mayOnPage(req, 'read:pages', req.params.siteId, {
          path: target.path,
          locale: target.locale,
          tags: target.tags
        })
      ) {
        return reply.notFound('No page uses this alias.')
      }
      return target
    }
  )

  /**
   * PAGE USER PERMISSIONS
   */
  app.post<{ Params: { siteId: string }; Body: { path: string; locale?: string } }>(
    '/sites/:siteId/pages/userPermissions',
    {
      schema: {
        summary: 'Get page user permissions',
        description:
          "Which page permissions the caller holds AT THIS PATH, as their groups' rules decide. This is what the interface hides its controls by, so it answers the same question the endpoints themselves do rather than a broader one.\n\nAn administrator holds all of them. Everybody else gets whatever their rules grant, which for a path nobody wrote a rule for is nothing at all.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            locale: {
              type: 'string',
              maxLength: 10
            }
          },
          examples: [
            {
              path: 'foo/bar',
              locale: 'en'
            }
          ]
        },
        response: {
          200: {
            description: 'Permissions the current user holds for this page',
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    },
    async (req) => {
      // -> Rules now fail closed on locale (`RulePageRef` requires it), so which locale this asks
      //    about actually decides the answer -- the site's primary locale is the default for a
      //    caller who doesn't say, not a stand-in for a param that doesn't exist.
      return pagePermissionsFor(req, req.params.siteId, {
        path: req.body.path.replace(/^\/+/, ''),
        locale: req.body.locale ?? defaultLocale(req.params.siteId)
      })
    }
  )
}

export default routes
