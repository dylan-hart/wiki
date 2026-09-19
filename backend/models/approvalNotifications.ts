import { eq, inArray } from 'drizzle-orm'
import { userGroups as userGroupsTable, users as usersTable } from '../db/schema.ts'
import { escapeHtml } from './mail.ts'
import type { ApprovalPageMatch } from './approvalRules.ts'

/**
 * The mail an edit suggestion generates, kept apart from `models/approvals.ts` so the submission
 * lifecycle is not read through it: nothing here decides anything, it only reports a decision
 * already made.
 */
class ApprovalNotifications {
  /**
   * Deliberately not widened by `reviewsAll` (`manage:system` or `review:pages`): neither is a group
   * membership a recipient list could be built from, and whoever holds that access sees the page's
   * queue whenever they look.
   */
  async resolveReviewers(siteId: string, page: ApprovalPageMatch): Promise<string[]> {
    const groupIds = await CARDINAL.models.approvalRules.reviewerGroupIdsForPage(siteId, page)
    if (groupIds.length < 1) {
      return []
    }
    const rows = await CARDINAL.db
      .selectDistinct({ id: usersTable.id })
      .from(userGroupsTable)
      .innerJoin(usersTable, eq(usersTable.id, userGroupsTable.userId))
      .where(inArray(userGroupsTable.groupId, groupIds))
    return rows.map((row: any) => row.id)
  }

  /**
   * For a genuinely NEW submission only, never for a resubmission that lands on
   * `onConflictDoUpdate`: that row is already in reviewers' queues and shows the latest content
   * whenever it is opened, so re-notifying would repeat a fact the first notice established, once
   * per save an author makes while iterating.
   *
   * Never throws: the submission is already stored, and an untold reviewer must not turn a
   * successful submit into a failed request.
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
      CARDINAL.logger.warn('hooks', 'notifying the reviewers of a submission failed', {
        submission: submissionId,
        error: err
      })
    }
  }

  /**
   * A plain send per reviewer rather than the `notifyPageWatchers` job: review-queue membership comes
   * from the approval rules, not from watching the page, so there is no watcher preference or inbox
   * entry to reuse. Each send is isolated in its own `try`/`catch` so one reviewer's bounce or
   * missing address does not stop the rest of the queue being told.
   */
  private async sendSubmissionNotification(
    siteId: string,
    page: ApprovalPageMatch,
    submissionId: string,
    reviewerIds: string[]
  ): Promise<void> {
    const link = CARDINAL.models.mail.buildLink(
      '/_admin/approvals',
      CARDINAL.models.mail.resolveMailBaseURL(siteId)
    )
    for (const reviewerId of reviewerIds) {
      try {
        const reviewer = await CARDINAL.models.users.getById(reviewerId)
        if (!reviewer?.email) {
          CARDINAL.logger.warn('hooks', 'no email address on file, skipping the reviewer', {
            reviewer: reviewerId,
            submission: submissionId
          })
          continue
        }
        const safePath = escapeHtml(page.path)
        const locale = (reviewer.prefs as { locale?: string } | null)?.locale
        await CARDINAL.models.mail.send({
          to: reviewer.email,
          kind: 'approval',
          userId: reviewerId,
          subject: await CARDINAL.models.locales.resolveString(
            locale,
            'mail.approvalReviewNotice.subject',
            { path: page.path }
          ),
          text: await CARDINAL.models.locales.resolveString(
            locale,
            'mail.approvalReviewNotice.text',
            { path: page.path, link }
          ),
          html: await CARDINAL.models.locales.resolveString(
            locale,
            'mail.approvalReviewNotice.html',
            { path: safePath, link }
          )
        })
      } catch (err: any) {
        CARDINAL.logger.warn('hooks', 'sending the submission notification failed', {
          reviewer: reviewerId,
          submission: submissionId,
          error: err
        })
      }
    }
  }

  /**
   * A guest has no account to watch anything with, so theirs goes straight through `models/mail.ts`
   * to the `guestEmail` on record. A logged-in author's rides the `notifyPageWatchers` job but is
   * addressed directly rather than resolved through `pageWatching.listWatchers()`: a watch
   * preference must not be able to opt an author out of the outcome of their own suggestion.
   *
   * @param skipIfWatching Approve-only: the finalizing approve writes the page, so `updatePage()`
   *   already queues its generic "page updated" notice to every watcher, the author included. A
   *   decline writes nothing and so always passes `false`.
   *
   * Never throws: a notification failure must not turn a successful approve/decline into a failed
   * request.
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
        const actorUser = await CARDINAL.models.users.getById(actorId)
        await CARDINAL.models.mail.sendPageWatchNotification({
          to: author.guestEmail,
          siteId,
          page: { title: page.title, path: page.path, locale: page.locale },
          action,
          changedFields: [],
          actorName: actorUser?.name ?? 'Someone'
        })
        return
      }

      if (
        skipIfWatching &&
        (await CARDINAL.models.pageWatching.isWatching(page.id, author.authorId))
      ) {
        return
      }

      await CARDINAL.scheduler.addJob({
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
      CARDINAL.logger.warn('hooks', 'notifying the submission author failed', {
        page: page.id,
        error: err
      })
    }
  }
}

export const approvalNotifications = new ApprovalNotifications()
