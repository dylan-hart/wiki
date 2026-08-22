import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  glossaryTerms as glossaryTermsTable,
  glossaryVersions as glossaryVersionsTable,
  pages as pagesTable
} from '../db/schema.ts'
import {
  CustomError,
  generatePathHash,
  localizedPagePath,
  normalizePagePath
} from '../helpers/common.ts'

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

/**
 * The portable, external-editing-round-trip shape (OpenProject #1114): a `path`, not a `pageId`,
 * since an id is meaningless once this JSON has been edited outside the app and re-imported --
 * possibly into a different instance entirely. `formatVersion` bumps only if this shape ever changes
 * incompatibly. Reused as-is for each stored version snapshot (OpenProject #1113) -- one
 * representation shared by export, import, and versioning, per the spec.
 */
export const GLOSSARY_EXPORT_FORMAT_VERSION = 1

export interface GlossaryExportTerm {
  term: string
  definition: string
  aliases: string[]
  /** The canonical page's path, resolved against the site's primary locale. Null when unset. */
  path: string | null
}

export interface GlossaryExport {
  formatVersion: number
  terms: GlossaryExportTerm[]
}

/** Who saved/restored a glossary version -- a session user, mirroring `auditLog`'s actor shape. */
export interface GlossaryActor {
  id: string | null
  name: string
}

/** A version's own metadata, without the (potentially large) snapshot payload. */
export interface GlossaryVersionSummary {
  id: string
  termCount: number
  actorId: string | null
  actorName: string
  createdAt: Date
}

export interface GlossaryVersion extends GlossaryVersionSummary {
  snapshot: GlossaryExport
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
   * The full term list, portable and ready to hand to an external editor (OpenProject #1114) -- e.g.
   * an LLM asked to iterate on definitions. See `GlossaryExportTerm`'s own comment for the shape.
   */
  async exportTerms(siteId: string): Promise<GlossaryExport> {
    const rows = await WIKI.db
      .select({
        term: glossaryTermsTable.term,
        definition: glossaryTermsTable.definition,
        aliases: glossaryTermsTable.aliases,
        pagePath: pagesTable.path
      })
      .from(glossaryTermsTable)
      .leftJoin(pagesTable, eq(glossaryTermsTable.pageId, pagesTable.id))
      .where(eq(glossaryTermsTable.siteId, siteId))
      .orderBy(asc(glossaryTermsTable.term))

    return {
      formatVersion: GLOSSARY_EXPORT_FORMAT_VERSION,
      terms: rows.map((row) => ({
        term: row.term,
        definition: row.definition,
        aliases: row.aliases,
        path: row.pagePath ?? null
      }))
    }
  }

  /**
   * Replaces the site's ENTIRE term list with `data.terms` (OpenProject #1114) -- not a per-term
   * merge. Every entry is validated, and every `path` resolved to a page, before anything is written,
   * so a bad entry anywhere in the payload leaves the existing glossary untouched rather than applying
   * partway through.
   */
  async importTerms(siteId: string, data: GlossaryExport): Promise<GlossaryTerm[]> {
    if (!data || !Array.isArray(data.terms)) {
      throw new CustomError(
        'glossaryInvalidImport',
        'Malformed glossary import: expected an object with a "terms" array.',
        400
      )
    }

    const resolved: {
      term: string
      definition: string
      aliases: string[]
      pageId: string | null
    }[] = []
    for (const raw of data.terms) {
      const term = (raw?.term ?? '').trim()
      const definition = (raw?.definition ?? '').trim()
      if (!term) {
        throw new CustomError('glossaryEmptyTerm', 'A term cannot be empty.', 400)
      }
      if (!definition) {
        throw new CustomError(
          'glossaryEmptyDefinition',
          `Term "${term}" has an empty definition.`,
          400
        )
      }
      const aliases = normalizeAliases(raw?.aliases, term)
      const pageId = await this.resolvePagePath(siteId, raw?.path, term)
      resolved.push({ term, definition, aliases, pageId })
    }

    assertNoInternalSurfaceFormCollision(resolved)

    return this.replaceAllRows(siteId, resolved)
  }

  /**
   * Deletes every existing term for the site and inserts `rows` instead, in one transaction --
   * shared by JSON import (`importTerms`) and the admin staged-save/restore paths (`saveVersion`/
   * `restoreVersion`, OpenProject #1113), so every wholesale-replace caller applies the same
   * all-or-nothing semantics. Callers are responsible for validating `rows` first
   * (`assertNoInternalSurfaceFormCollision` above) -- a case-insensitive collision within `rows`
   * itself would otherwise surface as an opaque unique-constraint violation from the bulk insert
   * instead of a clear 400.
   */
  private async replaceAllRows(
    siteId: string,
    rows: { term: string; definition: string; aliases: string[]; pageId: string | null }[]
  ): Promise<GlossaryTerm[]> {
    const inserted = await WIKI.db.transaction(async (tx) => {
      await tx.delete(glossaryTermsTable).where(eq(glossaryTermsTable.siteId, siteId))
      if (!rows.length) {
        return []
      }
      return tx
        .insert(glossaryTermsTable)
        .values(rows.map((row) => ({ siteId, ...row })))
        .returning()
    })
    this.invalidateCache(siteId)
    return inserted
  }

  /** Resolves an export's `path` to a `pageId` against the site's primary locale, or rejects it. */
  private async resolvePagePath(
    siteId: string,
    path: string | null | undefined,
    term: string
  ): Promise<string | null> {
    if (!path) {
      return null
    }
    const normalized = normalizePagePath(path)
    const page = await WIKI.models.pages.getPage({ siteId, hash: generatePathHash(normalized) })
    if (!page) {
      throw new CustomError(
        'glossaryInvalidPage',
        `Term "${term}"'s canonical page path "${path}" does not resolve to an existing page on this site.`,
        400
      )
    }
    return page.id
  }

  /**
   * Applies a staged set of edits as the new, complete term list -- the admin UI's "Save" action
   * (OpenProject #1113): not immediate-apply per create/edit/delete, but one atomic replace of the
   * whole glossary, paired with a version snapshot of the result. `pageId`-based (unlike
   * `importTerms`'s `path`-based shape), since the admin UI already has a resolved id from its own
   * canonical-page picker (OpenProject #1112) -- no need to round-trip through a path here.
   */
  async saveVersion(
    siteId: string,
    inputs: GlossaryTermInput[],
    actor: GlossaryActor
  ): Promise<{ terms: GlossaryTerm[]; version: GlossaryVersionSummary }> {
    const resolved: {
      term: string
      definition: string
      aliases: string[]
      pageId: string | null
    }[] = []
    for (const raw of inputs) {
      const term = (raw?.term ?? '').trim()
      const definition = (raw?.definition ?? '').trim()
      if (!term) {
        throw new CustomError('glossaryEmptyTerm', 'A term cannot be empty.', 400)
      }
      if (!definition) {
        throw new CustomError(
          'glossaryEmptyDefinition',
          `Term "${term}" has an empty definition.`,
          400
        )
      }
      const aliases = normalizeAliases(raw?.aliases, term)
      const pageId = await this.validatePageId(siteId, raw?.pageId)
      resolved.push({ term, definition, aliases, pageId })
    }
    assertNoInternalSurfaceFormCollision(resolved)

    const terms = await this.replaceAllRows(siteId, resolved)
    const version = await this.recordVersion(siteId, actor)
    return { terms, version }
  }

  /** Every saved version's metadata, most recent first -- no `snapshot` payload; see `getVersion`. */
  async listVersions(siteId: string): Promise<GlossaryVersionSummary[]> {
    return WIKI.db
      .select({
        id: glossaryVersionsTable.id,
        termCount: glossaryVersionsTable.termCount,
        actorId: glossaryVersionsTable.actorId,
        actorName: glossaryVersionsTable.actorName,
        createdAt: glossaryVersionsTable.createdAt
      })
      .from(glossaryVersionsTable)
      .where(eq(glossaryVersionsTable.siteId, siteId))
      .orderBy(desc(glossaryVersionsTable.createdAt))
  }

  /** One saved version, snapshot included -- what a diff or a restore reads from. */
  async getVersion(siteId: string, versionId: string): Promise<GlossaryVersion | null> {
    const rows = await WIKI.db
      .select()
      .from(glossaryVersionsTable)
      .where(and(eq(glossaryVersionsTable.siteId, siteId), eq(glossaryVersionsTable.id, versionId)))
      .limit(1)
    const row = rows[0]
    if (!row) {
      return null
    }
    return {
      id: row.id,
      termCount: row.termCount,
      actorId: row.actorId,
      actorName: row.actorName,
      createdAt: row.createdAt,
      snapshot: row.snapshot as GlossaryExport
    }
  }

  /**
   * Restores a saved version as the glossary's new live state -- reusing `importTerms`'s validated,
   * wholesale-replace path against the version's own stored snapshot (the same JSON shape, per
   * OpenProject #1114's decision record). Rather than rewriting history, a restore is itself recorded
   * as a NEW version: the version list stays append-only and monotonic, so "what did the glossary
   * look like at time T" never changes retroactively, including for T = right after a restore.
   */
  async restoreVersion(
    siteId: string,
    versionId: string,
    actor: GlossaryActor
  ): Promise<{ terms: GlossaryTerm[]; version: GlossaryVersionSummary }> {
    const target = await this.getVersion(siteId, versionId)
    if (!target) {
      throw new CustomError('glossaryVersionNotFound', 'This glossary version does not exist.', 404)
    }
    const terms = await this.importTerms(siteId, target.snapshot)
    const version = await this.recordVersion(siteId, actor)
    return { terms, version }
  }

  /** Snapshots the glossary's CURRENT (already-written) state as a new version row. */
  private async recordVersion(
    siteId: string,
    actor: GlossaryActor
  ): Promise<GlossaryVersionSummary> {
    const snapshot = await this.exportTerms(siteId)
    const rows = await WIKI.db
      .insert(glossaryVersionsTable)
      .values({
        siteId,
        snapshot,
        termCount: snapshot.terms.length,
        actorId: actor.id,
        actorName: actor.name
      })
      .returning()
    const row = rows[0]!
    return {
      id: row.id,
      termCount: row.termCount,
      actorId: row.actorId,
      actorName: row.actorName,
      createdAt: row.createdAt
    }
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

/**
 * Rejects two entries in the SAME list that share a case-insensitive surface form (own term or any
 * alias) -- the within-payload counterpart to `Glossary#assertNoSurfaceFormCollision`, which checks
 * one entry against every OTHER row already in the database. A wholesale import/save/restore payload
 * has no existing rows to compare against yet (they are all about to be replaced together), so this
 * is what catches two entries in the same submission claiming the same surface form.
 */
function assertNoInternalSurfaceFormCollision(
  entries: { term: string; aliases: string[] }[]
): void {
  const claimedBy = new Map<string, string>()
  for (const entry of entries) {
    for (const form of [entry.term, ...entry.aliases]) {
      const lower = form.toLowerCase()
      const claimant = claimedBy.get(lower)
      if (claimant) {
        throw new CustomError(
          'glossaryDuplicateTerm',
          `"${entry.term}" and "${claimant}" both resolve to the surface form "${form}".`,
          400
        )
      }
      claimedBy.set(lower, entry.term)
    }
  }
}

export const glossary = new Glossary()
