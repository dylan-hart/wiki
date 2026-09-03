import { stat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { locales as localesTable } from '../db/schema.ts'
import { eq, lt, sql } from 'drizzle-orm'
import { isPlainObject } from 'es-toolkit/predicate'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import type { LocalazyLanguage } from '../locales/metadata.d.ts'

/**
 * Builds the on-disk / DB `code` for a metadata.js language entry: `language[-region][-script]`,
 * e.g. `{ language: 'pt', region: 'BR' }` -> `pt-BR`, `{ language: 'zh', script: 'Hans' }` ->
 * `zh-Hans`. Exported so `locales.test.ts` can assert every declared language has a matching
 * `backend/locales/<code>.json` file on disk without duplicating this logic.
 */
export function localeCode(lang: Pick<LocalazyLanguage, 'language' | 'region' | 'script'>): string {
  const parts = [lang.language]
  if (lang.region) {
    parts.push(lang.region)
  }
  if (lang.script) {
    parts.push(lang.script)
  }
  return parts.join('-')
}

/**
 * Completeness of `targetStrings` against `baseStrings` (the `en` locale), as a 0-100 integer
 * percentage: `Math.round(100 * matchingNonEmptyKeys / totalBaseKeys)`. A base key counts as present
 * only if `targetStrings` has it too *and* the value is a non-empty string — a key present but blank
 * (a real shape translation tooling can produce) does not count as translated. `en.json` is flat (no
 * nesting), so this is a single top-level key comparison, not a deep walk. Exported so
 * `locales.test.ts` can assert the percentage directly without going through `refreshFromDisk`'s
 * disk/DB machinery.
 */
export function computeCompleteness(
  baseStrings: Record<string, unknown>,
  targetStrings: Record<string, unknown>
): number {
  const baseKeys = Object.keys(baseStrings)
  if (baseKeys.length === 0) {
    return 100
  }
  let matching = 0
  for (const key of baseKeys) {
    const value = targetStrings[key]
    if (typeof value === 'string' && value.length > 0) {
      matching++
    }
  }
  return Math.round((100 * matching) / baseKeys.length)
}

/**
 * One locale pack as a sideload JSON file must shape it — see `parseSideloadLocalePack`.
 *
 * `strings` is intersected in rather than narrowed on the `locales.strings` column itself
 * (`db/schema.ts`): that column's `.default([])` is an array, which is not assignable to a
 * `.$type<Record<string, unknown>>()` column.
 */
export type SideloadLocalePack = Pick<
  typeof localesTable.$inferSelect,
  'name' | 'nativeName' | 'language' | 'region' | 'script' | 'isRTL'
> & { strings: Record<string, unknown> }

/**
 * Substitute `{name}`-style placeholders in a server-rendered string — the same interpolation
 * syntax `en.json` already uses throughout for vue-i18n on the frontend, reused here so a
 * `mail.*` template reads the same way whichever side resolves it. A placeholder with no matching
 * `params` entry is left as-is rather than replaced with an empty string, so a typo'd or
 * not-yet-supplied key is visibly wrong instead of silently vanishing.
 */
export function interpolate(template: string, params: Record<string, string> = {}): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(params, key) ? params[key] : match
  )
}

/**
 * Validates one parsed JSON file from `<dataPath>/locales/` (OpenProject #820's sideload
 * mechanism — see `sideloadFromDataPath`) into a `SideloadLocalePack`, or an error string naming
 * what is missing. A sideload file is self-contained (unlike the vendored files under
 * `backend/locales/`, whose metadata comes from `locales/metadata.js`): it may name a code the
 * built-in language table has never heard of, which is the whole point of letting an operator add
 * a locale, not just update one. Only `name`, `language` and `strings` are required; the rest
 * default the same way a fresh row would.
 */
export function parseSideloadLocalePack(
  raw: unknown
): { ok: true; pack: SideloadLocalePack } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'not a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name) {
    return { ok: false, error: 'missing required string field "name"' }
  }
  if (typeof obj.language !== 'string' || !obj.language) {
    return { ok: false, error: 'missing required string field "language"' }
  }
  if (!isPlainObject(obj.strings)) {
    return { ok: false, error: 'missing required object field "strings"' }
  }
  return {
    ok: true,
    pack: {
      name: obj.name,
      nativeName: typeof obj.nativeName === 'string' ? obj.nativeName : obj.name,
      language: obj.language,
      region: typeof obj.region === 'string' ? obj.region : '',
      script: typeof obj.script === 'string' ? obj.script : '',
      isRTL: obj.isRTL === true,
      strings: obj.strings as Record<string, unknown>
    }
  }
}

/**
 * Locales model
 */
class Locales extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadLocales'

  /**
   * `<dataPath>/locales` — a writeable directory an operator drops locale-pack JSON files into
   * against a running instance's data volume, no rebuild/redeploy/network access needed. Read by
   * `sideloadFromDataPath`, which `refreshFromDisk` calls on every boot; `POST
   * /_api/locales/sideload` re-runs it on demand for an instance that is already up. See
   * `docs/offline-deployment.md` (OpenProject #820).
   */
  sideloadPath(): string {
    // -> Falls back to `base.yml`'s own default rather than requiring every caller (including a
    //    `WIKI.config` fixture that has no reason to care about paths) to have merged it in.
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath || './data', 'locales')
  }

  /**
   * Loads every `<code>.json` file under `sideloadPath()` into the `locales` table, the same
   * mtime-vs-`updatedAt` freshness check and `completeness` computation `refreshFromDisk` uses for
   * the vendored files — a sideloaded pack updates an existing code, or adds a wholly new one that
   * `locales/metadata.js` never declared. Missing directory is not an error: most instances have
   * nothing sideloaded, and this runs unconditionally on every boot.
   */
  async sideloadFromDataPath({ force = false }: { force?: boolean } = {}): Promise<{
    loaded: string[]
    skipped: { code: string; error: string }[]
  }> {
    const dir = this.sideloadPath()
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return { loaded: [], skipped: [] }
    }

    const baseStrings = JSON.parse(
      await readFile(path.join(WIKI.SERVERPATH, 'locales/en.json'), 'utf8')
    )
    const dbLocales = await WIKI.db
      .select({ code: localesTable.code, updatedAt: localesTable.updatedAt })
      .from(localesTable)

    const loaded: string[] = []
    const skipped: { code: string; error: string }[] = []

    for (const file of files) {
      const code = file.replace(/\.json$/, '')
      const flPath = path.join(dir, file)
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(flPath, 'utf8'))
      } catch (err: any) {
        skipped.push({ code, error: `invalid JSON: ${err.message}` })
        continue
      }
      const parsed = parseSideloadLocalePack(raw)
      if (!parsed.ok) {
        skipped.push({ code, error: parsed.error })
        continue
      }

      const dbLang = dbLocales.find((l) => l.code === code)
      if (dbLang && !force) {
        const flStat = await stat(flPath)
        const flUpdatedAt = flStat.mtime.toTemporalInstant()
        if (Temporal.Instant.compare(dbLang.updatedAt.toTemporalInstant(), flUpdatedAt) >= 0) {
          continue
        }
      }

      const completeness =
        code === 'en' ? 100 : computeCompleteness(baseStrings, parsed.pack.strings)
      // -> A pack can pass shape validation (`parseSideloadLocalePack`) and still violate a column
      //    constraint the DB enforces (e.g. `language`/`region`/`script` are short `varchar`s) — caught
      //    here rather than left to propagate, so one such file is reported in `skipped` like any other
      //    bad file instead of aborting the whole scan (at boot, taking every not-yet-processed vendored
      //    locale down with it; via `POST /sideload`, turning into an opaque 500 instead of the specific
      //    per-file report this endpoint exists to give).
      try {
        await WIKI.db
          .insert(localesTable)
          .values({ code, ...parsed.pack, completeness })
          .onConflictDoUpdate({
            target: localesTable.code,
            set: { ...parsed.pack, completeness, updatedAt: sql`now()` }
          })
      } catch (err: any) {
        skipped.push({ code, error: `could not be saved: ${err.message}` })
        continue
      }
      this.invalidateStringsCache(code)
      loaded.push(code)
      WIKI.logger.info(`Sideloaded locale ${code} from ${this.sideloadPath()}. [ OK ]`)
    }

    if (loaded.length > 0) {
      await this.broadcastReload()
    }
    if (skipped.length > 0) {
      WIKI.logger.warn(
        `${skipped.length} sideload locale file(s) were skipped: ${skipped.map((s) => `${s.code} (${s.error})`).join(', ')}`
      )
    }
    return { loaded, skipped }
  }

  async refreshFromDisk({ force = false }: { force?: boolean } = {}): Promise<false | void> {
    try {
      const localesMeta = (await import('../locales/metadata.js')).default
      WIKI.logger.info(`Found ${localesMeta.languages.length} locales [ OK ]`)

      // -> Base locale for completeness comparisons, read once per call (not per language) and
      //    reused across the whole loop below.
      const baseStrings = JSON.parse(
        await readFile(path.join(WIKI.SERVERPATH, 'locales/en.json'), 'utf8')
      )

      const dbLocales = await WIKI.db
        .select({
          code: localesTable.code,
          updatedAt: localesTable.updatedAt
        })
        .from(localesTable)
        .orderBy(localesTable.code)

      let localFilesSkipped = 0
      for (const lang of localesMeta.languages) {
        // -> Build filename
        const langFilename = localeCode(lang)

        // -> Get DB version
        const dbLang = dbLocales.find((l: any) => l.code === langFilename)

        // -> Get File version
        const flPath = path.join(WIKI.SERVERPATH, `locales/${langFilename}.json`)
        try {
          const flStat = await stat(flPath)
          const flUpdatedAt = flStat.mtime.toTemporalInstant()

          // -> Load strings
          if (
            !dbLang ||
            Temporal.Instant.compare(dbLang.updatedAt.toTemporalInstant(), flUpdatedAt) < 0 ||
            force
          ) {
            WIKI.logger.info(`Loading locale ${langFilename} into DB...`)
            const flStrings = JSON.parse(await readFile(flPath, 'utf8'))
            // -> The base locale trivially covers itself; comparing it against itself would also
            //    read 100 here (en.json has no empty values), but this is explicit rather than
            //    incidental.
            const completeness =
              langFilename === 'en' ? 100 : computeCompleteness(baseStrings, flStrings)
            await WIKI.db
              .insert(localesTable)
              .values({
                code: langFilename,
                name: lang.name,
                nativeName: lang.localizedName,
                language: lang.language,
                region: lang.region,
                script: lang.script,
                isRTL: lang.isRtl,
                strings: flStrings,
                completeness
              })
              .onConflictDoUpdate({
                target: localesTable.code,
                set: { strings: flStrings, completeness, updatedAt: sql`now()` },
                // -> The decision to reach this branch was made from `dbLocales`, ONE snapshot read
                //    at the top of this call -- by the time this specific statement executes (55
                //    languages, each its own file read + DB round trip, may run first), some other
                //    writer can have inserted or refreshed THIS code's row after that snapshot was
                //    taken. Without this guard the conflict path would still fire (its own snapshot
                //    said "stale or missing"), silently clobbering whatever that other writer just
                //    stored -- confirmed against a real Postgres instance for OpenProject #2371,
                //    where the e2e suite's own direct-DB seed of a locale sharing a code with a real
                //    vendored one lost exactly this race. Re-checking the freshness condition here,
                //    against the row's CURRENT `updatedAt` rather than the stale snapshot, makes the
                //    whole insert-or-refresh atomic: Postgres only applies the update if nothing else
                //    has written a same-or-newer row since. Skipped for `force`, which means
                //    "overwrite regardless of freshness" and must still do exactly that.
                setWhere: force ? undefined : lt(localesTable.updatedAt, flStat.mtime)
              })
            this.invalidateStringsCache(langFilename)
            WIKI.logger.info(`Locale ${langFilename} loaded successfully. [ OK ]`)
          } else {
            WIKI.logger.info(
              `Locale ${langFilename} is newer in the DB. Skipping disk version. [ OK ]`
            )
          }
        } catch {
          localFilesSkipped++
          WIKI.logger.warn(
            `Locale ${langFilename} not found on disk. Missing strings file. [ SKIPPED ]`
          )
        }
      }
      if (localFilesSkipped > 0) {
        WIKI.logger.warn(
          `${localFilesSkipped} locales were defined in the metadata file but not found on disk. [ SKIPPED ]`
        )
      }

      await this.sideloadFromDataPath({ force })
    } catch (err: any) {
      WIKI.logger.warn('Failed to load locales from disk: [ FAILED ]')
      WIKI.logger.warn(err)
      return false
    }
  }

  async getLocales({ cache = true }: { cache?: boolean } = {}): Promise<any[]> {
    if (!WIKI.cache.has('locales') || !cache) {
      const locales = await WIKI.db
        .select({
          code: localesTable.code,
          isRTL: localesTable.isRTL,
          language: localesTable.language,
          name: localesTable.name,
          nativeName: localesTable.nativeName,
          createdAt: localesTable.createdAt,
          updatedAt: localesTable.updatedAt,
          completeness: localesTable.completeness
        })
        .from(localesTable)
        .orderBy(localesTable.code)
      WIKI.cache.set('locales', locales)
    }
    return WIKI.cache.get('locales') as any[]
  }

  /**
   * Whether a path segment is reserved because it names an INSTALLED locale.
   *
   * Locale codes are reserved as first path segments for pages and folders (decision doc, Option A
   * item 4): on a site with `fr` active, a root folder `fr/` is unreachable — shadowed by
   * `stripLocalePrefix` — and one created while `fr` is merely installed becomes unreachable the
   * day it is activated. Case-insensitive, matching URL parsing.
   */
  async isReservedLocaleCode(segment: string): Promise<boolean> {
    if (!segment) {
      return false
    }
    const codes = (await this.getLocales()).map((lc: any) => String(lc.code).toLowerCase())
    return codes.includes(segment.toLowerCase())
  }

  /**
   * `en.json` alone is 2,807 keys / 180KB, and this is read on every locale-strings request — cached
   * under `localeStrings:${locale}`, the same pattern `getLocales()` already uses for the `locales`
   * key, so a hit skips both the DB round trip and (via the route's ETag/304) the response
   * serialization. Invalidated wherever a locale row's `strings` column can change — see
   * `invalidateStringsCache()`.
   */
  async getStrings(locale: string) {
    const cacheKey = `localeStrings:${locale}`
    if (!WIKI.cache.has(cacheKey)) {
      const results = await WIKI.db
        .select({ strings: localesTable.strings })
        .from(localesTable)
        .where(eq(localesTable.code, locale))
        .limit(1)
      WIKI.cache.set(cacheKey, results.length === 1 ? results[0].strings : [])
    }
    return WIKI.cache.get(cacheKey)
  }

  /**
   * Clears one locale's cached `getStrings()` result — the counterpart to that method's cache fill.
   * Called from every path that can change a `strings` column (`refreshFromDisk`,
   * `sideloadFromDataPath`, `reloadCache`) so a served-from-cache response never outlives the row it
   * was read from.
   */
  private invalidateStringsCache(code: string): void {
    WIKI.cache.delete(`localeStrings:${code}`)
  }

  /**
   * Look up one raw string by key — `en` for a missing/unknown `locale`, and `en` again for a key
   * present in `locale` but blank, matching {@link computeCompleteness}'s own "present but blank
   * does not count" rule. Returns the key itself if even `en` has nothing for it, so a caller sees
   * an obviously-wrong string rather than `undefined` reaching a template.
   */
  private async lookupString(locale: string | null | undefined, key: string): Promise<string> {
    if (locale && locale !== 'en') {
      const strings = await this.getStrings(locale)
      if (!Array.isArray(strings)) {
        const value = (strings as Record<string, unknown>)[key]
        if (typeof value === 'string' && value.length > 0) {
          return value
        }
      }
    }
    const enStrings = await this.getStrings('en')
    const enValue = Array.isArray(enStrings)
      ? undefined
      : (enStrings as Record<string, unknown>)[key]
    return typeof enValue === 'string' && enValue.length > 0 ? enValue : key
  }

  /**
   * Resolve one server-rendered string — `models/mail.ts`'s templates are the only caller today.
   * Client-rendered output goes through the frontend's own i18n instead; this exists because
   * `models/locales.ts` otherwise only *serves* the catalogue, with nothing on the server side to
   * resolve a string out of it (OpenProject #1611). Falls back to `en` for an unset/unknown
   * `locale` and for a key that locale doesn't have, then substitutes `params` via
   * {@link interpolate}.
   */
  async resolveString(
    locale: string | null | undefined,
    key: string,
    params: Record<string, string> = {}
  ): Promise<string> {
    const template = await this.lookupString(locale, key)
    return interpolate(template, params)
  }

  /**
   * Same as {@link resolveString}, but for a message stored as three pipe-delimited plural forms —
   * `<count=0 form> | <count=1 form> | <other form>` — selected by `count`. This is a plain
   * cardinal split rather than full CLDR plural-category matching (`zero`/`one`/`two`/`few`/`many`/
   * `other`): `en.json` only carries `en` strings today, and English needs no more than these three
   * forms; a locale whose grammar needs more categories gains them when it's actually translated,
   * without changing this method's contract. `{count}` is always available to interpolate
   * alongside `params`.
   */
  async resolvePluralString(
    locale: string | null | undefined,
    key: string,
    count: number,
    params: Record<string, string> = {}
  ): Promise<string> {
    const raw = await this.lookupString(locale, key)
    const forms = raw.split('|').map((form) => form.trim())
    const form =
      count === 0 ? (forms[0] ?? raw) : count === 1 ? (forms[1] ?? forms.at(-1)!) : forms.at(-1)!
    return interpolate(form, { ...params, count: String(count) })
  }

  /**
   * Reload the `locales`/`locale:<code>` cache entries. Called at boot, by both halves of the
   * cross-instance propagation below, and by `tasks/simple/update-locales.ts` once its own upsert
   * loop has actually changed something -- previously nothing called this after that task ran at all,
   * so a newly-synced language stayed invisible to `GET /_api/locales` (and rejected by
   * `api/sites.ts`'s installed-codes validation as "not installed") until the next restart, on every
   * instance including the one that ran the sync.
   */
  async reloadCache(): Promise<void> {
    WIKI.logger.info('Reloading locales cache...')
    const locales = await WIKI.models.locales.getLocales({ cache: false })
    // -> `getStrings()` caches per code under `localeStrings:<code>` (OpenProject #1915). This is
    //    the single invalidation point for that cache too — called from `sideloadFromDataPath` after
    //    a pack is written, so dropping every known code's entry here (rather than tracking which
    //    codes were ever actually requested) is what guarantees a sideloaded pack's strings are
    //    fresh on the very next `getStrings()` call.
    for (const locale of locales) {
      this.invalidateStringsCache(locale.code)
    }
    WIKI.logger.info(`Loaded ${locales.length} locales into cache [ OK ]`)
  }
}

export const locales = new Locales()
