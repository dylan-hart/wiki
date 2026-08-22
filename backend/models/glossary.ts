import { and, asc, eq, sql } from 'drizzle-orm'
import { glossaryTerms as glossaryTermsTable, pages as pagesTable } from '../db/schema.ts'
import { CustomError, localizedPagePath } from '../helpers/common.ts'

export interface GlossaryTerm {
  id: string
  term: string
  definition: string
  pageId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface GlossaryTermInput {
  term: string
  definition: string
  pageId?: string | null
}

/** What the markdown renderer actually needs: no id, no timestamps, and the page link pre-resolved. */
export interface CachedGlossaryTerm {
  term: string
  definition: string
  link: string | null
}

function cacheKey(siteId: string): string {
  return `glossary:${siteId}`
}

/**
 * Site-wide glossary terms (OpenProject #870).
 *
 * The admin CRUD screen is the source of truth for the term list — nothing here is derived from page
 * content, unlike `models/tags.ts`. `getCachedTerms` is the one method the rendering pipeline calls:
 * it resolves each term's canonical page (if any) to a link and caches the result under `WIKI.cache`,
 * invalidated by every write below the same way `models/locales.ts` refreshes its own `WIKI.cache`
 * entry — the next read after a write simply rebuilds it.
 */
class Glossary {
  async listTerms(siteId: string): Promise<GlossaryTerm[]> {
    return WIKI.db
      .select()
      .from(glossaryTermsTable)
      .where(eq(glossaryTermsTable.siteId, siteId))
      .orderBy(asc(glossaryTermsTable.term))
  }

  async getTerm(siteId: string, id: string): Promise<GlossaryTerm | null> {
    const rows = await WIKI.db
      .select()
      .from(glossaryTermsTable)
      .where(and(eq(glossaryTermsTable.siteId, siteId), eq(glossaryTermsTable.id, id)))
      .limit(1)
    return rows[0] ?? null
  }

  async createTerm(siteId: string, input: GlossaryTermInput): Promise<GlossaryTerm> {
    const term = input.term.trim()
    const definition = input.definition.trim()
    if (!term) {
      throw new CustomError('glossaryEmptyTerm', 'A term cannot be empty.', 400)
    }
    if (!definition) {
      throw new CustomError('glossaryEmptyDefinition', 'A definition cannot be empty.', 400)
    }
    const pageId = await this.validatePageId(siteId, input.pageId)

    let inserted
    try {
      inserted = await WIKI.db
        .insert(glossaryTermsTable)
        .values({ siteId, term, definition, pageId })
        .returning()
    } catch (err: any) {
      if (err.cause?.code === '23505' || err.code === '23505') {
        throw new CustomError('glossaryDuplicateTerm', 'A term with this name already exists.', 409)
      }
      throw err
    }
    this.invalidateCache(siteId)
    return inserted[0]
  }

  async updateTerm(
    siteId: string,
    id: string,
    input: Partial<GlossaryTermInput>
  ): Promise<GlossaryTerm> {
    const values: Record<string, any> = { updatedAt: sql`now()` }
    if (input.term !== undefined) {
      const term = input.term.trim()
      if (!term) {
        throw new CustomError('glossaryEmptyTerm', 'A term cannot be empty.', 400)
      }
      values.term = term
    }
    if (input.definition !== undefined) {
      const definition = input.definition.trim()
      if (!definition) {
        throw new CustomError('glossaryEmptyDefinition', 'A definition cannot be empty.', 400)
      }
      values.definition = definition
    }
    if (input.pageId !== undefined) {
      values.pageId = await this.validatePageId(siteId, input.pageId)
    }

    let updated
    try {
      updated = await WIKI.db
        .update(glossaryTermsTable)
        .set(values)
        .where(and(eq(glossaryTermsTable.siteId, siteId), eq(glossaryTermsTable.id, id)))
        .returning()
    } catch (err: any) {
      if (err.cause?.code === '23505' || err.code === '23505') {
        throw new CustomError('glossaryDuplicateTerm', 'A term with this name already exists.', 409)
      }
      throw err
    }
    if (!updated[0]) {
      throw new CustomError('glossaryNotFound', 'This glossary term does not exist.', 404)
    }
    this.invalidateCache(siteId)
    return updated[0]
  }

  async deleteTerm(siteId: string, id: string): Promise<boolean> {
    const deleted = await WIKI.db
      .delete(glossaryTermsTable)
      .where(and(eq(glossaryTermsTable.siteId, siteId), eq(glossaryTermsTable.id, id)))
      .returning({ id: glossaryTermsTable.id })
    if (deleted.length > 0) {
      this.invalidateCache(siteId)
    }
    return deleted.length > 0
  }

  /**
   * The term list the rendering pipeline matches against — sorted longest-term-first isn't done here,
   * that is the markdown plugin's own concern (`renderers/modules/markdown-it-glossary.js`); this just
   * hands back every term with its definition and, when a canonical page is set, the link to it.
   */
  async getCachedTerms(siteId: string): Promise<CachedGlossaryTerm[]> {
    const key = cacheKey(siteId)
    if (WIKI.cache.has(key)) {
      return WIKI.cache.get(key) as CachedGlossaryTerm[]
    }

    const rows = await WIKI.db
      .select({
        term: glossaryTermsTable.term,
        definition: glossaryTermsTable.definition,
        pagePath: pagesTable.path,
        pageLocale: pagesTable.locale
      })
      .from(glossaryTermsTable)
      .leftJoin(pagesTable, eq(glossaryTermsTable.pageId, pagesTable.id))
      .where(eq(glossaryTermsTable.siteId, siteId))

    const locales = WIKI.sites[siteId]?.config?.locales
    const terms: CachedGlossaryTerm[] = rows.map((row) => ({
      term: row.term,
      definition: row.definition,
      link: row.pagePath ? localizedPagePath(row.pagePath, row.pageLocale ?? '', locales) : null
    }))

    WIKI.cache.set(key, terms)
    return terms
  }

  private invalidateCache(siteId: string): void {
    WIKI.cache.del(cacheKey(siteId))
  }

  /** Confirms a canonical page reference exists and belongs to the same site, or rejects it. */
  private async validatePageId(
    siteId: string,
    pageId: string | null | undefined
  ): Promise<string | null> {
    if (!pageId) {
      return null
    }
    const page = await WIKI.models.pages.getPage({ siteId, id: pageId })
    if (!page) {
      throw new CustomError(
        'glossaryInvalidPage',
        'The selected canonical page does not exist on this site.',
        400
      )
    }
    return pageId
  }
}

export const glossary = new Glossary()
