import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  pageEditSubmissions as submissionsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor } from './pages.ts'
import type { ApprovalPageRef } from './approvals.ts'
import type { GroupRule, AccessActor } from './groups.ts'
import { mail } from './mail.ts'

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

/**
 * How many suggestions are still waiting on a page, read straight off the table.
 *
 * The model used to carry this as `countSubmissions()`, but nothing in production ever called it --
 * an assertion helper is what it actually was, so it lives here now rather than on the model.
 */
async function countOpenSubmissions(pageId: string): Promise<number> {
  return WIKI.db.$count(
    submissionsTable,
    and(eq(submissionsTable.pageId, pageId), eq(submissionsTable.status, 'open'))
  )
}

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
    const stillPending = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
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
    const beforeApproval = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
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
    const afterFirstApproval = await approvalsModel.getReviewableSubmissions(
      fixtures.siteId,
      actor,
      {
        groupIds: [],
        reviewsAll: true,
        pageId: page.id
      }
    )
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

  /**
   * OpenProject #2349: the finalizing transaction commits `status: 'approved'` before `updatePage()`
   * (deliberately non-transactional -- see that transaction's own comment) actually writes the page.
   * A failure there used to leave the submission stuck `approved` forever with no write behind it and
   * no retry path, since every other query here requires `status = 'open'` to act on a row.
   */
  test('reverts the submission back to open (not stuck approved) when updatePage() throws after the approval threshold is met', async () => {
    const page = await makePage('approvals/write-failure', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    const updatePage = mock.method(pagesModel, 'updatePage', async () => {
      throw new Error('simulated write failure')
    })
    try {
      await assert.rejects(
        () =>
          approvalsModel.approveSubmission({
            siteId: fixtures.siteId,
            submissionId: submission.id,
            content: 'Suggested content',
            render: '<p>Suggested content</p>',
            actor
          }),
        /simulated write failure/
      )
    } finally {
      updatePage.mock.restore()
    }

    const [row] = await fixtures.db
      .select({ status: submissionsTable.status, resolvedBy: submissionsTable.resolvedBy })
      .from(submissionsTable)
      .where(eq(submissionsTable.id, submission.id))
      .limit(1)
    assert.equal(row!.status, 'open')
    assert.equal(row!.resolvedBy, null)

    const untouched = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(untouched!.content, 'Original content')

    // -> Visible in the reviewer queue again, and retriable: a later approve call is not blocked by a
    //    permanently-resolved row that was never actually written.
    const stillPending = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
      groupIds: [],
      reviewsAll: true,
      pageId: page.id
    })
    assert.ok(stillPending.some((s) => s.id === submission.id))

    const retried = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })
    assert.deepEqual(retried, {
      ok: true,
      finalized: true,
      approvalsCount: 1,
      approvalsRequired: 1
    })
    const written = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(written!.content, 'Suggested content')
  })
})

/**
 * OpenProject #2160/#2165: the approval-rule reviewer queue is a DIFFERENT permission axis from the
 * ordinary page-rule engine. Being named as a reviewer must never stand in for `read:source` (the
 * body a direct "view source" already requires) or `write:pages` (what accepting a suggestion
 * actually does to the page). Covers both halves of the write:pages done-when too: a reviewer who
 * matches the rule but holds no `write:pages` on the target is refused, with the page untouched and
 * the submission left pending rather than partially applied; a reviewer who does hold it still
 * succeeds.
 */
describe(
  'approvals reviewer-queue permission gating (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let groupsModel: typeof import('./groups.ts').groups
    let adminActor: PageActor
    /** Holds only `read:pages` -- named as a reviewer, but never granted `read:source`/`write:pages`. */
    let readOnlyActor: PageActor
    /** Holds `read:pages` and `write:pages`, but not `read:source` -- the "does hold it" half. */
    let writeActor: PageActor

    const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
      id: 'rule-1',
      name: 'Read-only reviewer',
      roles: ['read:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: [],
      sites: [],
      ...overrides
    })

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      ;({ groups: groupsModel } = await import('./groups.ts'))
      adminActor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
      readOnlyActor = { id: fixtures.userId, groupIds: [fixtures.groupId], permissions: [] }

      // -> Grants `read:pages` everywhere, and nothing else -- no `read:source`, no `write:pages`.
      await fixtures.db
        .update(groupsTable)
        .set({ rules: [rule()] })
        .where(eq(groupsTable.id, fixtures.groupId))
      await groupsModel.reloadCache()

      // -> A second group, granted `write:pages` too, for the "and still succeeds for one who does
      //    hold it" half of the done-when.
      //
      // -> `updateGroup()` -> `clampGuestPatch()` reads `WIKI.data.systemIds.guestsGroupId`
      //    unconditionally; the minimal `WIKI` from `setupTestDb()` leaves `WIKI.data` empty.
      WIKI.data.systemIds = { guestsGroupId: '00000000-0000-0000-0000-000000000000' }
      const writeGroupId = await groupsModel.createGroup('WP2165 reviewers, with write:pages')
      await groupsModel.updateGroup(writeGroupId, {
        rules: [rule({ id: 'rule-write', roles: ['read:pages', 'write:pages'] })]
      })
      const [writeReviewer] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'wp2165-write@example.com',
          name: 'Write Reviewer',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      writeActor = { id: writeReviewer!.id, groupIds: [writeGroupId], permissions: [] }

      // -> One rule covering every page, so this reviewer's `reviewsAll: true` scope has something to
      //    intersect with `read:pages` against. Both groups are reviewer groups on it -- membership in
      //    either gets a submission into the review queue, but only `writeGroupId` also grants the
      //    permission that actually writing the page requires.
      await approvalsModel.createRule(fixtures.siteId, {
        name: 'covers everything',
        isEnabled: true,
        match: 'START',
        path: '',
        submitterGroups: [],
        reviewerGroups: [fixtures.groupId, writeGroupId]
      })
    })

    after(async () => {
      await teardownTestDb()
    })

    test('getSubmissionForReview blanks pageContent for a reviewer who lacks read:source', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'approvals/source-gated',
          title: 'Source gated',
          editor: 'markdown',
          content: 'Secret body'
        },
        adminActor
      )
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: {
          id: page.id,
          path: page.path,
          locale: 'en',
          tags: [],
          allowContributions: true,
          classification: null
        },
        baseContent: 'Secret body',
        content: 'Suggested body',
        authorId: fixtures.userId
      })

      const detail = await approvalsModel.getSubmissionForReview(
        fixtures.siteId,
        submission.id,
        readOnlyActor,
        { groupIds: [], reviewsAll: true }
      )

      // -> `read:pages` still holds, so the row is reviewable at all -- only the current page source
      //    (which `read:source` gates) is withheld. The suggestion's own proposed text is unaffected.
      assert.ok(detail, 'reviewable: read:pages holds even though read:source does not')
      assert.equal(detail!.pageContent, undefined)
      assert.equal(detail!.content, 'Suggested body')
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
        adminActor
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
        actor: readOnlyActor
      })

      assert.deepEqual(result, { ok: false, reason: 'forbidden' })

      const untouched = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        withContent: true
      })
      assert.equal(untouched!.content, 'Original content')

      const stillPending = await approvalsModel.getReviewableSubmissions(
        fixtures.siteId,
        adminActor,
        {
          groupIds: [],
          reviewsAll: true,
          pageId: page.id
        }
      )
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
        actor: writeActor
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
  let hooksModel: typeof import('./hooks.ts').hooks
  let pageHistoryModel: typeof import('./pageHistory.ts').pageHistory
  let actor: PageActor
  let reviewerBId: string
  let reviewerCId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    ;({ hooks: hooksModel } = await import('./hooks.ts'))
    ;({ pageHistory: pageHistoryModel } = await import('./pageHistory.ts'))
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
    const pending = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
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
    const afterFinalize = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
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

  /**
   * OpenProject #1735: `approveSubmission` used to insert the vote, count approvals and (once the
   * threshold was met) write the page + delete the submission with no serialization at all -- two
   * concurrent calls could both observe "count has reached the threshold" and both go on to write.
   * `minApprovals: 1` is the sharpest version of this: a single reviewer's double-submit (a doubled
   * click, a retried request) is enough to trigger it, since both requests count the same one vote as
   * meeting the threshold.
   *
   * Fired as genuine concurrent calls (`Promise.all`, not sequential `await`s) against the real
   * database, so this actually exercises the transaction's `SELECT ... FOR UPDATE` row lock's
   * cross-connection serialization rather than merely re-describing the code's control flow. One call
   * must finalize; the other must see the
   * submission already gone and return `not-found`. `pageHistory`'s `updated` row count is used as
   * the proxy for "how many times did `updatePage` actually run" -- `hooks.emit('page:edit', ...)`
   * and `storage.dispatch('page:edit', ...)` are both called exactly once per `updatePage` call (see
   * `models/pages.ts#updatePage`), so a single history row is sufficient evidence that neither of
   * those ran twice either, without this test also having to stand up a real storage target (which
   * needs `WIKI.SERVERPATH` and the on-disk module definitions -- out of scope for this fix). A
   * subscribed webhook is cheap to set up, though, and gives an independent, direct check on top.
   */
  test('two concurrent approve calls from the same reviewer at minApprovals:1 finalize exactly once', async () => {
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'concurrent finalize',
      isEnabled: true,
      match: 'START',
      path: 'approvals/concurrent/finalize',
      submitterGroups: [],
      reviewerGroups: [],
      minApprovals: 1
    })
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/concurrent/finalize/page',
        title: 'Concurrent Finalize',
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

    const hookId = await hooksModel.createHook({
      name: 'concurrent finalize watcher',
      events: ['page:edit'],
      url: 'https://example.com/concurrent-finalize',
      siteId: fixtures.siteId
    })
    const addJob = WIKI.scheduler.addJob as unknown as {
      mock: { calls: { arguments: [{ task: string; payload: any }] }[]; resetCalls: () => void }
    }
    addJob.mock.resetCalls()

    const approveCall = () =>
      approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor
      })
    const [first, second] = await Promise.all([approveCall(), approveCall()])
    const results = [first, second]

    const finalized = results.filter((r) => r.ok && r.finalized)
    const notFound = results.filter((r) => !r.ok && r.reason === 'not-found')
    assert.equal(finalized.length, 1, 'exactly one call should finalize')
    assert.equal(notFound.length, 1, 'the losing call should see the submission already gone')

    const finalPage = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(finalPage!.content, 'Suggested content')

    const history = await pageHistoryModel.list(fixtures.siteId, page.id)
    assert.equal(
      history.items.filter((entry) => entry.action === 'updated').length,
      1,
      'the page should carry exactly one "updated" history version'
    )

    const webhookJobs = addJob.mock.calls.filter(
      (call) =>
        call.arguments[0].task === 'dispatchWebhook' && call.arguments[0].payload.hookId === hookId
    )
    assert.equal(webhookJobs.length, 1, 'the page:edit hook should fire exactly once')

    // -> Closed out: gone from the queue, and re-approving the finalized submission is a no-op
    //    not-found, not a second finalization
    const afterBoth = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested content',
      render: '<p>Suggested content</p>',
      actor
    })
    assert.deepEqual(afterBoth, { ok: false, reason: 'not-found' })
  })
})

/**
 * OpenProject #1735 (part of #1730): `approveSubmission` used to insert the vote, count approvals and
 * -- if the threshold was met -- write the page and delete the submission, all as separate statements
 * on the default connection with no lock. Two requests both reading a threshold-satisfying count could
 * both enter the finalize branch: `onConflictDoNothing` only suppresses a duplicate vote *row* from the
 * same reviewer, not the count both still went on to read, so a single reviewer's double-submit at
 * `minApprovals: 1` produced two `updated` history versions for one approval. `approveSubmission` now
 * takes a `for('update')` row lock inside a transaction spanning the vote-insert through the
 * finalize-or-not decision, so the second call blocks until the first commits, then finds the
 * submission already gone and returns not-found.
 */
describe('approvals concurrent finalisation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let pageHistoryModel: typeof import('./pageHistory.ts').pageHistory
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    ;({ pageHistory: pageHistoryModel } = await import('./pageHistory.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('two concurrent approvals at minApprovals 1 finalize exactly once; the loser gets not-found', async () => {
    // -> No rule created: `requiredApprovalsForPage` defaults to 1 when nothing matches, the same
    //    `minApprovals: 1` case the audit finding calls out.
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/concurrent/single-reviewer',
        title: 'Concurrent Single Reviewer',
        editor: 'markdown',
        content: 'Original content'
      },
      actor
    )
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: {
        id: page.id,
        path: page.path,
        locale: 'en',
        tags: [],
        allowContributions: true,
        classification: null
      },
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    // -> The same reviewer's double-submit: a double click or a retried request, both racing to
    //    finalize the same submission at once.
    const [first, second] = await Promise.all([
      approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor
      }),
      approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor
      })
    ])

    const results = [first, second]
    const finalized = results.filter((r) => r.ok && r.finalized)
    const notFound = results.filter((r) => !r.ok && r.reason === 'not-found')
    assert.equal(finalized.length, 1, 'exactly one call finalized the submission')
    assert.equal(notFound.length, 1, 'the loser sees the submission already gone')

    const finalPage = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(finalPage!.content, 'Suggested content')

    const entries = await pageHistoryModel.list(fixtures.siteId, page.id)
    const updated = entries.items.filter((e) => e.action === 'updated')
    assert.equal(updated.length, 1, 'exactly one updated history version, not two')

    // -> Closed out: gone from the queue, not left behind for either racer to find again
    const pending = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
      groupIds: [],
      reviewsAll: true,
      pageId: page.id
    })
    assert.equal(
      pending.some((s) => s.id === submission.id),
      false
    )
  })

  /**
   * OpenProject #2354: `approveSubmission`'s finalizing UPDATE had no `status = 'open'` guard on its
   * WHERE clause, unlike `rejectSubmission`'s. The `for('update')` row lock re-check just above it
   * already serializes a concurrent approve/decline pair at the Postgres level, so this exercises
   * that the pairing still resolves to exactly one winner with the guard in place -- never both a
   * finalized approve AND a successful decline for the same submission.
   */
  test('a concurrent approve and reject on the same submission resolve to exactly one winner', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'approvals/concurrent/approve-vs-reject',
        title: 'Concurrent Approve vs Reject',
        editor: 'markdown',
        content: 'Original content'
      },
      actor
    )
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: {
        id: page.id,
        path: page.path,
        locale: 'en',
        tags: [],
        allowContributions: true,
        classification: null
      },
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    const [approveResult, rejectResult] = await Promise.all([
      approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor
      }),
      approvalsModel.rejectSubmission(fixtures.siteId, submission.id, 'no thanks', fixtures.userId)
    ])

    const approveWon = approveResult.ok && approveResult.finalized
    const rejectWon = rejectResult === true
    // -> Exactly one side prevails -- never both (the page written AND the row left declined), and
    //    never neither (both losing to a state the other side never actually reached).
    assert.notEqual(
      approveWon,
      rejectWon,
      'approve and reject must not both win, and must not both lose'
    )

    const finalPage = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    const finalRows = await WIKI.db
      .select({ status: submissionsTable.status })
      .from(submissionsTable)
      .where(eq(submissionsTable.id, submission.id))
      .limit(1)

    if (approveWon) {
      assert.equal(finalPage!.content, 'Suggested content')
      assert.equal(finalRows[0]!.status, 'approved')
      assert.equal(rejectResult, false, 'the losing reject call must report no-op, not success')
    } else {
      assert.equal(finalPage!.content, 'Original content')
      assert.equal(finalRows[0]!.status, 'declined')
      assert.equal(approveResult.ok, false, 'the losing approve call must not report ok')
    }
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
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let groupsModel: typeof import('./groups.ts').groups
    let actor: PageActor
    let authorId: string
    let reviewerBId: string

    before(async () => {
      fixtures = await setupTestDb()
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

      await approvalsModel.createRule(fixtures.siteId, {
        name: 'notify covers everything',
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
      await approvalsModel.createRule(fixtures.siteId, {
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
    assert.equal(await countOpenSubmissions(page.id), 2)

    const reviewable = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
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

    assert.equal(await countOpenSubmissions(page.id), 2)
    // -> Not the same submission stored twice under one id -- two independent rows, each with its own
    //    content, which is exactly what lets the frontend disambiguate them by id when their author
    //    labels are otherwise identical
    assert.notEqual(first.id, second.id)

    const reviewable = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
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

/**
 * OpenProject #2187: `approveSubmission` must resolve `write:scripts`/`write:styles` from the
 * SUBMITTER, not the reviewer finalizing the approval -- otherwise a reviewer who happens to hold
 * either permission launders a submitter's `<script>`/inline handler past a grant the submitter
 * never had (see `resolveSubmitterRenderPermissions`'s own comment in `models/approvals.ts`).
 * `reviewer` below holds `manage:system` specifically because that is the case where laundering
 * would be easiest to miss -- it bypasses every page-rule check for the reviewer themselves.
 */
describe(
  'approvals render permissions resolve from the submitter, not the reviewer (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let reviewer: PageActor
    let scriptedAuthorId: string

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      reviewer = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

      await approvalsModel.createRule(fixtures.siteId, {
        name: 'covers everything',
        isEnabled: true,
        match: 'START',
        path: '',
        submitterGroups: [],
        reviewerGroups: []
      })

      // -> A second user, granted `write:scripts` through a real group rule -- the "submitter who
      //    DOES hold the permission" half of the assertion below.
      const [scriptedAuthor] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'scripted-author@example.com',
          name: 'Scripted Author',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      scriptedAuthorId = scriptedAuthor!.id

      const [scriptsGroup] = await fixtures.db
        .insert(groupsTable)
        .values({
          name: 'Scripters',
          permissions: [],
          rules: [
            {
              id: 'allow-scripts',
              name: 'Allow scripts',
              roles: ['write:scripts', 'write:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        })
        .returning({ id: groupsTable.id })
      await fixtures.db
        .insert(userGroupsTable)
        .values({ userId: scriptedAuthorId, groupId: scriptsGroup!.id })
      await WIKI.models.groups.reloadCache()
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

    test('strips <script> and on* from a guest-authored submission even though the reviewer holds write:scripts', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'approvals/render-perms/guest',
          title: 'Guest',
          editor: 'markdown',
          content: 'Original'
        },
        reviewer
      )
      const html = '<p onclick="alert(1)">hi</p><script>alert(2)</script>'
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Guest suggestion',
        authorId: null,
        guestName: 'Guest',
        guestEmail: 'guest@example.com'
      })

      const result = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Guest suggestion',
        render: html,
        actor: reviewer
      })

      assert.equal(result.ok, true)
      const updated = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        withContent: true
      })
      assert.doesNotMatch(updated!.render, /<script/)
      assert.doesNotMatch(updated!.render, /onclick/)
    })

    test('keeps <script> and on* from a submission whose author does hold write:scripts', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'approvals/render-perms/scripted',
          title: 'Scripted',
          editor: 'markdown',
          content: 'Original'
        },
        reviewer
      )
      const html = '<p onclick="alert(1)">hi</p><script>alert(2)</script>'
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Scripted suggestion',
        authorId: scriptedAuthorId
      })

      const result = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Scripted suggestion',
        render: html,
        actor: reviewer
      })

      assert.equal(result.ok, true)
      const updated = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        withContent: true
      })
      assert.match(updated!.render, /<script/)
      assert.match(updated!.render, /onclick/)
    })
  }
)

/**
 * `status`/`resolvedReason`/`resolvedBy` (OpenProject #2125): a freshly-inserted submission is
 * `open` with no resolution recorded yet, before any reviewer has acted on it. Approve/reject
 * actually setting these on resolution is sibling work (#2129) -- this only locks down what the
 * migrated schema itself hands back on insert.
 */
describe(
  'approvals submission resolution columns (DB-backed)',
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

    test('a new submission defaults to status open with no resolvedReason or resolvedBy', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'approvals/resolution-columns',
          title: 'Resolution Columns',
          editor: 'markdown',
          content: 'Original'
        },
        actor
      )

      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: {
          id: page.id,
          path: page.path,
          locale: 'en',
          tags: [],
          allowContributions: true,
          classification: null
        },
        baseContent: 'Original',
        content: 'Suggested edit',
        authorId: fixtures.userId
      })

      const rows = await WIKI.db
        .select({
          status: submissionsTable.status,
          resolvedReason: submissionsTable.resolvedReason,
          resolvedBy: submissionsTable.resolvedBy
        })
        .from(submissionsTable)
        .where(eq(submissionsTable.id, submission.id))
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.status, 'open')
      assert.equal(rows[0]!.resolvedReason, null)
      assert.equal(rows[0]!.resolvedBy, null)
    })
  }
)

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

/**
 * OpenProject #2160/#2165: approval-rule membership (`reviewerGroups`) used to be the ENTIRE gate on
 * the review queue, the raw-source read, and the write that accepting a suggestion performs -- none of
 * `getReviewableSubmissions`, `getSubmissionForReview`, or `approveSubmission` ever called
 * `checkAccess`. A rule with `match: 'START', path: ''` covers the whole site, so any member of its
 * `reviewerGroups` could read and overwrite any page's source regardless of `read:pages`/`read:source`/
 * `write:pages`, the page password gate, or a classification DENY. These assert the fix: a reviewer
 * denied `read:pages` never sees the page in their queue at all; one allowed `read:pages` but denied
 * `read:source` sees the queue entry with no `pageContent`; and `approveSubmission` refuses to write
 * without `write:pages` on the target, leaving the page and the submission untouched.
 */
describe(
  'approvals read:pages/read:source/write:pages gating (DB-backed, OpenProject #2160/#2165)',
  {
    skip: !hasTestDatabase()
  },
  () => {
    let fixtures: TestFixtures
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let groupsModel: typeof import('./groups.ts').groups
    let adminActor: PageActor
    let reviewerGroupId: string

    before(async () => {
      fixtures = await setupTestDb()
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      ;({ groups: groupsModel } = await import('./groups.ts'))
      adminActor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

      // -> Covers the whole site, matching the `match: 'START', path: ''` shape the WP calls out
      await approvalsModel.createRule(fixtures.siteId, {
        name: 'covers everything',
        isEnabled: true,
        match: 'START',
        path: '',
        submitterGroups: [],
        reviewerGroups: [] // -> filled in below once the reviewer group exists
      })

      const [reviewerGroup] = await fixtures.db
        .insert(groupsTable)
        .values({ name: 'Filtering Test Reviewer', permissions: [], rules: [] })
        .returning({ id: groupsTable.id })
      reviewerGroupId = reviewerGroup!.id
      await groupsModel.reloadCache()

      const rules = await approvalsModel.getRules(fixtures.siteId)
      await approvalsModel.updateRule(fixtures.siteId, rules[0]!.id, {
        reviewerGroups: [reviewerGroupId]
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

    /** A reviewer scope for `reviewerGroupId` -- the actor's own rules decide read:pages/read:source/write:pages. */
    function reviewerScope() {
      return { groupIds: [reviewerGroupId], reviewsAll: false }
    }

    test('a reviewer denied read:pages never sees the page in their queue', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'gating/denied-read',
          title: 'Denied Read',
          editor: 'markdown',
          content: 'Original'
        },
        adminActor
      )
      await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original',
        content: 'Suggested content',
        authorId: fixtures.userId
      })

      // -> This reviewer's own group grants nothing at all -- no read:pages rule, so checkAccess denies
      const blindActor: AccessActor = { groupIds: [randomUUID()], permissions: [] }
      const queue = await approvalsModel.getReviewableSubmissions(
        fixtures.siteId,
        blindActor,
        reviewerScope()
      )
      assert.equal(
        queue.some((s) => s.page.id === page.id),
        false
      )

      const detail = await approvalsModel.getSubmissionForReview(
        fixtures.siteId,
        queue[0]?.id ?? 'nonexistent',
        blindActor,
        reviewerScope()
      )
      assert.equal(detail, null)
    })

    /**
     * OpenProject #2341: `getReviewableSubmissions()` was flagged by an automated review as running
     * `checkAccess(actor, 'read:pages', ...)` twice per row -- once filtering `rows` into
     * `matchedRows`, then again filtering the already-filtered `matchedRows` into `readableRows` --
     * a redundant duplicate left over from merging two overlapping branches (#2150/#2160). Reading
     * the current source shows `matchedRows` is filtered by `matchesPage()` (approval-rule path/tag
     * matching, which never calls `checkAccess`) and only `readableRows` calls `checkAccess`, so the
     * two filters are not duplicates of each other -- but this spies on the real `checkAccess` to
     * prove it directly rather than trust a reading of the source: exactly one call per matched row,
     * not two, is what distinguishes "already fixed" from "still redundant".
     */
    test('read:pages is checked exactly once per matched row, not filtered twice (OpenProject #2341)', async () => {
      const pageOne = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'gating/single-check-one',
          title: 'Single Check One',
          editor: 'markdown',
          content: 'Body one'
        },
        adminActor
      )
      const pageTwo = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'gating/single-check-two',
          title: 'Single Check Two',
          editor: 'markdown',
          content: 'Body two'
        },
        adminActor
      )
      await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(pageOne),
        baseContent: 'Body one',
        content: 'Suggested one',
        authorId: fixtures.userId
      })
      await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(pageTwo),
        baseContent: 'Body two',
        content: 'Suggested two',
        authorId: fixtures.userId
      })

      const [readOnlyGroup] = await fixtures.db
        .insert(groupsTable)
        .values({
          name: 'Filtering Test Single Check',
          permissions: ['read:pages'],
          rules: [
            {
              id: randomUUID(),
              name: 'read:pages only',
              roles: ['read:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        })
        .returning({ id: groupsTable.id })
      await groupsModel.reloadCache()
      const readOnlyActor: AccessActor = { groupIds: [readOnlyGroup!.id], permissions: [] }

      // -> Spy on the real checkAccess rather than stub it out: this has to exercise the actual
      //    matchedRows -> readableRows pipeline, only counting how many times it runs.
      const originalCheckAccess = groupsModel.checkAccess.bind(groupsModel)
      let callCount = 0
      groupsModel.checkAccess = ((...args: Parameters<typeof originalCheckAccess>) => {
        callCount++
        return originalCheckAccess(...args)
      }) as typeof groupsModel.checkAccess

      let queue: Awaited<ReturnType<typeof approvalsModel.getReviewableSubmissions>>
      try {
        queue = await approvalsModel.getReviewableSubmissions(
          fixtures.siteId,
          readOnlyActor,
          reviewerScope()
        )
      } finally {
        groupsModel.checkAccess = originalCheckAccess
      }

      // -> readOnlyActor's rule ALLOWs read:pages everywhere, so every row `matchesPage()` matched
      //    is also readable -- matchedRows.length === readableRows.length === queue.length here,
      //    which is exactly what lets callCount === queue.length prove "once per row", not "twice".
      assert.ok(queue.some((s) => s.page.id === pageOne.id))
      assert.ok(queue.some((s) => s.page.id === pageTwo.id))
      assert.equal(callCount, queue.length)
    })

    test('a reviewer allowed read:pages but denied read:source sees the queue entry with no pageContent', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'gating/no-source',
          title: 'No Source',
          editor: 'markdown',
          content: 'Original body'
        },
        adminActor
      )
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original body',
        content: 'Suggested content',
        authorId: fixtures.userId
      })

      const [readOnlyGroup] = await fixtures.db
        .insert(groupsTable)
        .values({
          name: 'Filtering Test Read Only',
          permissions: ['read:pages'],
          rules: [
            {
              id: randomUUID(),
              name: 'read:pages only',
              roles: ['read:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        })
        .returning({ id: groupsTable.id })
      await groupsModel.reloadCache()
      const readOnlyActor: AccessActor = { groupIds: [readOnlyGroup!.id], permissions: [] }

      const queue = await approvalsModel.getReviewableSubmissions(
        fixtures.siteId,
        readOnlyActor,
        reviewerScope()
      )
      assert.ok(queue.some((s) => s.id === submission.id))

      const detail = await approvalsModel.getSubmissionForReview(
        fixtures.siteId,
        submission.id,
        readOnlyActor,
        reviewerScope()
      )
      assert.ok(detail)
      assert.equal(detail!.pageContent, undefined)
      // -> The rest of the response is still there -- a reviewer can act on the queue entry without
      //    seeing the page's current source
      assert.equal(detail!.content, 'Suggested content')
    })

    test('approveSubmission refuses without write:pages, leaving the page and submission untouched', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'gating/no-write',
          title: 'No Write',
          editor: 'markdown',
          content: 'Original body'
        },
        adminActor
      )
      const submission = await approvalsModel.saveSubmission({
        siteId: fixtures.siteId,
        page: pageRef(page),
        baseContent: 'Original body',
        content: 'Suggested content',
        authorId: fixtures.userId
      })

      const [readOnlyGroup] = await fixtures.db
        .insert(groupsTable)
        .values({
          name: 'Filtering Test No Write',
          permissions: ['read:pages'],
          rules: [
            {
              id: randomUUID(),
              name: 'read only, no write',
              roles: ['read:pages', 'read:source'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        })
        .returning({ id: groupsTable.id })
      await groupsModel.reloadCache()
      const readOnlyActor = { id: fixtures.userId, permissions: [], groupIds: [readOnlyGroup!.id] }

      const refused = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor: readOnlyActor
      })
      assert.deepEqual(refused, { ok: false, reason: 'forbidden' })

      const untouched = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        withContent: true
      })
      assert.equal(untouched!.content, 'Original body')
      assert.equal(await countOpenSubmissions(page.id), 1)

      // -> The same submission still succeeds for a reviewer who does hold write:pages
      const applied = await approvalsModel.approveSubmission({
        siteId: fixtures.siteId,
        submissionId: submission.id,
        content: 'Suggested content',
        render: '<p>Suggested content</p>',
        actor: adminActor
      })
      assert.equal(applied.ok, true)
      const written = await pagesModel.getPage({
        siteId: fixtures.siteId,
        id: page.id,
        withContent: true
      })
      assert.equal(written!.content, 'Suggested content')
    })
  }
)

/**
 * OpenProject #2129: `rejectSubmission` used to be a bare DELETE, and `approveSubmission` ended in
 * one too -- neither path recorded anything, so a declined suggestion could not be shown back to its
 * author or recovered from a mistaken decline. Both now mark the row (`status`, `resolvedReason`,
 * `resolvedBy`) and retain it. This suite pins that: the row survives resolution with the right
 * fields set, and every "still pending" query (`getReviewableSubmissions`, `countOpenSubmissions`,
 * `getOwnSubmission` via `saveSubmission`'s resubmit path) stops surfacing a resolved row as open.
 */
describe('approvals retain resolved submissions (DB-backed)', { skip: !hasTestDatabase() }, () => {
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

  async function makePage(path: string, content: string) {
    return pagesModel.createPage(
      fixtures.siteId,
      { path, title: path, editor: 'markdown', content },
      actor
    )
  }

  async function rowFor(submissionId: string) {
    const rows = await fixtures.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, submissionId))
      .limit(1)
    return rows[0]
  }

  test('reject retains the row with status, resolvedReason and resolvedBy set', async () => {
    const page = await makePage('approvals/retain/reject', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    const rejected = await approvalsModel.rejectSubmission(
      fixtures.siteId,
      submission.id,
      'Not a good fit for this page',
      actor.id
    )
    assert.equal(rejected, true)

    const row = await rowFor(submission.id)
    assert.ok(row, 'the row must still exist -- reject retains it rather than deleting it')
    assert.equal(row!.status, 'declined')
    assert.equal(row!.resolvedReason, 'Not a good fit for this page')
    assert.equal(row!.resolvedBy, actor.id)
  })

  test('reject without a reason retains the row with resolvedReason left null', async () => {
    const page = await makePage('approvals/retain/reject-no-reason', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    await approvalsModel.rejectSubmission(fixtures.siteId, submission.id, null, actor.id)

    const row = await rowFor(submission.id)
    assert.equal(row!.status, 'declined')
    assert.equal(row!.resolvedReason, null)
    assert.equal(row!.resolvedBy, actor.id)
  })

  test('rejecting an already-resolved submission is a no-op and does not overwrite it', async () => {
    const page = await makePage('approvals/retain/reject-twice', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    await approvalsModel.rejectSubmission(fixtures.siteId, submission.id, 'First reason', actor.id)
    const secondAttempt = await approvalsModel.rejectSubmission(
      fixtures.siteId,
      submission.id,
      'Second reason',
      actor.id
    )
    assert.equal(secondAttempt, false)

    const row = await rowFor(submission.id)
    assert.equal(row!.resolvedReason, 'First reason')
  })

  test('rejecting a submission that does not exist returns false', async () => {
    const result = await approvalsModel.rejectSubmission(
      fixtures.siteId,
      '00000000-0000-0000-0000-000000000000',
      'reason',
      actor.id
    )
    assert.equal(result, false)
  })

  test('approve marks the row approved and resolvedBy rather than deleting it', async () => {
    const page = await makePage('approvals/retain/approve', 'Original content')
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
    assert.equal(result.ok, true)

    const row = await rowFor(submission.id)
    assert.ok(row, 'the row must still exist -- approve retains it rather than deleting it')
    assert.equal(row!.status, 'approved')
    assert.equal(row!.resolvedBy, actor.id)
  })

  test('a declined submission does not reappear in the reviewer queue', async () => {
    const page = await makePage('approvals/retain/queue-decline', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    const before = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
      groupIds: [fixtures.groupId],
      pageId: page.id
    })
    assert.ok(before.some((s) => s.id === submission.id))

    await approvalsModel.rejectSubmission(fixtures.siteId, submission.id, null, actor.id)

    const afterReject = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
      groupIds: [fixtures.groupId],
      pageId: page.id
    })
    assert.ok(!afterReject.some((s) => s.id === submission.id))
  })

  test('an approved submission does not reappear in the reviewer queue', async () => {
    const page = await makePage('approvals/retain/queue-approve', 'Original content')
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

    const afterApprove = await approvalsModel.getReviewableSubmissions(fixtures.siteId, actor, {
      groupIds: [fixtures.groupId],
      pageId: page.id
    })
    assert.ok(!afterApprove.some((s) => s.id === submission.id))
  })

  test('countOpenSubmissions does not count a resolved row as still waiting', async () => {
    const page = await makePage('approvals/retain/count', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })
    assert.equal(await countOpenSubmissions(page.id), 1)

    await approvalsModel.rejectSubmission(fixtures.siteId, submission.id, null, actor.id)
    assert.equal(await countOpenSubmissions(page.id), 0)
  })

  test('a declined submission no longer counts as the author’s open suggestion, so they can suggest again', async () => {
    const page = await makePage('approvals/retain/resubmit', 'Original content')
    const first = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'First suggestion',
      authorId: fixtures.userId
    })

    await approvalsModel.rejectSubmission(fixtures.siteId, first.id, null, actor.id)

    // -> `getOwnSubmission` must not resolve the declined row as still "open"
    assert.equal(await approvalsModel.getOwnSubmission(page.id, fixtures.userId), null)

    // -> And `saveSubmission`'s resubmit path must not collide with the declined row (its partial
    //    unique index is scoped to `status = 'open'`) -- it creates a fresh, independent row instead
    //    of silently reopening the declined one
    const second = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Second suggestion',
      authorId: fixtures.userId
    })
    assert.notEqual(second.id, first.id)
    assert.equal(second.content, 'Second suggestion')

    const firstRow = await rowFor(first.id)
    assert.equal(firstRow!.status, 'declined')
    assert.equal(firstRow!.content, 'First suggestion', 'the declined row itself is left untouched')

    const secondRow = await rowFor(second.id)
    assert.equal(secondRow!.status, 'open')
  })

  /*
    OpenProject #2137: the return leg -- what `getResolvedSubmission`/`pageViewerState` hand back once
    a reviewer has acted, since `hasOpenSuggestion` alone only ever says a suggestion is gone, never
    what happened to it.
  */

  test('getResolvedSubmission: null while nothing of this author’s has been resolved yet', async () => {
    const page = await makePage('approvals/resolved/none-yet', 'Original content')
    await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })

    assert.equal(await approvalsModel.getResolvedSubmission(page.id, fixtures.userId), null)
  })

  test('getResolvedSubmission: a declined row carries its status and reason', async () => {
    const page = await makePage('approvals/resolved/declined', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })
    await approvalsModel.rejectSubmission(
      fixtures.siteId,
      submission.id,
      'Overlaps with an existing section',
      actor.id
    )

    const resolved = await approvalsModel.getResolvedSubmission(page.id, fixtures.userId)
    assert.ok(resolved)
    assert.equal(resolved!.status, 'declined')
    assert.equal(resolved!.reason, 'Overlaps with an existing section')
  })

  test('getResolvedSubmission: an approved row carries its status with a null reason', async () => {
    const page = await makePage('approvals/resolved/approved', 'Original content')
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

    const resolved = await approvalsModel.getResolvedSubmission(page.id, fixtures.userId)
    assert.ok(resolved)
    assert.equal(resolved!.status, 'approved')
    assert.equal(resolved!.reason, null)
  })

  test('getResolvedSubmission: null for a guest, who has no account to look one up by', async () => {
    const page = await makePage('approvals/resolved/guest', 'Original content')
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: null,
      guestName: 'A Reader',
      guestEmail: 'reader@example.com'
    })
    await approvalsModel.rejectSubmission(fixtures.siteId, submission.id, 'Not needed', actor.id)

    assert.equal(await approvalsModel.getResolvedSubmission(page.id, null), null)
  })

  test('pageViewerState surfaces resolvedSubmission for the author of a declined suggestion', async () => {
    const page = await makePage('approvals/resolved/viewer-state', 'Original content')
    // -> The describe block's own rule (`before()` above) has `submitterGroups: []`, which
    //    `findSubmitRule` never matches -- a rule that actually names this actor's group as a
    //    submitter is what makes `pageViewerState` look up `resolvedSubmission` at all (same gate as
    //    `hasOpenSuggestion`), scoped to this test's own page so the site-wide rule above is untouched.
    await approvalsModel.createRule(fixtures.siteId, {
      name: 'submitter rule for viewer-state test',
      isEnabled: true,
      match: 'START',
      path: 'approvals/resolved/viewer-state',
      submitterGroups: [fixtures.groupId],
      reviewerGroups: [fixtures.groupId]
    })

    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original content',
      content: 'Suggested content',
      authorId: fixtures.userId
    })
    await approvalsModel.rejectSubmission(
      fixtures.siteId,
      submission.id,
      'Try again later',
      actor.id
    )

    const req = {
      session: {
        authenticated: true,
        user: { id: fixtures.userId },
        groups: [fixtures.groupId],
        permissions: []
      }
    }
    const state = await approvalsModel.pageViewerState(req, fixtures.siteId, pageRef(page))
    assert.equal(state.hasOpenSuggestion, false)
    assert.ok(state.resolvedSubmission)
    assert.equal(state.resolvedSubmission!.status, 'declined')
    assert.equal(state.resolvedSubmission!.reason, 'Try again later')
  })
})

/**
 * OpenProject #1932: `saveSubmission`/`approveSubmission`/`rejectSubmission` each now fire an
 * `approval:*` webhook event beside their primary write, the same convention `models/pages.ts` uses
 * for `page:*`. `WIKI.models.hooks.emit` is replaced with a `mock.fn()` after `setupTestDb()` installs
 * the real models, so every call this suite makes is captured directly rather than inferred from a
 * queued job -- `Hooks.emit()`'s own SQL/queuing behaviour is already covered by `Hooks.emit (unit)`
 * above and does not need re-proving here.
 */
describe('approvals webhook events (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let actor: PageActor
  let emit: ReturnType<typeof mock.fn>

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
      reviewerGroups: []
    })
  })

  beforeEach(() => {
    emit = mock.fn(async () => 0)
    ;(WIKI.models as any).hooks = { ...WIKI.models.hooks, emit }
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

  test('saveSubmission fires approval:submitted exactly once, with the page and actor', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'approvals/webhook-submit', title: 'x', editor: 'markdown', content: 'Original' },
      actor
    )

    // -> Reset AFTER creating the page, not before: `createPage` fires its own real
    //    `page:create` through this same mocked `emit`, and that call is not what this test
    //    is about.
    emit.mock.resetCalls()

    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Suggested',
      authorId: fixtures.userId
    })

    assert.equal(emit.mock.calls.length, 1)
    const [event, siteId, data] = emit.mock.calls[0]!.arguments
    assert.equal(event, 'approval:submitted')
    assert.equal(siteId, fixtures.siteId)
    assert.deepEqual(data, {
      id: submission.id,
      pageId: page.id,
      path: page.path,
      siteId: fixtures.siteId,
      authorId: fixtures.userId
    })
  })

  test('saveSubmission does not re-fire on a resubmission that replaces the same open submission', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'approvals/webhook-resubmit', title: 'x', editor: 'markdown', content: 'Original' },
      actor
    )
    await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'First suggestion',
      authorId: fixtures.userId
    })
    emit.mock.resetCalls()

    await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Revised suggestion',
      authorId: fixtures.userId
    })

    assert.equal(emit.mock.calls.length, 0)
  })

  test('approveSubmission fires approval:approved exactly once, with the page and actor', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'approvals/webhook-approve', title: 'x', editor: 'markdown', content: 'Original' },
      actor
    )
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Suggested',
      authorId: fixtures.userId
    })
    emit.mock.resetCalls()

    const result = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: submission.id,
      content: 'Suggested',
      render: '<p>Suggested</p>',
      actor
    })
    assert.equal(result.ok, true)

    // -> Filtered to `approval:approved` specifically, not a raw call count: a finalizing approve
    //    also writes the page through `pages.updatePage`, which fires its own real `page:edit`
    //    through this same mocked `emit` -- exactly-once is about THIS event, not every hook call
    //    the write path happens to make.
    const approvedCalls = emit.mock.calls.filter((c) => c.arguments[0] === 'approval:approved')
    assert.equal(approvedCalls.length, 1)
    const [event, siteId, data] = approvedCalls[0]!.arguments
    assert.equal(event, 'approval:approved')
    assert.equal(siteId, fixtures.siteId)
    assert.deepEqual(data, {
      id: submission.id,
      pageId: page.id,
      path: page.path,
      siteId: fixtures.siteId,
      authorId: fixtures.userId
    })
  })

  test('approveSubmission does not fire for a submission that does not exist', async () => {
    const result = await approvalsModel.approveSubmission({
      siteId: fixtures.siteId,
      submissionId: '00000000-0000-0000-0000-000000000000',
      content: 'x',
      render: '<p>x</p>',
      actor
    })
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
    assert.equal(emit.mock.calls.length, 0)
  })

  test('rejectSubmission fires approval:rejected exactly once, with the page and actor', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'approvals/webhook-reject', title: 'x', editor: 'markdown', content: 'Original' },
      actor
    )
    const submission = await approvalsModel.saveSubmission({
      siteId: fixtures.siteId,
      page: pageRef(page),
      baseContent: 'Original',
      content: 'Suggested',
      authorId: fixtures.userId
    })
    emit.mock.resetCalls()

    const declined = await approvalsModel.rejectSubmission(
      fixtures.siteId,
      submission.id,
      null,
      actor.id
    )
    assert.equal(declined, true)

    assert.equal(emit.mock.calls.length, 1)
    const [event, siteId, data] = emit.mock.calls[0]!.arguments
    assert.equal(event, 'approval:rejected')
    assert.equal(siteId, fixtures.siteId)
    assert.deepEqual(data, {
      id: submission.id,
      pageId: page.id,
      path: page.path,
      siteId: fixtures.siteId,
      authorId: fixtures.userId
    })
  })

  test('rejectSubmission does not fire for a submission that does not exist', async () => {
    const declined = await approvalsModel.rejectSubmission(
      fixtures.siteId,
      '00000000-0000-0000-0000-000000000000',
      null,
      actor.id
    )
    assert.equal(declined, false)
    assert.equal(emit.mock.calls.length, 0)
  })
})
