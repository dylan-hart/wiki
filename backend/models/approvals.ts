import { createHash } from 'node:crypto'
import { createPatch } from 'diff'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  pageEditSubmissionApprovals as submissionApprovalsTable,
  pageEditSubmissions as submissionsTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'
import { actorFrom } from '../helpers/pageAccess.ts'
import type { AccessActor } from './groups.ts'
import { hasPermission } from './pages.ts'
import type { ApprovalPageMatch, ApprovalPageRef, ApprovalRule } from './approvalRules.ts'
import type { RulePageRef } from '../helpers/pageRules.ts'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'
import type { FastifyRequest } from 'fastify'

/**
 * Who is reviewing, as the rules see them.
 *
 * `reviewsAll` covers the two ways of being a reviewer without a rule naming your group: the
 * `manage:system` permission, which sees everything everywhere, and `review:pages`, which is granted
 * to review pages and would be worth nothing if it could not. Neither widens WHICH pages take
 * suggestions -- a page still needs a rule -- only who may answer them.
 */
export interface ReviewerScope {
  groupIds: string[]
  reviewsAll?: boolean
  /**
   * The reviewer's own user id, used only to answer `hasApproved` on a submission -- whether THIS
   * reviewer already cast their sign-off towards its threshold. Optional because most callers of
   * `canReviewPage` never need that answer; omit it and `hasApproved` reads `false` throughout.
   */
  viewerId?: string
}

/** Where a submission stands against its rule's minimum-approvals threshold. */
export interface ApprovalProgress {
  /** How many distinct reviewers have approved so far. */
  approvalsCount: number
  /** How many are required before this finalizes -- the strictest of every rule covering the page. */
  approvalsRequired: number
  /** Whether the requesting reviewer (`ReviewerScope.viewerId`) already approved it. */
  hasApproved: boolean
}

/** An edit suggested against a page, as the author's own view of it. */
export type PageEditSubmission = Pick<
  typeof submissionsTable.$inferSelect,
  'id' | 'content' | 'baseHash' | 'createdAt' | 'updatedAt'
>

/**
 * What became of a resolved suggestion, as its author sees it -- the return leg `hasOpenSuggestion`
 * alone cannot give: that flag only ever says a suggestion is gone, never what happened to it.
 */
export interface ResolvedSubmission {
  status: 'approved' | 'declined'
  /** The reviewer's note on why. Always null for an approval -- only decline takes one. */
  reason: string | null
  resolvedAt: Date
}

/** A submission as a reviewer sees it in their queue. */
export interface ReviewableSubmission {
  id: string
  createdAt: Date
  updatedAt: Date
  /** Whether the page has changed since the suggestion was made against it. */
  isStale: boolean
  page: {
    id: string
    path: string
    title: string
    locale: string
  }
  author: {
    /** Null for a guest, who has no account to point at. */
    id: string | null
    name: string
    email: string
    isGuest: boolean
  }
  /** Where this submission stands against its rule's minimum-approvals threshold. */
  approvals: ApprovalProgress
}

/** A submission opened for review, with everything the diff needs. */
export interface ReviewableSubmissionDetail extends ReviewableSubmission {
  /** What the suggestion proposes the page should say. */
  content: string
  /**
   * What it currently says, i.e. the other side of the diff. Absent (OpenProject #2160), rather than
   * an empty string, when the reviewer holds `read:pages` on the page (enough to see it in the queue
   * at all) but not `read:source` there -- the queue entry and its metadata still come back so the
   * reviewer can act on it, but the raw source itself does not.
   */
  pageContent?: string
  /** Unified diff against the page as it stood when the suggestion was made. */
  patch: string
}

/**
 * The outcome of `approveSubmission`.
 *
 * `'not-found'` covers what the boolean used to: no such submission, or its page is gone.
 * `'stale'` is the one case that boolean could not express -- the page moved since the reviewer's
 * `baseHash` was taken, so nothing was written and the caller has to decide what to do about it,
 * rather than the write silently going ahead over whatever changed in between.
 * `'forbidden'` (OpenProject #2160/#2165) is the reviewer-queue gate and page-rule permissions
 * disagreeing: an approval rule made this reviewer one of the page's reviewers, but their own
 * `write:pages` grant does not cover it (or covers it more narrowly than the rule's `reviewerGroups`
 * implied) -- accepting a suggestion writes the page, and should never take less permission than a
 * direct save does. Checked before anything is recorded, so a refusal here leaves the page, the
 * submission, and its existing vote tally completely untouched -- there is nothing to partially apply.
 *
 * `ok: true` no longer means the page was written: with a `minApprovals` above 1, one reviewer's
 * approve only records their sign-off towards the threshold. `finalized` says which happened --
 * `false` is "recorded, still waiting on more approvers", `true` is "threshold reached, page written,
 * submission closed out" -- and `approvalsCount`/`approvalsRequired` are what a caller shows for
 * either one.
 */
export type ApproveSubmissionResult =
  | { ok: true; finalized: boolean; approvalsCount: number; approvalsRequired: number }
  | { ok: false; reason: 'not-found' | 'stale' | 'forbidden' }

/**
 * Approvals model
 *
 * The life of an edit suggestion: who may open one, what a reader is told about the ones already
 * open, the reviewer's queue and diff, and the accept/reject writes that end it. The rules deciding
 * all of that are `models/approvalRules.ts`; the mail sent about it is
 * `models/approvalNotifications.ts`.
 */
class Approvals {
  /**
   * The groups an actor belongs to, as the rules see them.
   *
   * A request with no session is not nobody: it is the guests group, and a rule naming that group is
   * how an administrator opens suggestions to anyone reading the site. Taken from the fixed ID in the
   * configuration rather than by reading the guest account's membership — that account's groups cannot
   * be changed, and the ID of the account itself only exists while an instance is being seeded.
   */
  getActorGroupIds(req: any): string[] {
    if (req.session?.authenticated && req.session.user?.id) {
      return req.session.groups ?? []
    }
    return [WIKI.data.systemIds.guestsGroupId]
  }

  /**
   * The enabled rule that lets these groups suggest an edit to this page, if there is one.
   *
   * The page's own `allowContributions` is a veto rather than another condition to match: a rule says
   * which pages MAY take suggestions, and turning the switch off on one page says that this one does
   * not — no rule has to be rewritten, narrowed or excluded around it.
   *
   * Everything asking whether a page takes a suggestion asks this, which is why the check lives here
   * rather than at either route.
   *
   * Unlike group page rules (`helpers/pageRules.ts`), approval rules carry no most-specific-wins
   * precedence and no ALLOW/DENY/FORCEALLOW distinction — the model is purely additive, and
   * `getRules`'s alphabetical order exists only to make the admin list legible, not to rank rules
   * against each other (`canReviewPage`/`getReviewableSubmissions` OR every enabled matching rule
   * together, and the create-rule API description says as much). This method's single-rule `.find()`
   * is therefore a shortcut for a yes/no answer, not a pick among several candidates: WHICH rule it
   * lands on among several that all match is an accident of `rulesCache`'s sort order, and every
   * caller today only asks `Boolean(rule)` — none reads `.id`, `.name` or any other field off the
   * result. If a future caller ever does read the returned rule's identity for something (which
   * group it names, what its own name is, ...), that is the bug this comment exists to flag: nothing
   * here promises the "first" match is the "right" one when more than one rule covers a page for the
   * same groups.
   *
   * @returns A matching rule, or null when no enabled rule lets them suggest here
   */
  async findSubmitRule(
    siteId: string,
    page: ApprovalPageRef,
    groupIds: string[]
  ): Promise<ApprovalRule | null> {
    if (groupIds.length < 1 || !page.allowContributions) {
      return null
    }
    const rules = await WIKI.models.approvalRules.getRules(siteId)
    return (
      rules.find(
        (rule) =>
          rule.isEnabled &&
          rule.submitterGroups.some((id) => groupIds.includes(id)) &&
          WIKI.models.approvalRules.matchesPage(rule, page)
      ) ?? null
    )
  }

  /**
   * Whether this reviewer has any business reviewing this page at all.
   *
   * What decides whether the page view offers a review button, so it is about the page rather than
   * about what happens to be waiting on it: a reviewer of a page with an empty queue is still its
   * reviewer. A page no rule covers takes no suggestions, so nobody reviews it -- not even an
   * administrator, who would only be offered a button that could never have anything behind it.
   */
  async canReviewPage(
    siteId: string,
    page: ApprovalPageMatch,
    { groupIds, reviewsAll = false }: ReviewerScope
  ): Promise<boolean> {
    if (!reviewsAll && groupIds.length < 1) {
      return false
    }
    const rules = await WIKI.models.approvalRules.getRules(siteId)
    return rules.some(
      (rule) =>
        rule.isEnabled &&
        (reviewsAll || rule.reviewerGroups.some((id) => groupIds.includes(id))) &&
        WIKI.models.approvalRules.matchesPage(rule, page)
    )
  }

  /**
   * Whether this request could review anything at all, i.e. it is a logged in user.
   *
   * Reads the session and nothing else, so a guest can be turned away before a single query is made on
   * their behalf. A guest counts as a member of the guests group everywhere else, which is right for
   * SUBMITTING — anonymous suggestions are a feature — but a review is an act with an author.
   */
  isReviewerSession(req: any): boolean {
    return Boolean(req.session?.authenticated && req.session.user?.id)
  }

  /**
   * Who is reviewing, as the approval rules see them: the groups on their session, plus whether they
   * review everything regardless of which groups a rule names.
   *
   * Two different kinds of rule meet here. An APPROVAL rule says which pages take suggestions and who
   * reviews them; a group's PAGE rules say what a member may do to a page, `review:pages` among them.
   * Holding that permission is the second way of being a reviewer, because reviewing is the entire
   * content of it - a group granted it and named in no approval rule could otherwise review nothing.
   *
   * Page permissions are per page, so `reviewsAll` is answered for a page when there is one. Without
   * one - the site-wide queue in the inbox - it is answered at the site root, which is the only thing
   * a queue spanning every page could ask about; the per-page check then still applies to each entry
   * through the approval rules that produced it.
   *
   * Nobody reviews anything without an account. A guest is treated as a member of the guests group,
   * which is right for SUBMITTING - anonymous suggestions are a feature - but a review is an act with
   * an author: accepting one writes the page and records who accepted it. So a rule that named the
   * guests group among its reviewers, or a page rule granting them `review:pages`, would otherwise hand
   * the queue to the public. An empty scope reviews nothing, whatever the rules say.
   *
   * `siteId` is threaded into the `checkAccess` call the same way `mayOnPage` takes it: so a rule scoped
   * to one site is honored even for the site-wide queue's `{ path: '' }` ref, which carries no site of
   * its own.
   *
   * Every caller needing a `ReviewerScope` builds it here. `api/approvals.ts`'s four route handlers
   * and `pageViewerState` below each rebuilt it independently, which is two places for the
   * guests-are-not-reviewers rule and the `manage:system` bypass to drift apart.
   */
  reviewerScopeFor(
    req: FastifyRequest,
    siteId: string,
    page?: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
  ): ReviewerScope {
    if (!this.isReviewerSession(req)) {
      return { groupIds: [], reviewsAll: false }
    }
    const actor = WIKI.models.groups.actorForRequest(req)
    return {
      groupIds: this.getActorGroupIds(req),
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

  /**
   * Where this reader stands on this page: may they suggest an edit to it, and do they review it.
   *
   * Answered here, in one place, because it is answered on EVERY page view — the page route carries it
   * back with the page rather than leaving the browser to ask two more questions about a page it has
   * just been given. The cost is kept to what is actually needed: the rules are in memory, and neither
   * of the two queries below is reached by a reader the rules say nothing about.
   *
   * @param req The request, for its session; both answers are about who is asking
   */
  async pageViewerState(
    req: any,
    siteId: string,
    page: ApprovalPageRef
  ): Promise<{
    canSuggestEdits: boolean
    hasOpenSuggestion: boolean
    canReview: boolean
    pendingSubmissions: ReviewableSubmission[]
    resolvedSubmission: ResolvedSubmission | null
  }> {
    const actorId = req.session?.authenticated ? (req.session.user?.id ?? null) : null
    const groupIds = this.getActorGroupIds(req)

    const submitRule = await this.findSubmitRule(siteId, page, groupIds)
    /*
      Only a logged in author can have one waiting: a guest suggestion is attributed to nobody, so
      there is nothing to look up and nothing to carry on from. `getOwnSubmission` says the same, and
      this keeps the query from being made at all.
    */
    const hasOpenSuggestion = Boolean(
      submitRule && actorId && (await this.getOwnSubmission(page.id, actorId))
    )
    // -> Same gate as `hasOpenSuggestion` above: no submit rule covering this page for this reader
    //    means no query, not just an unreachable answer.
    const resolvedSubmission =
      submitRule && actorId ? await this.getResolvedSubmission(page.id, actorId) : null

    const reviewerScope: ReviewerScope = this.reviewerScopeFor(req, siteId, page)
    const canReview = await this.canReviewPage(siteId, page, reviewerScope)

    return {
      canSuggestEdits: Boolean(submitRule),
      hasOpenSuggestion,
      canReview,
      pendingSubmissions: canReview
        ? await this.getReviewableSubmissions(siteId, WIKI.models.groups.actorForRequest(req), {
            ...reviewerScope,
            pageId: page.id
          })
        : [],
      resolvedSubmission
    }
  }

  /**
   * The suggestion this user already has open on this page, if any.
   *
   * Guests get null whoever they are: there is no account to look one up by, so every guest
   * suggestion is a new one.
   */
  async getOwnSubmission(
    pageId: string,
    authorId: string | null
  ): Promise<PageEditSubmission | null> {
    if (!authorId) {
      return null
    }
    const rows = await WIKI.db
      .select({
        id: submissionsTable.id,
        content: submissionsTable.content,
        baseHash: submissionsTable.baseHash,
        createdAt: submissionsTable.createdAt,
        updatedAt: submissionsTable.updatedAt
      })
      .from(submissionsTable)
      .where(
        and(
          eq(submissionsTable.pageId, pageId),
          eq(submissionsTable.authorId, authorId),
          eq(submissionsTable.status, 'open')
        )
      )
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * The most recently resolved (approved or declined) suggestion this user made on this page, if any.
   *
   * Guests get null whoever they are, for the same reason `getOwnSubmission` does: there is no
   * account to look one up by, so there is nothing to show back to them here either. A page can carry
   * more than one resolved row for the same author over time (declined, then suggested again and
   * approved) -- this answers only the latest, which is what a reader returning to the page cares
   * about.
   */
  async getResolvedSubmission(
    pageId: string,
    authorId: string | null
  ): Promise<ResolvedSubmission | null> {
    if (!authorId) {
      return null
    }
    const rows = await WIKI.db
      .select({
        status: submissionsTable.status,
        resolvedReason: submissionsTable.resolvedReason,
        updatedAt: submissionsTable.updatedAt
      })
      .from(submissionsTable)
      .where(
        and(
          eq(submissionsTable.pageId, pageId),
          eq(submissionsTable.authorId, authorId),
          inArray(submissionsTable.status, ['approved', 'declined'])
        )
      )
      .orderBy(desc(submissionsTable.updatedAt))
      .limit(1)
    const row = rows[0]
    if (!row) {
      return null
    }
    return {
      status: row.status as 'approved' | 'declined',
      reason: row.resolvedReason,
      resolvedAt: row.updatedAt
    }
  }

  /**
   * Store an edit somebody has suggested for a page.
   *
   * The patch is taken against the page as it stands right now, which is what makes two suggestions to
   * different parts of the same page both applicable later. A logged in author has one open suggestion
   * per page and this replaces it; a guest has no identity to match on, so each submission is its own.
   *
   * Notifies the page's reviewers once this is safely stored, but only when it is a genuinely NEW
   * submission -- not when an author's still-open suggestion is replaced via the `onConflictDoUpdate`
   * path below. See `notifyReviewersOfSubmission` for why a resubmission stays silent.
   *
   * @param baseContent The page source the suggestion was made against
   * @returns The stored suggestion
   */
  async saveSubmission({
    siteId,
    page,
    baseContent,
    content,
    authorId,
    guestName,
    guestEmail
  }: {
    siteId: string
    page: ApprovalPageRef
    baseContent: string
    content: string
    authorId: string | null
    guestName?: string
    guestEmail?: string
  }): Promise<PageEditSubmission> {
    const values = {
      siteId,
      pageId: page.id,
      authorId,
      content,
      patch: createPatch(page.path, baseContent, content),
      baseHash: createHash('sha256').update(baseContent).digest('hex'),
      guestName: authorId ? null : (guestName ?? ''),
      guestEmail: authorId ? null : (guestEmail ?? ''),
      updatedAt: new Date()
    }

    /*
      Read before the write, not derived from it: postgres's own `INSERT ... ON CONFLICT DO UPDATE
      ... RETURNING` gives back the row either way, with nothing in what drizzle exposes here to say
      which branch was taken. A guest has no identity to have an existing row under, so this is only
      worth asking for a logged in author -- and only they can ever reach the update branch below.
    */
    const hadOpenSubmission = authorId
      ? Boolean(await this.getOwnSubmission(page.id, authorId))
      : false

    const rows = authorId
      ? await WIKI.db
          .insert(submissionsTable)
          .values(values)
          .onConflictDoUpdate({
            target: [submissionsTable.pageId, submissionsTable.authorId],
            // -> Matches the partial index: only an OPEN submission of this author's on this page
            //    conflicts. A resolved one is left alone and this insert creates a fresh row instead.
            targetWhere: sql`"authorId" IS NOT NULL AND "status" = 'open'`,
            set: {
              content: values.content,
              patch: values.patch,
              baseHash: values.baseHash,
              updatedAt: values.updatedAt
            }
          })
          .returning()
      : await WIKI.db.insert(submissionsTable).values(values).returning()

    const stored = rows[0]
    WIKI.logger.debug(
      `Stored an edit suggestion for page ${page.id} from ${authorId ?? `guest <${guestEmail}>`}`
    )

    if (!hadOpenSubmission) {
      await WIKI.models.approvalNotifications.notifyReviewersOfSubmission(siteId, page, stored.id)
      // -> Only for a genuinely NEW submission, same gate `notifyReviewersOfSubmission` uses just
      //    above: an author revising their own still-open suggestion (the `onConflictDoUpdate`
      //    branch) is not a new thing for a subscriber to hear about.
      await WIKI.models.hooks.emit('approval:submitted', siteId, {
        id: stored.id,
        pageId: page.id,
        path: page.path,
        siteId,
        authorId
      })
    }

    return {
      id: stored.id,
      content: stored.content,
      baseHash: stored.baseHash,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    }
  }

  /**
   * The reviewer group ids of every enabled rule that matches this page, unioned across rules.
   *
   * The same rules `getReviewableSubmissions` filters by, read from the other direction: that method
   * starts from a reviewer's own groups and asks which submissions they cover; this starts from a page
   * and asks which groups cover it, so their members can be resolved and told. `getRules` is the same
   * in-memory cache either way, so this costs nothing beyond the loop.
   */
  async reviewerGroupIdsForPage(siteId: string, page: ApprovalPageMatch): Promise<string[]> {
    const rules = await WIKI.models.approvalRules.getRules(siteId)
    const groupIds = new Set<string>()
    for (const rule of rules) {
      if (rule.isEnabled && WIKI.models.approvalRules.matchesPage(rule, page)) {
        for (const id of rule.reviewerGroups) {
          groupIds.add(id)
        }
      }
    }
    return [...groupIds]
  }

  /**
   * How many distinct reviewers a submission on this page needs before it finalizes: the highest
   * `minApprovals` among every enabled rule that currently matches it.
   *
   * Read live, like every other rule question this model answers (`canReviewPage`, `findSubmitRule`,
   * ...), rather than frozen at submission time -- an administrator raising or lowering a rule's
   * threshold takes effect on the submissions already waiting, the same way narrowing a rule's path
   * takes a page out of the queue immediately rather than only for suggestions made after the change.
   * The highest of several matching rules, not the lowest: a page a stricter rule also covers should
   * not be finalizable by satisfying only the laxer one.
   *
   * Defaults to 1 when no enabled rule matches -- which should not arise for a submission actually
   * reachable through `approveSubmission` (nothing lets one be created or reviewed without a matching
   * rule), but leaves nothing stuck requiring zero approvers if it ever does.
   */
  private async requiredApprovalsForPage(siteId: string, page: ApprovalPageMatch): Promise<number> {
    const rules = await WIKI.models.approvalRules.getRules(siteId)
    let required = 1
    for (const rule of rules) {
      if (rule.isEnabled && WIKI.models.approvalRules.matchesPage(rule, page)) {
        required = Math.max(required, rule.minApprovals)
      }
    }
    return required
  }

  /**
   * How many distinct reviewers have approved each of these submissions so far, and whether `viewerId`
   * is among them.
   *
   * One query for the whole batch rather than one per submission -- `getReviewableSubmissions` builds
   * a queue of them, and a round trip per row would turn a queue of any size into that many.
   */
  private async approvalCountsFor(
    submissionIds: string[],
    viewerId?: string
  ): Promise<Map<string, { count: number; hasApproved: boolean }>> {
    const counts = new Map<string, { count: number; hasApproved: boolean }>()
    if (submissionIds.length < 1) {
      return counts
    }
    const rows = await WIKI.db
      .select({
        submissionId: submissionApprovalsTable.submissionId,
        reviewerId: submissionApprovalsTable.reviewerId
      })
      .from(submissionApprovalsTable)
      .where(inArray(submissionApprovalsTable.submissionId, submissionIds))
    for (const row of rows as { submissionId: string; reviewerId: string }[]) {
      const entry = counts.get(row.submissionId) ?? { count: 0, hasApproved: false }
      entry.count++
      if (viewerId && row.reviewerId === viewerId) {
        entry.hasApproved = true
      }
      counts.set(row.submissionId, entry)
    }
    return counts
  }

  /**
   * Every suggestion waiting on this reviewer, oldest first.
   *
   * A suggestion is theirs to review when an enabled rule covers its page and names a group they are
   * in — the same rules that let it be submitted, read from the other side — AND they hold `read:pages`
   * on that page (OpenProject #2160): approval-rule membership alone used to be the entire gate, so a
   * rule with `match: 'START', path: ''` handed its `reviewerGroups` every page on the site regardless
   * of a path/tag/classification DENY, the page password gate, or `read:pages` being denied outright.
   * Someone holding `manage:system` sees the site's whole queue, as they do everywhere else.
   *
   * Approval rules are page-blind to ordinary page permissions -- `matchesPage()` only knows START /
   * END / REGEX / TAG / TAGALL, with no ALLOW/DENY and no classification axis of its own -- so a rule
   * naming a reviewer's group is necessary but not sufficient. `actor` is intersected against every
   * matched row with `read:pages`, the same permission and the same `checkAccess()` any other reader
   * of a page would be held to; a rule with `match: 'START', path: ''` covering the whole site no
   * longer hands its named groups every page on it regardless of what the page's own rules say
   * (OpenProject #2160).
   *
   * Ordered oldest first because a queue is worked through in the order things arrived.
   *
   * OpenProject #2160: the approval-rule reviewer queue is a DIFFERENT permission axis from the
   * ordinary page-rule engine -- being named in a rule's `reviewerGroups` says who reviews a page,
   * not who may READ it. A reviewer whose group loses `read:pages` on a path (or is kept out of a
   * classification tier) must not keep seeing that page's title, tags or content through the
   * queue just because an approval rule still names them, so every row is additionally required to
   * pass `checkAccess(actor, 'read:pages', ...)`.
   */
  async getReviewableSubmissions(
    siteId: string,
    actor: AccessActor,
    { groupIds, reviewsAll = false, viewerId, pageId }: ReviewerScope & { pageId?: string }
  ): Promise<ReviewableSubmission[]> {
    if (!reviewsAll && groupIds.length < 1) {
      return []
    }
    const rules = (await WIKI.models.approvalRules.getRules(siteId)).filter(
      (rule) =>
        rule.isEnabled && (reviewsAll || rule.reviewerGroups.some((id) => groupIds.includes(id)))
    )
    if (rules.length < 1) {
      return []
    }

    const rows = await WIKI.db
      .select({
        id: submissionsTable.id,
        baseHash: submissionsTable.baseHash,
        guestName: submissionsTable.guestName,
        guestEmail: submissionsTable.guestEmail,
        createdAt: submissionsTable.createdAt,
        updatedAt: submissionsTable.updatedAt,
        pageId: pagesTable.id,
        pagePath: pagesTable.path,
        pageTitle: pagesTable.title,
        pageLocale: pagesTable.locale,
        pageTags: pagesTable.tags,
        pageClassification: pagesTable.classification,
        pageContent: pagesTable.content,
        authorId: usersTable.id,
        authorName: usersTable.name,
        authorEmail: usersTable.email
      })
      .from(submissionsTable)
      .innerJoin(pagesTable, eq(pagesTable.id, submissionsTable.pageId))
      .leftJoin(usersTable, eq(usersTable.id, submissionsTable.authorId))
      .where(
        // -> Retained resolved rows are not reviewable a second time -- only what is still `open`
        //    belongs in this queue.
        pageId
          ? and(
              eq(submissionsTable.siteId, siteId),
              eq(submissionsTable.pageId, pageId),
              eq(submissionsTable.status, 'open')
            )
          : and(eq(submissionsTable.siteId, siteId), eq(submissionsTable.status, 'open'))
      )
      .orderBy(asc(submissionsTable.createdAt))

    // -> Matched in memory rather than in SQL: a rule can be a regular expression or a set of tags,
    //    which no `WHERE` clause here could express, and a review queue is small
    const matchedRows = rows.filter((row: any) =>
      rules.some((rule) =>
        /*
          No `allowContributions` here, deliberately: that switch governs whether a suggestion may
          be MADE. One already sent stays in its reviewers' queue if the page is later closed to
          contributions -- otherwise turning the switch off would silently strand work somebody had
          submitted in good faith, with nobody able to accept or decline it.
        */
        WIKI.models.approvalRules.matchesPage(rule, {
          path: row.pagePath,
          tags: row.pageTags ?? []
        })
      )
    )

    // -> OpenProject #2160: intersect with the ordinary page-rule engine. Approval rules and page
    //    rules are independent axes -- a reviewer named by the approval rule can still be denied
    //    `read:pages` on the path, or excluded by a CLASSIFICATION rule, and either must remove the
    //    row from the queue the same as it would from any other read of the page.
    const readableRows = matchedRows.filter((row: any) =>
      WIKI.models.groups.checkAccess(actor, 'read:pages', {
        path: row.pagePath,
        siteId,
        locale: row.pageLocale,
        tags: row.pageTags ?? [],
        classification: row.pageClassification ?? null
      })
    )

    // -> Every enabled rule, not just the ones naming this reviewer's groups: the threshold a
    //    submission has to clear is the strictest rule covering the page, whoever it names as
    //    reviewers -- see `requiredApprovalsForPage`, whose logic is inlined here to share the one
    //    `getRules` read across every row instead of awaiting it per row.
    const allRules = await WIKI.models.approvalRules.getRules(siteId)
    const approvalCounts = await this.approvalCountsFor(
      readableRows.map((row: any) => row.id),
      viewerId
    )

    return readableRows.map((row: any) => {
      const pageMatch = { path: row.pagePath, tags: row.pageTags ?? [] }
      let approvalsRequired = 1
      for (const rule of allRules) {
        if (rule.isEnabled && WIKI.models.approvalRules.matchesPage(rule, pageMatch)) {
          approvalsRequired = Math.max(approvalsRequired, rule.minApprovals)
        }
      }
      const progress = approvalCounts.get(row.id) ?? { count: 0, hasApproved: false }
      return this.toReviewable(row, {
        approvalsCount: progress.count,
        approvalsRequired,
        hasApproved: progress.hasApproved
      })
    })
  }

  /**
   * One submission, if it is this reviewer's to look at, with both sides of the diff.
   *
   * `pageContent` (OpenProject #2160) additionally requires `read:source` on the page, on top of the
   * `read:pages` the queue itself already requires to surface the entry at all: the current page body
   * is exactly what a direct page view withholds without it, and a pending suggestion is not a way
   * around that. Refused with a missing field, not a 403 -- the reviewer still needs the rest of this
   * response (the diff's other side, `approvals`, …) to act on the queue entry even without seeing the
   * page's current source.
   *
   * @returns The submission, or null when it does not exist or is not theirs to review
   */
  async getSubmissionForReview(
    siteId: string,
    submissionId: string,
    actor: AccessActor,
    { groupIds, reviewsAll = false, viewerId }: ReviewerScope
  ): Promise<ReviewableSubmissionDetail | null> {
    // -> Reuses the queue rather than re-deriving who may see what: one definition of reviewable
    const reviewable = await this.getReviewableSubmissions(siteId, actor, {
      groupIds,
      reviewsAll,
      viewerId
    })
    if (!reviewable.some((s) => s.id === submissionId)) {
      return null
    }

    const rows = await WIKI.db
      .select({
        content: submissionsTable.content,
        patch: submissionsTable.patch,
        pageContent: pagesTable.content,
        pagePath: pagesTable.path,
        pageLocale: pagesTable.locale,
        pageTags: pagesTable.tags,
        pageClassification: pagesTable.classification
      })
      .from(submissionsTable)
      .innerJoin(pagesTable, eq(pagesTable.id, submissionsTable.pageId))
      .where(eq(submissionsTable.id, submissionId))
      .limit(1)
    const detail = rows[0]
    if (!detail) {
      return null
    }

    const maySeeSource = WIKI.models.groups.checkAccess(actor, 'read:source', {
      path: detail.pagePath,
      siteId,
      locale: detail.pageLocale,
      tags: detail.pageTags ?? [],
      classification: detail.pageClassification ?? null
    })

    return {
      ...reviewable.find((s) => s.id === submissionId)!,
      content: detail.content,
      ...(maySeeSource && { pageContent: detail.pageContent ?? '' }),
      patch: detail.patch
    }
  }

  /**
   * Approve a suggestion: record this reviewer's sign-off, then write it to the page and close the
   * suggestion out once the covering rule's `minApprovals` threshold is met.
   *
   * With the ordinary threshold of 1 this still happens on the very first approve, exactly as before
   * multi-approver support existed. With a higher one, every call up to the last records another
   * distinct reviewer's sign-off (`finalized: false`) and leaves the page untouched; only the approval
   * that reaches the threshold does the write. The SAME reviewer approving twice does not count twice
   * -- `pageEditSubmissionApprovals`'s unique index makes the insert a no-op the second time, so
   * `approvalsCount` does not move and finalizing still waits on a genuinely different reviewer.
   *
   * The content applied when the threshold is finally met is whatever THIS LAST reviewer settled on,
   * which is not necessarily what was submitted — the review screen lets them adjust it before
   * accepting. Earlier approvers' `content`/`render` are not applied: their approve call only ever
   * records a vote, so there is nothing of theirs to write. It is written as an ordinary page edit, so
   * the render, the search index and the page hooks all happen the way they do for any other save,
   * with this reviewer recorded as the author: they are the one putting it on the page, and a guest
   * submitter has no account to attribute it to.
   *
   * Re-checks the submission's `baseHash` against the page's current content immediately before
   * writing, not just when the reviewer's `GET .../submissions/:id` computed `isStale` for display --
   * that read and this write are two different moments, and the page can move between them: another
   * reviewer accepting a different suggestion on the same page, or the author saving straight to the
   * page while the review sat open. Refusing with `'stale'` rather than writing over it is what lets
   * the caller reload the diff and have the reviewer reconcile it instead of silently discarding
   * whatever changed underneath. Checked before EVERY approve, not just the finalizing one: an
   * approval recorded against a page that has since moved would otherwise count towards a threshold
   * for content nobody re-confirmed against the page as it now stands.
   *
   * @returns `{ ok: false, reason: 'not-found' }` when there is no such submission (or its page is
   *   gone), `{ ok: false, reason: 'stale' }` when the page moved since `baseHash`, otherwise
   *   `{ ok: true, finalized, approvalsCount, approvalsRequired }` -- `finalized` says whether this
   *   call was the one that wrote the page and closed the suggestion out, or only added to the count.
   */
  async approveSubmission({
    siteId,
    submissionId,
    content,
    render,
    actor
  }: {
    siteId: string
    submissionId: string
    content: string
    /** The rendered HTML. Rendered here instead when the caller has none, which needs an extension. */
    render?: string
    actor: { id: string; permissions: string[]; groupIds: string[] }
  }): Promise<ApproveSubmissionResult> {
    const rows = await WIKI.db
      .select({
        id: submissionsTable.id,
        pageId: submissionsTable.pageId,
        baseHash: submissionsTable.baseHash,
        status: submissionsTable.status,
        // -> Whose markup this is, for resolving submitter render permissions -- null for a guest
        //    submission (`POST .../submissions` allows one; see that route). Also who
        //    `notifySubmissionAuthor` tells the outcome to, below.
        authorId: submissionsTable.authorId,
        guestName: submissionsTable.guestName,
        guestEmail: submissionsTable.guestEmail
      })
      .from(submissionsTable)
      .where(and(eq(submissionsTable.id, submissionId), eq(submissionsTable.siteId, siteId)))
      .limit(1)
    const submission = rows[0]
    // -> A resolved row is retained rather than deleted (see the transaction below), so it is still
    //    found by the query above -- but it is no longer something a caller can act on, the same as
    //    if it were gone. Checked here, before the staleness comparison, because a resolved
    //    submission's `baseHash` is stale by definition (the page moved when it was finalized) and
    //    would otherwise report the wrong reason ('stale' instead of 'not-found').
    if (!submission || submission.status !== 'open') {
      return { ok: false, reason: 'not-found' }
    }

    const page = await WIKI.models.pages.getPage({
      siteId,
      id: submission.pageId,
      withContent: true
    })
    if (!page) {
      return { ok: false, reason: 'not-found' }
    }

    // -> OpenProject #2160/#2165: the approval-rule reviewer queue is a DIFFERENT permission axis
    //    from the ordinary page-rule engine -- being named in a rule's `reviewerGroups` is not the
    //    same thing as holding `write:pages` on the page a suggestion targets, and accepting one
    //    writes the page exactly like a direct save does.
    if (
      !WIKI.models.groups.checkAccess(actor, 'write:pages', {
        path: page.path,
        siteId,
        locale: page.locale,
        tags: page.tags ?? [],
        classification: page.classification ?? null
      })
    ) {
      return { ok: false, reason: 'forbidden' }
    }

    const currentHash = createHash('sha256')
      .update(page.content ?? '')
      .digest('hex')
    if (currentHash !== submission.baseHash) {
      return { ok: false, reason: 'stale' }
    }

    /*
      Everything from the row lock through the finalisation decision runs on one transaction, so two
      concurrent calls for the same submission cannot both read a threshold-satisfying count and both
      enter the finalize branch. `for('update')` blocks a second transaction on this row until the
      first commits; the second then re-reads and finds the row already gone if the first finalized,
      returning not-found instead of also racing to write the page. `onConflictDoNothing` alone was
      not enough -- it only suppresses a repeat vote *row* from the same reviewer, not the count both
      requests go on to read.

      `updatePage` stays out of this transaction on purpose: it does its own history/watcher/search/
      hook/storage I/O and must not run while holding a row lock, per `deletePage`'s and
      `setUserGroups`' transactions below applying the identical rule.

      Marking `status: 'approved'` here is therefore a CLAIM, not yet a fact -- it is what blocks a
      concurrent reviewer from also entering the finalize branch below, before this call has actually
      written the page. Everything from here down to the successful `updatePage()` call is obligated to
      make that claim true or undo it: `revertFailedFinalization()` is the undo, called from the
      `updatePage()` failure path below (OpenProject #2349) -- without it, a write failure after this
      point leaves the row permanently `approved` with no write behind it and no retry path, since
      every other query here (`getReviewableSubmissions`, `getOwnSubmission`, this method's own entry
      guard and the `for('update')` re-check above) requires `status = 'open'` to act on a row. The
      `write:pages` check itself runs before this transaction even starts (above), so a forbidden
      actor never reaches this claim in the first place.
    */
    const decision = await WIKI.db.transaction(async (tx) => {
      const lockedRows = await tx
        .select({ id: submissionsTable.id, status: submissionsTable.status })
        .from(submissionsTable)
        .where(eq(submissionsTable.id, submissionId))
        .for('update')
      if (!lockedRows[0] || lockedRows[0].status !== 'open') {
        // -> Already finalized by a concurrent call that reached this transaction first: the row is
        //    retained (`status: 'approved'`/`'declined'`) rather than deleted, but is no longer open
        //    for this call to act on.
        return { ok: false as const, reason: 'not-found' as const }
      }

      await tx
        .insert(submissionApprovalsTable)
        .values({ submissionId, reviewerId: actor.id })
        // -> Idempotent: this reviewer approving again (a double click, a retried request) must not
        //    count as a second, different sign-off
        .onConflictDoNothing({
          target: [submissionApprovalsTable.submissionId, submissionApprovalsTable.reviewerId]
        })

      const approvalsRequired = await this.requiredApprovalsForPage(siteId, {
        path: page.path,
        tags: page.tags ?? []
      })
      const approvalsCount = await tx.$count(
        submissionApprovalsTable,
        eq(submissionApprovalsTable.submissionId, submissionId)
      )

      if (approvalsCount < approvalsRequired) {
        return { ok: true as const, finalized: false as const, approvalsCount, approvalsRequired }
      }

      // -> Commits the finalisation intent while the row lock is still held: marking the submission
      //    resolved here is what a concurrent caller blocked on `for('update')` above sees (via the
      //    `status !== 'open'` check above) the instant this transaction commits, rather than also
      //    entering this branch. Marked resolved rather than deleted, so the author can be shown it
      //    was approved and onto which page; `pageEditSubmissionApprovals`'s votes are no longer
      //    cascaded away with the row, but they also no longer matter to anything -- `approvalCountsFor`
      //    and `getReviewableSubmissions` only ever look at `open` submissions.
      //
      // -> The `status = 'open'` guard mirrors `rejectSubmission`'s own final UPDATE
      //    (OpenProject #2354): the `for('update')` re-check just above already serializes this
      //    against a concurrent writer at the Postgres level, so this is defense-in-depth rather than
      //    the only thing preventing a resolved row from being flipped back to 'approved' -- but it
      //    keeps this write from ever being the one place that trusts the lock alone. A 0-rowcount
      //    result (the row resolved by some path this lock did not anticipate) is treated the same as
      //    the `for('update')` check above: not-found, not a silent "finalized" claim over content
      //    that was never actually written.
      const updateResult = await tx
        .update(submissionsTable)
        .set({ status: 'approved', resolvedBy: actor.id, updatedAt: new Date() })
        .where(and(eq(submissionsTable.id, submissionId), eq(submissionsTable.status, 'open')))
      if ((updateResult.rowCount ?? 0) === 0) {
        return { ok: false as const, reason: 'not-found' as const }
      }
      return { ok: true as const, finalized: true as const, approvalsCount, approvalsRequired }
    })

    if (!decision.ok) {
      return decision
    }

    // -> Fires once per call that gets this far (a real sign-off was recorded against a non-stale
    //    submission), whether or not THIS call is the one that reaches the threshold below -- "a
    //    reviewer approved" rather than "the page was finalized", so a subscriber watching every
    //    approval on a multi-approver rule sees each one, not only the last. Emitted outside the
    //    transaction above, same as `updatePage` below it: hook/webhook I/O must not run while
    //    holding the row lock.
    await WIKI.models.hooks.emit('approval:approved', siteId, {
      id: submissionId,
      pageId: page.id,
      path: page.path,
      siteId,
      authorId: actor.id
    })

    if (!decision.finalized) {
      WIKI.logger.debug(
        `Recorded approval ${decision.approvalsCount}/${decision.approvalsRequired} for edit ` +
          `suggestion ${submissionId} on page ${page.id}; waiting on more reviewers`
      )
      return decision
    }

    /*
      The markup being sanitized here is the SUBMITTER's, not the reviewer's -- `updatePage()` is
      called with `actor: reviewer` below because the reviewer is who performed the write (page
      history, `authorId`, notifications all still attribute to them), but sanitizing an edit
      suggestion's HTML against the REVIEWER's `write:scripts`/`write:styles` would let a
      lower-privileged (or, for a guest submission -- `api/approvals.ts`'s submit route explicitly
      allows one -- unauthenticated) submitter's markup launder through a reviewer's grant, which is
      a permission bypass neither side individually has: the reviewer never wrote the script, and the
      submitter never held the permission (OpenProject #1360/#2180, 2026-08-24 security audit §4).
      `resolveSubmitterRenderPermissions` returns neither permission for a guest submission
      (`authorId` is null), which is treated the same as "holds nothing".
    */
    const submitterRenderPermissions = await this.resolveSubmitterRenderPermissions(
      submission.authorId,
      {
        path: page.path,
        locale: page.locale,
        siteId,
        tags: page.tags ?? [],
        classification: page.classification
      }
    )
    // -> A suggestion approved with no `render` (content-only) is exactly the case `updatePage()`
    //    itself now handles: it consults `ensureCanRender()` before the write and queues the
    //    re-render after, so there is nothing left for this call site to do (OpenProject #1716/#1723).
    //
    // -> OpenProject #2349: `updatePage()` runs after the finalizing transaction already committed
    //    `status: 'approved'` (see that transaction's own comment on why it can't run inside it) --
    //    if this throws, the submission must not be left stuck `approved` with no write behind it and
    //    no retry path. `revertFailedFinalization()` undoes the claim before the error propagates, so
    //    the submission reads back `open` (visible in the reviewer queue again, and to a repeat
    //    `approveSubmission` call, exactly as if this attempt's votes were the only thing that
    //    happened) instead of a silent permanent success record for content that never landed.
    try {
      await WIKI.models.pages.updatePage(
        siteId,
        page.id,
        { content, ...(render && { render }) },
        actor,
        submitterRenderPermissions
      )
    } catch (err: any) {
      await this.revertFailedFinalization(submissionId)
      WIKI.logger.warn(
        `Failed to write approved edit suggestion ${submissionId} onto page ${page.id}; ` +
          `reverted the submission back to open for retry: ${err.message}`
      )
      throw err
    }
    WIKI.logger.debug(`Approved edit suggestion ${submissionId} onto page ${page.id}`)

    // -> `skipIfWatching: true` -- the `updatePage()` call above already queued its own generic
    //    "page updated by <reviewer>" notice to every watcher, this author included if they watch the
    //    page. Notifying them again here would be a double notice for the same event.
    await WIKI.models.approvalNotifications.notifySubmissionAuthor(
      siteId,
      { id: page.id, title: page.title, path: page.path, locale: page.locale },
      'suggestApproved',
      {
        authorId: submission.authorId,
        guestName: submission.guestName,
        guestEmail: submission.guestEmail
      },
      actor.id,
      { skipIfWatching: true }
    )

    return decision
  }

  /**
   * Undo `approveSubmission()`'s tentative `status: 'approved'` when the page write it was supposed
   * to precede never actually happened -- `updatePage()` throwing (OpenProject #2349).
   *
   * The finalizing transaction commits `status: 'approved'` while still holding the row lock, purely
   * to block a concurrent reviewer from also entering the finalize branch before this call's write has
   * run -- it is a claim, not yet a fact. Without this compensating update, a write failure left that
   * claim standing forever: every other query here (`getReviewableSubmissions`, `getOwnSubmission`,
   * this method's own entry guard, the finalizing transaction's own re-check) only ever acts on
   * `status = 'open'`, so a submission stuck `approved` with nothing written was both unfixable by a
   * retry and invisible as broken -- it just read as resolved. The `write:pages` check itself runs
   * before the finalizing transaction even starts, so a forbidden actor never makes this claim at all
   * and needs no revert.
   *
   * Guarded on `status = 'approved'` in the `WHERE` clause so this only reverts the specific attempt
   * that just failed: nothing else can move a row out of `'approved'` while it holds that status (the
   * entry guard above refuses any concurrent call on a non-`'open'` row), so this is a defensive
   * narrowing rather than a race this function itself needs to resolve.
   */
  private async revertFailedFinalization(submissionId: string): Promise<void> {
    await WIKI.db
      .update(submissionsTable)
      .set({ status: 'open', resolvedBy: null, updatedAt: new Date() })
      .where(and(eq(submissionsTable.id, submissionId), eq(submissionsTable.status, 'approved')))
  }

  /**
   * What `write:scripts`/`write:styles` the SUBMITTER holds on this page -- not the reviewer.
   *
   * `POST /sites/:siteId/pages/:pageId/submissions` only requires a matching submit rule, and
   * explicitly allows a guest (no `authorId`) to raise a suggestion; the reviewer's own browser then
   * renders that markdown and posts the resulting HTML to `approveSubmission`. Resolving these
   * permissions from `actor` (the reviewer) the way an ordinary save does would let a reviewer who
   * holds `write:scripts`/`write:styles` launder a submitter's `<script>`/inline `style` past a
   * permission the submitter never had -- a confused-deputy path, since the reviewer could always
   * have written the same markup themselves, but one that quietly turns a technical control into a
   * human one for third-party content the reviewer only skimmed as a diff (`InboxReview.vue`).
   *
   * A guest submission gets neither permission, unconditionally -- there is no group to check.
   */
  private async resolveSubmitterRenderPermissions(
    authorId: string | null,
    pageRef: RulePageRef
  ): Promise<RenderPermissions> {
    if (!authorId) {
      return { scripts: false, styles: false }
    }
    // -> Resolved fresh from the db, not from a session/API key -- the submitter has no request of
    //    their own for the reviewer's `approveSubmission` call to read one from.
    const submitterActor = { id: authorId, ...(await WIKI.models.groups.actorForUserId(authorId)) }
    return {
      scripts: hasPermission(submitterActor, 'write:scripts', pageRef),
      styles: hasPermission(submitterActor, 'write:styles', pageRef)
    }
  }

  /**
   * Decline a suggestion. The page is untouched, and the submission is retained with `status:
   * 'declined'` (rather than deleted) so it can be shown back to its author along with `reason`.
   *
   * Unlike `approveSubmission`, nothing else tells the author anything -- there is no page write to
   * trigger `updatePage()`'s own watcher notice -- so this always notifies them, logged in or guest,
   * with no `skipIfWatching` to consider.
   *
   * @param reason The reviewer's optional note on why, shown to the author
   * @param resolvedBy The reviewer declining it
   * @returns False when there is no such submission
   */
  async rejectSubmission(
    siteId: string,
    submissionId: string,
    reason: string | null,
    resolvedBy: string
  ): Promise<boolean> {
    // -> Read before the update, not after: `pagesTable` is only reachable from the submission row
    //    through this join, so the event payload below has to be captured while it's still there,
    //    same as it would have to be if this update were a delete. Also carries the fields
    //    `notifySubmissionAuthor` needs -- the submission's own author/guest columns, and the page's
    //    title/locale alongside the path `approval:rejected` already wanted.
    const rows = await WIKI.db
      .select({
        pageId: pagesTable.id,
        pagePath: pagesTable.path,
        pageTitle: pagesTable.title,
        pageLocale: pagesTable.locale,
        authorId: submissionsTable.authorId,
        guestName: submissionsTable.guestName,
        guestEmail: submissionsTable.guestEmail
      })
      .from(submissionsTable)
      .innerJoin(pagesTable, eq(pagesTable.id, submissionsTable.pageId))
      .where(and(eq(submissionsTable.id, submissionId), eq(submissionsTable.siteId, siteId)))
      .limit(1)
    const page = rows[0]

    const result = await WIKI.db
      .update(submissionsTable)
      .set({
        status: 'declined',
        resolvedReason: reason,
        resolvedBy,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(submissionsTable.id, submissionId),
          eq(submissionsTable.siteId, siteId),
          // -> Only an OPEN submission can be declined: this makes a repeat decline of an already
          //    resolved row a no-op (`false`) rather than silently overwriting its reason/resolver a
          //    second time.
          eq(submissionsTable.status, 'open')
        )
      )
    const declined = (result.rowCount ?? 0) > 0

    if (declined && page) {
      await WIKI.models.hooks.emit('approval:rejected', siteId, {
        id: submissionId,
        pageId: page.pageId,
        path: page.pagePath,
        siteId,
        authorId: resolvedBy
      })

      await WIKI.models.approvalNotifications.notifySubmissionAuthor(
        siteId,
        { id: page.pageId, title: page.pageTitle, path: page.pagePath, locale: page.pageLocale },
        'suggestDeclined',
        {
          authorId: page.authorId,
          guestName: page.guestName,
          guestEmail: page.guestEmail
        },
        resolvedBy
      )
    }

    return declined
  }

  /**
   * One joined row, as the review queue presents it.
   *
   * @param approvals Progress towards the submission's threshold. Defaults to "no approvals yet,
   *   requires 1" for callers that have not computed it -- today, none; kept so a future caller of this
   *   already-public method is not forced to plumb through counts it has no use for.
   */
  toReviewable(
    row: any,
    approvals: ApprovalProgress = { approvalsCount: 0, approvalsRequired: 1, hasApproved: false }
  ): ReviewableSubmission {
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // -> The page has moved on since this was written, so accepting it wholesale would undo whatever
      //    changed in between. The reviewer is shown the current page as the other side of the diff
      //    either way; this is what tells them to look closely.
      isStale:
        createHash('sha256')
          .update(row.pageContent ?? '')
          .digest('hex') !== row.baseHash,
      page: {
        id: row.pageId,
        path: row.pagePath,
        title: row.pageTitle,
        locale: row.pageLocale
      },
      author: {
        id: row.authorId ?? null,
        name: row.authorName ?? row.guestName ?? '',
        email: row.authorEmail ?? row.guestEmail ?? '',
        isGuest: !row.authorId
      },
      approvals
    }
  }
}

export const approvals = new Approvals()
