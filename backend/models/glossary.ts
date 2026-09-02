import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { WikiDbOrTx } from '../core/db.ts'
import type { AccessActor } from './groups.ts'
import {
  glossaryTerms as glossaryTermsTable,
  glossaryVersions as glossaryVersionsTable,
  pages as pagesTable
} from '../db/schema.ts'
import {
  CustomError,
  generatePathHash,
  isUniqueViolation,
  normalizePagePath
} from '../helpers/common.ts'
import { localizedPagePath } from '../helpers/localeRouting.ts'

export type GlossaryTerm = Omit<typeof glossaryTermsTable.$inferSelect, 'siteId'>

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
 * The actor-blind shape actually cached under `WIKI.cache` (OpenProject #1127) -- everything
 * `getCachedTerms` needs to resolve a `link` per actor, without a `link` baked in for any one of
 * them. `pagePath` null means the term has no canonical page at all, the same "renders as plain text"
 * case a denied actor now also gets.
 */
interface CachedGlossaryEntry {
  term: string
  definition: string
  aliases: string[]
  pagePath: string | null
  pageLocale: string | null
  pageClassification: string | null
  pageTags: string[]
}

/**
 * The portable, external-editing-round-trip shape (OpenProject #1114): a `path`, not a `pageId`,
 * since an id is meaningless once this JSON has been edited outside the app and re-imported --
 * possibly into a different instance entirely. `formatVersion` bumps only if this shape ever changes
 * incompatibly. Reused as-is for each stored version snapshot (OpenProject #1113) -- one
 * representation shared by export, import, and versioning, per the spec.
 */
const GLOSSARY_EXPORT_FORMAT_VERSION = 1

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

/**
 * The writable counterpart to `GlossaryExportTerm`: what `importTerms`/`saveVersion` accept, where
 * `aliases`/`path` are optional (a malformed/partial payload is a validation error at runtime, not a
 * type error at the call site) -- mirroring how `GlossaryTermInput` relates to `GlossaryTerm`.
 */
export interface GlossaryExportTermInput {
  term: string
  definition: string
  aliases?: string[]
  path?: string | null
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

/** How long a raw term→page mapping survives with no invalidation heard at all -- see `invalidateCache`. */
const CACHE_TTL_MS = 5 * 60 * 1000

/** The HA propagation event name for a glossary cache invalidation -- see `invalidateCache`. */
const INVALIDATE_EVENT = 'invalidateGlossaryCache'

/**
 * Site-wide glossary terms (OpenProject #870).
 *
 * The admin CRUD screen is the source of truth for the term list — nothing here is derived from page
 * content, unlike `models/tags.ts`. `getCachedTerms` is the one method the rendering pipeline calls:
 * it resolves each term's canonical page (if any) to a link, per the calling actor's `read:pages`
 * access (OpenProject #1127) — a term whose page that actor may not read renders as plain, unlinked
 * text. Only the raw term→page mapping is cached under `WIKI.cache` (`getRawCachedTerms`), invalidated
 * by every write below the same way `models/locales.ts` refreshes its own `WIKI.cache` entry; the link
 * resolution itself is never cached, so it stays correct per actor without needing its own
 * invalidation whenever a group's rules change.
 *
 * `invalidateCache` broadcasts across the cluster (OpenProject #2038, mirroring
 * `models/groups.ts`/`sites.ts`/`approvals.ts`'s `reloadGroups`/`reloadSites`/`reloadApprovals`):
 * every caller below already routes through it, so a page saved on one instance drops the stale
 * term→page mapping everywhere, not just locally. `getRawCachedTerms` also caps every entry with a
 * bounded `CACHE_TTL_MS` as a defence-in-depth belt underneath the broadcast, not instead of it — a
 * missed notification (see `core/db.ts`'s at-most-once delivery notes) then diverges for minutes
 * rather than indefinitely, since the LRU it lives in (`new LRUCache({ max: 5000 })`, `index.ts`) has
 * no ttl of its own and would otherwise only evict this key under memory pressure.
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

  /**
   * `actor` is optional -- a caller with no session to attribute to (a test, a future seed/migration
   * path) simply gets no audit entry AND no version row, rather than being forced to invent an
   * attribution for either. The single-term REST routes (`api/glossary.ts`) always pass
   * `actorFromRequest(req)`, so every real admin/API-key edit through those routes IS attributed, and
   * therefore IS versioned. Audit instrumentation written from here rather than the API layer --
   * unlike every other `auditLog.record()` call site in this codebase -- per the OpenProject #1115
   * spec's explicit instruction to instrument these model methods directly.
   *
   * The insert and the version snapshot it triggers run in ONE transaction (OpenProject #1891):
   * before this, the per-term routes wrote directly with no version recorded at all, so a later
   * "restore previous version" would silently revert an edit made through them. Snapshotting the
   * whole glossary here, the same way `saveVersion`/`restoreVersion` do, means a per-term write is
   * indistinguishable from a staged-edit save as far as the version history is concerned -- both
   * leave the version list an accurate, restorable record of what the live glossary actually held.
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
    const pageId = await this.validatePageId(siteId, input.pageId)
    await this.assertNoSurfaceFormCollision(siteId, term, aliases)

    let inserted
    try {
      inserted = await WIKI.db.transaction(async (tx) => {
        const rows = await tx
          .insert(glossaryTermsTable)
          .values({ siteId, term, definition, aliases, pageId })
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
      await WIKI.models.auditLog.record({
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

  /** Same actor-optional audit + version semantics as `createTerm` above (OpenProject #1891) --
   *  the update and its version snapshot share one transaction, recorded only when a row actually
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
      // -> Recorded whenever the STORED set actually changes, not only when the caller explicitly
      //    passed `aliases` -- renaming a term to match one of its own existing aliases silently
      //    drops that alias too (see `normalizeAliases`'s own doc), and the audit log's whole point
      //    (OpenProject #1115) is reporting what actually changed, not just what the caller asked for.
      if (JSON.stringify(aliases) !== JSON.stringify(current.aliases)) {
        changedFields.push('aliases')
      }
      await this.assertNoSurfaceFormCollision(siteId, nextTerm, aliases, id)
    }

    let updated
    try {
      updated = await WIKI.db.transaction(async (tx) => {
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
      await WIKI.models.auditLog.record({
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

  /** Same actor-optional audit + version semantics as `createTerm` above (OpenProject #1891) --
   *  the delete and its version snapshot share one transaction, recorded only when a row was
   *  actually deleted. */
  async deleteTerm(siteId: string, id: string, actor?: GlossaryActor): Promise<boolean> {
    const existing = actor ? await this.getTerm(siteId, id) : null
    const deleted = await WIKI.db.transaction(async (tx) => {
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
        await WIKI.models.auditLog.record({
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
   * The full term list, portable and ready to hand to an external editor (OpenProject #1114) -- e.g.
   * an LLM asked to iterate on definitions. See `GlossaryExportTerm`'s own comment for the shape.
   *
   * `db` defaults to the ambient `WIKI.db`, but `recordVersionIn` passes its own open transaction so a
   * snapshot it takes reads back the rows that same transaction just wrote, not a separate connection
   * that cannot see them yet.
   */
  async exportTerms(siteId: string, db: WikiDbOrTx = WIKI.db): Promise<GlossaryExport> {
    const rows = await db
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
    const resolved = await this.resolveExportTerms(siteId, data.terms)
    return this.replaceAllRows(siteId, resolved)
  }

  /**
   * Validates a list of `GlossaryExportTerm`s -- the same shape whether it came from a JSON import
   * (`importTerms`) or the admin staged-edit UI's Save action (`saveVersion`, OpenProject #1112/#1113:
   * the canonical-page picker there is a live-validated path input, not a dropdown, so the admin UI's
   * own edits are already in this shape too) -- trimming/checking each entry, resolving `path` to a
   * `pageId`, and rejecting a within-payload surface-form collision, before anything is written.
   */
  private async resolveExportTerms(
    siteId: string,
    terms: GlossaryExportTermInput[]
  ): Promise<{ term: string; definition: string; aliases: string[]; pageId: string | null }[]> {
    const resolved: {
      term: string
      definition: string
      aliases: string[]
      pageId: string | null
    }[] = []
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
      const pageId = await this.resolvePagePath(siteId, raw?.path, term)
      resolved.push({ term, definition, aliases, pageId })
    }

    assertNoInternalSurfaceFormCollision(resolved)
    return resolved
  }

  /**
   * Deletes every existing term for the site and inserts `rows` instead, against `db` -- so this
   * never applies only halfway as long as `db` is itself a transaction handle. Callers are
   * responsible for validating `rows` first (`assertNoInternalSurfaceFormCollision` above) -- a
   * case-insensitive collision within `rows` itself would otherwise surface as an opaque
   * unique-constraint violation from the bulk insert instead of a clear 400.
   *
   * Does NOT invalidate the cache itself -- `db` may be mid-transaction, and invalidating before a
   * commit could hand a reader stale-again data if the transaction then rolls back. Callers
   * invalidate once their transaction has actually committed (`replaceAllRows`, `saveVersion`,
   * `restoreVersion` below).
   */
  private async replaceAllRowsIn(
    db: WikiDbOrTx,
    siteId: string,
    rows: { term: string; definition: string; aliases: string[]; pageId: string | null }[]
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
   * nothing else that needs to share its fate (JSON import, `importTerms` below). `saveVersion`/
   * `restoreVersion` need the replace and the version snapshot to commit or roll back together
   * (OpenProject #1113's "atomically" requirement), so THEY open one transaction themselves and call
   * `replaceAllRowsIn` directly instead of going through this wrapper.
   */
  private async replaceAllRows(
    siteId: string,
    rows: { term: string; definition: string; aliases: string[]; pageId: string | null }[]
  ): Promise<GlossaryTerm[]> {
    const inserted = await WIKI.db.transaction((tx) => this.replaceAllRowsIn(tx, siteId, rows))
    this.invalidateCache(siteId)
    return inserted
  }

  /**
   * Resolves an export's `path` to a `pageId` against the site's primary locale, or rejects it.
   *
   * Deliberately does NOT apply the `|| 'home'` default that `api/pages.ts` and `mcp/tools/getPage.ts`
   * use at their own normalize-then-hash call sites (OpenProject #1936). Those two resolve a
   * *request* for "whatever's at this path", where an empty path legitimately means the site root.
   * Here `path` is a glossary term's user-typed canonical-page reference: the `!path` guard above
   * already gives "no path at all" its own correct meaning (no canonical page for the term -- a valid
   * state), so a path that survives that guard but normalizes to empty (a bare `/`) is not a
   * deliberate reference to home -- it's unresolvable, exactly as `GlossaryTermDialog.vue`'s
   * `checkPath()` already treats it client-side before save. Defaulting it here would make the backend
   * silently accept what the UI already flags as invalid.
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
   * whole glossary, paired with a version snapshot of the result -- "atomically" per the spec's own
   * wording, so the replace and the snapshot run inside ONE transaction: either both commit, or
   * (a DB error mid-write, a crash) neither does, rather than a replace that landed with no version
   * to show for it. `GlossaryExportTerm`-shaped (`path`, not `pageId`), the SAME shape `importTerms`
   * takes: the admin UI's canonical-page picker is a live-validated path input, not a dropdown
   * (OpenProject #1112), so its own staged edits are already in this shape -- resolving `path` here
   * (rather than requiring the client to resolve it itself first) is what keeps that one round-trip
   * instead of two.
   */
  async saveVersion(
    siteId: string,
    terms: GlossaryExportTermInput[],
    actor: GlossaryActor
  ): Promise<{ terms: GlossaryTerm[]; version: GlossaryVersionSummary }> {
    const resolved = await this.resolveExportTerms(siteId, terms)
    const result = await WIKI.db.transaction(async (tx) => {
      const savedTerms = await this.replaceAllRowsIn(tx, siteId, resolved)
      const version = await this.recordVersionIn(tx, siteId, actor)
      return { terms: savedTerms, version }
    })
    this.invalidateCache(siteId)
    return result
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
   * Restores a saved version as the glossary's new live state -- the SAME validate-then-replace path
   * `importTerms` uses (against the version's own stored snapshot, per OpenProject #1114's decision
   * record), reused here directly rather than through `importTerms` itself so the replace and the new
   * version record below can share ONE transaction -- same "atomically" reasoning as `saveVersion`.
   * Rather than rewriting history, a restore is itself recorded as a NEW version: the version list
   * stays append-only and monotonic, so "what did the glossary look like at time T" never changes
   * retroactively, including for T = right after a restore.
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
    const result = await WIKI.db.transaction(async (tx) => {
      const terms = await this.replaceAllRowsIn(tx, siteId, resolved)
      const version = await this.recordVersionIn(tx, siteId, actor)
      return { terms, version }
    })
    this.invalidateCache(siteId)
    return result
  }

  /** Snapshots the glossary's CURRENT (already-written) state as a new version row, against `db` --
   *  see `replaceAllRowsIn`'s identical reasoning: `saveVersion`/`restoreVersion` pass their own open
   *  transaction so the snapshot this takes shares fate with the replace it is snapshotting. */
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

  /**
   * The raw, actor-blind term→page mapping, cached under `WIKI.cache` — the part that is genuinely
   * the same for everyone (which page a term points at). `getCachedTerms` is what turns this into a
   * `link`, fresh per actor, on every call.
   */
  private async getRawCachedTerms(siteId: string): Promise<CachedGlossaryEntry[]> {
    const key = cacheKey(siteId)
    if (WIKI.cache.has(key)) {
      return WIKI.cache.get(key) as CachedGlossaryEntry[]
    }

    const rows = await WIKI.db
      .select({
        term: glossaryTermsTable.term,
        definition: glossaryTermsTable.definition,
        aliases: glossaryTermsTable.aliases,
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
      pagePath: row.pagePath,
      pageLocale: row.pageLocale,
      pageClassification: row.pageClassification ?? null,
      pageTags: row.pageTags ?? []
    }))

    WIKI.cache.set(key, entries, { ttl: CACHE_TTL_MS })
    return entries
  }

  /**
   * The term list the rendering pipeline matches against — sorted longest-term-first isn't done here,
   * that is the markdown plugin's own concern (`renderers/modules/markdown-it-glossary.js`); this just
   * hands back every term with its definition and, when `actor` may read the canonical page set for
   * it, the link to it (OpenProject #1127). A term with no canonical page, or whose page `actor` may
   * not read, comes back with `link: null` — rendered as plain, unlinked text either way.
   */
  async getCachedTerms(siteId: string, actor: AccessActor): Promise<CachedGlossaryTerm[]> {
    const entries = await this.getRawCachedTerms(siteId)
    const locales = WIKI.sites[siteId]?.config?.locales
    return entries.map((entry) => ({
      term: entry.term,
      definition: entry.definition,
      aliases: entry.aliases,
      link:
        entry.pagePath &&
        WIKI.models.groups.checkAccess(actor, 'read:pages', {
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
   * Drops this instance's own raw term→page cache entry for a site, and nothing else -- no
   * broadcast. Called by `invalidateCache()` for the local half of its job, and by
   * `subscribeToEvents()`'s inbound handler answering *another* instance's broadcast, which must
   * never call `invalidateCache()` itself or the invalidation would echo around the cluster forever
   * (the same rule `models/groups.ts`'s `broadcastReload()` documents for `reloadCache()`).
   */
  dropLocalCache(siteId: string): void {
    WIKI.cache.delete(cacheKey(siteId))
  }

  /**
   * Drops the raw term→page cache for a site, then tells every other instance in the cluster to do
   * the same. Public because a canonical page's path (or existence) can change from outside this
   * model — `models/pages.ts`'s `movePage`/`deletePage`/`deleteOrphaned` call this too, since
   * `getRawCachedTerms` caches which page a term points at and nothing else would otherwise tell it a
   * linked page moved or was deleted (OpenProject #870).
   */
  invalidateCache(siteId: string): void {
    this.dropLocalCache(siteId)
    WIKI.events.outbound.emit(INVALIDATE_EVENT, { siteId })
  }

  /**
   * Subscribe to HA propagation events.
   *
   * `emittery` (pinned 2.0.0) hands a specific `.on(eventName, listener)` the same `{ name, data }`
   * wrapper `onAny` gets, not the raw payload — see `core/db.ts`'s `notifyViaDB` and
   * `core/db.test.ts`'s "echoing this same instance" test for the same shape read the same way.
   */
  subscribeToEvents(): void {
    WIKI.events.inbound.on(INVALIDATE_EVENT, (evt: { data?: { siteId?: string } }) => {
      const siteId = evt?.data?.siteId
      if (siteId) {
        this.dropLocalCache(siteId)
      }
    })
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
