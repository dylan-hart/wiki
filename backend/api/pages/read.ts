import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SEARCH_ORDER_BY, type SearchOrderBy, type SearchResult } from '../../models/search.ts'
import { generatePathHash, isValidUuid, normalizePagePath } from '../../helpers/common.ts'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { limitAuthAttempts } from '../../helpers/rateLimit.ts'
import {
  computeTranslationStatus,
  computeTranslationStatuses,
  type TranslationRow
} from '../../helpers/translationStatus.ts'
import {
  actorFrom,
  mayBypassPassword,
  mayOnPage,
  pagePermissionsFor,
  requireReadablePage,
  splitList,
  unlockedFor
} from '../../helpers/pageAccess.ts'

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
 * Fills in each result's `localeStatus` (OpenProject #2476) -- the admin pages view's per-locale
 * staleness/missing column -- in place, mutating `results` rather than returning a new array, since
 * the caller already holds the exact array the response schema is about to serialize.
 *
 * One batched `getTranslationRows` call over every distinct path on this page of results, not one
 * query per row: `results` is already capped at `limit` (at most 100), so the join stays a single,
 * small `IN (...)` read regardless of how many locales end up represented.
 */
async function attachLocaleStatus(siteId: string, results: SearchResult[]): Promise<void> {
  if (results.length < 1) {
    return
  }
  const paths = [...new Set(results.map((r) => r.path))]
  const rows = await WIKI.models.pages.getTranslationRows(siteId, paths)
  const rowsByPath = new Map<string, TranslationRow[]>()
  for (const row of rows) {
    const list = rowsByPath.get(row.path) ?? []
    list.push({ locale: row.locale, updatedAt: row.updatedAt })
    rowsByPath.set(row.path, list)
  }
  const activeLocales: string[] = WIKI.sites[siteId]?.config?.locales?.active ?? [
    defaultLocale(siteId)
  ]
  const statuses = computeTranslationStatuses(rowsByPath, activeLocales, defaultLocale(siteId))
  for (const result of results) {
    result.localeStatus = statuses.get(result.path) ?? []
  }
}

/**
 * Read-side page routes: finding a page, opening one, unlocking a protected one, and the small
 * lookups a page view makes around it -- its translations, what links to it, the alias it answers to,
 * and what the reader themselves may do here.
 */
async function routes(app: FastifyInstance) {
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
      includeLocaleStatus?: boolean
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
            },
            includeLocaleStatus: {
              type: 'boolean',
              default: false,
              description:
                "Attach each result's `localeStatus`: whether every one of the site's active locales is missing, stale, current, or the primary translation for that path — the admin pages view's per-locale column. Off by default: it costs one extra batched query over this page of results, so a caller that does not render it should not opt in."
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
                    },
                    localeStatus: {
                      type: 'array',
                      description:
                        "Present only when `includeLocaleStatus=true` was requested. One entry per the site's active locales, primary locale first.",
                      items: {
                        type: 'object',
                        properties: {
                          locale: { type: 'string' },
                          state: {
                            type: 'string',
                            enum: ['primary', 'current', 'stale', 'missing']
                          },
                          updatedAt: { type: ['string', 'null'], format: 'date-time' }
                        }
                      }
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
      const result = await WIKI.models.search.query({
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
      if (req.query.includeLocaleStatus) {
        await attachLocaleStatus(req.params.siteId, result.results)
      }
      return result
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
          "Addressed either by ID or by the hash of its path, which is how a page view asks for one. A hash only identifies a page within a locale, so `locale` picks between translations — the site's primary one when absent.\n\nReadable without a session, because a wiki is read by people who are not logged in — but an anonymous request only ever sees published pages, and never their source. Access is enforced per page against the requester's group rules (`mayOnPage()`), not against a group-wide permission list, so who may read a given page can differ path by path. `withContent` needs `read:source` ON THIS PAGE on top of `read:pages`, granted by a group rule.\n\nA password-protected page answers with its metadata and `isLocked: true`, its body withheld, until the session satisfies `POST …/unlock` — or unless the requester holds `write:pages` or `manage:pages` ON THIS PAGE, for whom the password is not a barrier.\n\n`revision` — where the page stands in its own history — needs `read:history` ON THIS PAGE, and is absent entirely without it.",
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
      /*
        `rev N · M changes` for the metadata rail's Revision section (OpenProject #2651), carried back
        with the page rather than fetched separately -- the history route is keyset-paginated over
        whole versions, which is the wrong shape for "just where the newest one stands", and the rail
        must not cost the page view a second round trip.

        History data, so it is gated on `read:history` ON THIS PAGE, checked with `mayOnPage` like
        every other permission here: `read:history` is a page rule permission, and a route-level
        `config.permissions` reads the group-wide list only, so declaring it there would refuse
        everybody. A reader without it gets no `revision` key at all (not a zeroed one), and pays for
        no query either.
      */
      const [approvalState, isWatching, commentsCount, revision] = await Promise.all([
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
        WIKI.models.comments.countForPage(page.id),
        mayOnPage(req, 'read:history', req.params.siteId, page)
          ? WIKI.models.pageHistory.revisionSummary(page.id)
          : null
      ])
      /*
        Who else already has this page open, on this instance — a cheap "someone else has this open"
        hint for before a collab session starts, drawn straight from whatever room `core/collab.ts`
        already has for the page. No query: it is in memory or it is nothing. Left at zero on a site
        without the feature, since a room can never exist there and the number would be misleading if
        the feature were re-enabled and disabled again while a stale one lingered.
      */
      const collabEnabled = Boolean(
        WIKI.sites[req.params.siteId]?.config?.features?.collaborativeEditing
      )
      const activeEditors = collabEnabled
        ? WIKI.collab.participantInfo(page.id)
        : { count: 0, names: [] }
      /*
        A recovery draft (OpenProject #2455) is nothing but a collaboration room's own leftover
        content, so it can only exist -- and only matters -- to whoever could have written the room in
        the first place: `write:pages` on this page, the same permission the collaboration websocket
        itself checks. Skipped for anyone else, the same way `activeEditors` above is skipped when the
        feature is off, so this never runs an extra query for a plain reader.
      */
      const draft =
        collabEnabled && mayOnPage(req, 'write:pages', req.params.siteId, page)
          ? ((await WIKI.models.pageDrafts.summary(page.id)) ?? null)
          : null
      return {
        ...page,
        commentsCount,
        // -> Spread, not `revision: revision ?? null`: absence is the answer for a reader without
        //    `read:history`, and a null here would serialize as `{ ordinal: 0 }` against the schema
        ...(revision ? { revision } : {}),
        viewer: {
          permissions: pagePermissionsFor(req, req.params.siteId, page),
          ...approvalState,
          isWatching,
          activeEditors,
          draft
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
      // -> A password endpoint like the ones in `api/auth/site.ts`, and limited with them
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
   * PAGE TRANSLATION STATUS (OpenProject #2475)
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/translationStatus',
    {
      /*
        No route-level `permissions`: `read:pages` is a page permission granted by a group's
        RULES. Checked against the target page via `requireReadablePage` (folded into 404 when
        missing or unreadable), and again per candidate translation row below -- same pattern as
        the backlinks route just above.
      */
      schema: {
        summary: "Get a page's per-locale translation staleness/missing status",
        description:
          "For every locale the site has active, whether a translation exists at this page's path and whether it predates the primary-locale page there (`translation.updatedAt < primary.updatedAt` on the shared `(siteId, path)` join -- see docs/decisions/locale-translation-linking.md). What `LocaleSelectorMenu.vue` reads to badge a stale or missing translation before the reader switches to it.\n\nReadable without a session, same as reading the page itself -- but each candidate translation row is dropped unless the caller may `read:pages` on it, and unpublished/scheduled translations are invisible to an anonymous caller entirely, so this never reveals a translation the caller could not otherwise discover by trying to read it directly.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: 'One entry per active locale on this site',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                locale: { type: 'string' },
                exists: {
                  type: 'boolean',
                  description:
                    'Whether a page exists in this locale at this path, as far as the caller may see.'
                },
                stale: {
                  type: 'boolean',
                  description:
                    "Whether the existing translation's `updatedAt` predates the primary-locale page's own. Always `false` for the primary locale itself, or when `exists` is `false`, or when the primary-locale page is not visible to the caller at all."
                }
              }
            }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> A staleness badge reveals no part of this page's body, so a password still standing
      //    between the caller and the text is not a reason to refuse it -- same reasoning as
      //    backlinks' own `allowLocked: true`.
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        allowLocked: true
      })
      if (!page) {
        return reply
      }
      const actor = actorFrom(req)
      const rows = await WIKI.models.pages.listTranslationStatusRows(req.params.siteId, page.path)
      // -> Same two-step narrowing as `api/graph.ts`'s node listing: publication-state exclusion
      //    for an anonymous caller first (a draft/scheduled translation must never reach one),
      //    then `read:pages` per candidate row.
      const visibleRows = (
        actor ? rows : rows.filter((row) => row.publishState === 'published')
      ).filter((row) => mayOnPage(req, 'read:pages', req.params.siteId, row))
      const activeLocales: string[] = WIKI.sites[req.params.siteId]?.config?.locales?.active ?? [
        defaultLocale(req.params.siteId)
      ]
      return computeTranslationStatus(
        activeLocales,
        defaultLocale(req.params.siteId),
        visibleRows.map((row) => ({ locale: row.locale, updatedAt: row.updatedAt }))
      )
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
