import { and, asc, eq, sql } from 'drizzle-orm'
import { glossaryTerms as glossaryTermsTable, pages as pagesTable } from '../db/schema.ts'
import { CustomError, localizedPagePath } from '../helpers/common.ts'

export interface GlossaryTerm {
  id: string
  term: string
  definition: string
  aliases: string[]
  pageId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface GlossaryTermInput {
  term: string
  definition: string
  aliases?: string[]
  pageId?: string | null
}

/** What the markdown renderer actually needs: no id, no timestamps, and the page link pre-resolved. */
export interface CachedGlossaryTerm {
  term: string
  definition: string
  aliases: string[]
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
    const aliases = normalizeAliases(input.aliases, term)
    const pageId = await this.validatePageId(siteId, input.pageId)
    await this.assertNoSurfaceFormCollision(siteId, term, aliases)

    let inserted
    try {
      inserted = await WIKI.db
        .insert(glossaryTermsTable)
        .values({ siteId, term, definition, aliases, pageId })
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

    // -> A collision check needs the FULL post-update surface-form set, so when either `term` or
    //    `aliases` changes we need whichever of the two ISN'T changing too, from the current row.
    if (input.term !== undefined || input.aliases !== undefined) {
      const current = await this.getTerm(siteId, id)
      if (!current) {
        throw new CustomError('glossaryNotFound', 'This glossary term does not exist.', 404)
      }
      const nextTerm = values.term ?? current.term
      const aliases = normalizeAliases(input.aliases ?? current.aliases, nextTerm)
      values.aliases = aliases
      await this.assertNoSurfaceFormCollision(siteId, nextTerm, aliases, id)
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
        aliases: glossaryTermsTable.aliases,
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
      aliases: row.aliases,
      link: row.pagePath ? localizedPagePath(row.pagePath, row.pageLocale ?? '', locales) : null
    }))

    WIKI.cache.set(key, terms)
    return terms
  }

  /**
   * Drops the resolved-term cache for a site. Public because a canonical page's path (or existence)
   * can change from outside this model — `models/pages.ts`'s `movePage`/`deletePage`/`deleteOrphaned`
   * call this too, since `getCachedTerms` bakes each term's link in at cache-build time and nothing
   * else would otherwise tell it a linked page moved or was deleted (OpenProject #870).
   */
  invalidateCache(siteId: string): void {
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

  /**
   * Rejects a term/aliases combination that shares a surface form -- case-insensitively -- with any
   * OTHER row on the site, across that row's own term AND aliases (OpenProject #1110). The DB's
   * `glossaryTerms_composite_idx` still catches an exact `term`-vs-`term` collision atomically; this
   * covers every other combination a plain unique index can't express (term-vs-alias, alias-vs-alias),
   * at the application level -- see the schema comment on `aliases`.
   */
  private async assertNoSurfaceFormCollision(
    siteId: string,
    term: string,
    aliases: string[],
    excludeId?: string
  ): Promise<void> {
    const surfaceForms = new Set([term.toLowerCase(), ...aliases.map((a) => a.toLowerCase())])
    const rows = await WIKI.db
      .select({
        id: glossaryTermsTable.id,
        term: glossaryTermsTable.term,
        aliases: glossaryTermsTable.aliases
      })
      .from(glossaryTermsTable)
      .where(eq(glossaryTermsTable.siteId, siteId))

    for (const row of rows) {
      if (excludeId && row.id === excludeId) {
        continue
      }
      const collides = [row.term, ...row.aliases].some((form) =>
        surfaceForms.has(form.toLowerCase())
      )
      if (collides) {
        throw new CustomError(
          'glossaryDuplicateTerm',
          'A term or alias with this name already exists.',
          409
        )
      }
    }
  }
}

/**
 * Trims each alias, drops empties, dedupes case-insensitively (first occurrence's casing wins), and
 * drops any alias that is just the term itself under a different case -- that would only ever be a
 * no-op surface form, never a genuinely distinct one.
 */
function normalizeAliases(aliases: string[] | undefined, term: string): string[] {
  const seen = new Set<string>([term.toLowerCase()])
  const result: string[] = []
  for (const raw of aliases ?? []) {
    const alias = raw.trim()
    if (!alias) {
      continue
    }
    const lower = alias.toLowerCase()
    if (seen.has(lower)) {
      continue
    }
    seen.add(lower)
    result.push(alias)
  }
  return result
}

export const glossary = new Glossary()
