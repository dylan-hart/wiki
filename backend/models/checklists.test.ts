import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'
import { checklists } from './checklists.ts'
import type { PageActor, PageInput } from './pages.ts'

// This dev environment's Node predates 26 (per CLAUDE.md), so `Temporal` is not a native global here.
// Shim just enough of `Temporal.Now.instant()` for `checkItem()`'s completion timestamp, unmodified.
if (typeof (globalThis as any).Temporal === 'undefined') {
  ;(globalThis as any).Temporal = {
    Now: { instant: () => ({ epochMilliseconds: Date.now() }) }
  }
}

/**
 * `checkItem`'s two input guards run before it ever touches `WIKI.db`, so they are testable with no
 * database and no `WIKI` global at all — unlike the rest of this file, this suite always runs.
 */
describe('checklists model — validation (no database)', () => {
  test('rejects an empty itemKey', async () => {
    await assert.rejects(
      checklists.checkItem({
        siteId: 'site',
        pageId: 'page',
        blockKey: 'block',
        itemKey: '   ',
        itemCount: 1,
        userId: 'user'
      }),
      /itemKey must not be empty/
    )
  })

  test('rejects a zero itemCount', async () => {
    await assert.rejects(
      checklists.checkItem({
        siteId: 'site',
        pageId: 'page',
        blockKey: 'block',
        itemKey: 'item-0',
        itemCount: 0,
        userId: 'user'
      }),
      /itemCount must be a positive integer/
    )
  })

  test('rejects a non-integer itemCount', async () => {
    await assert.rejects(
      checklists.checkItem({
        siteId: 'site',
        pageId: 'page',
        blockKey: 'block',
        itemKey: 'item-0',
        itemCount: 1.5,
        userId: 'user'
      }),
      /itemCount must be a positive integer/
    )
  })
})

/**
 * `itemKey` shape validation runs after `_ensureActiveExecution`, which needs `WIKI.db` — so unlike
 * the guards above, these two need the DB-backed fixture even though what they are asserting is pure
 * input validation, not SQL behavior.
 */
describe('checklists model — itemKey validation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let checklistsModel: typeof import('./checklists.ts').checklists
  let pagesModel: typeof import('./pages.ts').pages
  let pageId: string

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    ;({ checklists: checklistsModel } = await import('./checklists.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))

    const actor: PageActor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'ops/itemkey-validation',
        title: 'ItemKey Validation',
        editor: 'markdown',
        content: '#'
      },
      actor
    )
    pageId = page.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('rejects an itemKey that is not the "item-N" position shape', async () => {
    await assert.rejects(
      checklistsModel.checkItem({
        siteId: fixtures.siteId,
        pageId,
        blockKey: 'malformed-key',
        itemKey: 'not-a-position',
        itemCount: 3,
        userId: fixtures.userId
      }),
      /itemKey must be a valid item position/
    )
  })

  test('rejects an itemKey whose position is out of range for the active execution', async () => {
    const blockKey = 'out-of-range-key'
    // -> Starts a real 2-item execution first, so the execution's stored itemCount (not just the
    //    argument on this call) is what the out-of-range check runs against.
    await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-0',
      itemCount: 2,
      userId: fixtures.userId
    })

    await assert.rejects(
      checklistsModel.checkItem({
        siteId: fixtures.siteId,
        pageId,
        blockKey,
        itemKey: 'item-5',
        itemCount: 2,
        userId: fixtures.userId
      }),
      /itemKey must be a valid item position/
    )

    const execution = await checklistsModel.getLatestExecution(pageId, blockKey)
    assert.equal(execution!.checkedCount, 1, 'the out-of-range attempt recorded nothing')
    assert.equal(execution!.completedAt, null, 'and did not spuriously complete the execution')
  })
})

/**
 * `models/checklists.ts` is almost entirely SQL orchestration — an insert guarded by a partial unique
 * index, a conflict-driven idempotent check, a threshold-triggered update, joins across two tables —
 * so a mock of the query builder would mostly be re-describing the code under test rather than
 * verifying it. This suite runs the real methods against a migrated, per-run-fresh database (see
 * `test/db.ts`), matching `models/pages.test.ts`'s own reasoning for the same choice.
 */
describe('checklists model (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let checklistsModel: typeof import('./checklists.ts').checklists
  let pagesModel: typeof import('./pages.ts').pages
  let pageId: string
  let secondUserId: string

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    ;({ checklists: checklistsModel } = await import('./checklists.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))

    const actor: PageActor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    const pageInput: PageInput = {
      path: 'ops/shift-open',
      title: 'Shift Open Checklist',
      editor: 'markdown',
      content: '# Shift Open'
    }
    const page = await pagesModel.createPage(fixtures.siteId, pageInput, actor)
    pageId = page.id

    const [second] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'second@example.com',
        name: 'Second Checker',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    secondUserId = second!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('checking the first item starts a new execution, attributed to the checker', async () => {
    const execution = await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey: 'first-item-starts',
      itemKey: 'item-0',
      itemCount: 3,
      userId: fixtures.userId
    })

    assert.equal(execution.pageId, pageId)
    assert.equal(execution.blockKey, 'first-item-starts')
    assert.equal(execution.itemCount, 3)
    assert.equal(execution.startedBy, fixtures.userId)
    assert.equal(execution.startedByName, 'Fixture User')
    assert.equal(execution.completedAt, null)
    assert.equal(execution.checkedCount, 1)
    assert.equal(execution.items.length, 1)
    assert.equal(execution.items[0]!.itemKey, 'item-0')
    assert.equal(execution.items[0]!.checkedBy, fixtures.userId)
  })

  test('checking an already-checked item is idempotent and keeps the original checker', async () => {
    const blockKey = 'idempotent-check'
    const first = await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-0',
      itemCount: 2,
      userId: fixtures.userId
    })
    const second = await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-0',
      itemCount: 2,
      userId: secondUserId
    })

    assert.equal(second.id, first.id)
    assert.equal(second.checkedCount, 1)
    assert.equal(second.items[0]!.checkedBy, fixtures.userId, 'the original checker is preserved')
  })

  test('checking the last item completes the execution, attributed to whoever checked it', async () => {
    const blockKey = 'completes-on-last-item'
    await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-0',
      itemCount: 2,
      userId: fixtures.userId
    })
    const completed = await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-1',
      itemCount: 2,
      userId: secondUserId
    })

    assert.equal(completed.checkedCount, 2)
    assert.ok(completed.completedAt, 'completedAt is set once every item is checked')
    assert.equal(completed.completedBy, secondUserId)
    assert.equal(completed.completedByName, 'Second Checker')
  })

  test('a check after completion starts a fresh execution rather than reopening the old one', async () => {
    const blockKey = 'resets-after-completion'
    const first = await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-0',
      itemCount: 1,
      userId: fixtures.userId
    })
    assert.ok(first.completedAt, 'single-item checklist completes on its only check')

    const second = await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-0',
      itemCount: 1,
      userId: secondUserId
    })

    assert.notEqual(second.id, first.id, 'a new execution id, not the completed one')
    assert.equal(second.checkedCount, 1)
    assert.equal(second.startedBy, secondUserId)

    const history = await checklistsModel.listExecutions(pageId, blockKey)
    assert.equal(history.length, 2)
    assert.equal(history[0]!.id, second.id, 'most recently started first')
    assert.equal(history[1]!.id, first.id)
  })

  test('concurrent first checks on the same block collapse into one execution', async () => {
    const blockKey = 'concurrent-start-race'
    const [a, b] = await Promise.all([
      checklistsModel.checkItem({
        siteId: fixtures.siteId,
        pageId,
        blockKey,
        itemKey: 'item-0',
        itemCount: 2,
        userId: fixtures.userId
      }),
      checklistsModel.checkItem({
        siteId: fixtures.siteId,
        pageId,
        blockKey,
        itemKey: 'item-1',
        itemCount: 2,
        userId: secondUserId
      })
    ])

    assert.equal(a!.id, b!.id, 'both checks landed on the same execution')
    const history = await checklistsModel.listExecutions(pageId, blockKey)
    assert.equal(history.length, 1, 'the partial unique index allowed only one active execution')
    assert.equal(history[0]!.checkedCount, 2)
  })

  test('getLatestExecution returns null for a checklist that has never run', async () => {
    const latest = await checklistsModel.getLatestExecution(pageId, 'never-run')
    assert.equal(latest, null)
  })

  test('getLatestExecution and getExecutionDetail agree on the same execution', async () => {
    const blockKey = 'latest-matches-detail'
    const created = await checklistsModel.checkItem({
      siteId: fixtures.siteId,
      pageId,
      blockKey,
      itemKey: 'item-0',
      itemCount: 5,
      userId: fixtures.userId
    })

    const latest = await checklistsModel.getLatestExecution(pageId, blockKey)
    const detail = await checklistsModel.getExecutionDetail(created.id)

    assert.deepEqual(latest, detail)
    assert.equal(detail!.id, created.id)
  })
})
