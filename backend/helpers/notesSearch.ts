import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { notes as notesTable } from '../db/schema.ts'
import { escapeLikePattern } from './common.ts'

export const NOTE_SEARCH_DEFAULT_LIMIT = 25
export const NOTE_SEARCH_MAX_LIMIT = 100

export interface NoteSearchRow {
  id: string
  sectionId: string
  title: string | null
  excerpt: string
}

export async function searchNotes({
  siteId,
  userId,
  query,
  limit = NOTE_SEARCH_DEFAULT_LIMIT
}: {
  siteId: string
  userId: string
  query: string
  limit?: number
}): Promise<NoteSearchRow[]> {
  const terms = query.trim()
  if (!terms) {
    return []
  }
  const document = sql`to_tsvector('simple', coalesce(${notesTable.title}, '') || ' ' || ${notesTable.content})`
  const tsQuery = sql`websearch_to_tsquery('simple', ${terms})`
  const pattern = `%${escapeLikePattern(terms)}%`

  return CARDINAL.db
    .select({
      id: notesTable.id,
      sectionId: notesTable.sectionId,
      title: notesTable.title,
      excerpt: notesTable.excerpt
    })
    .from(notesTable)
    .where(
      and(
        eq(notesTable.siteId, siteId),
        eq(notesTable.userId, userId),
        or(
          sql`${document} @@ ${tsQuery}`,
          ilike(notesTable.title, pattern),
          ilike(notesTable.content, pattern)
        )
      )
    )
    .orderBy(desc(sql`ts_rank(${document}, ${tsQuery})`), desc(notesTable.updatedAt), notesTable.id)
    .limit(Math.min(Math.max(1, limit), NOTE_SEARCH_MAX_LIMIT))
}
