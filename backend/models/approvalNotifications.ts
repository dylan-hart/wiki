import { eq, inArray } from 'drizzle-orm'
import { userGroups as userGroupsTable, users as usersTable } from '../db/schema.ts'
import { escapeHtml } from './mail.ts'
import type { ApprovalPageMatch } from './approvalRules.ts'

/**
 * Approval notifications model
 *
 * The mail an edit suggestion generates: reviewers told there is something waiting, and an author
 * told what became of what they sent. Split out of `models/approvals.ts` (MOD-F13) so the submission
 * lifecycle is not read through the mail it happens to send — nothing here decides anything, it only
 * reports a decision already made.
 */
class ApprovalNotifications {
  /**
   * Every user who should be told a suggestion is waiting on this page: the members of every enabled
   * rule's `reviewerGroups` that matches it, deduplicated across both overlapping rules and overlapping
   * group membership.
   *
   * Deliberately not widened by `reviewsAll` (`manage:system` or `review:pages`): neither of those is a
   * group membership a recipient list could be built from -- whoever holds that access sees the page's
   * queue whenever they look, whether or not they were named in a rule and told about this particular
   * entry.
   */
  async resolveReviewers(siteId: string, page: ApprovalPageMatch): Promise<string[]> {
    const groupIds = await WIKI.models.approvals.reviewerGroupIdsForPage(siteId, page)
    if (groupIds.length < 1) {
      return []
    }
    const rows = await WIKI.db
      .selectDistinct({ id: usersTable.id })
      .from(userGroupsTable)
      .innerJoin(usersTable, eq(usersTable.id, userGroupsTable.userId))
      .where(inArray(userGroupsTable.groupId, groupIds))
    return rows.map((row: any) => row.id)
  }

  /**
   * Tell this page's reviewers that a suggestion is waiting on them.
   *
   * Called once from `saveSubmission`, for a genuinely NEW submission only -- never for a
   * resubmission that lands on the `onConflictDoUpdate` path, i.e. an author replacing their own
   * still-open suggestion. That row was already in reviewers' queues; revising its content does not
   * put it there a second time, and whoever opens it sees the latest content regardless of when it was
   * last edited. The alternative -- re-notifying on every save -- would mean a reviewer hearing about
   * the same pending item once per keystroke-save an author makes while iterating, for no new fact
   * ("something is waiting on you") a first notification did not already establish. So: notify on
   * insert, stay silent on update.
   *
   * Never throws: the submission is already safely stored by the time this runs, and a reviewer not
   * being told about it is a real loss but must never turn a successful submit into a failed request.
   */
  async notifyReviewersOfSubmission(
    siteId: string,
    page: ApprovalPageMatch,
    submissionId: string
  ): Promise<void> {
    try {
      const reviewerIds = await this.resolveReviewers(siteId, page)
      if (reviewerIds.length < 1) {
        return
      }
      await this.sendSubmissionNotification(siteId, page, submissionId, reviewerIds)
    } catch (err: any) {
      WIKI.logger.warn(`Failed to notify reviewers of submission ${submissionId}: ${err.message}`)
    }
  }

  /**
   * Tell every resolved reviewer a suggestion is waiting on them, by mail.
   *
   * A plain send per reviewer with an email address, not routed through the `notifyPageWatchers` job:
   * reviewing is not a preference a page-watch row could express (a reviewer's own review-queue
   * membership comes from the approval rules, not from watching the page -- see `resolveReviewers`),
   * so there is no watcher preference or in-app inbox entry to reuse here the way a submission
   * author's own decision notice does. Each recipient's send is isolated in its own `try`/`catch`: one
   * reviewer's bounce or missing email must not stop the rest of the queue from being told.
   */
  private async sendSubmissionNotification(
    siteId: string,
    page: ApprovalPageMatch,
    submissionId: string,
    reviewerIds: string[]
  ): Promise<void> {
    const link = WIKI.models.mail.buildLink(
      '/_admin/approvals',
      WIKI.models.mail.resolveMailBaseURL(siteId)
    )
    for (const reviewerId of reviewerIds) {
      try {
        const reviewer = await WIKI.models.users.getById(reviewerId)
        if (!reviewer?.email) {
          WIKI.logger.warn(
            `Skipping submission notification for reviewer ${reviewerId}: no email address on file.`
          )
          continue
        }
        const safePath = escapeHtml(page.path)
        await WIKI.models.mail.send({
          to: reviewer.email,
          subject: `New edit suggestion waiting for review: ${page.path}`,
          text: `A new edit suggestion is waiting for your review on "${page.path}" — ${link}`,
          html: `<p>A new edit suggestion is waiting for your review on <strong>${safePath}</strong> — <a href="${link}">${link}</a></p>`
        })
      } catch (err: any) {
        WIKI.logger.warn(
          `Failed to send submission notification to reviewer ${reviewerId} for submission ${submissionId}: ${err.message}`
        )
      }
    }
  }

  /**
   * Tell a submission's author their suggestion was approved or declined.
   *
   * A guest has no account to watch anything with, so their notification always goes straight through
   * `models/mail.ts` to the `guestEmail` on record. A logged in author is told the same way any other
   * page-watch change would reach them -- queued through the existing `notifyPageWatchers` job -- but
   * addressed directly at just this one person rather than resolved via `pageWatching.listWatchers()`:
   * being told the outcome of your own suggestion is not something the author's watch preference
   * should be able to opt them out of the way an ordinary edit notification can be.
   *
   * @param skipIfWatching Approve-only: `updatePage()` already queues its own generic "page updated by
   *   <reviewer>" notice to every watcher when the finalizing approve writes the page, the author
   *   included if they watch it -- this is what stops that from becoming a second, more specific
   *   notice on top. `rejectSubmission` never writes the page, so nothing else tells the author
   *   anything, and always passes this as `false`.
   *
   * Never throws: a notification failure must not turn an already-successful approve/decline into a
   * failed request, the same contract `notifyReviewersOfSubmission` keeps for the reviewer side.
   */
  async notifySubmissionAuthor(
    siteId: string,
    page: { id: string; title: string; path: string; locale: string },
    action: 'suggestApproved' | 'suggestDeclined',
    author: { authorId: string | null; guestName: string | null; guestEmail: string | null },
    actorId: string,
    { skipIfWatching = false }: { skipIfWatching?: boolean } = {}
  ): Promise<void> {
    try {
      if (!author.authorId) {
        if (!author.guestEmail) {
          return
        }
        const actorUser = await WIKI.models.users.getById(actorId)
        await WIKI.models.mail.sendPageWatchNotification({
          to: author.guestEmail,
          siteId,
          page: { title: page.title, path: page.path, locale: page.locale },
          action,
          changedFields: [],
          actorName: actorUser?.name ?? 'Someone'
        })
        return
      }

      if (skipIfWatching && (await WIKI.models.pageWatching.isWatching(page.id, author.authorId))) {
        return
      }

      await WIKI.scheduler.addJob({
        task: 'notifyPageWatchers',
        payload: {
          siteId,
          pageId: page.id,
          pageTitle: page.title,
          pagePath: page.path,
          pageLocale: page.locale,
          action,
          changedFields: [],
          actorId,
          watchers: [{ userId: author.authorId, notifyMode: 'immediate' }]
        }
      })
    } catch (err: any) {
      WIKI.logger.warn(`Failed to notify submission author of page ${page.id}: ${err.message}`)
    }
  }
}

export const approvalNotifications = new ApprovalNotifications()
