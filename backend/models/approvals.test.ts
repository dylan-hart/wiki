import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'
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
    actor = { id: fixtures.userId, permissions: ['manage:system'] }

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
    return { id: page.id, path: page.path, tags: [], allowContributions: true }
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

    assert.deepEqual(result, { ok: true })
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
    assert.deepEqual(approveFirst, { ok: true })

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
