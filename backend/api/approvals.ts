import { CustomError } from '../helpers/common.ts'
import { actorFrom, loadReadablePage } from '../helpers/pageAccess.ts'
import type { ApprovalPageRef, ApprovalRulePatch, ReviewerScope } from '../models/approvals.ts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Who is reviewing, as the approval rules see them: the groups on their session, plus whether they
 * review everything regardless of which groups a rule names.
 *
 * Two different kinds of rule meet here. An APPROVAL rule says which pages take suggestions and who
 * reviews them; a group's PAGE rules say what a member may do to a page, `review:pages` among them.
 * Holding that permission is the second way of being a reviewer, because reviewing is the entire
 * content of it — a group granted it and named in no approval rule could otherwise review nothing.
 *
 * Page permissions are per page, so `reviewsAll` is answered for a page when there is one. Without
 * one — the site-wide queue in the inbox — it is answered at the site root, which is the only thing
 * a queue spanning every page could ask about; the per-page check then still applies to each entry
 * through the approval rules that produced it.
 *
 * Nobody reviews anything without an account. A guest is treated as a member of the guests group,
 * which is right for SUBMITTING — anonymous suggestions are a feature — but a review is an act with
 * an author: accepting one writes the page and records who accepted it. So a rule that named the
 * guests group among its reviewers, or a page rule granting them `review:pages`, would otherwise hand
 * the queue to the public. An empty scope reviews nothing, whatever the rules say.
 *
 * `siteId` is threaded into the `checkAccess` call the same way `mayOnPage` takes it: so a rule scoped
 * to one site is honored even for the site-wide queue's `{ path: '' }` ref, which carries no site of
 * its own.
 */
function reviewerFor(
  req: FastifyRequest,
  siteId: string,
  page?: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
): ReviewerScope {
  if (!isReviewerSession(req)) {
    return { groupIds: [], reviewsAll: false }
  }
  const actor = WIKI.models.groups.actorForRequest(req)
  return {
    groupIds: WIKI.models.approvals.getActorGroupIds(req),
    reviewsAll:
      actor.permissions.includes('manage:system') ||
      WIKI.models.groups.checkAccess(actor, 'review:pages', {
        // -> deliberately `locale: null` for the site-wide queue's `{ path: '' }` fallback: a
        //    reviewer whose only `review:pages` grant is locale-scoped no longer gets blanket
        //    `reviewsAll` for a ref with no real page to carry a locale, which is the safe direction
        ...(page ?? { path: '', locale: null }),
        classification: page?.classification ?? null,
        siteId
      }),
    // -> Undefined for a guest: `isReviewerSession` above already sent them home with an empty scope,
    //    but a guest could not have approved anything anyway, so `hasApproved` reading `false` for them
    //    is right either way.
    viewerId: actorFrom(req)?.id
  }
}

/** Shorthand for the model's own check; see `isReviewerSession` there for why reviewing needs one. */
function isReviewerSession(req: FastifyRequest): boolean {
  return WIKI.models.approvals.isReviewerSession(req)
}

/**
 * Whether this caller may read or manage this site's approval rules — i.e. reach
 * `AdminApprovals.vue` for it, in either direction.
 *
 * One function for both, not a read/manage pair: `helpers/siteRules.ts` carries exactly one
 * `site:approvals` entry, so there is no narrower grant a "read" version could use that a "manage"
 * version couldn't — every route in this file promises the same grant either way. `manage:sites`
 * keeps working exactly as before delegation existed; `site:approvals` (see `helpers/siteRules.ts`)
 * is the narrower alternative a rule can grant per site.
 */
function mayAdministerApprovals(req: FastifyRequest, siteId: string): boolean {
  const actor = WIKI.models.groups.actorForRequest(req)
  return (
    actor.permissions.includes('manage:sites') ||
    WIKI.models.groups.checkSiteAccess(actor, 'site:approvals', siteId)
  )
}

/**
 * Everything a rule has to satisfy beyond what the JSON Schema already enforces.
 *
 * All of it comes down to the same thing: a rule that cannot match a page, or that nobody is on either
 * side of, is a rule that does nothing, and storing one silently is worse than refusing it.
 *
 * @returns A `CustomError` to throw, or null when the rule is usable
 */
function validateRule({
  name,
  match,
  path,
  submitterGroups,
  reviewerGroups,
  minApprovals
}: {
  name: string
  match: string
  path: string
  submitterGroups: string[]
  reviewerGroups: string[]
  minApprovals: number
}): CustomError | null {
  if (!name || name.trim().length < 1) {
    return new CustomError('approvalRuleEmptyName', 'A rule name is required.')
  }
  /*
    Empty is only meaningful for `START`, where it is every path and therefore the whole site -- which
    is how a rule covers a site without naming a folder.

    Every other mode still needs something. An empty `EXACT` matches no page at all; an empty `END` or
    `REGEX` matches every one of them, but by accident of the operator rather than by intent, and a
    rule whose reach nobody meant to write is exactly what this refuses.
  */
  if (match !== 'START' && (!path || path.trim().length < 1)) {
    return new CustomError(
      'approvalRuleEmptyPath',
      match === 'TAG' || match === 'TAGALL'
        ? 'At least one tag is required.'
        : 'A path is required.'
    )
  }
  if (match === 'REGEX') {
    try {
      new RegExp(path)
    } catch (err: any) {
      return new CustomError(
        'approvalRuleInvalidRegex',
        `Not a valid regular expression: ${err.message}`
      )
    }
  }
  if (submitterGroups.length < 1) {
    return new CustomError(
      'approvalRuleNoSubmitters',
      'At least one group has to be able to submit edits.'
    )
  }
  if (reviewerGroups.length < 1) {
    return new CustomError(
      'approvalRuleNoReviewers',
      'At least one group has to review submissions.'
    )
  }
  if (!Number.isInteger(minApprovals) || minApprovals < 1) {
    return new CustomError(
      'approvalRuleInvalidMinApprovals',
      'The number of required approvals must be a whole number of at least 1.'
    )
  }
  return null
}

/**
 * Reject group IDs that are not groups on this instance, for either list.
 *
 * @returns Whether the reply has been sent
 */
async function rejectUnknownGroups(
  reply: FastifyReply,
  groupIds: (string[] | undefined)[]
): Promise<boolean> {
  const unknown = await WIKI.models.approvals.getUnknownGroupIds(
    groupIds.flatMap((ids) => ids ?? [])
  )
  if (unknown.length > 0) {
    reply.badRequest('ERR_UNKNOWN_GROUPS')
    return true
  }
  return false
}

/**
 * Approvals API Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST SITE APPROVAL RULES
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/approvals/rules',
    {
      /*
        No route-level `permissions`: who may read this comes from `checkSiteAccess()`, which that
        hook cannot call — see `mayAdministerApprovals`.
      */
      schema: {
        summary: 'List the approval rules of a site',
        description:
          'Each rule says which pages accept edit suggestions, which groups may submit them, and which groups review them. A page matched by no rule accepts none, so a site with no rules has the feature off.\n\nRequires `manage:sites`, or `site:approvals` on this site.',
        tags: ['Approvals'],
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
            description: 'List of approval rules',
            type: 'array',
            items: { $ref: 'ApprovalRule#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayAdministerApprovals(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return WIKI.models.approvals.getRules(req.params.siteId)
    }
  )

  /**
   * CREATE AN APPROVAL RULE
   */
  app.post<{ Params: { siteId: string }; Body: ApprovalRulePatch }>(
    '/sites/:siteId/approvals/rules',
    {
      /*
        No route-level `permissions`: who may write this comes from `checkSiteAccess()`, which that
        hook cannot call — see `mayAdministerApprovals`.
      */
      schema: {
        summary: 'Create an approval rule',
        description:
          'Rules are not ordered: a page is covered when any rule matches it, so a new one only ever adds coverage.\n\nRequires `manage:sites`, or `site:approvals` on this site.',
        tags: ['Approvals'],
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
        body: {
          allOf: [
            { $ref: 'ApprovalRuleInput#' },
            { type: 'object', required: ['name', 'match', 'path'] }
          ]
        },
        response: {
          200: {
            description: 'Rule created successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              rule: { $ref: 'ApprovalRule#' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayAdministerApprovals(req, req.params.siteId)) {
        return reply.forbidden()
      }

      const invalid = validateRule({
        name: req.body.name!,
        match: req.body.match!,
        path: req.body.path!,
        submitterGroups: req.body.submitterGroups ?? [],
        reviewerGroups: req.body.reviewerGroups ?? [],
        minApprovals: req.body.minApprovals ?? 1
      })
      if (invalid) {
        throw invalid
      }
      if (await rejectUnknownGroups(reply, [req.body.submitterGroups, req.body.reviewerGroups])) {
        return reply
      }

      const rule = await WIKI.models.approvals.createRule(req.params.siteId, req.body)
      return {
        ok: true,
        rule
      }
    }
  )

  /**
   * UPDATE AN APPROVAL RULE
   */
  app.put<{ Params: { siteId: string; ruleId: string }; Body: ApprovalRulePatch }>(
    '/sites/:siteId/approvals/rules/:ruleId',
    {
      /*
        No route-level `permissions`: same reasoning as the POST above — see
        `mayAdministerApprovals`.
      */
      schema: {
        summary: 'Update an approval rule',
        description:
          'Accepts any subset of the fields; omitted ones are left unchanged.\n\nRequires `manage:sites`, or `site:approvals` on this site.',
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            ruleId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'ruleId']
        },
        body: { $ref: 'ApprovalRuleInput#' },
        response: {
          200: {
            description: 'Rule updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              rule: { $ref: 'ApprovalRule#' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!mayAdministerApprovals(req, req.params.siteId)) {
        return reply.forbidden()
      }
      const current = await WIKI.models.approvals.getRule(req.params.siteId, req.params.ruleId)
      if (!current) {
        return reply.notFound('Approval rule does not exist.')
      }
      if (Object.keys(req.body).length < 1) {
        throw new CustomError('approvalRuleEmpty', 'No rule fields provided to update.')
      }

      // -> Validated as the rule will be, not as it was sent: changing the mode alone has to hold up
      //    against the stored path, and emptying one group list has to be caught even though the other
      //    was not touched
      const invalid = validateRule({
        name: req.body.name ?? current.name,
        match: req.body.match ?? current.match,
        path: req.body.path ?? current.path,
        submitterGroups: req.body.submitterGroups ?? current.submitterGroups,
        reviewerGroups: req.body.reviewerGroups ?? current.reviewerGroups,
        minApprovals: req.body.minApprovals ?? current.minApprovals
      })
      if (invalid) {
        throw invalid
      }
      if (await rejectUnknownGroups(reply, [req.body.submitterGroups, req.body.reviewerGroups])) {
        return reply
      }

      const rule = await WIKI.models.approvals.updateRule(
        req.params.siteId,
        req.params.ruleId,
        req.body
      )
      if (!rule) {
        return reply.notFound('Approval rule does not exist.')
      }
      return {
        ok: true,
        rule
      }
    }
  )

  /**
   * DELETE AN APPROVAL RULE
   */
  app.delete<{ Params: { siteId: string; ruleId: string } }>(
    '/sites/:siteId/approvals/rules/:ruleId',
    {
      /*
        No route-level `permissions`: same reasoning as the POST above — see
        `mayAdministerApprovals`.
      */
      schema: {
        summary: 'Delete an approval rule',
        description:
          'The pages it covered stop accepting edit suggestions, unless another rule also matches them.\n\nRequires `manage:sites`, or `site:approvals` on this site.',
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            ruleId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'ruleId']
        },
        response: {
          204: {
            description: 'Rule deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!mayAdministerApprovals(req, req.params.siteId)) {
        return reply.forbidden()
      }
      if (!(await WIKI.models.approvals.deleteRule(req.params.siteId, req.params.ruleId))) {
        return reply.notFound('Approval rule does not exist.')
      }
      return reply.code(204).send()
    }
  )

  /**
   * LIST SUGGESTIONS WAITING ON THIS REVIEWER
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/approvals/submissions',
    {
      schema: {
        summary: 'List the edit suggestions waiting for the caller to review',
        description:
          'Scoped by the approval rules: a suggestion appears here when an enabled rule covers its page and names a group the caller is in. Oldest first, which is the order a queue is worked through. `manage:system` sees the whole site’s queue.',
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'Suggestions awaiting review',
            type: 'array',
            items: { $ref: 'PageEditSubmission#' }
          }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      return WIKI.models.approvals.getReviewableSubmissions(
        req.params.siteId,
        WIKI.models.groups.actorForRequest(req),
        reviewerFor(req, req.params.siteId)
      )
    }
  )

  /**
   * GET ONE SUGGESTION TO REVIEW
   */
  app.get<{ Params: { siteId: string; submissionId: string } }>(
    '/sites/:siteId/approvals/submissions/:submissionId',
    {
      schema: {
        summary: 'Get an edit suggestion, with both sides of the diff',
        description:
          'The suggested source and the page as it currently stands, which is what the review screen compares. Answers 404 for a suggestion that is not the caller’s to review, so that an ID cannot be probed for.',
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            submissionId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'submissionId']
        },
        response: {
          200: { $ref: 'PageEditSubmissionDetail#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const submission = await WIKI.models.approvals.getSubmissionForReview(
        req.params.siteId,
        req.params.submissionId,
        WIKI.models.groups.actorForRequest(req),
        reviewerFor(req, req.params.siteId)
      )
      if (!submission) {
        return reply.notFound('This edit suggestion does not exist.')
      }
      return submission
    }
  )

  /**
   * APPROVE A SUGGESTION
   */
  app.post<{
    Params: { siteId: string; submissionId: string }
    Body: { content?: string; render?: string }
  }>(
    '/sites/:siteId/approvals/submissions/:submissionId/approve',
    {
      schema: {
        summary: 'Approve an edit suggestion, writing it to the page once enough reviewers have',
        description:
          'Records this reviewer’s sign-off. If the covering rule’s `minApprovals` is 1 (the default) this writes the page immediately, exactly as a single-approver sign-off always has. With a higher threshold, every call up to the last only adds to the count — `finalized: false`, page untouched — and only the approve that reaches the threshold writes it (`finalized: true`); the same reviewer approving twice counts once. Applies `content` when given — the reviewer may have adjusted the suggestion before accepting it — and what was submitted otherwise; only the FINALIZING approve’s `content`/`render` are ever written. Send `render` alongside it, as the editor does on any other save: the markdown pipeline lives in the client. Without it the server queues the page for rendering, which needs the Puppeteer extension and answers 503 without it; the page then serves its previous HTML until the queue reaches it. Once finalized the page is re-indexed as it would be for any other edit, with this reviewer recorded as the author, and the suggestion is closed out.',
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            submissionId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'submissionId']
        },
        body: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'What to write to the page. Defaults to the suggestion as submitted.'
            },
            render: {
              type: 'string',
              description:
                'The HTML for that content. Omitting it makes the server render the page, which needs the Puppeteer extension.'
            }
          }
        },
        response: {
          200: {
            description: 'Approval recorded; see `finalized` for whether it was also written',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              finalized: {
                type: 'boolean',
                description:
                  'Whether this approval was the one that reached the threshold and wrote the page.'
              },
              approvalsCount: { type: 'integer' },
              approvalsRequired: { type: 'integer' }
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
        return reply.unauthorized()
      }
      const submission = await WIKI.models.approvals.getSubmissionForReview(
        req.params.siteId,
        req.params.submissionId,
        WIKI.models.groups.actorForRequest(req),
        reviewerFor(req, req.params.siteId)
      )
      if (!submission) {
        return reply.notFound('This edit suggestion does not exist.')
      }

      const applied = await WIKI.models.approvals.approveSubmission({
        siteId: req.params.siteId,
        submissionId: req.params.submissionId,
        content: req.body.content ?? submission.content,
        render: req.body.render,
        actor
      })
      if (!applied.ok) {
        // -> Distinguishable from the generic 404 above: the submission is real, but the page moved
        //    since this reviewer's own GET computed its diff, and writing over that would silently
        //    discard whatever changed in between. The client re-fetches both sides and re-prompts
        //    instead of treating this as an ordinary failure.
        if (applied.reason === 'stale') {
          return reply.conflict(
            'This page has changed since you loaded this suggestion. Reload it and reconcile the changes before approving.'
          )
        }
        // -> OpenProject #2165: the reviewer queue and `write:pages` disagreeing -- being one of
        //    this page's approval-rule reviewers is not the same grant as being allowed to write it.
        if (applied.reason === 'forbidden') {
          return reply.forbidden('You do not have permission to write this page.')
        }
        return reply.notFound('This edit suggestion does not exist.')
      }
      return {
        ok: true,
        message: applied.finalized
          ? 'Edit suggestion approved.'
          : `Approval recorded (${applied.approvalsCount}/${applied.approvalsRequired}). Waiting on more reviewers.`,
        finalized: applied.finalized,
        approvalsCount: applied.approvalsCount,
        approvalsRequired: applied.approvalsRequired
      }
    }
  )

  /**
   * REJECT A SUGGESTION
   */
  app.post<{
    Params: { siteId: string; submissionId: string }
    Body: { reason?: string }
  }>(
    '/sites/:siteId/approvals/submissions/:submissionId/reject',
    {
      schema: {
        summary: 'Decline an edit suggestion',
        description:
          'Retains the suggestion rather than deleting it, so it can be shown back to its author. The page is left exactly as it is.',
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            submissionId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'submissionId']
        },
        body: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Optional note on why this was declined, shown back to its author.'
            }
          }
        },
        response: {
          200: {
            description: 'Suggestion declined',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      // -> Defensive rather than reachable: `reviewerFor` (via `isReviewerSession`) already requires
      //    an authenticated session before `getSubmissionForReview` can return anything below, so this
      //    never actually fires -- kept explicit anyway, the same shape as the approve route above,
      //    since `rejectSubmission` now records who declined the suggestion.
      if (!actor) {
        return reply.unauthorized()
      }
      const submission = await WIKI.models.approvals.getSubmissionForReview(
        req.params.siteId,
        req.params.submissionId,
        WIKI.models.groups.actorForRequest(req),
        reviewerFor(req, req.params.siteId)
      )
      if (!submission) {
        return reply.notFound('This edit suggestion does not exist.')
      }
      await WIKI.models.approvals.rejectSubmission(
        req.params.siteId,
        req.params.submissionId,
        req.body?.reason?.trim() || null,
        actor.id
      )
      return {
        ok: true,
        message: 'Edit suggestion declined.'
      }
    }
  )

  /**
   * GET OWN SUGGESTION STATE FOR A PAGE
   *
   * Deliberately not permission-gated: whether somebody may suggest an edit is decided by the site's
   * approval rules and the groups they are in, and for an anonymous reader those are the guests
   * group's. A route permission would answer 401 before any of that could be considered.
   */
  app.get<{
    Params: { siteId: string; pageId: string }
    Querystring: { withContent?: boolean }
  }>(
    '/sites/:siteId/pages/:pageId/suggestions/self',
    {
      schema: {
        summary: 'Whether the caller may suggest edits to a page, and what they already suggested',
        description:
          "Answers `canSubmit: false` for a page no enabled rule opens to this reader, which is what hides the button. With `withContent`, also returns the source the editor should open with: the caller's own pending suggestion when they have one, so that they carry on where they left off, otherwise the page as it stands. The source is only ever included when `canSubmit` holds.",
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            pageId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'pageId']
        },
        querystring: {
          type: 'object',
          properties: {
            withContent: { type: 'boolean', default: false }
          }
        },
        response: {
          200: {
            description: 'Suggestion state for the caller',
            type: 'object',
            properties: {
              canSubmit: { type: 'boolean' },
              isGuest: {
                type: 'boolean',
                description:
                  'True when nobody is logged in, in which case submitting has to carry a name and an email address.'
              },
              submission: {
                type: ['object', 'null'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  updatedAt: { type: 'string', format: 'date-time' }
                }
              },
              content: {
                type: 'string',
                description: 'Only present with `withContent`, and only when `canSubmit` holds.'
              }
            }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      /*
        The page a suggestion is about, with the source it would be edited from. Loaded the way the
        public page route loads it — an anonymous reader sees published pages only, and a password
        still has to have been entered — so eligibility to suggest an edit never becomes a way to read
        something that was not readable. `withContent` fetches the source regardless of who is asking,
        because the caller has to be able to edit what they are looking at; the checks below only hand
        it over once a rule says this actor may suggest edits to this page.

        Reading the page comes first, for suggesting an edit to it and for reviewing one alike: neither
        is something to be done to a page the caller may not see, and answering as though it were not
        there is how every other page-scoped route treats that.
      */
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId, {
        withContent: true,
        withPassword: true
      })
      if (!page) {
        return reply.notFound('This page does not exist.')
      }

      const actor = actorFrom(req)
      const groupIds = WIKI.models.approvals.getActorGroupIds(req)
      const pageRef: ApprovalPageRef = {
        id: page.id,
        path: page.path,
        locale: page.locale,
        tags: page.tags ?? [],
        allowContributions: page.allowContributions,
        classification: page.classification
      }
      const rule = await WIKI.models.approvals.findSubmitRule(req.params.siteId, pageRef, groupIds)
      if (!rule) {
        return { canSubmit: false, isGuest: !actor, submission: null }
      }

      const submission = await WIKI.models.approvals.getOwnSubmission(page.id, actor?.id ?? null)
      return {
        canSubmit: true,
        isGuest: !actor,
        submission: submission ? { id: submission.id, updatedAt: submission.updatedAt } : null,
        ...(req.query.withContent
          ? { content: submission ? submission.content : (page.content ?? '') }
          : {})
      }
    }
  )

  /**
   * SUBMIT AN EDIT SUGGESTION FOR A PAGE
   */
  app.put<{
    Params: { siteId: string; pageId: string }
    Body: { content: string; guestName?: string; guestEmail?: string }
  }>(
    '/sites/:siteId/pages/:pageId/suggestions/self',
    {
      schema: {
        summary: 'Submit an edit suggestion for a page',
        description:
          'Stores the suggested source together with a patch against the page as it stands, so that suggestions to different parts of a page can each be accepted later. A logged in author has one open suggestion per page and submitting again replaces it. An anonymous submitter has no account to attribute it to and has to give a name and an email address instead.',
        tags: ['Approvals'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            pageId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'pageId']
        },
        body: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string' },
            guestName: { type: 'string', maxLength: 255 },
            guestEmail: { type: 'string', maxLength: 255 }
          }
        },
        response: {
          200: {
            description: 'Suggestion submitted successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              submission: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  updatedAt: { type: 'string', format: 'date-time' }
                }
              }
            }
          },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      /*
        The page a suggestion is about, with the source it would be edited from. Loaded the way the
        public page route loads it — an anonymous reader sees published pages only, and a password
        still has to have been entered — so eligibility to suggest an edit never becomes a way to read
        something that was not readable. `withContent` fetches the source regardless of who is asking,
        because the caller has to be able to edit what they are looking at; the checks below only hand
        it over once a rule says this actor may suggest edits to this page.

        Reading the page comes first, for suggesting an edit to it and for reviewing one alike: neither
        is something to be done to a page the caller may not see, and answering as though it were not
        there is how every other page-scoped route treats that.
      */
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId, {
        withContent: true,
        withPassword: true
      })
      if (!page) {
        return reply.notFound('This page does not exist.')
      }

      const actor = actorFrom(req)
      const groupIds = WIKI.models.approvals.getActorGroupIds(req)
      const pageRef: ApprovalPageRef = {
        id: page.id,
        path: page.path,
        locale: page.locale,
        tags: page.tags ?? [],
        allowContributions: page.allowContributions,
        classification: page.classification
      }
      const rule = await WIKI.models.approvals.findSubmitRule(req.params.siteId, pageRef, groupIds)
      if (!rule) {
        return reply.forbidden('This page does not accept edit suggestions from you.')
      }

      const guestName = (req.body.guestName ?? '').trim()
      const guestEmail = (req.body.guestEmail ?? '').trim()
      if (!actor) {
        // -> Nothing else records who this came from, and a reviewer has to be able to answer whoever
        //    sent it
        if (guestName.length < 1) {
          throw new CustomError('suggestionGuestNameMissing', 'A name is required.')
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
          throw new CustomError('suggestionGuestEmailInvalid', 'A valid email address is required.')
        }
      }

      const submission = await WIKI.models.approvals.saveSubmission({
        siteId: req.params.siteId,
        page: pageRef,
        baseContent: page.content ?? '',
        content: req.body.content,
        authorId: actor?.id ?? null,
        guestName,
        guestEmail
      })

      return {
        ok: true,
        submission: { id: submission.id, updatedAt: submission.updatedAt }
      }
    }
  )
}

export default routes
