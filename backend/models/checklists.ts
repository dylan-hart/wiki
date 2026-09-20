import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  checklistExecutions as checklistExecutionsTable,
  checklistItemChecks as checklistItemChecksTable,
  users as usersTable
} from '../db/schema.ts'

const startedByUsers = alias(usersTable, 'checklistStartedByUsers')
const completedByUsers = alias(usersTable, 'checklistCompletedByUsers')
const checkedByUsers = alias(usersTable, 'checklistCheckedByUsers')

const DEFAULT_HISTORY_LIMIT = 50

/**
 * `blocks/block-checklist/component.js` keys every item by its position (`item-0`, `item-1`, ...).
 * `checkItem` enforces this shape — and that the position is within the execution's own `itemCount` —
 * because otherwise `itemCount`-many *distinct* keys of any shape would satisfy the completion
 * threshold without ever naming a real item on the block.
 */
const ITEM_KEY_PATTERN = /^item-(\d+)$/

export interface ChecklistItemCheck {
  itemKey: string
  checkedAt: Date
  checkedBy: string | null
  /** Read live through a left join, so `null` once the account is gone. */
  checkedByName: string | null
}

export interface ChecklistExecutionSummary {
  id: string
  siteId: string
  pageId: string
  blockKey: string
  itemCount: number
  startedAt: Date
  startedBy: string | null
  startedByName: string | null
  completedAt: Date | null
  completedBy: string | null
  completedByName: string | null
  checkedCount: number
}

export interface ChecklistExecutionDetail extends ChecklistExecutionSummary {
  items: ChecklistItemCheck[]
}

const executionColumns = {
  id: checklistExecutionsTable.id,
  siteId: checklistExecutionsTable.siteId,
  pageId: checklistExecutionsTable.pageId,
  blockKey: checklistExecutionsTable.blockKey,
  itemCount: checklistExecutionsTable.itemCount,
  startedAt: checklistExecutionsTable.startedAt,
  startedBy: checklistExecutionsTable.startedBy,
  startedByName: startedByUsers.name,
  completedAt: checklistExecutionsTable.completedAt,
  completedBy: checklistExecutionsTable.completedBy,
  completedByName: completedByUsers.name
}

/**
 * The run log behind `block-checklist`. Distinct from `models/pageHistory.ts` (content revisions)
 * and `models/approvals.ts` (the editorial publish workflow): this records that someone actually
 * performed a procedure, not that a page's content changed.
 *
 * No permission checks here: that is `api/checklists.ts`'s job, where the request and the page-rule
 * actor legitimately live.
 */
class Checklists {
  /**
   * Starts a new execution first if none is currently active.
   *
   * Idempotent per item: checking an already-checked item in the same execution changes nothing and
   * keeps the original `checkedBy`/`checkedAt` — a run log records the first time something happened,
   * not the most recent click. When this check brings the checked count up to the execution's
   * `itemCount`, it completes automatically, attributed to whoever checked the last item.
   */
  async checkItem({
    siteId,
    pageId,
    blockKey,
    itemKey,
    itemCount,
    userId
  }: {
    siteId: string
    pageId: string
    blockKey: string
    itemKey: string
    itemCount: number
    userId: string
  }): Promise<ChecklistExecutionDetail> {
    if (!itemKey.trim()) {
      throw new Error('itemKey must not be empty.')
    }
    if (!Number.isInteger(itemCount) || itemCount < 1) {
      throw new Error('itemCount must be a positive integer.')
    }

    const execution = await this._ensureActiveExecution({
      siteId,
      pageId,
      blockKey,
      itemCount,
      userId
    })

    // -> Validated against the execution's OWN itemCount, not the possibly-stale argument above:
    //    that one only ever starts a brand new execution, and an active execution someone else
    //    already started keeps the count it was started with.
    const match = ITEM_KEY_PATTERN.exec(itemKey)
    if (!match || Number(match[1]) >= execution.itemCount) {
      throw new Error(`itemKey must be a valid item position for this checklist, e.g. "item-0".`)
    }

    await CARDINAL.db
      .insert(checklistItemChecksTable)
      .values({ executionId: execution.id, itemKey, checkedBy: userId })
      .onConflictDoNothing({
        target: [checklistItemChecksTable.executionId, checklistItemChecksTable.itemKey]
      })

    const checkedCount = await CARDINAL.db.$count(
      checklistItemChecksTable,
      eq(checklistItemChecksTable.executionId, execution.id)
    )

    if (checkedCount >= execution.itemCount) {
      // -> Guarded by `isNull` so a concurrent request that also just crossed the threshold cannot
      //    overwrite the completion already recorded by whichever of the two committed first.
      await CARDINAL.db
        .update(checklistExecutionsTable)
        .set({
          completedAt: new Date(Temporal.Now.instant().epochMilliseconds),
          completedBy: userId
        })
        .where(
          and(
            eq(checklistExecutionsTable.id, execution.id),
            isNull(checklistExecutionsTable.completedAt)
          )
        )
    }

    const detail = await this.getExecutionDetail(execution.id)
    if (!detail) {
      throw new Error('Checklist execution vanished while recording a check.')
    }
    return detail
  }

  /**
   * Relies on `checklistExecutions_active_idx` (unique on `(pageId, blockKey)` scoped to
   * `completedAt IS NULL` rows) to stay correct under concurrent requests: both an insert race and a
   * `SELECT`-then-lost-race fall through to the same `onConflictDoNothing` + re-select, so at most one
   * active execution is ever created regardless of how many requests arrive at once.
   */
  private async _ensureActiveExecution({
    siteId,
    pageId,
    blockKey,
    itemCount,
    userId
  }: {
    siteId: string
    pageId: string
    blockKey: string
    itemCount: number
    userId: string
  }): Promise<{ id: string; itemCount: number }> {
    const active = await this._getActive(pageId, blockKey)
    if (active) {
      return active
    }

    const inserted = await CARDINAL.db
      .insert(checklistExecutionsTable)
      .values({ siteId, pageId, blockKey, itemCount, startedBy: userId })
      .onConflictDoNothing({
        target: [checklistExecutionsTable.pageId, checklistExecutionsTable.blockKey],
        where: sql`"completedAt" IS NULL`
      })
      .returning({ id: checklistExecutionsTable.id, itemCount: checklistExecutionsTable.itemCount })
    if (inserted[0]) {
      return inserted[0]
    }

    const winner = await this._getActive(pageId, blockKey)
    if (!winner) {
      throw new Error('Failed to start or find an active checklist execution.')
    }
    return winner
  }

  private async _getActive(
    pageId: string,
    blockKey: string
  ): Promise<{ id: string; itemCount: number } | null> {
    const rows = await CARDINAL.db
      .select({ id: checklistExecutionsTable.id, itemCount: checklistExecutionsTable.itemCount })
      .from(checklistExecutionsTable)
      .where(
        and(
          eq(checklistExecutionsTable.pageId, pageId),
          eq(checklistExecutionsTable.blockKey, blockKey),
          isNull(checklistExecutionsTable.completedAt)
        )
      )
      .limit(1)
    return rows[0] ?? null
  }

  async getLatestExecution(
    pageId: string,
    blockKey: string
  ): Promise<ChecklistExecutionDetail | null> {
    const rows = await CARDINAL.db
      .select({ id: checklistExecutionsTable.id })
      .from(checklistExecutionsTable)
      .where(
        and(
          eq(checklistExecutionsTable.pageId, pageId),
          eq(checklistExecutionsTable.blockKey, blockKey)
        )
      )
      .orderBy(desc(checklistExecutionsTable.startedAt))
      .limit(1)
    const latest = rows[0]
    return latest ? this.getExecutionDetail(latest.id) : null
  }

  async getExecutionDetail(executionId: string): Promise<ChecklistExecutionDetail | null> {
    const rows = await CARDINAL.db
      .select(executionColumns)
      .from(checklistExecutionsTable)
      .leftJoin(startedByUsers, eq(startedByUsers.id, checklistExecutionsTable.startedBy))
      .leftJoin(completedByUsers, eq(completedByUsers.id, checklistExecutionsTable.completedBy))
      .where(eq(checklistExecutionsTable.id, executionId))
      .limit(1)
    const execution = rows[0]
    if (!execution) {
      return null
    }

    const items = await CARDINAL.db
      .select({
        itemKey: checklistItemChecksTable.itemKey,
        checkedAt: checklistItemChecksTable.checkedAt,
        checkedBy: checklistItemChecksTable.checkedBy,
        checkedByName: checkedByUsers.name
      })
      .from(checklistItemChecksTable)
      .leftJoin(checkedByUsers, eq(checkedByUsers.id, checklistItemChecksTable.checkedBy))
      .where(eq(checklistItemChecksTable.executionId, executionId))
      .orderBy(asc(checklistItemChecksTable.checkedAt))

    return { ...execution, checkedCount: items.length, items }
  }

  /**
   * One query for the executions plus one grouped query for their checked-item counts, not one count
   * query per row.
   */
  async listExecutions(
    pageId: string,
    blockKey: string,
    limit: number = DEFAULT_HISTORY_LIMIT
  ): Promise<ChecklistExecutionSummary[]> {
    const executions = await CARDINAL.db
      .select(executionColumns)
      .from(checklistExecutionsTable)
      .leftJoin(startedByUsers, eq(startedByUsers.id, checklistExecutionsTable.startedBy))
      .leftJoin(completedByUsers, eq(completedByUsers.id, checklistExecutionsTable.completedBy))
      .where(
        and(
          eq(checklistExecutionsTable.pageId, pageId),
          eq(checklistExecutionsTable.blockKey, blockKey)
        )
      )
      .orderBy(desc(checklistExecutionsTable.startedAt))
      .limit(limit)

    if (executions.length === 0) {
      return []
    }

    const counts = await CARDINAL.db
      .select({
        executionId: checklistItemChecksTable.executionId,
        count: sql<number>`count(*)::int`
      })
      .from(checklistItemChecksTable)
      .where(
        inArray(
          checklistItemChecksTable.executionId,
          executions.map((execution) => execution.id)
        )
      )
      .groupBy(checklistItemChecksTable.executionId)
    const countByExecution = new Map(counts.map((row) => [row.executionId, row.count]))

    return executions.map((execution) => ({
      ...execution,
      checkedCount: countByExecution.get(execution.id) ?? 0
    }))
  }
}

export const checklists = new Checklists()
