import { createHash } from 'node:crypto'
import { createPatch } from 'diff'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  pageEditSubmissionApprovals as submissionApprovalsTable,
  pageEditSubmissions as submissionsTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'
import { actorFrom, mayReadSourceAs } from '../helpers/pageAccess.ts'
import type { AccessActor } from './groups.ts'
import { hasPermission } from './pages.ts'
import type { ApprovalPageMatch, ApprovalPageRef, ApprovalRule } from './approvalRules.ts'
import type { RulePageRef } from '../helpers/pageRules.ts'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'
import type { FastifyRequest } from 'fastify'

/**
 * `reviewsAll` covers the two ways of being a reviewer without a rule naming your group:
 * `manage:system` and `review:pages`. Neither widens WHICH pages take suggestions -- a page still
 * needs a rule -- only who may answer them.
 */
export interface ReviewerScope {
  groupIds: string[]
  reviewsAll?: boolean
  /** Only answers `hasApproved`; omitted, that reads `false` throughout. */
  viewerId?: string
}

export interface ApprovalProgress {
  approvalsCount: number
  approvalsRequired: number
  /** Whether `ReviewerScope.viewerId` already approved it. */
  hasApproved: boolean
}

export type PageEditSubmission = Pick<
  typeof submissionsTable.$inferSelect,
  'id' | 'content' | 'baseHash' | 'createdAt' | 'updatedAt'
>

export interface ResolvedSubmission {
  status: 'approved' | 'declined'
  /** Always null for an approval -- only a decline takes a reason. */
  reason: string | null
  resolvedAt: Date
}

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
    id: string | null
    name: string
    email: string
    isGuest: boolean
  }
  approvals: ApprovalProgress
}

export interface ReviewableSubmissionDetail extends ReviewableSubmission {
  content: string
  /**
   * Absent, rather than an empty string, when the reviewer holds `read:pages` on the page but not
   * `read:source` there (which `write:pages`/`manage:pages` imply) -- the queue entry still comes back so they can act on it, the source does
   * not.
   */
  pageContent?: string
  /** Against the page as it stood when the suggestion was made, not as it stands now. */
  patch: string
}

/**
 * `'stale'` is the page having moved since the `baseHash` was taken: nothing is written, and the
 * caller reconciles rather than the write going ahead over what changed in between. `'forbidden'`
 * is a reviewer the queue admits but whose `write:pages` grant does not cover the page; it is
 * checked before anything is recorded, so a refusal leaves page, submission and tally untouched.
 *
 * `ok: true` does not mean the page was written: with `minApprovals` above 1, an approve only
 * records a sign-off towards the threshold. `finalized` says which of the two happened.
 */
export type ApproveSubmissionResult =
  | { ok: true; finalized: boolean; approvalsCount: number; approvalsRequired: number }
  | { ok: false; reason: 'not-found' | 'stale' | 'forbidden' }

class Approvals {
  /**
   * A request with no session is not nobody: it is the guests group, and a rule naming that group is
   * how an administrator opens suggestions to anyone reading the site. Taken from the configured ID
   * rather than the guest account's own membership — that membership cannot be changed, and the
   * account's ID only exists while an instance is being seeded.
   */
  getActorGroupIds(req: any): string[] {
    if (req.session?.authenticated && req.session.user?.id) {
      return req.session.groups ?? []
    }
    return [CARDINAL.data.systemIds.guestsGroupId]
  }

  /**
   * The page's own `allowContributions` is a veto rather than another condition to match: a rule says
   * which pages MAY take suggestions, and the switch closes one page without any rule being rewritten
   * or narrowed around it.
   *
   * Unlike group page rules (`helpers/pageRules.ts`), approval rules carry no most-specific-wins
   * precedence and no ALLOW/DENY/FORCEALLOW — the model is purely additive. So this `.find()` is a
   * shortcut for a yes/no answer, not a pick among candidates: WHICH rule it lands on when several
   * match is an accident of the cache's sort order. Do not read the result's identity.
   */
  async findSubmitRule(
    siteId: string,
    page: ApprovalPageRef,
    groupIds: string[]
  ): Promise<ApprovalRule | null> {
    if (groupIds.length < 1 || !page.allowContributions) {
      return null
    }
    const rules = await CARDINAL.models.approvalRules.getRules(siteId)
    return (
      rules.find(
        (rule) =>
          rule.isEnabled &&
          rule.submitterGroups.some((id) => groupIds.includes(id)) &&
          CARDINAL.models.approvalRules.matchesPage(rule, page)
      ) ?? null
    )
  }

  /**
   * About the page, not about what happens to be waiting on it: a reviewer of a page with an empty
   * queue is still its reviewer. A page no rule covers takes no suggestions, so nobody reviews it --
   * not even an administrator, who would only get a button that could never have anything behind it.
   */
  async canReviewPage(
    siteId: string,
    page: ApprovalPageMatch,
    { groupIds, reviewsAll = false }: ReviewerScope
  ): Promise<boolean> {
    if (!reviewsAll && groupIds.length < 1) {
      return false
    }
    const rules = await CARDINAL.models.approvalRules.getRules(siteId)
    return rules.some(
      (rule) =>
        rule.isEnabled &&
        (reviewsAll || rule.reviewerGroups.some((id) => groupIds.includes(id))) &&
        CARDINAL.models.approvalRules.matchesPage(rule, page)
    )
  }

  /**
   * A guest counts as a member of the guests group everywhere else, which is right for SUBMITTING —
   * anonymous suggestions are a feature — but a review is an act with an author.
   */
  isReviewerSession(req: any): boolean {
    return Boolean(req.session?.authenticated && req.session.user?.id)
  }

  /**
   * `review:pages` is the second way of being a reviewer, independent of any approval rule naming
   * your group — reviewing is the entire content of that permission, so a group granted it and named
   * in no rule could otherwise review nothing.
   *
   * It is a page permission, so without a page — the site-wide queue in the inbox — `reviewsAll` is
   * answered at the site root, the only thing a queue spanning every page could ask about; the
   * per-page check still applies to each entry through the approval rules that produced it.
   *
   * Build every `ReviewerScope` here: rebuilding one at a route is two places for the
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
    const actor = CARDINAL.models.groups.actorForRequest(req)
    return {
      groupIds: this.getActorGroupIds(req),
      reviewsAll:
        actor.permissions.includes('manage:system') ||
        CARDINAL.models.groups.checkAccess(actor, 'review:pages', {
          // -> `locale: null` for the site-wide queue's `{ path: '' }` fallback: a reviewer whose
          //    only `review:pages` grant is locale-scoped does not get blanket `reviewsAll`
          ...(page ?? { path: '', locale: null }),
          classification: page?.classification ?? null,
          siteId
        }),
      viewerId: actorFrom(req)?.id
    }
  }

  /**
   * Carried back with the page on EVERY page view rather than leaving the browser to ask more
   * questions about a page it has just been given. The rules are in memory, and no query below is
   * reached by a reader they say nothing about.
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
      Gated on `submitRule` as much as on the author, here and for `resolvedSubmission` below: a
      reader no rule covers means no query, not just an unreachable answer.
    */
    const hasOpenSuggestion = Boolean(
      submitRule && actorId && (await this.getOwnSubmission(page.id, actorId))
    )
    const resolvedSubmission =
      submitRule && actorId ? await this.getResolvedSubmission(page.id, actorId) : null

    const reviewerScope: ReviewerScope = this.reviewerScopeFor(req, siteId, page)
    const canReview = await this.canReviewPage(siteId, page, reviewerScope)

    return {
      canSuggestEdits: Boolean(submitRule),
      hasOpenSuggestion,
      canReview,
      pendingSubmissions: canReview
        ? await this.getReviewableSubmissions(siteId, CARDINAL.models.groups.actorForRequest(req), {
            ...reviewerScope,
            pageId: page.id
          })
        : [],
      resolvedSubmission
    }
  }

  /**
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
    const rows = await CARDINAL.db
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
   * A page can carry more than one resolved row for the same author over time (declined, then
   * suggested again and approved); only the latest matters to a reader returning to the page.
   */
  async getResolvedSubmission(
    pageId: string,
    authorId: string | null
  ): Promise<ResolvedSubmission | null> {
    if (!authorId) {
      return null
    }
    const rows = await CARDINAL.db
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
   * The patch is taken against the page as it stands right now, which is what makes two suggestions to
   * different parts of the same page both applicable later.
   *
   * Reviewers and subscribers hear only about a genuinely NEW submission: an author revising their
   * own still-open suggestion is not a new thing to be told about.
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
      Read before the write, not derived from it: `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
      gives back the row either way, with nothing in what drizzle exposes here to say which branch was
      taken.
    */
    const hadOpenSubmission = authorId
      ? Boolean(await this.getOwnSubmission(page.id, authorId))
      : false

    const rows = authorId
      ? await CARDINAL.db
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
      : await CARDINAL.db.insert(submissionsTable).values(values).returning()

    const stored = rows[0]
    CARDINAL.logger.debug('pages', 'stored an edit suggestion', {
      page: page.id,
      author: authorId ?? 'guest'
    })

    if (!hadOpenSubmission) {
      await CARDINAL.models.approvalNotifications.notifyReviewersOfSubmission(
        siteId,
        page,
        stored.id
      )
      await CARDINAL.models.hooks.emit('approval:submitted', siteId, {
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
   * The HIGHEST `minApprovals` among every enabled rule matching the page, not the lowest: a page a
   * stricter rule also covers should not be finalizable by satisfying only the laxer one. Read live
   * rather than frozen at submission time, so changing a rule's threshold takes effect on the
   * submissions already waiting.
   *
   * The 1 default should not be reachable for a submission `approveSubmission` accepted, but leaves
   * nothing stuck requiring zero approvers if it ever is.
   */
  private async requiredApprovalsForPage(siteId: string, page: ApprovalPageMatch): Promise<number> {
    const rules = await CARDINAL.models.approvalRules.getRules(siteId)
    let required = 1
    for (const rule of rules) {
      if (rule.isEnabled && CARDINAL.models.approvalRules.matchesPage(rule, page)) {
        required = Math.max(required, rule.minApprovals)
      }
    }
    return required
  }

  /** One query for the whole batch: a round trip per row would scale with the queue's length. */
  private async approvalCountsFor(
    submissionIds: string[],
    viewerId?: string
  ): Promise<Map<string, { count: number; hasApproved: boolean }>> {
    const counts = new Map<string, { count: number; hasApproved: boolean }>()
    if (submissionIds.length < 1) {
      return counts
    }
    const rows = await CARDINAL.db
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
   * A suggestion is theirs to review when an enabled rule covers its page and names a group they are
   * in AND they hold `read:pages` on that page. The two are independent permission axes: approval
   * rules are blind to ordinary page permissions -- `matchesPage()` only knows START / END / REGEX /
   * TAG / TAGALL, with no ALLOW/DENY and no classification of its own. Without the intersection, a
   * rule with `match: 'START', path: ''` would hand its `reviewerGroups` every page's title, tags and
   * content regardless of a DENY, a classification tier, the password gate or a `read:pages` denial.
   */
  async getReviewableSubmissions(
    siteId: string,
    actor: AccessActor,
    { groupIds, reviewsAll = false, viewerId, pageId }: ReviewerScope & { pageId?: string }
  ): Promise<ReviewableSubmission[]> {
    if (!reviewsAll && groupIds.length < 1) {
      return []
    }
    const rules = (await CARDINAL.models.approvalRules.getRules(siteId)).filter(
      (rule) =>
        rule.isEnabled && (reviewsAll || rule.reviewerGroups.some((id) => groupIds.includes(id)))
    )
    if (rules.length < 1) {
      return []
    }

    const rows = await CARDINAL.db
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
        // -> A resolved submission is retained rather than deleted, so the queue has to filter it out
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
          be MADE. One already sent stays in its reviewers' queue if the page is later closed, rather
          than stranding work somebody submitted in good faith with nobody able to answer it.
        */
        CARDINAL.models.approvalRules.matchesPage(rule, {
          path: row.pagePath,
          tags: row.pageTags ?? []
        })
      )
    )

    const readableRows = matchedRows.filter((row: any) =>
      CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
        path: row.pagePath,
        siteId,
        locale: row.pageLocale,
        tags: row.pageTags ?? [],
        classification: row.pageClassification ?? null
      })
    )

    // -> Every enabled rule, not just the ones naming this reviewer's groups: the threshold is set
    //    by the strictest rule covering the page, whoever it names. `requiredApprovalsForPage`'s
    //    logic is inlined below to share this one `getRules` read across every row.
    const allRules = await CARDINAL.models.approvalRules.getRules(siteId)
    const approvalCounts = await this.approvalCountsFor(
      readableRows.map((row: any) => row.id),
      viewerId
    )

    return readableRows.map((row: any) => {
      const pageMatch = { path: row.pagePath, tags: row.pageTags ?? [] }
      let approvalsRequired = 1
      for (const rule of allRules) {
        if (rule.isEnabled && CARDINAL.models.approvalRules.matchesPage(rule, pageMatch)) {
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
   * `pageContent` additionally requires `read:source` (or what implies it, `mayReadSourceAs`) on the
   * page, on top of the `read:pages` the queue itself already requires: the current page body is
   * exactly what a direct page view withholds without it, and a pending suggestion is not a way
   * around that. Refused with a missing field, not a 403 -- the reviewer still needs the rest of
   * this response to act on the queue entry.
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

    const rows = await CARDINAL.db
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

    const maySeeSource = mayReadSourceAs(actor, siteId, {
      path: detail.pagePath,
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
   * The content applied when the threshold is met is whatever THIS LAST reviewer settled on, which is
   * not necessarily what was submitted — the review screen lets them adjust it before accepting.
   * Earlier approvers' `content`/`render` are not applied: their call only recorded a vote. The write
   * is attributed to the reviewer — they are the one putting it on the page, and a guest submitter
   * has no account to attribute it to.
   *
   * `baseHash` is re-checked before EVERY approve rather than only the finalizing one: the reviewer's
   * `isStale` display and this write are different moments, and an approval recorded against a page
   * that has since moved would count towards a threshold for content nobody re-confirmed. Refusing
   * with `'stale'` lets the caller reload the diff and reconcile it instead of silently discarding
   * whatever changed underneath.
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
    /** Omitted, `updatePage()` queues a re-render, which needs the Puppeteer extension. */
    render?: string
    actor: { id: string; permissions: string[]; groupIds: string[] }
  }): Promise<ApproveSubmissionResult> {
    const rows = await CARDINAL.db
      .select({
        id: submissionsTable.id,
        pageId: submissionsTable.pageId,
        baseHash: submissionsTable.baseHash,
        status: submissionsTable.status,
        // -> Whose markup this is, for the submitter render permissions below
        authorId: submissionsTable.authorId,
        guestName: submissionsTable.guestName,
        guestEmail: submissionsTable.guestEmail
      })
      .from(submissionsTable)
      .where(and(eq(submissionsTable.id, submissionId), eq(submissionsTable.siteId, siteId)))
      .limit(1)
    const submission = rows[0]
    // -> Checked before the staleness comparison below: a resolved submission's `baseHash` is stale
    //    by definition, which would report 'stale' where the truth is 'not-found'
    if (!submission || submission.status !== 'open') {
      return { ok: false, reason: 'not-found' }
    }

    const page = await CARDINAL.models.pages.getPage({
      siteId,
      id: submission.pageId,
      withContent: true
    })
    if (!page) {
      return { ok: false, reason: 'not-found' }
    }

    // -> Accepting a suggestion writes the page exactly like a direct save does, and being named in
    //    a rule's `reviewerGroups` is a different permission axis from holding `write:pages` on it
    if (
      !CARDINAL.models.groups.checkAccess(actor, 'write:pages', {
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
      enter the finalize branch. `onConflictDoNothing` alone is not enough -- it suppresses a repeat
      vote *row* from the same reviewer, not the count both requests go on to read. `updatePage` stays
      out of it: it does its own history/watcher/search/hook/storage I/O, which must not run while
      holding a row lock.

      So marking `status: 'approved'` below is a CLAIM, not yet a fact -- it is what blocks a
      concurrent reviewer from also finalizing, before this call has written the page. Everything down
      to the successful `updatePage()` is obligated to make that claim true or undo it via
      `revertFailedFinalization()`: every other query here requires `status = 'open'` to act on a row,
      so a row left `approved` with no write behind it has no retry path.
    */
    const decision = await CARDINAL.db.transaction(async (tx) => {
      const lockedRows = await tx
        .select({ id: submissionsTable.id, status: submissionsTable.status })
        .from(submissionsTable)
        .where(eq(submissionsTable.id, submissionId))
        .for('update')
      if (!lockedRows[0] || lockedRows[0].status !== 'open') {
        // -> Resolved by a concurrent call that reached this transaction first
        return { ok: false as const, reason: 'not-found' as const }
      }

      await tx
        .insert(submissionApprovalsTable)
        .values({ submissionId, reviewerId: actor.id })
        // -> A double click or a retried request must not count as a second, different sign-off
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

      // -> The `status = 'open'` guard is defense-in-depth: the `for('update')` re-check above already
      //    serializes this against a concurrent writer at the Postgres level, but this write should
      //    not be the one place trusting the lock alone. A 0-rowcount result is treated as not-found
      //    rather than a silent "finalized" claim over content that was never written.
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

    // -> "A reviewer approved", not "the page was finalized": a subscriber on a multi-approver rule
    //    sees each sign-off, not only the last
    await CARDINAL.models.hooks.emit('approval:approved', siteId, {
      id: submissionId,
      pageId: page.id,
      path: page.path,
      siteId,
      authorId: actor.id
    })

    if (!decision.finalized) {
      CARDINAL.logger.debug('pages', 'recorded an approval, waiting on more reviewers', {
        submission: submissionId,
        page: page.id,
        approvals: `${decision.approvalsCount}/${decision.approvalsRequired}`
      })
      return decision
    }

    // -> `updatePage()` below is called with `actor: reviewer`, since the reviewer performed the
    //    write, but the markup being sanitized is the SUBMITTER's -- deliberately different actors
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
    try {
      await CARDINAL.models.pages.updatePage(
        siteId,
        page.id,
        { content, ...(render && { render }) },
        actor,
        submitterRenderPermissions
      )
    } catch (err: any) {
      await this.revertFailedFinalization(submissionId)
      CARDINAL.logger.warn(
        'pages',
        'writing the approved edit suggestion failed, reverted it back to open for retry',
        { submission: submissionId, page: page.id, error: err }
      )
      throw err
    }
    CARDINAL.logger.debug('pages', 'approved an edit suggestion', {
      submission: submissionId,
      page: page.id
    })

    // -> `skipIfWatching`: the `updatePage()` above already queued a "page updated" notice to every
    //    watcher, this author included, and two notices for one event is one too many
    await CARDINAL.models.approvalNotifications.notifySubmissionAuthor(
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
   * `status: 'approved'` is a claim held only to block a concurrent reviewer from also finalizing;
   * without this compensating update a failed page write leaves it standing forever, since every
   * other query here acts on `status = 'open'` alone -- unfixable by a retry and invisible as
   * broken, because it just reads as resolved.
   */
  private async revertFailedFinalization(submissionId: string): Promise<void> {
    await CARDINAL.db
      .update(submissionsTable)
      .set({ status: 'open', resolvedBy: null, updatedAt: new Date() })
      .where(and(eq(submissionsTable.id, submissionId), eq(submissionsTable.status, 'approved')))
  }

  /**
   * The SUBMITTER's `write:scripts`/`write:styles`, not the reviewer's. The submit route only
   * requires a matching submit rule, and explicitly allows a guest; the reviewer's own browser then
   * renders that markdown and posts the resulting HTML to `approveSubmission`. Resolving these from
   * the reviewer the way an ordinary save does would let them launder a submitter's `<script>`/inline
   * `style` past a permission the submitter never had -- a confused-deputy path that turns a
   * technical control into a human one for third-party content the reviewer only skimmed as a diff.
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
    // -> From the db, not a session/API key: the submitter has no request of their own here
    const submitterActor = {
      id: authorId,
      ...(await CARDINAL.models.groups.actorForUserId(authorId))
    }
    return {
      scripts: hasPermission(submitterActor, 'write:scripts', pageRef),
      styles: hasPermission(submitterActor, 'write:styles', pageRef)
    }
  }

  /**
   * The submission is retained with `status: 'declined'` rather than deleted so it can be shown back
   * to its author along with `reason`. No page write means no `updatePage()` watcher notice to
   * collide with, so this always notifies, logged in or guest, with no `skipIfWatching` to consider.
   */
  async rejectSubmission(
    siteId: string,
    submissionId: string,
    reason: string | null,
    resolvedBy: string
  ): Promise<boolean> {
    const rows = await CARDINAL.db
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

    const result = await CARDINAL.db
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
          // -> A repeat decline of an already resolved row is a no-op (`false`), not a silent
          //    overwrite of its reason and resolver
          eq(submissionsTable.status, 'open')
        )
      )
    const declined = (result.rowCount ?? 0) > 0

    if (declined && page) {
      await CARDINAL.models.hooks.emit('approval:rejected', siteId, {
        id: submissionId,
        pageId: page.pageId,
        path: page.pagePath,
        siteId,
        authorId: resolvedBy
      })

      await CARDINAL.models.approvalNotifications.notifySubmissionAuthor(
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

  toReviewable(
    row: any,
    approvals: ApprovalProgress = { approvalsCount: 0, approvalsRequired: 1, hasApproved: false }
  ): ReviewableSubmission {
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
