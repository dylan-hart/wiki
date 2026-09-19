import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { WikiDbOrTx } from '../core/db.ts'
import type { AccessActor } from './groups.ts'
import {
  glossaryTerms as glossaryTermsTable,
  glossaryVersions as glossaryVersionsTable,
  pages as pagesTable,
  type GlossaryAliasRow
} from '../db/schema.ts'
import {
  CustomError,
  generatePathHash,
  isUniqueViolation,
  normalizePagePath
} from '../helpers/common.ts'
import { localizedPagePath } from '../helpers/localeRouting.ts'

export type GlossaryTerm = Omit<typeof glossaryTermsTable.$inferSelect, 'siteId'>

export type GlossaryAlias = GlossaryAliasRow

export interface GlossaryTermInput {
  term: string
  definition: string
  aliases?: GlossaryAlias[]
  /** Marks the term itself, not its aliases -- each alias carries its own flag. */
  isAcronym?: boolean
  pageId?: string | null
}

export interface CachedGlossaryTerm {
  term: string
  definition: string
  aliases: GlossaryAlias[]
  isAcronym: boolean
  link: string | null
}

/**
 * The actor-blind shape cached under `CARDINAL.cache`: everything `getCachedTerms` needs to resolve a
 * `link` per actor, with no `link` baked in for any one of them.
 */
interface CachedGlossaryEntry {
  term: string
  definition: string
  aliases: GlossaryAlias[]
  isAcronym: boolean
  pagePath: string | null
  pageLocale: string | null
  pageClassification: string | null
  pageTags: string[]
}

/**
 * The portable, external-editing-round-trip shape: a `path`, not a `pageId`, since an id is
 * meaningless once this JSON has been edited outside the app and re-imported -- possibly into a
 * different instance entirely. Bumped only when that shape changes incompatibly. One representation
 * shared by export, import and version snapshots.
 */
const GLOSSARY_EXPORT_FORMAT_VERSION = 2

export interface GlossaryExportTerm {
  term: string
  definition: string
  aliases: GlossaryAlias[]
  isAcronym: boolean
  /** Resolved against the site's primary locale. */
  path: string | null
}

export interface GlossaryExport {
  formatVersion: number
  terms: GlossaryExportTerm[]
}

/**
 * The writable counterpart to `GlossaryExportTerm`: the optional fields make a partial payload a
 * runtime validation error rather than a type error at the call site.
 */
export interface GlossaryExportTermInput {
  term: string
  definition: string
  aliases?: GlossaryAlias[]
  isAcronym?: boolean
  path?: string | null
}

export interface GlossaryActor {
  id: string | null
  name: string
}

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

interface ResolvedTermRow {
  term: string
  definition: string
  aliases: GlossaryAlias[]
  isAcronym: boolean
  pageId: string | null
}

function cacheKey(siteId: string): string {
  return `glossary:${siteId}`
}

/**
 * A belt underneath `invalidateCache`'s broadcast, not instead of it: event delivery is at-most-once,
 * and the LRU these entries live in has no ttl of its own, so a missed notification diverges for
 * minutes rather than until the key is evicted under memory pressure.
 */
const CACHE_TTL_MS = 5 * 60 * 1000

const INVALIDATE_EVENT = 'invalidateGlossaryCache'

/**
 * Site-wide glossary terms. The admin CRUD screen is the source of truth for the term list — nothing
 * here is derived from page content, unlike `models/tags.ts`.
 *
 * Only the actor-blind term→page mapping is cached (`getRawCachedTerms`); the per-actor `read:pages`
 * link resolution `getCachedTerms` layers on top is never cached, so it stays correct as a group's
 * rules change without needing an invalidation of its own.
 */
class Glossary {
  async listTerms(siteId: string): Promise<GlossaryTerm[]> {
    return CARDINAL.db
      .select()
      .from(glossaryTermsTable)
      .where(eq(glossaryTermsTable.siteId, siteId))
      .orderBy(asc(glossaryTermsTable.term))
  }

  async getTerm(siteId: string, id: string): Promise<GlossaryTerm | null> {
    const rows = await CARDINAL.db
      .select()
      .from(glossaryTermsTable)
      .where(and(eq(glossaryTermsTable.siteId, siteId), eq(glossaryTermsTable.id, id)))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * `actor` is optional -- a caller with no session to attribute to gets no audit entry AND no
   * version row, rather than being forced to invent an attribution for either. The single-term REST
   * routes always pass one, so every real admin/API-key edit is attributed and therefore versioned.
   *
   * The insert and the version snapshot it triggers share ONE transaction: a per-term write that
   * landed without a version would make a later "restore previous version" silently revert it.
   */
  async createTerm(
    siteId: string,
    input: GlossaryTermInput,
    actor?: GlossaryActor
  ): Promise<GlossaryTerm> {
    const term = input.term.trim()
    const definition = input.definition.trim()
    if (!term) {
      throw new CustomError('glossaryEmptyTerm', 'A term cannot be empty.', 400)
    }
    if (!definition) {
      throw new CustomError('glossaryEmptyDefinition', 'A definition cannot be empty.', 400)
    }
    const aliases = normalizeAliases(input.aliases, term)
    const isAcronym = !!input.isAcronym
    const pageId = await this.validatePageId(siteId, input.pageId)
    await this.assertNoSurfaceFormCollision(siteId, term, aliases)

    let inserted
    try {
      inserted = await CARDINAL.db.transaction(async (tx) => {
        const rows = await tx
          .insert(glossaryTermsTable)
          .values({ siteId, term, definition, aliases, isAcronym, pageId })
          .returning()
        if (actor) {
          await this.recordVersionIn(tx, siteId, actor)
        }
        return rows
      })
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        throw new CustomError('glossaryDuplicateTerm', 'A term with this name already exists.', 409)
      }
      throw err
    }
    this.invalidateCache(siteId)
    const row = inserted[0]!
    if (actor) {
      await CARDINAL.models.auditLog.record({
        event: 'glossaryTerm.created',
        actor,
        targetType: 'glossaryTerm',
        targetId: row.id,
        targetLabel: row.term,
        detail: {},
        siteId
      })
    }
    return row
  }

  /** Same actor-optional audit + version semantics as `createTerm`, recorded only when a row actually
   *  changed. */
  async updateTerm(
    siteId: string,
    id: string,
    input: Partial<GlossaryTermInput>,
    actor?: GlossaryActor
  ): Promise<GlossaryTerm> {
    const values: Record<string, any> = { updatedAt: sql`now()` }
    const changedFields: string[] = []
    if (input.term !== undefined) {
      const term = input.term.trim()
      if (!term) {
        throw new CustomError('glossaryEmptyTerm', 'A term cannot be empty.', 400)
      }
      values.term = term
      changedFields.push('term')
    }
    if (input.definition !== undefined) {
      const definition = input.definition.trim()
      if (!definition) {
        throw new CustomError('glossaryEmptyDefinition', 'A definition cannot be empty.', 400)
      }
      values.definition = definition
      changedFields.push('definition')
    }
    if (input.pageId !== undefined) {
      values.pageId = await this.validatePageId(siteId, input.pageId)
      changedFields.push('pageId')
    }
    if (input.isAcronym !== undefined) {
      values.isAcronym = !!input.isAcronym
      changedFields.push('isAcronym')
    }

    // -> A collision check needs the FULL post-update surface-form set, so a change to either `term`
    //    or `aliases` has to read whichever of the two isn't changing back from the current row.
    if (input.term !== undefined || input.aliases !== undefined) {
      const current = await this.getTerm(siteId, id)
      if (!current) {
        throw new CustomError('glossaryNotFound', 'This glossary term does not exist.', 404)
      }
      const nextTerm = values.term ?? current.term
      const aliases = normalizeAliases(input.aliases ?? current.aliases, nextTerm)
      values.aliases = aliases
      // -> Recorded whenever the STORED set actually changes, not only when the caller explicitly
      //    passed `aliases`: renaming a term to match one of its own existing aliases silently drops
      //    that alias too (`normalizeAliases`), and the audit log reports what changed, not what was
      //    asked for.
      if (JSON.stringify(aliases) !== JSON.stringify(current.aliases)) {
        changedFields.push('aliases')
      }
      await this.assertNoSurfaceFormCollision(siteId, nextTerm, aliases, id)
    }

    let updated
    try {
      updated = await CARDINAL.db.transaction(async (tx) => {
        const rows = await tx
          .update(glossaryTermsTable)
          .set(values)
          .where(and(eq(glossaryTermsTable.siteId, siteId), eq(glossaryTermsTable.id, id)))
          .returning()
        if (actor && rows[0]) {
          await this.recordVersionIn(tx, siteId, actor)
        }
        return rows
      })
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        throw new CustomError('glossaryDuplicateTerm', 'A term with this name already exists.', 409)
      }
      throw err
    }
    if (!updated[0]) {
      throw new CustomError('glossaryNotFound', 'This glossary term does not exist.', 404)
    }
    this.invalidateCache(siteId)
    const row = updated[0]!
    if (actor) {
      await CARDINAL.models.auditLog.record({
        event: 'glossaryTerm.updated',
        actor,
        targetType: 'glossaryTerm',
        targetId: row.id,
        targetLabel: row.term,
        detail: { changedFields },
        siteId
      })
    }
    return row
  }

  /** Same actor-optional audit + version semantics as `createTerm`, recorded only when a row was
   *  actually deleted. */
  async deleteTerm(siteId: string, id: string, actor?: GlossaryActor): Promise<boolean> {
    const existing = actor ? await this.getTerm(siteId, id) : null
    const deleted = await CARDINAL.db.transaction(async (tx) => {
      const rows = await tx
        .delete(glossaryTermsTable)
        .where(and(eq(glossaryTermsTable.siteId, siteId), eq(glossaryTermsTable.id, id)))
        .returning({ id: glossaryTermsTable.id })
      if (actor && rows.length > 0) {
        await this.recordVersionIn(tx, siteId, actor)
      }
      return rows
    })
    if (deleted.length > 0) {
      this.invalidateCache(siteId)
      if (actor && existing) {
        await CARDINAL.models.auditLog.record({
          event: 'glossaryTerm.deleted',
          actor,
          targetType: 'glossaryTerm',
          targetId: existing.id,
          targetLabel: existing.term,
          detail: {},
          siteId
        })
      }
    }
    return deleted.length > 0
  }

  /**
   * `db` defaults to the ambient `CARDINAL.db`, but `recordVersionIn` passes its own open transaction
   * so a snapshot reads back the rows that same transaction just wrote, rather than a separate
   * connection that cannot see them yet.
   */
  async exportTerms(siteId: string, db: WikiDbOrTx = CARDINAL.db): Promise<GlossaryExport> {
    const rows = await db
      .select({
        term: glossaryTermsTable.term,
        definition: glossaryTermsTable.definition,
        aliases: glossaryTermsTable.aliases,
        isAcronym: glossaryTermsTable.isAcronym,
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
        isAcronym: row.isAcronym,
        path: row.pagePath ?? null
      }))
    }
  }

  /**
   * Replaces the site's ENTIRE term list with `data.terms` -- not a per-term merge. Everything is
   * validated before anything is written, so a bad entry anywhere in the payload leaves the existing
   * glossary untouched rather than applying partway through.
   */
  async importTerms(siteId: string, data: GlossaryExport): Promise<GlossaryTerm[]> {
    if (!data || !Array.isArray(data.terms)) {
      throw new CustomError(
        'glossaryInvalidImport',
        'Malformed glossary import: expected an object with a "terms" array.',
        400
      )
    }
    const resolved = await this.resolveExportTerms(siteId, data.terms)
    return this.replaceAllRows(siteId, resolved)
  }

  /**
   * Validates a list of `GlossaryExportTerm`s -- the same shape whether it came from a JSON import or
   * the admin staged-edit UI's Save -- resolving `path` to a `pageId` and rejecting a within-payload
   * surface-form collision, all before anything is written.
   */
  private async resolveExportTerms(
    siteId: string,
    terms: GlossaryExportTermInput[]
  ): Promise<ResolvedTermRow[]> {
    const resolved: ResolvedTermRow[] = []
    for (const raw of terms) {
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
      const isAcronym = !!raw?.isAcronym
      const pageId = await this.resolvePagePath(siteId, raw?.path, term)
      resolved.push({ term, definition, aliases, isAcronym, pageId })
    }

    assertNoInternalSurfaceFormCollision(resolved)
    return resolved
  }

  /**
   * Deletes every existing term for the site and inserts `rows` instead, against `db` -- so this
   * never applies only halfway as long as `db` is itself a transaction handle. Callers validate
   * `rows` first (`assertNoInternalSurfaceFormCollision`): a case-insensitive collision within `rows`
   * itself would otherwise surface as an opaque unique-constraint violation instead of a clear 400.
   *
   * Does NOT invalidate the cache itself -- `db` may be mid-transaction, and invalidating before the
   * commit could refill it with stale-again data if that transaction then rolls back. Callers
   * invalidate once their transaction has committed.
   */
  private async replaceAllRowsIn(
    db: WikiDbOrTx,
    siteId: string,
    rows: ResolvedTermRow[]
  ): Promise<GlossaryTerm[]> {
    await db.delete(glossaryTermsTable).where(eq(glossaryTermsTable.siteId, siteId))
    if (!rows.length) {
      return []
    }
    return db
      .insert(glossaryTermsTable)
      .values(rows.map((row) => ({ siteId, ...row })))
      .returning()
  }

  /**
   * `replaceAllRowsIn`, opening its own transaction -- for a standalone wholesale replace with
   * nothing else that needs to share its fate. `saveVersion`/`restoreVersion` open their own
   * instead, so the replace and the version snapshot commit or roll back together.
   */
  private async replaceAllRows(siteId: string, rows: ResolvedTermRow[]): Promise<GlossaryTerm[]> {
    const inserted = await CARDINAL.db.transaction((tx) => this.replaceAllRowsIn(tx, siteId, rows))
    this.invalidateCache(siteId)
    return inserted
  }

  /**
   * Resolves an export's `path` to a `pageId` against the site's primary locale, or rejects it.
   *
   * Deliberately does NOT apply the `|| 'home'` default that other normalize-then-hash call sites
   * use. Those resolve a *request* for "whatever's at this path", where an empty path legitimately
   * means the site root. Here `path` is a term's user-typed canonical-page reference, and the `!path`
   * guard below already gives "no path at all" its own meaning, so a path that survives that guard
   * but normalizes to empty (a bare `/`) is unresolvable rather than a reference to home.
   */
  private async resolvePagePath(
    siteId: string,
    path: string | null | undefined,
    term: string
  ): Promise<string | null> {
    if (!path) {
      return null
    }
    const normalized = normalizePagePath(path)
    const page = await CARDINAL.models.pages.getPage({ siteId, hash: generatePathHash(normalized) })
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
   * Applies a staged set of edits as the new, complete term list -- the admin UI's "Save" action:
   * not immediate-apply per create/edit/delete, but one atomic replace of the whole glossary paired
   * with a version snapshot of the result, inside ONE transaction, so a replace never lands with no
   * version to show for it. `path`-shaped, not `pageId`-shaped, because the admin UI's
   * canonical-page picker is a live-validated path input: resolving it here keeps the save to one
   * round trip.
   */
  async saveVersion(
    siteId: string,
    terms: GlossaryExportTermInput[],
    actor: GlossaryActor
  ): Promise<{ terms: GlossaryTerm[]; version: GlossaryVersionSummary }> {
    const resolved = await this.resolveExportTerms(siteId, terms)
    const result = await CARDINAL.db.transaction(async (tx) => {
      const savedTerms = await this.replaceAllRowsIn(tx, siteId, resolved)
      const version = await this.recordVersionIn(tx, siteId, actor)
      return { terms: savedTerms, version }
    })
    this.invalidateCache(siteId)
    return result
  }

  async listVersions(siteId: string): Promise<GlossaryVersionSummary[]> {
    return CARDINAL.db
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

  async getVersion(siteId: string, versionId: string): Promise<GlossaryVersion | null> {
    const rows = await CARDINAL.db
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
   * Restores a saved version as the glossary's new live state -- the SAME validate-then-replace path
   * `importTerms` uses, inlined rather than called through it so the replace and the new version
   * record share ONE transaction. Rather than rewriting history, a restore is itself recorded as a
   * NEW version: the version list stays append-only, so "what did the glossary look like at time T"
   * never changes retroactively.
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
    const resolved = await this.resolveExportTerms(siteId, target.snapshot.terms)
    const result = await CARDINAL.db.transaction(async (tx) => {
      const terms = await this.replaceAllRowsIn(tx, siteId, resolved)
      const version = await this.recordVersionIn(tx, siteId, actor)
      return { terms, version }
    })
    this.invalidateCache(siteId)
    return result
  }

  /** Snapshots the glossary's CURRENT (already-written) state as a new version row, against `db` --
   *  `saveVersion`/`restoreVersion` pass their own open transaction so the snapshot shares fate with
   *  the replace it is snapshotting. */
  private async recordVersionIn(
    db: WikiDbOrTx,
    siteId: string,
    actor: GlossaryActor
  ): Promise<GlossaryVersionSummary> {
    const snapshot = await this.exportTerms(siteId, db)
    const rows = await db
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

  private async getRawCachedTerms(siteId: string): Promise<CachedGlossaryEntry[]> {
    const key = cacheKey(siteId)
    if (CARDINAL.cache.has(key)) {
      return CARDINAL.cache.get(key) as CachedGlossaryEntry[]
    }

    const rows = await CARDINAL.db
      .select({
        term: glossaryTermsTable.term,
        definition: glossaryTermsTable.definition,
        aliases: glossaryTermsTable.aliases,
        isAcronym: glossaryTermsTable.isAcronym,
        pagePath: pagesTable.path,
        pageLocale: pagesTable.locale,
        pageClassification: pagesTable.classification,
        pageTags: pagesTable.tags
      })
      .from(glossaryTermsTable)
      .leftJoin(pagesTable, eq(glossaryTermsTable.pageId, pagesTable.id))
      .where(eq(glossaryTermsTable.siteId, siteId))

    const entries: CachedGlossaryEntry[] = rows.map((row) => ({
      term: row.term,
      definition: row.definition,
      aliases: row.aliases,
      isAcronym: row.isAcronym,
      pagePath: row.pagePath,
      pageLocale: row.pageLocale,
      pageClassification: row.pageClassification ?? null,
      pageTags: row.pageTags ?? []
    }))

    CARDINAL.cache.set(key, entries, { ttl: CACHE_TTL_MS })
    return entries
  }

  /**
   * The term list the rendering pipeline matches against. Longest-term-first ordering is the markdown
   * plugin's own concern (`frontend/src/renderers/modules/markdown-it-glossary.js`), not done here. A
   * `link: null` term — no canonical page, or one `actor` may not read — renders as plain text.
   */
  async getCachedTerms(siteId: string, actor: AccessActor): Promise<CachedGlossaryTerm[]> {
    const entries = await this.getRawCachedTerms(siteId)
    const locales = CARDINAL.sites[siteId]?.config?.locales
    return entries.map((entry) => ({
      term: entry.term,
      definition: entry.definition,
      aliases: entry.aliases,
      isAcronym: entry.isAcronym,
      link:
        entry.pagePath &&
        CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
          path: entry.pagePath,
          locale: entry.pageLocale,
          siteId,
          classification: entry.pageClassification,
          tags: entry.pageTags
        })
          ? localizedPagePath(entry.pagePath, entry.pageLocale ?? '', locales)
          : null
    }))
  }

  /**
   * Lowercase surface form → canonical display casing, for every term/alias marked `isAcronym`. The
   * frontend's path-segment humanizer looks a segment up by lowercase key, so "uss" renders as "USS"
   * rather than its own title-case guess. Actor-blind -- an acronym's casing carries no page-access
   * sensitivity -- so it shares the raw cache rather than keeping a separate entry to invalidate.
   */
  async getAcronymMap(siteId: string): Promise<Record<string, string>> {
    const entries = await this.getRawCachedTerms(siteId)
    const map: Record<string, string> = {}
    for (const entry of entries) {
      if (entry.isAcronym) {
        map[entry.term.toLowerCase()] = entry.term
      }
      for (const alias of entry.aliases) {
        if (alias.isAcronym) {
          map[alias.value.toLowerCase()] = alias.value
        }
      }
    }
    return map
  }

  /**
   * Drops this instance's own raw term→page cache entry for a site, and nothing else -- no broadcast.
   * `subscribeToEvents()`'s inbound handler answers *another* instance's broadcast with this and must
   * never call `invalidateCache()`, or the invalidation would echo around the cluster forever.
   */
  dropLocalCache(siteId: string): void {
    CARDINAL.cache.delete(cacheKey(siteId))
  }

  /**
   * Drops the raw term→page cache for a site, then tells every other instance in the cluster to do
   * the same. Public because a canonical page's path (or existence) can change from outside this
   * model — `models/pages.ts`'s move/delete paths call it too, since nothing else would tell the
   * cache that a linked page moved or was deleted.
   */
  invalidateCache(siteId: string): void {
    this.dropLocalCache(siteId)
    CARDINAL.events.outbound.emit(INVALIDATE_EVENT, { siteId })
  }

  /**
   * `emittery` hands a specific `.on(eventName, listener)` the same `{ name, data }` wrapper `onAny`
   * gets, not the raw payload.
   */
  subscribeToEvents(): void {
    CARDINAL.events.inbound.on(INVALIDATE_EVENT, (evt: { data?: { siteId?: string } }) => {
      const siteId = evt?.data?.siteId
      if (siteId) {
        this.dropLocalCache(siteId)
      }
    })
  }

  private async validatePageId(
    siteId: string,
    pageId: string | null | undefined
  ): Promise<string | null> {
    if (!pageId) {
      return null
    }
    const page = await CARDINAL.models.pages.getPage({ siteId, id: pageId })
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
   * OTHER row on the site, across that row's own term AND aliases. The DB's
   * `glossaryTerms_composite_idx` still catches an exact `term`-vs-`term` collision atomically; this
   * covers, at the application level, every combination a plain unique index can't express
   * (term-vs-alias, alias-vs-alias).
   */
  private async assertNoSurfaceFormCollision(
    siteId: string,
    term: string,
    aliases: GlossaryAlias[],
    excludeId?: string
  ): Promise<void> {
    const surfaceForms = new Set([term.toLowerCase(), ...aliases.map((a) => a.value.toLowerCase())])
    const rows = await CARDINAL.db
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
      const collides = [row.term, ...row.aliases.map((a) => a.value)].some((form) =>
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
 * Trims, drops empties, dedupes case-insensitively (first occurrence's casing AND `isAcronym` win),
 * and drops any alias that is just the term itself under a different case -- a no-op surface form,
 * never a genuinely distinct one.
 */
function normalizeAliases(aliases: GlossaryAlias[] | undefined, term: string): GlossaryAlias[] {
  const seen = new Set<string>([term.toLowerCase()])
  const result: GlossaryAlias[] = []
  for (const raw of aliases ?? []) {
    const value = (raw?.value ?? '').trim()
    if (!value) {
      continue
    }
    const lower = value.toLowerCase()
    if (seen.has(lower)) {
      continue
    }
    seen.add(lower)
    result.push({ value, isAcronym: !!raw?.isAcronym })
  }
  return result
}

/**
 * Rejects two entries in the SAME list that share a case-insensitive surface form (own term or any
 * alias) -- the within-payload counterpart to `Glossary#assertNoSurfaceFormCollision`, which checks
 * one entry against every OTHER row already in the database. A wholesale import/save/restore payload
 * has no such rows to compare against: they are all about to be replaced together.
 */
function assertNoInternalSurfaceFormCollision(
  entries: { term: string; aliases: GlossaryAlias[] }[]
): void {
  const claimedBy = new Map<string, string>()
  for (const entry of entries) {
    for (const form of [entry.term, ...entry.aliases.map((a) => a.value)]) {
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
