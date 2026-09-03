import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { approvalRules } from './approvalRules.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  pageEditSubmissions as submissionsTable,
  groups as groupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor } from './pages.ts'
import type { ApprovalPageRef } from './approvalRules.ts'
import type { GroupRule, AccessActor } from './groups.ts'

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
      await approvalRules.createRule(fixtures.siteId, {
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
      await approvalRules.createRule(fixtures.siteId, {
        name: 'broad',
        isEnabled: true,
        match: 'START',
        path: 'approvals/overlap',
        submitterGroups: [fixtures.groupId],
        reviewerGroups: []
      })
      await approvalRules.createRule(fixtures.siteId, {
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

      await approvalRules.createRule(fixtures.siteId, {
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

    await approvalRules.createRule(fixtures.siteId, {
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
      await approvalRules.createRule(fixtures.siteId, {
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

      const rules = await approvalRules.getRules(fixtures.siteId)
      await approvalRules.updateRule(fixtures.siteId, rules[0]!.id, {
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
