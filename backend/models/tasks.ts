import { and, asc, eq, like, or, sql } from 'drizzle-orm'
import { pages as pagesTable } from '../db/schema.ts'
import { escapeLikePattern } from '../helpers/common.ts'
import { parseTaskItems } from '../helpers/taskItems.ts'
import type { AccessActor } from './groups.ts'

export interface RollupTaskItem {
  index: number
  text: string
  line: number
}

export interface RollupPage {
  pageId: string
  path: string
  locale: string
  title: string
  tags: string[]
  updatedAt: Date
  items: RollupTaskItem[]
}

export interface TaskRollup {
  results: RollupPage[]
  totalHits: number
  totalItems: number
}

export interface ListOpenTasksParams {
  siteId: string
  actor: AccessActor
  isUnlocked: (page: {
    id: string
    path: string
    locale: string
    tags: string[]
    classification: string
  }) => boolean
  publicOnly?: boolean
  tags?: string[]
  folder?: string
  offset?: number
  limit?: number
}

class Tasks {
  async listOpenTasks({
    siteId,
    actor,
    isUnlocked,
    publicOnly = false,
    tags = [],
    folder,
    offset = 0,
    limit = 25
  }: ListOpenTasksParams): Promise<TaskRollup> {
    const conditions = [eq(pagesTable.siteId, siteId), like(pagesTable.content, '%[ ]%')]
    if (publicOnly) {
      conditions.push(eq(pagesTable.publishState, 'published'))
    }
    if (tags.length > 0) {
      conditions.push(sql`${pagesTable.tags} @> ${sql.param(tags)}`)
    }
    const folderPath = folder?.replace(/^\/+|\/+$/g, '')
    if (folderPath) {
      conditions.push(
        or(
          eq(pagesTable.path, folderPath),
          like(pagesTable.path, `${escapeLikePattern(folderPath)}/%`)
        )!
      )
    }

    const rows = await CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        title: pagesTable.title,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        password: pagesTable.password,
        content: pagesTable.content,
        updatedAt: pagesTable.updatedAt
      })
      .from(pagesTable)
      .where(and(...conditions))
      .orderBy(asc(pagesTable.path), asc(pagesTable.locale))

    const matches: RollupPage[] = []
    let totalItems = 0
    for (const row of rows) {
      if (!CARDINAL.models.groups.checkAccess(actor, 'read:pages', { ...row, siteId })) {
        continue
      }
      if (row.password && !isUnlocked(row)) {
        continue
      }
      const items = parseTaskItems(row.content ?? '')
        .filter((item) => !item.checked)
        .map(({ index, text, line }) => ({ index, text, line }))
      if (items.length === 0) {
        continue
      }
      totalItems += items.length
      matches.push({
        pageId: row.id,
        path: row.path,
        locale: row.locale,
        title: row.title,
        tags: row.tags,
        updatedAt: row.updatedAt,
        items
      })
    }

    return {
      results: matches.slice(offset, offset + limit),
      totalHits: matches.length,
      totalItems
    }
  }
}

export const tasks = new Tasks()
