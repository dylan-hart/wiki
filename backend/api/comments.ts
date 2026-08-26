import { actorFrom, loadReadablePage, mayOnPage } from './pages.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AccessActor } from '../models/groups.ts'
import type { AdminPageRef, Comment, ThreadedComment } from '../models/comments.ts'

/**
 * Comments API Routes
 *
 * Merges two independently-built halves at merge-review time. Feature 391 (`feature/comments-rest-api`)
 * built the page-scoped CRUD below (list/post/edit/delete under `.../pages/:pageId/comments`, with a
 * self-authorship exception on edit/delete). Feature 394 (`feature/admin-comments-management-ui`) built
 * the comment-provider endpoints and a site-wide admin moderation surface.
 *
 * Both branches ALSO independently built a site-wide `GET /sites/:siteId/comments` moderation listing —
 * two different designs for the same route, a genuine duplicate this merge had to pick between rather
 * than keep both:
 *   - Feature 391's version gated on `mayManageCommentsAnywhere` (holds `manage:comments` on AT LEAST
 *     ONE path) and then returned EVERY comment on the site regardless of which page it was on — its own
 *     doc comment flagged this as a known gap ("a caller who only holds it on some paths still sees
 *     every comment on the site").
 *   - Feature 394's version (kept here) evaluates `manage:comments` per PAGE via `accessiblePageIdsForAdmin`
 *     below, so a moderator only ever sees comments on pages they can actually moderate — no such gap,
 *     and it matches the page-rule permission pattern `api/pages.ts`/`api/assets.ts` already use.
 * Feature 391's `mayManageCommentsAnywhere`/`listForSite`-based route was discarded in favor of this one;
 * nothing else depended on it.
 *
 * `WIKI.models.comments`'s `get`/`create`/`update`/`delete`/`listForPage` (Feature 391's page-scoped
 * primitives) don't resolve `authorName`/`authorEmail` on their own — only `listForPage`'s join does.
 * `resolveAuthorName` below fills that gap for the POST/PATCH responses at the route layer rather than
 * widening every model method's query, since it's needed in exactly two places.
 */
const siteIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId']
}

const pageIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    pageId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'pageId']
}

const pageCommentIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    pageId: { type: 'string', format: 'uuid' },
    commentId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'pageId', 'commentId']
}

const commentIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    commentId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'commentId']
}

/**
 * QUERY STRATEGY (Task 625): the accessible-pages set behind the admin moderation listing.
 *
 * `manage:comments` is a page-rule permission (`helpers/pageRules.ts`), not a global one, so this
 * route cannot ask "may this actor moderate comments on this site?" as a single yes/no the way
 * `config.permissions` would — it has to be decided per page, individually, exactly as `api/pages.ts`
 * and `api/assets.ts` already do for their own page-rule permissions (the `No route-level
 * permissions:` pattern this route follows below).
 *
 * The naive version of "per page, individually" is a per-COMMENT check: fetch every comment on the
 * site, then call `checkAccess` once per row before deciding whether to keep it. That is an N+1
 * shaped cost against exactly the table this endpoint is built to page through — the more comments a
 * site has, the slower every single request gets, independent of how many the actor can actually see.
 *
 * This does the opposite: it bounds the permission check by page COUNT, not comment count.
 * `WIKI.models.groups.checkAccess` is a synchronous, in-memory call — `models/groups.ts` keeps every
 * group's rules cached, reloaded on write, so evaluating it repeatedly costs no database round trip at
 * all — so the only DB-bound work is one query for the site's page refs (`comments.pageRefsForSite`,
 * backed by `pages_siteId_locale_path_idx` (siteId is its leading column), narrowed further by a
 * `pathFilter` prefix match pushed into the query itself)
 * plus the `manage:comments` evaluation against each row, all in memory. The result — a `Set` of
 * accessible page ids, typically a small fraction of a site's total comment volume — is what actually
 * reaches `comments.listForAdmin`, which does the real pagination (`LIMIT`/`OFFSET` in SQL) against
 * `comments_siteId_idx (siteId, createdAt)` narrowed by `pageId IN (...)`. No comment row is ever
 * fetched, let alone permission-checked, unless it belongs to a page already known to be accessible.
 *
 * `manage:system` short-circuits entirely, matching `checkAccess` itself: every page is accessible,
 * so the per-page evaluation is skipped rather than trivially answering `true` for each one.
 */
async function accessiblePageIdsForAdmin(
  actor: AccessActor,
  siteId: string,
  pathFilter?: string
): Promise<string[]> {
  const pageRefs: AdminPageRef[] = await WIKI.models.comments.pageRefsForSite(siteId, pathFilter)
  if (actor.permissions.includes('manage:system')) {
    return pageRefs.map((page) => page.id)
  }
  return pageRefs
    .filter((page) => WIKI.models.groups.checkAccess(actor, 'manage:comments', { ...page, siteId }))
    .map((page) => page.id)
}

/**
 * Resolves the display name behind a comment: the account's current name for a logged in author, the
 * stored `guestName` otherwise. Not returned directly by `create`/`update`/`get` (only `listForPage`'s
 * join does this), so the POST/PATCH routes below call this once for their response.
 */
async function resolveAuthorName(comment: {
  authorId: string | null
  guestName: string | null
}): Promise<string> {
  if (comment.authorId) {
    const user = await WIKI.models.users.getById(comment.authorId)
    if (user) {
      return user.name
    }
  }
  return comment.guestName ?? ''
}

/**
 * Queue `comment:new` / `comment:edit` / `comment:delete` webhook deliveries (task 610).
 *
 * The convention elsewhere (`models/pages.ts`'s `page:create` et al., `models/assets.ts`'s
 * `asset:upload` et al.) is to call `WIKI.models.hooks.emit()` from inside the model's write methods.
 * FLAG FOR FOLLOW-UP: this route is presently the only writer of comments, so calling it here is
 * functionally equivalent for now; moving these three `emit()` calls into `models/comments.ts`'s
 * `create`/`update`/`delete` would match that convention exactly, but is left for a dedicated task
 * rather than folded into this merge.
 */
async function emitCommentEvent(
  event: 'comment:new' | 'comment:edit' | 'comment:delete',
  comment: Comment,
  authorName?: string
): Promise<void> {
  const base = {
    id: comment.id,
    pageId: comment.pageId,
    siteId: comment.siteId,
    authorId: comment.authorId,
    isGuest: comment.authorId === null
  }
  await WIKI.models.hooks.emit(
    event,
    comment.siteId,
    event === 'comment:delete'
      ? base
      : {
          ...base,
          metadata: { authorName, replyTo: comment.replyTo },
          content: comment.content
        }
  )
}

/**
 * A comment as the page-view routes hand it back. `authorEmail` is always null here — every reader of
 * a page's comment list may be anonymous, so a commenter's address is never published through it (the
 * one exception, the POST response echoing the poster's own address back, is built inline in that
 * route instead of through this helper).
 */
function toPublicComment(comment: ThreadedComment): Record<string, unknown> {
  return {
    id: comment.id,
    siteId: comment.siteId,
    pageId: comment.pageId,
    authorId: comment.authorId,
    authorName: comment.authorName,
    authorEmail: null,
    replyTo: comment.replyTo,
    content: comment.content,
    render: comment.render,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    replies: comment.replies.map((reply) => toPublicComment(reply))
  }
}

/** Every id in a threaded list, replies included — for validating a `replyTo` against. */
function flattenIds(thread: ThreadedComment[]): Set<string> {
  const ids = new Set<string>()
  const visit = (nodes: ThreadedComment[]) => {
    for (const node of nodes) {
      ids.add(node.id)
      visit(node.replies)
    }
  }
  visit(thread)
  return ids
}

/**
 * Whether this requester may edit or delete `comment`.
 *
 * SELF-AUTHORSHIP POLICY (task 608): 2.5.x's `server/models/comments.js` requires `manage:comments`
 * for every edit and delete, with no exception for the comment's own author — confirmed by reading
 * that file directly. This fork deliberately diverges: a comment's own author
 * (`comment.authorId === actor.id`) may edit or delete it without holding `manage:comments`. Fixing
 * a typo or retracting your own remark is the overwhelmingly common case, and forcing every one of
 * those through a moderator permission that most contributors will never hold is unfriendly friction
 * upstream never actually needed the safety of — moderation is still fully enforced for everyone
 * else's comments, which is the case that matters.
 *
 * `manage:comments` always overrides, regardless of authorship, in both directions: a moderator may
 * act on their own comment or anyone else's. Moderation has to work even when the authorship check
 * would otherwise say no, so it is checked first and short-circuits the rest.
 *
 * GUESTS (authorId null): a guest-authored comment can never be self-edited, under either policy.
 * There is no account behind it to match `actor.id` against — `authorId === actor.id` is false for
 * every actor when `authorId` is null, including, deliberately, the guest who originally posted it:
 * nothing on a later, unauthenticated request can prove they are the same person, so the only way to
 * touch a guest comment is `manage:comments`.
 */
function maySelfModerate(
  req: FastifyRequest,
  siteId: string,
  page: { path: string; locale: string | null; tags?: string[] },
  comment: { authorId: string | null },
  actor: { id: string } | null
): boolean {
  if (mayOnPage(req, 'manage:comments', siteId, page)) {
    return true
  }
  return Boolean(actor && comment.authorId !== null && comment.authorId === actor.id)
}

async function routes(app: FastifyInstance) {
  /**
   * LIST A SITE'S COMMENT PROVIDERS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/comments/providers',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "List a site's comment providers",
        description:
          'One entry per comments module installed in `modules/comments`, whether or not it has ever been enabled — same pattern as `GET /sites/:siteId/storage/targets`. At most one entry has `isEnabled` true: comments have a single active provider per site, not several simultaneous targets.',
        tags: ['Comments'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'List of comment providers',
            type: 'array',
            items: { $ref: 'CommentProvider#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      return WIKI.models.commentProviders.getSiteProviders(req.params.siteId)
    }
  )

  /**
   * SET THE ACTIVE COMMENT PROVIDER
   */
  app.put<{ Params: { siteId: string }; Body: { module: string; config?: Record<string, any> } }>(
    '/sites/:siteId/comments/providers',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "Set a site's active comment provider",
        description:
          'Activates the named module and stores its config values, disabling whichever provider was active before. There is exactly one active provider per site at any time; there is no endpoint to turn comments off short of activating a module and leaving its config at defaults, since "no provider active" is not itself a supported state past initial site creation.',
        tags: ['Comments'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        body: { $ref: 'CommentProviderInput#' },
        response: {
          200: {
            description: 'The provider now active, as stored',
            $ref: 'CommentProvider#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      try {
        const provider = await WIKI.models.commentProviders.setActiveProvider(
          req.params.siteId,
          req.body.module,
          req.body.config ?? {}
        )
        if (!provider) {
          return reply.notFound(`No such comment provider module: ${req.body.module}`)
        }
        return provider
      } catch (err: any) {
        return reply.badRequest(err.message)
      }
    }
  )

  /**
   * LIST COMMENTS ACROSS A SITE FOR MODERATION
   */
  app.get<{
    Params: { siteId: string }
    Querystring: {
      pagePath?: string
      author?: string
      dateFrom?: string
      dateTo?: string
      offset?: number
      limit?: number
    }
  }>(
    '/sites/:siteId/comments',
    {
      /*
        No route-level `permissions`: `manage:comments` is a page-rule permission, granted by a
        group's rules and not the group-wide list that hook checks — same pattern as `api/pages.ts`,
        `api/assets.ts` and `api/watching.ts`. Every comment below is included only after its own
        page individually passes `checkAccess(actor, 'manage:comments', page)` — see
        `accessiblePageIdsForAdmin` above for how that is done without an N+1 per-comment check.
      */
      schema: {
        summary: 'List comments across a site for moderation',
        description:
          'Every comment on every page the requesting actor holds `manage:comments` on, across the whole site — distinct from `GET .../pages/:pageId/comments`, which is scoped to one page and needs only `read:comments`. Nothing here is granted by a single site-wide flag: a comment is included only after the page it lives on individually passes a `manage:comments` check, so two administrators with different rules see different, correctly scoped lists from the same request shape.\n\nPaginated (`offset`/`limit`, `totalHits` ignores both) and filterable by page path (prefix match), author (substring match against the account name or guest name), and a `createdAt` date range.',
        tags: ['Comments'],
        params: siteIdParam,
        querystring: {
          type: 'object',
          properties: {
            pagePath: {
              type: 'string',
              maxLength: 2048,
              description: 'Only comments on pages whose path starts with this.'
            },
            author: {
              type: 'string',
              maxLength: 255,
              description: 'Substring match against the account name or guest name.'
            },
            dateFrom: {
              type: 'string',
              format: 'date-time',
              description: 'Only comments created at or after this instant.'
            },
            dateTo: {
              type: 'string',
              format: 'date-time',
              description: 'Only comments created at or before this instant.'
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
            description: 'Matching comments, plus how many there are in total',
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: { $ref: 'AdminComment#' }
              },
              totalHits: {
                type: 'integer',
                description: 'How many comments match, ignoring `limit` and `offset`.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

      const actor = WIKI.models.groups.actorForRequest(req)
      const pageIds = await accessiblePageIdsForAdmin(actor, req.params.siteId, req.query.pagePath)

      return WIKI.models.comments.listForAdmin({
        siteId: req.params.siteId,
        pageIds,
        author: req.query.author,
        dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom) : undefined,
        dateTo: req.query.dateTo ? new Date(req.query.dateTo) : undefined,
        offset: req.query.offset,
        limit: req.query.limit
      })
    }
  )

  /**
   * DELETE A COMMENT (MODERATION)
   */
  app.delete<{ Params: { siteId: string; commentId: string } }>(
    '/sites/:siteId/comments/:commentId',
    {
      /*
        No route-level `permissions`: same reasoning as the listing above. `manage:comments` is
        checked against this one comment's own page below, individually — never assumed from the
        site-wide listing having been reachable at all.
      */
      schema: {
        summary: 'Delete a comment (moderation)',
        description:
          "Deletes any comment on the site, provided the requesting actor holds `manage:comments` on the page it lives on. Distinct from the page-scoped delete below, which additionally lets a comment's own author remove it without that permission — this endpoint carries no such exception, since it exists purely for moderation.",
        tags: ['Comments'],
        params: commentIdParam,
        response: {
          204: {
            description: 'The comment was deleted',
            type: 'null'
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

      const comment = await WIKI.models.comments.getWithPage(req.params.commentId)
      // -> Existence is checked only after confirming it belongs to this site, so a comment id from a
      //    different site is indistinguishable from one that does not exist at all.
      if (!comment || comment.siteId !== req.params.siteId) {
        return reply.notFound('This comment does not exist.')
      }

      const actor = WIKI.models.groups.actorForRequest(req)
      if (
        !WIKI.models.groups.checkAccess(actor, 'manage:comments', {
          ...comment.page,
          siteId: req.params.siteId
        })
      ) {
        return reply.forbidden('You are not allowed to moderate comments on this page.')
      }

      // -> `getWithPage()` above only selects enough to decide `manage:comments` against, not the
      //    full row `emitCommentEvent` needs (`authorId` in particular) -- fetched fresh right before
      //    delete rather than widening that query, the same two-lookup shape the page-scoped delete
      //    below already uses (`comments.get()` after its own page-level gate).
      const full = await WIKI.models.comments.get(comment.id)
      await WIKI.models.comments.delete(comment.id)
      // -> Previously missing: the page-scoped delete below emits comment:delete, but this
      //    site-wide moderation delete did not -- a webhook subscriber mirroring comments missed
      //    every deletion done from the admin moderation screen (OpenProject #935).
      if (full) {
        await emitCommentEvent('comment:delete', full)
      }
      return reply.code(204).send()
    }
  )

  /**
   * LIST COMMENTS FOR A PAGE
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      /*
        No route-level `permissions`: `read:comments` is a page-rule permission, granted by a
        group's rules and not the group-wide list that hook checks — decided per page below, exactly
        as `watching.ts` does for `read:pages`. Anonymous-safe: the Guests group can hold
        `read:comments`, same as it can hold `read:pages`.
      */
      schema: {
        summary: 'List the comments on a page',
        description:
          "The full threaded comment list for a page, oldest first at every level. `authorEmail` is always null here — this endpoint is read by anonymous visitors as often as logged in ones, so a commenter's address is never published through it.",
        tags: ['Comments'],
        params: pageIdParam,
        response: {
          200: {
            description: 'Comments on this page, threaded',
            type: 'array',
            items: { $ref: 'Comment#' }
          }
        }
      }
    },
    async (req, reply) => {
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:comments', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }
      const thread = await WIKI.models.comments.listForPage(page.id)
      return thread.map((comment) => toPublicComment(comment))
    }
  )

  /**
   * POST A COMMENT
   */
  app.post<{
    Params: { siteId: string; pageId: string }
    Body: {
      content: string
      replyTo?: string | null
      guestName?: string | null
      guestEmail?: string | null
    }
  }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      /*
        No route-level `permissions`: same as the list route, `write:comments` is a page-rule
        permission decided per page below — and, per task 609, THIS route is the anonymous-safe one
        of the two, mirroring 2.5.x's guest commenting. An anonymous actor reaches `mayOnPage` the
        same way an authenticated one does (`WIKI.models.groups.actorForRequest` resolves it to the
        Guests group), so a wiki that grants that group `write:comments` gets guest posting simply by
        the rule existing — nothing here special-cases "no session" as a blanket refusal.
      */
      schema: {
        summary: 'Post a comment on a page',
        description:
          'Creates a top-level comment, or a reply when `replyTo` names an existing comment on the ' +
          'same page.\n\n' +
          '**Authenticated** (a session is present): identity comes from the session only. ' +
          '`guestName`/`guestEmail` in the body are rejected with 400 rather than silently ignored — ' +
          "an authenticated comment cannot claim a different name than the poster's account.\n\n" +
          '**Anonymous** (no session): allowed only when the Guests group (or another rule matching ' +
          'this requester) grants `write:comments` on this page. `guestName` and `guestEmail` are then ' +
          'required in the body — there is no account to draw a name/address from — and the poster’s ' +
          'IP is recorded for abuse tracking. `guestEmail` is validated as an email at the schema level.\n\n' +
          'Refused with 403 when the site has comments turned off (`features.comments`) or this page ' +
          'does (`allowComments`) — both otherwise only hide the form client-side.',
        tags: ['Comments'],
        params: pageIdParam,
        body: { $ref: 'CommentInput#' },
        response: {
          200: {
            description: 'The comment as stored',
            $ref: 'Comment#'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'write:comments', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to comment on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }
      // -> Both flags only ever hid the form client-side (`PageComments.vue` gates its own mount on
      //    `siteStore.features.comments && pageStore.allowComments`) -- neither was checked here, so
      //    a direct POST still stored the comment regardless of either being off (OpenProject #935).
      if (!WIKI.sites[req.params.siteId]?.config?.features?.comments) {
        return reply.forbidden('Comments are disabled for this site.')
      }
      if (!page.allowComments) {
        return reply.forbidden('Comments are disabled for this page.')
      }

      // -> The guest-vs-authenticated split (task 609): an authenticated poster's identity comes
      //    from the session only, so guest fields on the body are rejected outright rather than
      //    silently dropped — a caller sending them almost certainly expected them to take effect. An
      //    anonymous poster has no session to draw an identity from, so the same fields are required
      //    instead.
      if (actor) {
        if (req.body.guestName != null || req.body.guestEmail != null) {
          return reply.badRequest(
            'guestName/guestEmail may not be set on an authenticated request; your account identity is used instead.'
          )
        }
      } else if (!req.body.guestName || !req.body.guestEmail) {
        return reply.badRequest(
          'guestName and guestEmail are required to comment without an account.'
        )
      }

      const replyTo = req.body.replyTo ?? null
      if (replyTo) {
        // -> A `replyTo` naming a comment that doesn't exist, or that exists on a different page,
        //    must be rejected rather than stored: `listForPage` is scoped to THIS page, so a
        //    cross-page id simply won't be found here either way.
        const thread = await WIKI.models.comments.listForPage(page.id)
        if (!flattenIds(thread).has(replyTo)) {
          return reply.badRequest('replyTo does not name a comment on this page.')
        }
      }

      const comment = await WIKI.models.comments.create({
        siteId: req.params.siteId,
        pageId: page.id,
        authorId: actor ? actor.id : null,
        replyTo,
        content: req.body.content,
        // -> Guest fields only ever travel together: an authenticated post has none of them, an
        //    anonymous one has all three (the validation above guarantees guestName/guestEmail are
        //    present by this point). `req.ip` is Fastify's resolved client address (honors
        //    `trustProxy`, same as the rest of this codebase), captured here for abuse tracking —
        //    Akismet/rate-limit policy itself is a comment-provider's job, not this route's.
        guestName: actor ? null : req.body.guestName,
        guestEmail: actor ? null : req.body.guestEmail,
        guestIp: actor ? null : req.ip
      })

      const authorName = await resolveAuthorName(comment)
      await emitCommentEvent('comment:new', comment, authorName)

      // -> The one case `authorEmail` IS shown: the poster being handed their own address back.
      const authorEmail = actor
        ? ((await WIKI.models.users.getById(actor.id))?.email ?? null)
        : comment.guestEmail
      return {
        id: comment.id,
        siteId: comment.siteId,
        pageId: comment.pageId,
        authorId: comment.authorId,
        authorName,
        authorEmail,
        replyTo: comment.replyTo,
        content: comment.content,
        render: comment.render,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        replies: []
      }
    }
  )

  /**
   * UPDATE A COMMENT
   */
  app.patch<{
    Params: { siteId: string; pageId: string; commentId: string }
    Body: { content: string }
  }>(
    '/sites/:siteId/pages/:pageId/comments/:commentId',
    {
      // -> Same as the list route: `read:comments` is checked per page, below. The author/moderator
      //    decision past that point is `maySelfModerate`'s policy, not a route-level permission.
      schema: {
        summary: 'Edit a comment',
        description:
          "Updates a comment's content. Allowed for the comment's own author, or for anyone holding " +
          '`manage:comments` on this page. A guest-authored comment (no account behind it) can only ' +
          'be edited via `manage:comments`.',
        tags: ['Comments'],
        params: pageCommentIdParam,
        body: { $ref: 'CommentInput#' },
        response: {
          200: {
            description: 'The comment as stored, updated',
            $ref: 'Comment#'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:comments', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }

      // -> Existence is checked only after the page-level read gate above, so a comment's presence
      //    is never revealed to a requester who could not even see the page's comments at all.
      const comment = await WIKI.models.comments.get(req.params.commentId)
      if (!comment || comment.pageId !== page.id) {
        return reply.notFound('This comment does not exist.')
      }

      if (!maySelfModerate(req, req.params.siteId, page, comment, actor)) {
        return reply.forbidden('You are not allowed to edit this comment.')
      }

      const updated = await WIKI.models.comments.update(comment.id, { content: req.body.content })
      const authorName = await resolveAuthorName(updated)
      await emitCommentEvent('comment:edit', updated, authorName)
      return {
        id: updated.id,
        siteId: updated.siteId,
        pageId: updated.pageId,
        authorId: updated.authorId,
        authorName,
        authorEmail: null,
        replyTo: updated.replyTo,
        content: updated.content,
        render: updated.render,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        replies: []
      }
    }
  )

  /**
   * DELETE A COMMENT
   */
  app.delete<{
    Params: { siteId: string; pageId: string; commentId: string }
  }>(
    '/sites/:siteId/pages/:pageId/comments/:commentId',
    {
      // -> Same as PATCH: `read:comments` per page below, then `maySelfModerate`'s policy.
      schema: {
        summary: 'Delete a comment',
        description:
          "Deletes a comment. Allowed for the comment's own author, or for anyone holding " +
          '`manage:comments` on this page. A guest-authored comment (no account behind it) can only ' +
          'be deleted via `manage:comments`.',
        tags: ['Comments'],
        params: pageCommentIdParam,
        response: {
          204: {
            description: 'The comment was deleted',
            type: 'null'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:comments', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }

      // -> Same ordering as PATCH: existence is only checked past the page-level read gate.
      const comment = await WIKI.models.comments.get(req.params.commentId)
      if (!comment || comment.pageId !== page.id) {
        return reply.notFound('This comment does not exist.')
      }

      if (!maySelfModerate(req, req.params.siteId, page, comment, actor)) {
        return reply.forbidden('You are not allowed to delete this comment.')
      }

      await WIKI.models.comments.delete(comment.id)
      await emitCommentEvent('comment:delete', comment)
      return reply.code(204).send()
    }
  )
}

export default routes
