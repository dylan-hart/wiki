import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { approvalRules } from './approvalRules.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  pageEditSubmissions as submissionsTable,
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor } from './pages.ts'
import type { ApprovalPageRef } from './approvalRules.ts'

/**
 * One schema for the whole file rather than one per describe: every `setupTestDb()` call is a
 * `CREATE SCHEMA`, the full migration set and a seed, and each describe below wants the same fixture.
 *
 * The `hasTestDatabase()` guard is what a per-describe `{ skip }` cannot do for a FILE-level hook: a
 * root `before()` runs even when every describe is skipped, so without it an unset `DATABASE_URL`
 * throws out of the hook.
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

async function countOpenSubmissions(pageId: string): Promise<number> {
  return CARDINAL.db.$count(
    submissionsTable,
    and(eq(submissionsTable.pageId, pageId), eq(submissionsTable.status, 'open'))
  )
}

/**
 * A submission's `baseHash` is re-checked immediately before the write, not only when the reviewer's
 * `GET .../submissions/:id` computed `isStale` for display.
 */

describe('approvals approveSubmission staleness (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let actor: PageActor
  let secondAuthorId: string

  before(async () => {
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

    // -> One rule covering every page, so `getReviewableSubmissions` has something to match against.
    await approvalRules.createRule(fixtures.siteId, {
      name: 'covers everything',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: []
    })
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

    const untouched = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(untouched!.content, 'Somebody else changed this')

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

    // -> `getReviewableSubmissions` joins the live page row on every call, with no cache in front of
    //    it -- staleness lands on the next read, without a queue refresh.
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
   * `updatePage()` runs after the finalizing transaction has already committed `status: 'approved'`,
   * so a failure there needs an explicit revert: every other query requires `status = 'open'` to act
   * on a row, leaving the submission otherwise unreachable and unretriable.
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

describe('approvals multi-approver threshold (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let hooksModel: typeof import('./hooks.ts').hooks
  let pageHistoryModel: typeof import('./pageHistory.ts').pageHistory
  let actor: PageActor
  let reviewerBId: string
  let reviewerCId: string

  before(async () => {
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
    await approvalRules.createRule(fixtures.siteId, {
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

    const untouched = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: page.id,
      withContent: true
    })
    assert.equal(untouched!.content, 'Original content')

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

    // -> The finalizing reviewer's own content/render is what lands, not the first approver's.
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
    await approvalRules.createRule(fixtures.siteId, {
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
    await approvalRules.createRule(fixtures.siteId, {
      name: 'lax',
      isEnabled: true,
      match: 'START',
      path: 'approvals/threshold/strictest',
      submitterGroups: [],
      reviewerGroups: [],
      minApprovals: 1
    })
    await approvalRules.createRule(fixtures.siteId, {
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
   * `Promise.all`, not sequential `await`s: only genuinely concurrent calls exercise the
   * transaction's `SELECT ... FOR UPDATE` serializing across two connections.
   *
   * `pageHistory`'s `updated` row count stands in for how many times `updatePage` ran -- it fires
   * `hooks.emit` and `storage.dispatch` once per call, so one history row also rules out a doubled
   * dispatch without this test standing up a real storage target.
   */
  test('two concurrent approve calls from the same reviewer at minApprovals:1 finalize exactly once', async () => {
    await approvalRules.createRule(fixtures.siteId, {
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
    const addJob = CARDINAL.scheduler.addJob as unknown as {
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
 * `onConflictDoNothing` on the vote insert suppresses a duplicate vote row, but not the count two
 * concurrent calls both go on to read -- the `for('update')` row lock spanning vote-insert through
 * the finalize decision is what makes exactly one of them finalize.
 */
describe('approvals concurrent finalisation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let pageHistoryModel: typeof import('./pageHistory.ts').pageHistory
  let actor: PageActor

  before(async () => {
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    ;({ pageHistory: pageHistoryModel } = await import('./pageHistory.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  test('two concurrent approvals at minApprovals 1 finalize exactly once; the loser gets not-found', async () => {
    // -> No rule created: `requiredApprovalsForPage` defaults to 1 when nothing matches.
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
    const finalRows = await CARDINAL.db
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
 * Resolving `write:scripts`/`write:styles` from the reviewer would let one who holds either launder
 * a submitter's `<script>`/inline handler past a grant the submitter never had. `reviewer` below
 * holds `manage:system` because that is where laundering would be easiest to miss -- it bypasses
 * every page-rule check for the reviewer themselves.
 */
describe(
  'approvals render permissions resolve from the submitter, not the reviewer (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let reviewer: PageActor
    let scriptedAuthorId: string

    before(async () => {
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      reviewer = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

      await approvalRules.createRule(fixtures.siteId, {
        name: 'covers everything',
        isEnabled: true,
        match: 'START',
        path: '',
        submitterGroups: [],
        reviewerGroups: []
      })

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
      await CARDINAL.models.groups.reloadCache()
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

describe(
  'approvals submission resolution columns (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let pagesModel: typeof import('./pages.ts').pages
    let approvalsModel: typeof import('./approvals.ts').approvals
    let actor: PageActor

    before(async () => {
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ approvals: approvalsModel } = await import('./approvals.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
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

      const rows = await CARDINAL.db
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

/**
 * Approve and reject both mark the row (`status`, `resolvedReason`, `resolvedBy`) and retain it
 * rather than deleting it, so a decline can be shown back to its author. Every "still pending" query
 * therefore has to exclude a resolved row rather than relying on its absence.
 */
describe('approvals retain resolved submissions (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let actor: PageActor

  before(async () => {
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    await approvalRules.createRule(fixtures.siteId, {
      name: 'covers everything',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
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

    assert.equal(await approvalsModel.getOwnSubmission(page.id, fixtures.userId), null)

    // -> The resubmit path must not collide with the declined row: the one-open-submission unique
    //    index is partial, scoped to `status = 'open'`.
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
    // -> The describe's own rule has `submitterGroups: []`, which `findSubmitRule` never matches,
    //    and `pageViewerState` only looks up `resolvedSubmission` for an actor a submit rule names.
    //    Scoped to this test's page so the site-wide rule stays untouched.
    await approvalRules.createRule(fixtures.siteId, {
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
 * `CARDINAL.models.hooks.emit` is stubbed so events are captured directly rather than inferred from
 * a queued job; `Hooks.emit()`'s own SQL/queuing behaviour is covered by `models/hooks.test.ts`.
 */
describe('approvals webhook events (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let pagesModel: typeof import('./pages.ts').pages
  let approvalsModel: typeof import('./approvals.ts').approvals
  let actor: PageActor
  let emit: ReturnType<typeof mock.fn>

  before(async () => {
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    await approvalRules.createRule(fixtures.siteId, {
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
    ;(CARDINAL.models as any).hooks = { ...CARDINAL.models.hooks, emit }
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

    // -> Reset after creating the page: `createPage` fires its own `page:create` through this same
    //    stubbed `emit`.
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

    // -> Filtered rather than counted: a finalizing approve also writes the page, whose own
    //    `page:edit` goes through this same stubbed `emit`.
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
