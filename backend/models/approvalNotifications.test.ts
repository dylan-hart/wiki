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
 * One schema for the whole file: every `setupTestDb()` call is a `CREATE SCHEMA`, the full migration
 * set and a seed, and both describes want the same fixture.
 *
 * The guard inside the hook is what a per-describe `{ skip }` cannot do: a root `before()` runs even
 * when every describe is skipped, so without it an unset `DATABASE_URL` throws out of the hook.
 */
let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

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
   * Inserted directly rather than through `groups.assignUserToGroup`, which also enforces the
   * guests-group rule and so reads a `systemIds.guestsGroupId` the test fixture's minimal `CARDINAL`
   * does not set. Membership itself is only a `userGroups` row.
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

  // Drives the real `sendSubmissionNotification` and stubs only the outbound `mail.send`, so
  // inlining the strings back into the send path fails here.
  test('the reviewer notice resolves its subject/text/html via locale keys, in the reviewer’s own locale', async () => {
    const group = await groupsModel.createGroup('Localized Notice Reviewers')
    await assignToGroup(group, reviewerAId)
    await fixtures.db
      .update(usersTable)
      .set({ prefs: { locale: 'fr' } })
      .where(eq(usersTable.id, reviewerAId))
    await approvalRules.createRule(fixtures.siteId, {
      name: 'localized notice rule',
      isEnabled: true,
      match: 'START',
      path: 'notify/localized',
      submitterGroups: [],
      reviewerGroups: [group]
    })

    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'notify/localized/page',
        title: 'Localized',
        editor: 'markdown',
        content: 'Original'
      },
      actor
    )

    const resolveString = mock.method(CARDINAL.models.locales, 'resolveString')
    const send = mock.method(mail, 'send', async () => {})

    await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Suggested',
      authorId: fixtures.userId
    })

    assert.equal(send.mock.callCount(), 1)
    const [sent] = send.mock.calls[0]!.arguments as [any]
    assert.equal(sent.kind, 'approval')

    const noticeCalls = resolveString.mock.calls.filter((call) =>
      String(call.arguments[1]).startsWith('mail.approvalReviewNotice.')
    )
    assert.equal(noticeCalls.length, 3)
    for (const call of noticeCalls) {
      assert.equal(call.arguments[0], 'fr')
    }
    const keys = noticeCalls.map((call) => call.arguments[1]).sort()
    assert.deepEqual(keys, [
      'mail.approvalReviewNotice.html',
      'mail.approvalReviewNotice.subject',
      'mail.approvalReviewNotice.text'
    ])

    // -> No 'fr' translation is installed, so the lookup falls back to `en`: these are the
    //    en.json-templated strings, asserted to prove the templates are what got sent.
    assert.equal(sent.subject, `New edit suggestion waiting for review: ${page.path}`)
    assert.match(sent.text, /^A new edit suggestion is waiting for your review on "/)
    assert.match(sent.html, /^<p>A new edit suggestion is waiting for your review on <strong>/)

    resolveString.mock.restore()
    send.mock.restore()
  })
})

/**
 * The author's outcome notice rides the same `notifyPageWatchers` job path as an ordinary page-edit
 * notice, addressed directly at them; `skipIfWatching` is what stops an approve from ALSO sending
 * the generic "page updated" notice `updatePage()` queues for a watcher. A guest author has no
 * account for a job to address, so theirs goes straight through `models/mail.ts`.
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

      // -> `pageWatching.listWatchers` re-checks `read:pages` against a watcher's current groups
      //    before queuing, so an author in no group is filtered out of `updatePage()`'s own watcher
      //    notice -- which the double-notify test needs to see queued. The fixture group starts with
      //    empty `rules`, so both the membership row and the granting rule are set up here.
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
      mail.sendPageWatchNotification = originalSendPageWatchNotification
      ;(
        CARDINAL.scheduler.addJob as unknown as { mock: { resetCalls: () => void } }
      ).mock.resetCalls()
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

    function queuedNotifyJobs(): { task: string; payload: any }[] {
      const addJob = CARDINAL.scheduler.addJob as unknown as {
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
      await CARDINAL.models.pageWatching.watch({
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
      await CARDINAL.models.pageWatching.watch({
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
