import { actorFrom, mayOnPage, requireActorId, requireReadablePage } from '../helpers/pageAccess.ts'
import { enforceCommentCooldown, limitGuestComments } from '../helpers/rateLimit.ts'
import { requestOrigin } from '../helpers/common.ts'
import { HANDLE_MAX_LENGTH } from '../models/users.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AccessActor } from '../models/groups.ts'
import type { AdminPageRef, ThreadedComment } from '../models/comments.ts'

const MENTION_SUGGESTION_LIMIT = 5

const commentIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    commentId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'commentId']
}

/**
 * The page ids `actor` holds `manage:comments` on, so the moderation listing filters by
 * `pageId IN (...)` rather than permission-checking each comment row: `checkAccess` is in-memory,
 * so the cost is one page-ref query, bounded by page count, not comment count.
 *
 * `null` means "no restriction" (`manage:system`): materialising every page id on the site would
 * only turn back into "everything", at the cost of an unbounded `IN (...)` list.
 */
async function accessiblePageIdsForAdmin(
  actor: AccessActor,
  siteId: string,
  pathFilter?: string
): Promise<string[] | null> {
  if (actor.permissions.includes('manage:system')) {
    return null
  }
  const pageRefs: AdminPageRef[] = await CARDINAL.models.comments.pageRefsForSite(
    siteId,
    pathFilter
  )
  return pageRefs
    .filter((page) =>
      CARDINAL.models.groups.checkAccess(actor, 'manage:comments', { ...page, siteId })
    )
    .map((page) => page.id)
}

/** `create`/`update`/`get` do not resolve an author's name; only `listForPage`'s join does. */
async function resolveAuthorName(comment: {
  authorId: string | null
  guestName: string | null
}): Promise<string> {
  if (comment.authorId) {
    const user = await CARDINAL.models.users.getById(comment.authorId)
    if (user) {
      return user.name
    }
  }
  return comment.guestName ?? ''
}

/** `authorEmail` is always null: a page's comment list may be read anonymously. */
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
 * A comment's own author may edit or delete it without `manage:comments` — a deliberate divergence
 * from Wiki.js 2.5.x, which requires it for every edit and delete. A guest comment (`authorId`
 * null) is moderator-only: nothing on a later request can prove it is the same person.
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
        params: { $ref: 'SiteIdParams#' },
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
    async (req) => {
      return CARDINAL.models.commentProviders.getSiteProviders(req.params.siteId, { mask: true })
    }
  )

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
        params: { $ref: 'SiteIdParams#' },
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
      try {
        const provider = await CARDINAL.models.commentProviders.setActiveProvider(
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
        No route-level `permissions`: `manage:comments` is a page-rule permission, which that hook
        cannot check — decided per page by `accessiblePageIdsForAdmin`.
      */
      schema: {
        summary: 'List comments across a site for moderation',
        description:
          'Every comment on every page the requesting actor holds `manage:comments` on, across the whole site — distinct from `GET .../pages/:pageId/comments`, which is scoped to one page and needs only `read:comments`. Nothing here is granted by a single site-wide flag: a comment is included only after the page it lives on individually passes a `manage:comments` check, so two administrators with different rules see different, correctly scoped lists from the same request shape.\n\nPaginated (`offset`/`limit`, `totalHits` ignores both) and filterable by page path (prefix match), author (substring match against the account name or guest name), and a `createdAt` date range.',
        tags: ['Comments'],
        params: { $ref: 'SiteIdParams#' },
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
    async (req) => {
      const actor = CARDINAL.models.groups.actorForRequest(req)
      const pageIds = await accessiblePageIdsForAdmin(actor, req.params.siteId, req.query.pagePath)

      return CARDINAL.models.comments.listForAdmin({
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

  app.get<{ Params: { siteId: string }; Querystring: { q: string } }>(
    '/sites/:siteId/comments/mentions',
    {
      schema: {
        summary: 'Suggest handles to mention in a comment',
        description:
          'Up to five active accounts whose handle starts with `q`, compared case-insensitively, for the comment composer’s `@` autocomplete. Each entry carries the canonical stored `handle` and the display `name`, and nothing else — no email, no id.\n\nRefused with 401 without a session (a guest can type `@handle` but is offered no suggestions), and with 403 when the site has comments turned off or the requester holds `write:comments` on no page of the site. `write:comments` is a page-rule permission, so this is the coarse "could post a comment somewhere here" check rather than a per-page one.',
        tags: ['Comments'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            q: {
              type: 'string',
              minLength: 1,
              maxLength: HANDLE_MAX_LENGTH,
              pattern: '^[A-Za-z0-9._-]+$',
              description: 'The handle prefix typed after the `@`.'
            }
          },
          required: ['q']
        },
        response: {
          200: {
            description: 'Matching accounts, at most five',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                handle: { type: 'string' },
                name: { type: 'string' }
              },
              required: ['handle', 'name'],
              additionalProperties: false
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!requireActorId(req, reply)) {
        return reply
      }
      if (!CARDINAL.sites[req.params.siteId]?.config?.features?.comments) {
        return reply.forbidden('Comments are disabled for this site.')
      }
      const actor = CARDINAL.models.groups.actorForRequest(req)
      if (
        !CARDINAL.models.groups.mayHoldPermissionSomewhere(
          actor,
          ['write:comments'],
          req.params.siteId
        )
      ) {
        return reply.forbidden('You are not allowed to comment on this site.')
      }
      return CARDINAL.models.users.searchHandles(req.query.q, MENTION_SUGGESTION_LIMIT)
    }
  )

  app.delete<{ Params: { siteId: string; commentId: string } }>(
    '/sites/:siteId/comments/:commentId',
    {
      // -> No route-level `permissions`: `manage:comments` is checked against this comment's own
      //    page below.
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
      const comment = await CARDINAL.models.comments.getWithPage(req.params.commentId)
      // -> A comment id from another site is indistinguishable from one that does not exist.
      if (!comment || comment.siteId !== req.params.siteId) {
        return reply.notFound('This comment does not exist.')
      }

      const actor = CARDINAL.models.groups.actorForRequest(req)
      if (
        !CARDINAL.models.groups.checkAccess(actor, 'manage:comments', {
          ...comment.page,
          siteId: req.params.siteId
        })
      ) {
        return reply.forbidden('You are not allowed to moderate comments on this page.')
      }

      await CARDINAL.models.comments.delete(comment.id)
      return reply.code(204).send()
    }
  )

  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      /*
        No route-level `permissions`: `read:comments` is a page-rule permission, decided per page
        below. Anonymous-safe: the Guests group can hold it.
      */
      schema: {
        summary: 'List the comments on a page',
        description:
          "The full threaded comment list for a page, oldest first at every level. `authorEmail` is always null here — this endpoint is read by anonymous visitors as often as logged in ones, so a commenter's address is never published through it.",
        tags: ['Comments'],
        params: { $ref: 'SitePageParams#' },
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
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'read:comments',
        forbiddenMessage: 'You are not allowed to read comments on this page.'
      })
      if (!page) {
        return reply
      }
      const thread = await CARDINAL.models.comments.listForPage(page.id)
      return thread.map((comment) => toPublicComment(comment))
    }
  )

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
        No route-level `permissions`: `write:comments` is a page-rule permission, decided per page
        below. An anonymous request resolves to the Guests group, so granting that group
        `write:comments` is all guest posting takes — "no session" is not itself a refusal.
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
          'does (`allowComments`) — both otherwise only hide the form client-side.\n\n' +
          "When the site's active comment provider is the native one: refused with 429 when the " +
          'poster is within its configured minimum delay since their last comment (`manage:comments` ' +
          'on this page is exempt), and refused with 400 when its configured Akismet key flags the ' +
          'content as spam (an unreachable or misconfigured Akismet fails open, not closed).',
        tags: ['Comments'],
        params: { $ref: 'SitePageParams#' },
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
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'write:comments',
        forbiddenMessage: 'You are not allowed to comment on this page.'
      })
      if (!page) {
        return reply
      }
      // -> Enforced here too: the frontend only hides the form when either flag is off.
      if (!CARDINAL.sites[req.params.siteId]?.config?.features?.comments) {
        return reply.forbidden('Comments are disabled for this site.')
      }
      if (!page.allowComments) {
        return reply.forbidden('Comments are disabled for this page.')
      }

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

      // -> Only anonymous posters are bucketed: an authenticated one already sits behind the per-user
      //    API limit and is individually identifiable.
      if (!actor) {
        await limitGuestComments(req, reply)
        if (reply.sent) {
          return reply
        }
      }

      // -> Null for a provider with no server-side implementation: an embed-only one has neither a
      //    minimum delay nor an Akismet key to enforce.
      const providerModule = await CARDINAL.models.comments.activeProviderModule(req.params.siteId)
      if (providerModule) {
        const minDelay =
          typeof providerModule.provider.config.minDelay === 'number'
            ? providerModule.provider.config.minDelay
            : 0
        if (minDelay > 0 && !mayOnPage(req, 'manage:comments', req.params.siteId, page)) {
          const bucketKey = actor ? actor.id : 'guests'
          await enforceCommentCooldown(req, reply, bucketKey, minDelay)
          if (reply.sent) {
            return reply
          }
        }

        const akismetKey =
          typeof providerModule.provider.config.akismet === 'string'
            ? providerModule.provider.config.akismet.trim()
            : ''
        if (akismetKey) {
          const spamCheck = await providerModule.module.checkSpam(
            {
              ip: req.ip,
              userAgent: req.headers['user-agent'] ?? '',
              content: req.body.content,
              name: actor ? undefined : (req.body.guestName ?? undefined),
              email: actor ? undefined : (req.body.guestEmail ?? undefined),
              permalink: `${requestOrigin(req.protocol, req.hostname)}/${page.path}`,
              permalinkDate: page.updatedAt?.toISOString(),
              type: 'comment',
              role: !actor
                ? 'guest'
                : actor.permissions.includes('access:admin')
                  ? 'administrator'
                  : 'user'
            },
            providerModule.provider.config
          )
          // -> `checkSpam` never throws: an unreachable or misconfigured Akismet resolves to
          //    `isSpam: false` (fail-open), so there is nothing to catch here.
          if (spamCheck.isSpam) {
            return reply.badRequest('This comment was flagged as spam and was not posted.')
          }
        }
      }

      const replyTo = req.body.replyTo ?? null
      if (replyTo) {
        // -> `listForPage` is scoped to this page, so a cross-page `replyTo` is refused too.
        const thread = await CARDINAL.models.comments.listForPage(page.id)
        if (!flattenIds(thread).has(replyTo)) {
          return reply.badRequest('replyTo does not name a comment on this page.')
        }
      }

      const comment = await CARDINAL.models.comments.create({
        siteId: req.params.siteId,
        pageId: page.id,
        authorId: actor ? actor.id : null,
        replyTo,
        content: req.body.content,
        guestName: actor ? null : req.body.guestName,
        guestEmail: actor ? null : req.body.guestEmail,
        guestIp: actor ? null : req.ip
      })

      const authorName = await resolveAuthorName(comment)

      // -> The one case `authorEmail` IS shown: the poster being handed their own address back.
      const authorEmail = actor
        ? ((await CARDINAL.models.users.getById(actor.id))?.email ?? null)
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

  app.patch<{
    Params: { siteId: string; pageId: string; commentId: string }
    Body: { content: string; replyTo?: string | null; guestName?: string; guestEmail?: string }
  }>(
    '/sites/:siteId/pages/:pageId/comments/:commentId',
    {
      // -> No route-level `permissions`: `read:comments` per page below, then `maySelfModerate`.
      schema: {
        summary: 'Edit a comment',
        description:
          "Updates a comment's content. Allowed for the comment's own author, or for anyone holding " +
          '`manage:comments` on this page. A guest-authored comment (no account behind it) can only ' +
          'be edited via `manage:comments`.',
        tags: ['Comments'],
        params: { $ref: 'SitePageCommentParams#' },
        body: { $ref: 'CommentUpdateInput#' },
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
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'read:comments',
        forbiddenMessage: 'You are not allowed to read comments on this page.'
      })
      if (!page) {
        return reply
      }

      // -> Looked up only past the page-level read gate, so a comment's existence is never revealed
      //    to a requester who cannot read the page's comments.
      const comment = await CARDINAL.models.comments.get(req.params.commentId)
      if (!comment || comment.pageId !== page.id) {
        return reply.notFound('This comment does not exist.')
      }

      if (!maySelfModerate(req, req.params.siteId, page, comment, actor)) {
        return reply.forbidden('You are not allowed to edit this comment.')
      }

      // -> `CommentUpdateInput#` declares these only so they survive ajv's `removeAdditional` and
      //    can be refused here, rather than a 200 that silently changed nothing.
      if (req.body.replyTo != null || req.body.guestName != null || req.body.guestEmail != null) {
        return reply.badRequest(
          'replyTo, guestName and guestEmail may not be changed via PATCH; only content can be edited.'
        )
      }

      const updated = await CARDINAL.models.comments.update(comment.id, {
        content: req.body.content
      })
      const authorName = await resolveAuthorName(updated)
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

  app.delete<{
    Params: { siteId: string; pageId: string; commentId: string }
  }>(
    '/sites/:siteId/pages/:pageId/comments/:commentId',
    {
      // -> No route-level `permissions`: `read:comments` per page below, then `maySelfModerate`.
      schema: {
        summary: 'Delete a comment',
        description:
          "Deletes a comment. Allowed for the comment's own author, or for anyone holding " +
          '`manage:comments` on this page. A guest-authored comment (no account behind it) can only ' +
          'be deleted via `manage:comments`.',
        tags: ['Comments'],
        params: { $ref: 'SitePageCommentParams#' },
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
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'read:comments',
        forbiddenMessage: 'You are not allowed to read comments on this page.'
      })
      if (!page) {
        return reply
      }

      // -> Same ordering as PATCH: existence is only checked past the page-level read gate.
      const comment = await CARDINAL.models.comments.get(req.params.commentId)
      if (!comment || comment.pageId !== page.id) {
        return reply.notFound('This comment does not exist.')
      }

      if (!maySelfModerate(req, req.params.siteId, page, comment, actor)) {
        return reply.forbidden('You are not allowed to delete this comment.')
      }

      await CARDINAL.models.comments.delete(comment.id)
      return reply.code(204).send()
    }
  )
}

export default routes
