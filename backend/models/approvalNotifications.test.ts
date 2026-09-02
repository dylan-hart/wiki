import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { approvalRules } from './approvalRules.ts'
import { approvalNotifications } from './approvalNotifications.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor } from './pages.ts'
import type { ApprovalPageRef } from './approvalRules.ts'
import type { GroupRule } from './groups.ts'
import { mail } from './mail.ts'

/**
 * One schema for the whole file rather than one per describe (TEST-F14): every `setupTestDb()` call
 * is a `CREATE SCHEMA`, the full migration set and a seed, and each describe below wants the same
 * fixture. Anything a describe needs on top of that stays in its own `before()`.
 */
let fixtures: TestFixtures

before(async () => {
  fixtures = await setupTestDb()
})

after(async () => {
  await teardownTestDb()
})

/**
 * `saveSubmission`'s reviewer-notification trigger: who gets told, and when.
 *
 * Reviewer resolution is exercised through `resolveReviewers` directly (SQL orchestration across
 * `userGroups`/`users`, same reasoning as the rest of this file), and the trigger point itself --
 * notify on a new submission, stay silent on a resubmission that lands on `onConflictDoUpdate` -- is
 * exercised by spying on `sendSubmissionNotification`, the stubbed delivery call, so these tests do
 * not depend on Feature 375's transport ever landing.
 */
describe('approvals reviewer notification (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let groupsModel: typeof import('./groups.ts').groups
  let actor: PageActor
  let reviewerAId: string
  let reviewerBId: string

  before(async () => {
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    ;({ groups: groupsModel } = await import('./groups.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    const [reviewerA] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'reviewer-a@example.com',
        name: 'Reviewer A',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    reviewerAId = reviewerA!.id

    const [reviewerB] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'reviewer-b@example.com',
        name: 'Reviewer B',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    reviewerBId = reviewerB!.id
  })

  function pageRef(page: { id: string; path: string }): ApprovalPageRef {
    return {
      id: page.id,
      path: page.path,
      locale: 'en',
      tags: [],
      allowContributions: true,
      classification: null
    }
  }

  /**
   * Inserted directly rather than through `groups.assignUserToGroup`: that method also enforces the
   * guests-group membership rule, which reads `WIKI.data.systemIds.guestsGroupId` -- a full-boot value
   * this fixture's minimal `WIKI` deliberately does not set (see `test/db.ts`). Membership itself is
   * nothing more than a row in `userGroups`.
   */
  async function assignToGroup(groupId: string, userId: string) {
    await fixtures.db.insert(userGroupsTable).values({ groupId, userId })
  }

  test('resolveReviewers unions reviewerGroups across every enabled rule that matches the page, deduplicated', async () => {
    const groupOne = await groupsModel.createGroup('Reviewers One')
    const groupTwo = await groupsModel.createGroup('Reviewers Two')
    await assignToGroup(groupOne, reviewerAId)
    // -> Reviewer B is in both groups: the union must still list them once
    await assignToGroup(groupOne, reviewerBId)
    await assignToGroup(groupTwo, reviewerBId)

    await approvalRules.createRule(fixtures.siteId, {
      name: 'rule one',
      isEnabled: true,
      match: 'START',
      path: 'notify/dedup',
      submitterGroups: [],
      reviewerGroups: [groupOne]
    })
    await approvalRules.createRule(fixtures.siteId, {
      name: 'rule two',
      isEnabled: true,
      match: 'START',
      path: 'notify/dedup',
      submitterGroups: [],
      reviewerGroups: [groupTwo]
    })
    // -> Disabled, and would also match: neither its reviewer group nor anyone in it should show up
    const disabledGroup = await groupsModel.createGroup('Disabled Rule Reviewers')
    await assignToGroup(disabledGroup, reviewerAId)
    await approvalRules.createRule(fixtures.siteId, {
      name: 'disabled rule',
      isEnabled: false,
      match: 'START',
      path: 'notify/dedup',
      submitterGroups: [],
      reviewerGroups: [disabledGroup]
    })

    const reviewerIds = await approvalNotifications.resolveReviewers(fixtures.siteId, {
      path: 'notify/dedup/page',
      tags: []
    })

    assert.deepEqual([...reviewerIds].sort(), [reviewerAId, reviewerBId].sort())
  })

  test('resolveReviewers returns nothing when no enabled rule matches the page', async () => {
    const group = await groupsModel.createGroup('Unmatched Rule Reviewers')
    await assignToGroup(group, reviewerAId)
    await approvalRules.createRule(fixtures.siteId, {
      name: 'elsewhere',
      isEnabled: true,
      match: 'START',
      path: 'notify/nowhere-near',
      submitterGroups: [],
      reviewerGroups: [group]
    })

    const reviewerIds = await approvalNotifications.resolveReviewers(fixtures.siteId, {
      path: 'notify/unrelated-page',
      tags: []
    })

    assert.deepEqual(reviewerIds, [])
  })

  test('notifies reviewers once for a new submission, and does not re-notify when the same author resubmits', async () => {
    const group = await groupsModel.createGroup('Trigger Point Reviewers')
    await assignToGroup(group, reviewerAId)
    await approvalRules.createRule(fixtures.siteId, {
      name: 'trigger point rule',
      isEnabled: true,
      match: 'START',
      path: 'notify/trigger',
      submitterGroups: [],
      reviewerGroups: [group]
    })

    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'notify/trigger/page', title: 'Trigger', editor: 'markdown', content: 'Original' },
      actor
    )

    const send = mock.method(
      approvalNotifications as any,
      'sendSubmissionNotification',
      async () => {}
    )

    const first = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'First suggestion',
      authorId: fixtures.userId
    })
    assert.equal(send.mock.callCount(), 1)
    const [firstCallSiteId, firstCallPage, firstCallSubmissionId, firstCallReviewerIds] =
      send.mock.calls[0]!.arguments
    assert.equal(firstCallSiteId, fixtures.siteId)
    assert.equal(firstCallPage.path, page.path)
    assert.equal(firstCallSubmissionId, first.id)
    assert.deepEqual(firstCallReviewerIds, [reviewerAId])

    // -> Same author, same page: this lands on `onConflictDoUpdate`, replacing the still-open
    //    suggestion rather than creating a new one -- and must not notify a second time.
    const resubmitted = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Revised suggestion',
      authorId: fixtures.userId
    })
    assert.equal(
      resubmitted.id,
      first.id,
      'the update replaced the same row rather than adding one'
    )
    assert.equal(
      send.mock.callCount(),
      1,
      'resubmitting a still-open suggestion must not re-notify'
    )

    send.mock.restore()
  })

  test('a guest submission always notifies, since a guest has no open suggestion to replace', async () => {
    const group = await groupsModel.createGroup('Guest Trigger Reviewers')
    await assignToGroup(group, reviewerAId)
    await approvalRules.createRule(fixtures.siteId, {
      name: 'guest trigger rule',
      isEnabled: true,
      match: 'START',
      path: 'notify/guest-trigger',
      submitterGroups: [],
      reviewerGroups: [group]
    })

    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'notify/guest-trigger/page',
        title: 'Guest Trigger',
        editor: 'markdown',
        content: 'Original'
      },
      actor
    )

    const send = mock.method(
      approvalNotifications as any,
      'sendSubmissionNotification',
      async () => {}
    )

    await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Guest suggestion',
      authorId: null,
      guestName: 'A Guest',
      guestEmail: 'guest@example.com'
    })

    assert.equal(send.mock.callCount(), 1)
    send.mock.restore()
  })
})

/**
 * OpenProject #2134: the submission author is told the outcome on approve and decline, through the
 * same `notifyPageWatchers` job path a logged-in author's watch preference would otherwise route an
 * ordinary page-edit notice through, addressed directly at them (`skipIfWatching` is what stops
 * approve from ALSO sending the generic "page updated" notice `updatePage()` queues for a watcher). A
 * guest author has no account to address that job at, so their notification goes straight through
 * `models/mail.ts` to the stored `guestEmail` instead.
 */
describe(
  'approvals submission author notification (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let groupsModel: typeof import('./groups.ts').groups
    let actor: PageActor
    let authorId: string
    let reviewerBId: string

    before(async () => {
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      ;({ groups: groupsModel } = await import('./groups.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

      const [author] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'notify-author@example.com',
          name: 'Notify Author',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      authorId = author!.id

      // -> `models/pageWatching.ts#listWatchers` re-checks `read:pages` for each watcher's CURRENT
      //    group membership before queuing anything (OpenProject #2173) -- a submission author with
      //    no group at all would silently be filtered out of `updatePage()`'s own watcher notice,
      //    which is exactly what the "does not double-notify" test below needs to see queued.
      //    `fixtures.groupId` starts with empty `rules` (`test/db.ts`), so both the membership row
      //    and the rule granting it have to be set up here.
      await fixtures.db
        .insert(userGroupsTable)
        .values({ groupId: fixtures.groupId, userId: authorId })
      await fixtures.db
        .update(groupsTable)
        .set({
          rules: [
            {
              id: 'notify-author-read',
              name: 'Notify author read access',
              roles: ['read:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            } satisfies GroupRule
          ]
        })
        .where(eq(groupsTable.id, fixtures.groupId))
      await groupsModel.reloadCache()

      const [reviewerB] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'notify-reviewer-b@example.com',
          name: 'Notify Reviewer B',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      reviewerBId = reviewerB!.id

      await approvalRules.createRule(fixtures.siteId, {
        name: 'notify covers everything',
        isEnabled: true,
        match: 'START',
        path: '',
        submitterGroups: [],
        reviewerGroups: []
      })
    })

    const originalSendPageWatchNotification = mail.sendPageWatchNotification.bind(mail)

    beforeEach(() => {
      // -> A stub installed by one test must not leak into the next.
      mail.sendPageWatchNotification = originalSendPageWatchNotification
      ;(WIKI.scheduler.addJob as unknown as { mock: { resetCalls: () => void } }).mock.resetCalls()
    })

    function pageRef(page: { id: string; path: string }): ApprovalPageRef {
      return {
        id: page.id,
        path: page.path,
        locale: 'en',
        tags: [],
        allowContributions: true,
        classification: null
      }
    }

    /** Every `notifyPageWatchers` job queued since the last reset, decoded from the stub scheduler. */
    function queuedNotifyJobs(): { task: string; payload: any }[] {
      const addJob = WIKI.scheduler.addJob as unknown as {
        mock: { calls: { arguments: [{ task: string; payload: any }] }[] }
      }
      return addJob.mock.calls
        .map((call) => call.arguments[0])
        .filter((call) => call.task === 'notifyPageWatchers')
    }

    test('a finalizing approve queues a suggestApproved notification addressed to the author', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'notify-author/approve',
          title: 'Approve Me',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Suggested',
        authorId
      })

      const result = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested',
        render: '<p>Suggested</p>',
        actor
      })
      assert.equal(result.ok, true)
      assert.equal((result as any).finalized, true)

      const jobs = queuedNotifyJobs().filter((job) => job.payload.action === 'suggestApproved')
      assert.equal(jobs.length, 1)
      assert.deepEqual(jobs[0]!.payload.watchers, [{ userId: authorId, notifyMode: 'immediate' }])
      assert.equal(jobs[0]!.payload.pageId, page.id)
      assert.equal(jobs[0]!.payload.actorId, actor.id)
    })

    test('an approve does not double-notify an author who already watches the page', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'notify-author/approve-watching',
          title: 'Approve Watching',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )
      await WIKI.models.pageWatching.watch({
        siteId: fixtures.siteId,
        pageId: page.id,
        userId: authorId
      })
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Suggested',
        authorId
      })

      await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested',
        render: '<p>Suggested</p>',
        actor
      })

      // -> `updatePage()`'s own generic notice still queues (action: 'updated') -- only the
      //    submission-specific one must be skipped
      const suggestJobs = queuedNotifyJobs().filter(
        (job) => job.payload.action === 'suggestApproved'
      )
      assert.equal(suggestJobs.length, 0)
      const updatedJobs = queuedNotifyJobs().filter((job) => job.payload.action === 'updated')
      assert.equal(updatedJobs.length, 1)
      assert.deepEqual(updatedJobs[0]!.payload.watchers, [
        { userId: authorId, notifyMode: 'digest' }
      ])
    })

    test('a decline always queues a suggestDeclined notification, even for an author who watches the page', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'notify-author/decline-watching',
          title: 'Decline Watching',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )
      await WIKI.models.pageWatching.watch({
        siteId: fixtures.siteId,
        pageId: page.id,
        userId: authorId
      })
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Suggested',
        authorId
      })

      const declined = await approvalsModel.rejectSubmission(
        fixtures.siteId,
        submission.id,
        null,
        actor.id
      )
      assert.equal(declined, true)

      const jobs = queuedNotifyJobs().filter((job) => job.payload.action === 'suggestDeclined')
      assert.equal(jobs.length, 1)
      assert.deepEqual(jobs[0]!.payload.watchers, [{ userId: authorId, notifyMode: 'immediate' }])
    })

    test('a partial approve, short of the threshold, does not notify the author yet', async () => {
      await approvalRules.createRule(fixtures.siteId, {
        name: 'notify threshold two',
        isEnabled: true,
        match: 'START',
        path: 'notify-author/partial',
        submitterGroups: [],
        reviewerGroups: [],
        minApprovals: 2
      })
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'notify-author/partial/page',
          title: 'Partial',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Suggested',
        authorId
      })

      const firstApprove = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested',
        render: '<p>Suggested</p>',
        actor
      })
      assert.equal((firstApprove as any).finalized, false)
      assert.equal(
        queuedNotifyJobs().filter((job) => job.payload.action === 'suggestApproved').length,
        0,
        'no notification yet -- the threshold has not been reached'
      )

      const secondApprove = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested',
        render: '<p>Suggested</p>',
        actor: { id: reviewerBId, permissions: ['manage:system'], groupIds: [] }
      })
      assert.equal((secondApprove as any).finalized, true)
      assert.equal(
        queuedNotifyJobs().filter((job) => job.payload.action === 'suggestApproved').length,
        1,
        'the finalizing approve notifies'
      )
    })

    test('an approve notifies a guest author directly by mail, not through the scheduler', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'notify-author/guest-approve',
          title: 'Guest Approve',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Suggested',
        authorId: null,
        guestName: 'A Guest',
        guestEmail: 'guest-approve@example.com'
      })

      const send = mock.method(mail, 'sendPageWatchNotification', async () => {})

      await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested',
        render: '<p>Suggested</p>',
        actor
      })

      assert.equal(send.mock.callCount(), 1)
      const [args] = send.mock.calls[0]!.arguments as [any]
      assert.equal(args.to, 'guest-approve@example.com')
      assert.equal(args.action, 'suggestApproved')
      assert.equal(
        queuedNotifyJobs().filter((job) => job.payload.action === 'suggestApproved').length,
        0,
        'a guest has no account for the job to address'
      )
      send.mock.restore()
    })

    test('a decline notifies a guest author directly by mail, not through the scheduler', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'notify-author/guest-decline',
          title: 'Guest Decline',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Suggested',
        authorId: null,
        guestName: 'A Guest',
        guestEmail: 'guest-decline@example.com'
      })

      const send = mock.method(mail, 'sendPageWatchNotification', async () => {})

      const declined = await approvalsModel.rejectSubmission(
        fixtures.siteId,
        submission.id,
        null,
        actor.id
      )
      assert.equal(declined, true)

      assert.equal(send.mock.callCount(), 1)
      const [args] = send.mock.calls[0]!.arguments as [any]
      assert.equal(args.to, 'guest-decline@example.com')
      assert.equal(args.action, 'suggestDeclined')
      send.mock.restore()
    })
  }
)
