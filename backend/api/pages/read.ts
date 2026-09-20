import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  SEARCH_ORDER_BY,
  TAGS_MATCH,
  type SearchFilters,
  type TagsMatch,
  type SearchOrderBy,
  type SearchResult
} from '../../models/search.ts'
import {
  CustomError,
  generatePathHash,
  isValidUuid,
  normalizePagePath
} from '../../helpers/common.ts'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { limitAuthAttempts } from '../../helpers/rateLimit.ts'
import { semanticSearchEnabledFor } from '../../helpers/semanticSearch.ts'
import {
  computeTranslationStatus,
  computeTranslationStatuses,
  type TranslationRow
} from '../../helpers/translationStatus.ts'
import {
  actorFrom,
  mayBypassPassword,
  mayOnPage,
  mayReadSource,
  pagePermissionsFor,
  requireReadablePage,
  splitList,
  unlockedFor
} from '../../helpers/pageAccess.ts'

/**
 * Never awaited: `models/pageviews.ts#record()` swallows its own failures.
 *
 * A `browser` visitor is keyed by session id, which only outlives the request if something writes
 * to the session (`saveUninitialized: false`) -- hence `pageViewed`; without it every anonymous
 * view looks like a new visitor. The write is gated on `pageviews.isEnabled`, since with tracking
 * off it would mint a cookie and a `sessions` row per anonymous read for nothing.
 */
function recordPageview(req: FastifyRequest, siteId: string, pageId: string): void {
  if (req.apiKey) {
    void CARDINAL.models.pageviews.record({
      siteId,
      pageId,
      clientType: 'api',
      visitorRawId: req.apiKey.id
    })
    return
  }
  if (req.session && CARDINAL.config.pageviews?.isEnabled === true) {
    req.session.pageViewed = true
    void CARDINAL.models.pageviews.record({
      siteId,
      pageId,
      clientType: 'browser',
      visitorRawId: req.session.sessionId
    })
  }
}

/**
 * Asked of `mayHoldPermissionSomewhere()`, not of one page's rule: search spans many pages, so it
 * is deliberately coarser than `mayBypassPassword()` — it hides every protected excerpt from a
 * searcher or none of them.
 */
const PAGE_PASSWORD_BYPASS_ROLES = ['write:pages', 'manage:pages']

/** Mutates `results` in place, with one batched query for the whole page of results. */
async function attachLocaleStatus(siteId: string, results: SearchResult[]): Promise<void> {
  if (results.length < 1) {
    return
  }
  const paths = [...new Set(results.map((r) => r.path))]
  const rows = await CARDINAL.models.pages.getTranslationRows(siteId, paths)
  const rowsByPath = new Map<string, TranslationRow[]>()
  for (const row of rows) {
    const list = rowsByPath.get(row.path) ?? []
    list.push({ locale: row.locale, updatedAt: row.updatedAt })
    rowsByPath.set(row.path, list)
  }
  const activeLocales: string[] = CARDINAL.sites[siteId]?.config?.locales?.active ?? [
    defaultLocale(siteId)
  ]
  const statuses = computeTranslationStatuses(rowsByPath, activeLocales, defaultLocale(siteId))
  for (const result of results) {
    result.localeStatus = statuses.get(result.path) ?? []
  }
}

const stringList = (description: string) => ({
  type: 'array',
  items: { type: 'string', maxLength: 2048 },
  maxItems: 50,
  description
})

const enumList = (values: string[], description: string) => ({
  type: 'array',
  items: { type: 'string', enum: values },
  maxItems: values.length,
  description
})

const uuidList = (description: string) => ({
  type: 'array',
  items: { type: 'string', format: 'uuid' },
  maxItems: 50,
  description
})

const PUBLISH_STATES = ['draft', 'published', 'scheduled']

/**
 * Both search routes take the same include/exclude filter lists. Each name is repeatable
 * (`?path=a&path=b`); `locales`/`tags` (and their exclusions) also accept a comma-separated value.
 */
function filterQueryProperties(localesDescription: string) {
  return {
    path: stringList('Only pages whose path starts with any of these.'),
    excludePath: stringList('Drop pages whose path starts with any of these.'),
    locales: stringList(localesDescription),
    excludeLocales: stringList('Drop pages in any of these locales (comma-separated allowed).'),
    tags: stringList(
      'Tags a page must carry (comma-separated allowed): all of them, or any one of them per `tagsMatch`.'
    ),
    tagsMatch: {
      type: 'string',
      enum: TAGS_MATCH,
      default: 'all',
      description:
        'Whether a page must carry every tag in `tags` (`all`) or at least one (`any`). Exclusions are always any-of.'
    },
    excludeTags: stringList('Drop pages carrying any of these tags (comma-separated allowed).'),
    editor: stringList('Only pages using any of these editors.'),
    excludeEditor: stringList('Drop pages using any of these editors.'),
    publishState: enumList(PUBLISH_STATES, 'Only pages in any of these publish states.'),
    excludePublishState: enumList(PUBLISH_STATES, 'Drop pages in any of these publish states.'),
    creatorId: uuidList('Only pages first created by any of these users (user IDs).'),
    excludeCreatorId: uuidList('Drop pages first created by any of these users (user IDs).'),
    authorId: uuidList('Only pages last edited by any of these users (user IDs).'),
    excludeAuthorId: uuidList('Drop pages last edited by any of these users (user IDs).')
  }
}

interface FilterQuery {
  path?: string[]
  excludePath?: string[]
  locales?: string[]
  excludeLocales?: string[]
  tags?: string[]
  tagsMatch?: TagsMatch
  excludeTags?: string[]
  editor?: string[]
  excludeEditor?: string[]
  publishState?: string[]
  excludePublishState?: string[]
  creatorId?: string[]
  excludeCreatorId?: string[]
  authorId?: string[]
  excludeAuthorId?: string[]
}

function commaList(values?: string[]): string[] {
  return (values ?? []).flatMap((value) => splitList(value))
}

function searchFiltersFrom(query: FilterQuery): SearchFilters {
  return {
    path: query.path ?? [],
    excludePath: query.excludePath ?? [],
    locales: commaList(query.locales),
    excludeLocales: commaList(query.excludeLocales),
    tags: commaList(query.tags),
    tagsMatch: query.tagsMatch ?? 'all',
    excludeTags: commaList(query.excludeTags),
    editor: query.editor ?? [],
    excludeEditor: query.excludeEditor ?? [],
    publishState: query.publishState ?? [],
    excludePublishState: query.excludePublishState ?? [],
    creatorId: query.creatorId ?? [],
    excludeCreatorId: query.excludeCreatorId ?? [],
    authorId: query.authorId ?? [],
    excludeAuthorId: query.excludeAuthorId ?? []
  }
}

async function routes(app: FastifyInstance) {
  app.get<{
    Params: { siteId: string }
    Querystring: FilterQuery & {
      query?: string
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
            ...filterQueryProperties(
              'Locale codes (comma-separated allowed). Every locale when absent.'
            ),
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
      const accessActor = CARDINAL.models.groups.actorForRequest(req)
      // -> One answer serves both `includeDrafts` and `hideProtectedContent`: each means holding
      //    `write:pages`/`manage:pages` through some rule on this site.
      const maySeeEverything = CARDINAL.models.groups.mayHoldPermissionSomewhere(
        accessActor,
        PAGE_PASSWORD_BYPASS_ROLES,
        req.params.siteId
      )
      const result = await CARDINAL.models.search.query({
        siteId: req.params.siteId,
        query: req.query.query,
        ...searchFiltersFrom(req.query),
        orderBy: req.query.orderBy,
        orderByDirection: req.query.orderByDirection,
        offset: req.query.offset,
        limit: req.query.limit,
        publicOnly: !actor,
        actor: accessActor,
        includeDrafts: maySeeEverything,
        hideProtectedContent: !maySeeEverything
      })
      if (req.query.includeLocaleStatus) {
        await attachLocaleStatus(req.params.siteId, result.results)
      }
      return result
    }
  )

  app.get<{
    Params: { siteId: string }
    Querystring: FilterQuery & {
      query: string
      offset?: number
      limit?: number
    }
  }>(
    '/sites/:siteId/pages/search/semantic',
    /*
      No route-level permissions: visibility is enforced per row by `filterVisible`, inside
      `CARDINAL.models.semanticSearch.search()`.
    */
    {
      schema: {
        summary: 'Semantic search pages',
        description:
          "Multi-hop vector similarity search over the site's page content (Epic #3050): embeds `query`, finds the pages whose stored chunks sit closest to it, then hops one step further from the best of those to surface pages that are topically related without sharing the query's own wording. Each result carries `hop` — `1` for a direct match (including one that was ALSO reached via the second hop, which always keeps its real, unpenalized hop-1 distance), `2` only for a page found solely by following another result's own embedding.\n\nReadable without a session, exactly like `pages/search`: `filterVisible` decides what an anonymous — or any other — caller may see, and a page the caller cannot read never appears, however close its embedding.\n\n`path`/`tags`/`locales`/`editor`/`publishState`/`creatorId`/`authorId` (OpenProject #3328, #3558), and their `exclude*` counterparts, are the same filters and names `pages/search` takes, applied identically at both hops so a filtered-out page cannot reappear via the second hop's expansion. There is no `orderBy`/`orderByDirection` — Sort By is explicitly out of scope for semantic search.\n\nAnswers `503` when semantic search is not available on this site — this instance has no working vector index, or a site administrator has not turned it on — rather than a silent empty result, matching `helpers/puppeteer.ts#assertPuppeteerAvailable`'s convention for a missing optional capability.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              maxLength: 2048,
              description: 'The question or phrase to search for. Embedded once, server-side.'
            },
            ...filterQueryProperties(
              "Locale codes (comma-separated allowed). The site's primary locale when absent."
            ),
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
          200: { $ref: 'SemanticSearchPagesResult#' },
          503: { $ref: 'ApiError#', description: 'Semantic search is not available on this site.' }
        }
      }
    },
    async (req) => {
      const siteId = req.params.siteId
      if (!semanticSearchEnabledFor(siteId)) {
        throw new CustomError(
          'semanticSearchUnavailable',
          'Semantic search is not available on this site.',
          503
        )
      }
      const accessActor = CARDINAL.models.groups.actorForRequest(req)
      const { locales, ...filters } = searchFiltersFrom(req.query)
      return CARDINAL.models.semanticSearch.search(
        req.query.query,
        accessActor,
        siteId,
        locales && locales.length > 0 ? locales : [defaultLocale(siteId)],
        {
          ...filters,
          limit: req.query.limit ?? 25,
          offset: req.query.offset ?? 0
        }
      )
    }
  )

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
      const path = normalizePagePath(req.query.path)
      const page = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        hash: generatePathHash(path || 'home'),
        locale: req.query.locale,
        publicOnly: !actor,
        // -> `isLocked` is all an include needs, so the password is never read back.
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

  app.get<{
    Params: { siteId: string; pageIdOrHash: string }
    Querystring: { withContent?: boolean; locale?: string }
  }>(
    '/sites/:siteId/pages/:pageIdOrHash',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against this page below.
      */
      schema: {
        summary: 'Get a single page',
        description:
          "Addressed either by ID or by the hash of its path, which is how a page view asks for one. A hash only identifies a page within a locale, so `locale` picks between translations — the site's primary one when absent.\n\nReadable without a session, because a wiki is read by people who are not logged in — but an anonymous request only ever sees published pages. Access is enforced per page against the requester's group rules (`mayOnPage()`), not against a group-wide permission list, so who may read a given page — and its source — can differ path by path. `withContent` needs `read:source` ON THIS PAGE on top of `read:pages`, granted by a group rule to the guests group exactly as to any other, so an anonymous caller with that grant sees the source too.\n\nA password-protected page answers with its metadata and `isLocked: true`, its body withheld, until the session satisfies `POST …/unlock` — or unless the requester holds `write:pages` or `manage:pages` ON THIS PAGE, for whom the password is not a barrier.\n\n`revision` — where the page stands in its own history — needs `read:history` ON THIS PAGE, and is absent entirely without it.",
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
      const isId = isValidUuid(req.params.pageIdOrHash)
      const actor = actorFrom(req)
      // -> Not gated on `actor`: `mayReadSource()` below is the sole gate, anonymous or not.
      const wantsContent = Boolean(req.query.withContent)
      const page = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        ...(isId ? { id: req.params.pageIdOrHash } : { hash: req.params.pageIdOrHash }),
        locale: req.query.locale,
        withContent: wantsContent,
        publicOnly: !actor,
        // -> Callbacks: a hash does not say which page it is yet, and both are decided per page.
        unlocked: (page) => unlockedFor(req, req.params.siteId, page),
        withPassword: (page) => mayBypassPassword(req, req.params.siteId, page)
      })
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:pages', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to read this page.')
      }
      if (wantsContent && !mayReadSource(req, req.params.siteId, page)) {
        return reply.forbidden("You are not allowed to read this page's source.")
      }
      recordPageview(req, req.params.siteId, page.id)
      const actorId = actor?.id ?? null
      // -> The reader's standing on this page rides back with it, so a page view is one request.
      const [approvalState, isWatching, commentsCount, revision] = await Promise.all([
        CARDINAL.models.approvals.pageViewerState(req, req.params.siteId, {
          id: page.id,
          path: page.path,
          locale: page.locale,
          tags: page.tags ?? [],
          allowContributions: page.allowContributions,
          classification: page.classification
        }),
        CARDINAL.models.pageWatching.isWatching(page.id, actorId),
        CARDINAL.models.comments.countForPage(page.id),
        mayOnPage(req, 'read:history', req.params.siteId, page)
          ? CARDINAL.models.pageHistory.revisionSummary(page.id)
          : null
      ])
      // -> In-memory and per-instance: read from the page's `core/collab.ts` room, if one exists.
      //    Zero when the feature is off, so a stale room cannot leak a count.
      const collabEnabled = Boolean(
        CARDINAL.sites[req.params.siteId]?.config?.features?.collaborativeEditing
      )
      const activeEditors = collabEnabled
        ? CARDINAL.collab.participantInfo(page.id)
        : { count: 0, names: [] }
      // -> A recovery draft is a collab room's leftover content, so it is only for whoever could
      //    have written to the room: `write:pages`, the permission the collab websocket checks.
      const draft =
        collabEnabled && mayOnPage(req, 'write:pages', req.params.siteId, page)
          ? ((await CARDINAL.models.pageDrafts.summary(page.id)) ?? null)
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

  app.post<{
    Params: { siteId: string; pageIdOrHash: string }
    Querystring: { locale?: string }
    Body: { password: string }
  }>(
    '/sites/:siteId/pages/:pageIdOrHash/unlock',
    {
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
      const page = await CARDINAL.models.pages.unlockPage({
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
        Recorded per page, not as a blanket unlock: each password is a separate secret. This write is
        also what first creates a session for an anonymous reader (`saveUninitialized` is off), which
        is intended — the unlock has to outlive the request.
      */
      req.session.unlockedPages = [...new Set([...(req.session.unlockedPages ?? []), page.id])]
      return page
    }
  )

  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/translations',
    {
      // -> No route-level `permissions`: `manage:pages` is a page permission, checked below.
      schema: {
        summary: "Get a page's translations",
        description:
          "Other locales' pages sharing this page's path -- the translation link this data model uses. What the move/rename dialog queries to offer `includeTranslations`, and what that option cascades a path change to.\n\nNeeds `manage:pages` on this page, the same permission moving it needs.",
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
      const target = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'manage:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to manage this page.')
      }
      const translations = await CARDINAL.models.pages.getTranslations(
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

  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/translationStatus',
    {
      /*
        No route-level `permissions`: `read:pages` is a page permission, checked against the target
        page by `requireReadablePage` and again per translation row below.
      */
      schema: {
        summary: "Get a page's per-locale translation staleness/missing status",
        description:
          "For every locale the site has active, whether a translation exists at this page's path and whether it predates the primary-locale page there (`translation.updatedAt < primary.updatedAt` on the shared `(siteId, path)` join). What `LocaleSelectorMenu.vue` reads to badge a stale or missing translation before the reader switches to it.\n\nReadable without a session, same as reading the page itself -- but each candidate translation row is dropped unless the caller may `read:pages` on it, and unpublished/scheduled translations are invisible to an anonymous caller entirely, so this never reveals a translation the caller could not otherwise discover by trying to read it directly.",
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
      // -> `allowLocked`: a staleness badge reveals none of the page's body.
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        allowLocked: true
      })
      if (!page) {
        return reply
      }
      const actor = actorFrom(req)
      const rows = await CARDINAL.models.pages.listTranslationStatusRows(
        req.params.siteId,
        page.path
      )
      const visibleRows = (
        actor ? rows : rows.filter((row) => row.publishState === 'published')
      ).filter((row) => mayOnPage(req, 'read:pages', req.params.siteId, row))
      const activeLocales: string[] = CARDINAL.sites[req.params.siteId]?.config?.locales
        ?.active ?? [defaultLocale(req.params.siteId)]
      return computeTranslationStatus(
        activeLocales,
        defaultLocale(req.params.siteId),
        visibleRows.map((row) => ({ locale: row.locale, updatedAt: row.updatedAt }))
      )
    }
  )

  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/backlinks',
    {
      /*
        No route-level `permissions`: `read:pages` is a page permission, checked against the target
        page by `requireReadablePage` and again per linking row below.
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
      // -> `allowLocked`: a backlinks listing reveals none of the page's body.
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        allowLocked: true
      })
      if (!page) {
        return reply
      }
      const rows = await CARDINAL.models.pages.listBacklinks(req.params.siteId, page.path)
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

  app.get<{ Params: { siteId: string; alias: string } }>(
    '/sites/:siteId/pages/alias/:alias',
    {
      // -> No route-level `permissions`: `read:pages` is a page permission, checked below.
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
      const target = await CARDINAL.models.pages.getPathFromAlias(
        req.params.siteId,
        req.params.alias
      )
      if (!target) {
        return reply.notFound('No page uses this alias.')
      }
      // -> 404, not 403: an alias reveals that a page exists and where, which is only for whoever
      //    may read it. Locale and tags go along so locale- and tag-scoped rules apply as by path.
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
      const path = req.body.path.replace(/^\/+/, '')
      const locale = req.body.locale ?? defaultLocale(req.params.siteId)
      // -> Tags come from the stored page, never the request: a tag-scoped rule is judged on what
      //    the page carries, not on what a caller claims. A path with no page yet (this doubles as
      //    a create-permission check) has none.
      const page = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        hash: generatePathHash(path || 'home'),
        locale,
        withPassword: false
      })
      return pagePermissionsFor(req, req.params.siteId, {
        path,
        locale,
        tags: page?.tags,
        classification: page?.classification ?? null
      })
    }
  )
}

export default routes
