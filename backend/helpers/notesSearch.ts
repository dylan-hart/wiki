import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { notes as notesTable } from '../db/schema.ts'
import { escapeLikePattern } from './common.ts'

export const NOTE_SEARCH_DEFAULT_LIMIT = 25
export const NOTE_SEARCH_MAX_LIMIT = 100

/**
 * How much of a note's content goes into its `tsvector`. Postgres refuses a `tsvector` whose lexemes
 * and positions take more than 1 MiB ("string is too long for tsvector"), and a 2 MiB note of
 * distinct words is far past that, which would fail the whole query and so every search the user
 * makes. `left()` counts characters, and measured against the worst inputs found (4-byte characters
 * joined by hyphens, which the parser splits into three lexemes each) one character costs at most
 * about 10.5 bytes of `tsvector`, and by the parser's own arithmetic under 13. 64K characters plus a
 * full title stays under the limit at that bound. The `ILIKE` match below still sees the whole
 * note, so a note longer than this still turns up for a word or phrase further in.
 */
export const NOTE_SEARCH_TSVECTOR_MAX_CHARS = 65_536

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
  const document = sql`to_tsvector('simple', coalesce(${notesTable.title}, '') || ' ' || left(${notesTable.content}, ${sql.raw(String(NOTE_SEARCH_TSVECTOR_MAX_CHARS))}))`
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
