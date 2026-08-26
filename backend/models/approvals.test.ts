import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { userGroups as userGroupsTable, users as usersTable } from '../db/schema.ts'
import type { PageActor } from './pages.ts'
import type { ApprovalPageRef } from './approvals.ts'

/**
 * `approveSubmission` writes to the page and closes the suggestion out -- almost entirely SQL
 * orchestration across the submissions, pages and rules tables -- so this runs the real methods
 * against a migrated, per-run-fresh database (see `test/db.ts`), the same call `models/pages.test.ts`
 * makes for the same reason.
 *
 * Covers the approve-time staleness race: a submission's `baseHash` is checked again immediately
 * before the write, not just when the reviewer's `GET .../submissions/:id` computed `isStale` for
 * display. Includes the two-pending-submissions case, where approving the first must stale the
 * second on the very next read -- there is no cache in front of `getReviewableSubmissions` to miss.
 */
describe('approvals approveSubmission staleness (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let actor: PageActor
  let secondAuthorId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    const [secondAuthor] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'second-author@example.com',
        name: 'Second Author',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    secondAuthorId = secondAuthor!.id

    // -> One rule covering every page, enabled, so `getReviewableSubmissions` (used below to check
    //    staleness lands on the *next read* with no manual refresh) has something to match against.
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'covers everything',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: []
    })
  })

  after(async () => {
    await teardownTestDb()
  })

  async function makePage(path: string, content: string) {
    return pagesModel.createPage(
      fixtures.siteId,
      { path, title: path, editor: 'markdown', content },
      actor
    )
  }

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

  test('approves cleanly when the page has not moved since the submission was based on it', async () => {
    const page = await makePage('approvals/clean', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    const result = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })

    assert.deepEqual(result, {
      ok: true,
      finalized: true,
      approvalsCount: 1,
      approvalsRequired: 1
    })
    const updated = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(updated!.content, 'Suggested content')
  })

  test('refuses with a stale reason when the page changed after the reviewer loaded the diff', async () => {
    const page = await makePage('approvals/moved', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    // -> Somebody else writes to the page in between the reviewer's GET and their approve click
    await pagesModel.updatePage(
      fixtures.siteId,
      page.id,
      { content: 'Somebody else changed this' },
      actor
    )

    const result = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })

    assert.deepEqual(result, { ok: false, reason: 'stale' })

    // -> Refused, so the interleaving write is not silently clobbered
    const untouched = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(untouched!.content, 'Somebody else changed this')

    // -> And the submission is still there to be reconciled, not silently discarded
    const stillPending = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
      groupIds: [],
      reviewsAll: true,
      pageId: page.id
    })
    assert.ok(stillPending.some((s) => s.id === submission.id))
  })

  test('returns not-found for a submission that does not exist', async () => {
    const result = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: '00000000-0000-0000-0000-000000000000',
      content: 'x',
      render: '<p>x</p>',
      actor
    })
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
  })

  test('approving one of two pending submissions on the same page stales the other on the very next read', async () => {
    const page = await makePage('approvals/two-pending', 'Original content')
    const first = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'First suggestion',
      authorId: fixtures.userId
    })
    const second = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Second suggestion',
      authorId: secondAuthorId
    })

    // Sanity: before either is approved, neither is stale
    const beforeApproval = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
      groupIds: [],
      reviewsAll: true,
      pageId: page.id
    })
    assert.equal(beforeApproval.find((s) => s.id === first.id)!.isStale, false)
    assert.equal(beforeApproval.find((s) => s.id === second.id)!.isStale, false)

    const approveFirst = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: first.id,
      content: 'First suggestion',
      render: '<p>First suggestion</p>',
      actor
    })
    assert.deepEqual(approveFirst, {
      ok: true,
      finalized: true,
      approvalsCount: 1,
      approvalsRequired: 1
    })

    // -> `getReviewableSubmissions` joins the live page row every time it is called -- there is no
    //    cache sitting in front of it to miss, so this is what "without a manual queue refresh" means
    const afterFirstApproval = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
      groupIds: [],
      reviewsAll: true,
      pageId: page.id
    })
    const secondNow = afterFirstApproval.find((s) => s.id === second.id)
    assert.ok(secondNow, 'the second submission is still in the queue')
    assert.equal(secondNow!.isStale, true)

    // And approving the second is now refused, for exactly the reason it shows as stale
    const approveSecond = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: second.id,
      content: 'Second suggestion',
      render: '<p>Second suggestion</p>',
      actor
    })
    assert.deepEqual(approveSecond, { ok: false, reason: 'stale' })
  })
})

/**
 * OpenProject #2165: `approveSubmission()` writes the reviewer's content straight to the page, so it
 * is still a write and takes the same `write:pages` a direct save would -- approval-rule
 * (`reviewerGroups`) membership alone must not be enough to push arbitrary content onto a page nobody
 * granted this reviewer write access to. Covers both halves of the done-when: a reviewer who matches
 * the rule but holds no `write:pages` on the target is refused, with the page untouched and the
 * submission left pending rather than partially applied; a reviewer who does hold it still succeeds.
 */
describe(
  'approvals approveSubmission write:pages gate (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let groupsModel: typeof import('./groups.ts').groups
    let authorActor: PageActor
    let noWriteGroupId: string
    let writeGroupId: string
    let noWriteReviewerId: string
    let writeReviewerId: string

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      ;({ groups: groupsModel } = await import('./groups.ts'))
      authorActor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

      // -> `createGroup`'s own default rule grants only read:pages/read:assets/read:comments -- no
      //    write:pages -- which is exactly the "reviewer matches the rule but holds no write:pages"
      //    case this gate exists for.
      noWriteGroupId = await groupsModel.createGroup('WP2165 reviewers, no write:pages')

      // -> A second group, granted write:pages everywhere, for the "and still succeeds for one who
      //    does" half of the done-when.
      writeGroupId = await groupsModel.createGroup('WP2165 reviewers, with write:pages')
      await groupsModel.updateGroup(writeGroupId, {
        rules: [
          {
            id: 'wp2165-write-rule',
            name: 'Grants write:pages',
            roles: ['read:pages', 'write:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          }
        ]
      })

      // -> Both groups are reviewer groups on the same rule -- membership in either gets a submission
      //    into the review queue, but only `writeGroupId` also grants the permission that actually
      //    writing the page requires.
      await approvalsModel.createRule(fixtures.siteId, {
        name: 'covers everything',
        isEnabled: true,
        match: 'START',
        path: '',
        submitterGroups: [],
        reviewerGroups: [noWriteGroupId, writeGroupId]
      })

      const [noWriteReviewer] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'wp2165-no-write@example.com',
          name: 'No Write Reviewer',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      noWriteReviewerId = noWriteReviewer!.id

      const [writeReviewer] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'wp2165-write@example.com',
          name: 'Write Reviewer',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      writeReviewerId = writeReviewer!.id
    })

    after(async () => {
      await teardownTestDb()
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

    async function makePage(path: string, content: string) {
      return pagesModel.createPage(
        fixtures.siteId,
        { path, title: path, editor: 'markdown', content },
        authorActor
      )
    }

    test('refuses the write, leaving content and submission untouched, for a reviewer with no write:pages on the target', async () => {
      const page = await makePage('approvals/write-gate-refused', 'Original content')
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original content',
        content: 'Suggested content',
        authorId: fixtures.userId
      })

      const result = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor: { id: noWriteReviewerId, permissions: [], groupIds: [noWriteGroupId] }
      })

      assert.deepEqual(result, { ok: false, reason: 'forbidden' })

      const untouched = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        withContent: true
      })
      assert.equal(untouched!.content, 'Original content')

      const stillPending = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
        groupIds: [],
        reviewsAll: true,
        pageId: page.id
      })
      assert.ok(stillPending.some((s) => s.id === submission.id))
    })

    test('succeeds and writes the page for a reviewer who holds write:pages on the target', async () => {
      const page = await makePage('approvals/write-gate-allowed', 'Original content')
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original content',
        content: 'Suggested content',
        authorId: fixtures.userId
      })

      const result = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor: { id: writeReviewerId, permissions: [], groupIds: [writeGroupId] }
      })

      assert.deepEqual(result, {
        ok: true,
        finalized: true,
        approvalsCount: 1,
        approvalsRequired: 1
      })

      const updated = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        withContent: true
      })
      assert.equal(updated!.content, 'Suggested content')
    })
  }
)

/**
 * OpenProject #828: multi-approver minimum-threshold support. `approveSubmission` used to write the
 * page and close the submission out on the very first approve, whoever cast it -- a single-approver
 * sign-off no matter how many reviewers a rule named. These pin the threshold behaviour a rule's
 * `minApprovals` now adds: an approve short of the threshold only records a vote and leaves the page
 * untouched, the same reviewer approving twice does not count as two different sign-offs, and the
 * threshold enforced is the strictest of every enabled rule currently covering the page.
 */
describe('approvals multi-approver threshold (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let actor: PageActor
  let reviewerBId: string
  let reviewerCId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    const [reviewerB] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'threshold-reviewer-b@example.com',
        name: 'Threshold Reviewer B',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    reviewerBId = reviewerB!.id

    const [reviewerC] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'threshold-reviewer-c@example.com',
        name: 'Threshold Reviewer C',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    reviewerCId = reviewerC!.id
  })

  after(async () => {
    await teardownTestDb()
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

  test('a rule requiring 2 approvals leaves the page untouched after the first, and writes it on the second from a different reviewer', async () => {
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'requires two',
      isEnabled: true,
      match: 'START',
      path: 'approvals/threshold/two',
      submitterGroups: [],
      reviewerGroups: [],
      minApprovals: 2
    })
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/threshold/two/page',
        title: 'Threshold Two',
        editor: 'markdown',
        content: 'Original content'
      },
      actor
    )
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    const firstApprove = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })
    assert.deepEqual(firstApprove, {
      ok: true,
      finalized: false,
      approvalsCount: 1,
      approvalsRequired: 2
    })

    // -> Not written yet: only one of the two required approvals is in
    const untouched = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(untouched!.content, 'Original content')

    // -> Still in the queue, and shows progress towards the threshold
    const pending = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
      groupIds: [],
      reviewsAll: true,
      pageId: page.id,
      viewerId: fixtures.userId
    })
    const pendingEntry = pending.find((s) => s.id === submission.id)
    assert.ok(pendingEntry)
    assert.deepEqual(pendingEntry!.approvals, {
      approvalsCount: 1,
      approvalsRequired: 2,
      hasApproved: true
    })

    // -> A second, DIFFERENT reviewer reaches the threshold and their own content/render is what gets
    //    written
    const secondApprove = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Second reviewer content',
      render: '<p>Second reviewer content</p>',
      actor: { id: reviewerBId, permissions: ['manage:system'], groupIds: [] }
    })
    assert.deepEqual(secondApprove, {
      ok: true,
      finalized: true,
      approvalsCount: 2,
      approvalsRequired: 2
    })

    const finalPage = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(finalPage!.content, 'Second reviewer content')

    // -> Closed out: gone from the queue
    const afterFinalize = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
      groupIds: [],
      reviewsAll: true,
      pageId: page.id
    })
    assert.equal(
      afterFinalize.some((s) => s.id === submission.id),
      false
    )
  })

  test('the same reviewer approving twice counts once, and does not finalize a threshold of 2 on its own', async () => {
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'requires two, same reviewer twice',
      isEnabled: true,
      match: 'START',
      path: 'approvals/threshold/dedup',
      submitterGroups: [],
      reviewerGroups: [],
      minApprovals: 2
    })
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/threshold/dedup/page',
        title: 'Threshold Dedup',
        editor: 'markdown',
        content: 'Original content'
      },
      actor
    )
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })
    // -> Same reviewer (`actor`) approving again must not be a second, different sign-off
    const repeated = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })
    assert.deepEqual(repeated, {
      ok: true,
      finalized: false,
      approvalsCount: 1,
      approvalsRequired: 2
    })

    const untouched = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(untouched!.content, 'Original content')
  })

  test('the threshold enforced is the strictest of every enabled rule currently matching the page', async () => {
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'lax',
      isEnabled: true,
      match: 'START',
      path: 'approvals/threshold/strictest',
      submitterGroups: [],
      reviewerGroups: [],
      minApprovals: 1
    })
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'strict',
      isEnabled: true,
      match: 'START',
      path: 'approvals/threshold/strictest',
      submitterGroups: [],
      reviewerGroups: [],
      minApprovals: 3
    })
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/threshold/strictest/page',
        title: 'Threshold Strictest',
        editor: 'markdown',
        content: 'Original content'
      },
      actor
    )
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    const first = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })
    assert.equal(first.ok, true)
    assert.equal((first as any).approvalsRequired, 3)
    assert.equal((first as any).finalized, false)

    await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor: { id: reviewerBId, permissions: ['manage:system'], groupIds: [] }
    })
    const third = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor: { id: reviewerCId, permissions: ['manage:system'], groupIds: [] }
    })
    assert.deepEqual(third, {
      ok: true,
      finalized: true,
      approvalsCount: 3,
      approvalsRequired: 3
    })
  })
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
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let groupsModel: typeof import('./groups.ts').groups
  let actor: PageActor
  let reviewerAId: string
  let reviewerBId: string

  before(async () => {
    fixtures = await setupTestDb()
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

  after(async () => {
    await teardownTestDb()
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

    await approvalsModel.createRule(fixtures.siteId, {
      name: 'rule one',
      isEnabled: true,
      match: 'START',
      path: 'notify/dedup',
      submitterGroups: [],
      reviewerGroups: [groupOne]
    })
    await approvalsModel.createRule(fixtures.siteId, {
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
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'disabled rule',
      isEnabled: false,
      match: 'START',
      path: 'notify/dedup',
      submitterGroups: [],
      reviewerGroups: [disabledGroup]
    })

    const reviewerIds = await approvalsModel.resolveReviewers(fixtures.siteId, {
      path: 'notify/dedup/page',
      tags: []
    })

    assert.deepEqual([...reviewerIds].sort(), [reviewerAId, reviewerBId].sort())
  })

  test('resolveReviewers returns nothing when no enabled rule matches the page', async () => {
    const group = await groupsModel.createGroup('Unmatched Rule Reviewers')
    await assignToGroup(group, reviewerAId)
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'elsewhere',
      isEnabled: true,
      match: 'START',
      path: 'notify/nowhere-near',
      submitterGroups: [],
      reviewerGroups: [group]
    })

    const reviewerIds = await approvalsModel.resolveReviewers(fixtures.siteId, {
      path: 'notify/unrelated-page',
      tags: []
    })

    assert.deepEqual(reviewerIds, [])
  })

  test('notifies reviewers once for a new submission, and does not re-notify when the same author resubmits', async () => {
    const group = await groupsModel.createGroup('Trigger Point Reviewers')
    await assignToGroup(group, reviewerAId)
    await approvalsModel.createRule(fixtures.siteId, {
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

    const send = mock.method(approvalsModel as any, 'sendSubmissionNotification', async () => {})

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
    await approvalsModel.createRule(fixtures.siteId, {
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

    const send = mock.method(approvalsModel as any, 'sendSubmissionNotification', async () => {})

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
 * `findSubmitRule`'s additive contract: when several enabled rules all let the same groups suggest
 * an edit to a page, the method still answers, but WHICH of them it returns is not something a
 * caller may depend on -- see the doc comment on the method itself. What every caller in this repo
 * actually relies on is truthiness, so that is what this pins down: a non-null result when any rule
 * matches, `null` the moment none does, unaffected by how many others also matched.
 */
describe(
  'approvals findSubmitRule additive semantics (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let actor: PageActor

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    })

    after(async () => {
      await teardownTestDb()
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

    test('returns a rule when two enabled rules both match the same page for the same groups', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'approvals/overlap/page',
          title: 'Overlap',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )

      // -> Both cover this page for `fixtures.groupId`; nothing here says which one "wins" -- there is
      //    nothing to win, only whether at least one of them matches
      await approvalsModel.createRule(fixtures.siteId, {
        name: 'broad',
        isEnabled: true,
        match: 'START',
        path: 'approvals/overlap',
        submitterGroups: [fixtures.groupId],
        reviewerGroups: []
      })
      await approvalsModel.createRule(fixtures.siteId, {
        name: 'narrow',
        isEnabled: true,
        match: 'EXACT',
        path: 'approvals/overlap/page',
        submitterGroups: [fixtures.groupId],
        reviewerGroups: []
      })

      const rule = await approvalsModel.findSubmitRule(fixtures.siteId, pageRef(page), [
        fixtures.groupId
      ])

      // -> The only contract: truthy when covered. Which rule's id came back is deliberately not
      //    asserted -- that is the exact thing the doc comment says not to rely on.
      assert.ok(rule)
    })

    test('returns null the moment no enabled rule matches, even with an unrelated rule for the same groups elsewhere', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'approvals/no-match/page',
          title: 'No Match',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )

      await approvalsModel.createRule(fixtures.siteId, {
        name: 'elsewhere',
        isEnabled: true,
        match: 'START',
        path: 'approvals/somewhere-else',
        submitterGroups: [fixtures.groupId],
        reviewerGroups: []
      })

      const rule = await approvalsModel.findSubmitRule(fixtures.siteId, pageRef(page), [
        fixtures.groupId
      ])

      assert.equal(rule, null)
    })
  }
)

/**
 * A guest has no account, so `saveSubmission`'s one-open-suggestion-per-page dedup (the
 * `onConflictDoUpdate` path, keyed on `(pageId, authorId)`) never applies to them -- the partial
 * unique index behind it is scoped to `authorId IS NOT NULL` specifically because guests are all the
 * same nobody and cannot be deduplicated against each other. Two different guests suggesting an edit
 * to the same page must therefore both land as their own row, and `getReviewableSubmissions` must
 * still hand a reviewer two distinguishable entries back -- even when both guests left the name and
 * email blank, which is the case the frontend queue has to render without them collapsing into what
 * looks like one submission shown twice (see `InboxReview.vue`'s `authorLabel`).
 */
describe('approvals guest multi-submission (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    await approvalsModel.createRule(fixtures.siteId, {
      name: 'covers everything',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
  })

  after(async () => {
    await teardownTestDb()
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

  test('two different guests suggesting an edit to the same page both persist', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/guests/named',
        title: 'Named Guests',
        editor: 'markdown',
        content: 'Original'
      },
      actor
    )

    await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'First guest suggestion',
      authorId: null,
      guestName: 'Alice',
      guestEmail: 'alice@example.com'
    })
    await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Second guest suggestion',
      authorId: null,
      guestName: 'Bob',
      guestEmail: 'bob@example.com'
    })

    // -> Neither replaced the other -- unlike two submissions from the same logged in author, which
    //    `onConflictDoUpdate` collapses into one row
    assert.equal(await approvalsModel.countSubmissions(page.id), 2)

    const reviewable = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
      groupIds: [fixtures.groupId]
    })
    const forPage = reviewable.filter((s) => s.page.id === page.id)
    assert.equal(forPage.length, 2)
    assert.deepEqual(forPage.map((s) => s.author.name).sort(), ['Alice', 'Bob'])
    // -> Genuinely two different rows, not the same one read twice
    assert.notEqual(forPage[0]!.id, forPage[1]!.id)
  })

  test('two guests who both left the name and email blank still persist and read back as two distinct entries', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/guests/blank',
        title: 'Blank Guests',
        editor: 'markdown',
        content: 'Original'
      },
      actor
    )

    const first = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'First blank guest suggestion',
      authorId: null
    })
    const second = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Second blank guest suggestion',
      authorId: null
    })

    assert.equal(await approvalsModel.countSubmissions(page.id), 2)
    // -> Not the same submission stored twice under one id -- two independent rows, each with its own
    //    content, which is exactly what lets the frontend disambiguate them by id when their author
    //    labels are otherwise identical
    assert.notEqual(first.id, second.id)

    const reviewable = await approvalsModel.getReviewableSubmissions(fixtures.siteId, {
      groupIds: [fixtures.groupId]
    })
    const forPage = reviewable.filter((s) => s.page.id === page.id)
    assert.equal(forPage.length, 2)
    for (const submission of forPage) {
      assert.equal(submission.author.isGuest, true)
      assert.equal(submission.author.id, null)
      // -> Blank, not a placeholder string -- the frontend is the layer responsible for turning this
      //    into "Unknown" and disambiguating two of them, not the model
      assert.equal(submission.author.name, '')
    }
    assert.deepEqual(forPage.map((s) => s.id).sort(), [first.id, second.id].sort())
  })
})

describe('approvals pageViewerState siteId threading (task 678)', () => {
  /**
   * Regression test for task 678: `pageViewerState`'s reviewer-scope check calls
   * `WIKI.models.groups.checkAccess` directly (not through `mayOnPage`/`mayOnAsset`, so task 673's
   * fix never touched it), but the inline page ref it built never carried `siteId` — so a
   * `review:pages` rule scoped to one site (task 671) could not tell this site apart from another's.
   * `siteId` is already `pageViewerState`'s second parameter; this only proves it reaches the
   * `checkAccess` call.
   *
   * The reviewer-scope `checkAccess` call is only reached for an authenticated session whose group
   * permissions don't already include `manage:system` (that short-circuits first).
   * `allowContributions: false` on the page ref keeps `findSubmitRule`/`getOwnSubmission` from
   * needing a real DB.
   */

  let checkAccessCalls: any[] = []

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        groups: {
          actorForRequest: () => ({ groupIds: [], permissions: [] }),
          checkAccess: (actor: any, permission: string, page: any) => {
            checkAccessCalls.push(page)
            return true
          }
        }
      }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('pageViewerState: threads siteId into the RulePageRef passed to checkAccess', async () => {
    checkAccessCalls = []
    const { approvals } = await import('./approvals.ts')

    const req = {
      session: {
        authenticated: true,
        user: { id: 'user-1' },
        groups: [],
        permissions: []
      }
    }

    await approvals.pageViewerState(req, '11111111-1111-4111-8111-111111111111', {
      id: 'page-1',
      path: 'engineering/onboarding',
      locale: 'en',
      tags: [],
      allowContributions: false,
      classification: null
    })

    assert.equal(checkAccessCalls.length, 1)
    assert.equal(checkAccessCalls[0].siteId, '11111111-1111-4111-8111-111111111111')
    // -> Task 992: the ref's locale threads through too, same as siteId did for task 678
    assert.equal(checkAccessCalls[0].locale, 'en')
  })
})

/**
 * OpenProject #966: same fix, and the same reasoning, as `models/groups.ts`'s
 * `groups.broadcastReload` suite — `createRule`/`updateRule`/`deleteRule` used to call
 * `reloadCache()` directly, refreshing only this instance's own cache. See that suite's doc comment
 * for the full writeup; this one just re-proves the wiring for the approvals model.
 */
describe('approvals.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let approvalsModel: typeof import('./approvals.ts').approvals

  before(async () => {
    fixtures = await setupTestDb()
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('createRule broadcasts reloadApprovals after refreshing this instance', async () => {
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'broadcast create',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadApprovals'))
  })

  test('updateRule broadcasts reloadApprovals after refreshing this instance', async () => {
    const rule = await approvalsModel.createRule(fixtures.siteId, {
      name: 'broadcast update',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await approvalsModel.updateRule(fixtures.siteId, rule.id, { isEnabled: false })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadApprovals'))
  })

  test('deleteRule broadcasts reloadApprovals after refreshing this instance', async () => {
    const rule = await approvalsModel.createRule(fixtures.siteId, {
      name: 'broadcast delete',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await approvalsModel.deleteRule(fixtures.siteId, rule.id)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadApprovals'))
  })

  test('subscribeToEvents wires the inbound reloadApprovals event to reloadCache', async () => {
    let reloaded = false
    const originalReloadCache = approvalsModel.reloadCache.bind(approvalsModel)
    approvalsModel.reloadCache = async () => {
      reloaded = true
      await originalReloadCache()
    }
    try {
      approvalsModel.subscribeToEvents()
      const onCalls = (WIKI.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadApprovals')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadApprovals handler')
      await handler()
      assert.equal(reloaded, true)
    } finally {
      approvalsModel.reloadCache = originalReloadCache
    }
  })
})
