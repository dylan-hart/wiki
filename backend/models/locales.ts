import { stat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { locales as localesTable } from '../db/schema.ts'
import { eq, lt, sql } from 'drizzle-orm'
import { isPlainObject } from 'es-toolkit/predicate'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { isConfiguredLocaleAlias } from '../helpers/localeRouting.ts'
import type { LocalazyLanguage } from '../locales/metadata.d.ts'

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
 * Completeness of `targetStrings` against `baseStrings` (the `en` locale), 0-100. A key present but
 * blank — a shape translation tooling really produces — does not count as translated. `en.json` is
 * flat, so a top-level key comparison is the whole of it rather than a deep walk.
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
 * A per-key override rather than a full-row replacement: a source naming one key must leave every
 * other string already stored for that locale untouched.
 */
export function mergeLocaleStrings(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  return { ...base, ...overlay }
}

/**
 * `strings` is intersected in rather than narrowed on the `locales.strings` column itself
 * (`db/schema.ts`): that column's `.default([])` is an array, which is not assignable to a
 * `.$type<Record<string, unknown>>()` column.
 */
export type SideloadLocalePack = Pick<
  typeof localesTable.$inferSelect,
  'name' | 'nativeName' | 'language' | 'region' | 'script' | 'isRTL'
> & { strings: Record<string, unknown> }

/**
 * `{name}`-style substitution, the syntax `en.json` already uses for vue-i18n, so a `mail.*`
 * template reads the same whichever side resolves it. A placeholder with no matching `params` entry
 * is left as-is rather than blanked, so a typo'd key is visibly wrong instead of silently vanishing.
 */
export function interpolate(template: string, params: Record<string, string> = {}): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(params, key) ? params[key] : match
  )
}

/**
 * Validates one parsed `<dataPath>/locales/` file into a `SideloadLocalePack`, or an error string
 * naming what is missing. A sideload file is self-contained — no `locales/metadata.js` entry behind
 * it, unlike the vendored files under `backend/locales/` — so it may name a code the built-in
 * language table has never heard of, which is what lets an operator add a locale, not only update
 * one.
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

class Locales extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadLocales'

  /**
   * `<dataPath>/locales` — a writeable directory an operator drops locale-pack JSON files into on a
   * running instance's data volume, no rebuild, redeploy or network access needed. See
   * `docs/offline-deployment.md`.
   */
  sideloadPath(): string {
    // -> Falls back to `base.yml`'s own default, so a `CARDINAL.config` fixture with no interest in
    //    paths need not have merged it in.
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath || './data', 'locales')
  }

  /**
   * Loads every `<code>.json` file under `sideloadPath()`, on the same mtime-vs-`updatedAt`
   * freshness check `refreshFromDisk` uses for the vendored files. A missing directory is not an
   * error: most instances have nothing sideloaded, and this runs unconditionally on every boot.
   *
   * A sideload is a per-key merge, not a full-row replacement, so a one-key pack cannot wipe out
   * the rest of that locale's strings. `completeness` is computed off the merged result for every
   * code, `en` included — a partial `en` sideload does not imply a complete `en` row.
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
      await readFile(path.join(CARDINAL.SERVERPATH, 'locales/en.json'), 'utf8')
    )
    const dbLocales = await CARDINAL.db
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

      // -> The merge target is what is CURRENTLY stored for this code: the `dbLocales` snapshot
      //    above carries only `code`/`updatedAt`, and pulling every installed locale's `strings`
      //    column would be far more than the handful being sideloaded needs. No row, or the
      //    column's `[]` default, merges as if the base were empty.
      let storedStrings: Record<string, unknown> = {}
      if (dbLang) {
        const existingRows = await CARDINAL.db
          .select({ strings: localesTable.strings })
          .from(localesTable)
          .where(eq(localesTable.code, code))
          .limit(1)
        if (existingRows.length === 1 && isPlainObject(existingRows[0].strings)) {
          storedStrings = existingRows[0].strings as Record<string, unknown>
        }
      }
      const mergedStrings = mergeLocaleStrings(storedStrings, parsed.pack.strings)
      const completeness = computeCompleteness(baseStrings, mergedStrings)
      // -> A pack can pass `parseSideloadLocalePack` and still violate a column constraint
      //    (`language`/`region`/`script` are short `varchar`s). Caught here so one bad file lands in
      //    `skipped` like any other instead of aborting the scan — at boot that would take every
      //    not-yet-processed locale with it, and via `POST /sideload` it becomes an opaque 500
      //    rather than the per-file report that endpoint exists to give.
      try {
        await CARDINAL.db
          .insert(localesTable)
          .values({ code, ...parsed.pack, strings: mergedStrings, completeness })
          .onConflictDoUpdate({
            target: localesTable.code,
            set: { ...parsed.pack, strings: mergedStrings, completeness, updatedAt: sql`now()` }
          })
      } catch (err: any) {
        skipped.push({ code, error: `could not be saved: ${err.message}` })
        continue
      }
      this.invalidateStringsCache(code)
      loaded.push(code)
      CARDINAL.logger.debug('locale', 'sideloaded locale', {
        locale: code,
        path: this.sideloadPath()
      })
    }

    if (loaded.length > 0) {
      await this.broadcastReload()
    }
    if (skipped.length > 0) {
      CARDINAL.logger.warn('locale', 'skipped sideload files', {
        skipped: skipped.length,
        files: skipped.map((s) => `${s.code} (${s.error})`).join(', ')
      })
    }
    return { loaded, skipped }
  }

  async mergeDownloadedStrings(
    code: string,
    meta: Omit<SideloadLocalePack, 'strings'>,
    downloaded: Record<string, string>,
    baseStrings: Record<string, unknown>
  ): Promise<number> {
    const existingRows = await CARDINAL.db
      .select({ strings: localesTable.strings })
      .from(localesTable)
      .where(eq(localesTable.code, code))
      .limit(1)
    const storedStrings =
      existingRows.length === 1 && isPlainObject(existingRows[0].strings)
        ? (existingRows[0].strings as Record<string, unknown>)
        : {}
    const mergedStrings = mergeLocaleStrings(storedStrings, downloaded)
    const completeness = computeCompleteness(baseStrings, mergedStrings)
    await CARDINAL.db
      .insert(localesTable)
      .values({ code, ...meta, strings: mergedStrings, completeness })
      .onConflictDoUpdate({
        target: localesTable.code,
        set: { strings: mergedStrings, completeness, updatedAt: sql`now()` }
      })
    this.invalidateStringsCache(code)
    return completeness
  }

  async refreshFromDisk({ force = false }: { force?: boolean } = {}): Promise<false | void> {
    try {
      const localesMeta = (await import('../locales/metadata.js')).default

      const baseStrings = JSON.parse(
        await readFile(path.join(CARDINAL.SERVERPATH, 'locales/en.json'), 'utf8')
      )

      const dbLocales = await CARDINAL.db
        .select({
          code: localesTable.code,
          updatedAt: localesTable.updatedAt
        })
        .from(localesTable)
        .orderBy(localesTable.code)

      const missingOnDisk: string[] = []
      for (const lang of localesMeta.languages) {
        const langFilename = localeCode(lang)

        const dbLang = dbLocales.find((l: any) => l.code === langFilename)

        const flPath = path.join(CARDINAL.SERVERPATH, `locales/${langFilename}.json`)
        try {
          const flStat = await stat(flPath)
          const flUpdatedAt = flStat.mtime.toTemporalInstant()

          if (
            !dbLang ||
            Temporal.Instant.compare(dbLang.updatedAt.toTemporalInstant(), flUpdatedAt) < 0 ||
            force
          ) {
            const flStrings = JSON.parse(await readFile(flPath, 'utf8'))
            // -> `en` covers itself by definition; explicit rather than relying on the comparison
            //    incidentally reading 100.
            const completeness =
              langFilename === 'en' ? 100 : computeCompleteness(baseStrings, flStrings)
            await CARDINAL.db
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
                // -> The decision to reach this branch came from `dbLocales`, ONE snapshot read at
                //    the top of the call; every other language's file read and round trip may run
                //    before this statement, so another writer can have refreshed THIS code's row in
                //    the meantime and the conflict path would clobber it. Re-checking freshness
                //    against the row's CURRENT `updatedAt` makes the insert-or-refresh atomic.
                //    `force` means "overwrite regardless of freshness" and must still do that.
                setWhere: force ? undefined : lt(localesTable.updatedAt, flStat.mtime)
              })
            this.invalidateStringsCache(langFilename)
            CARDINAL.logger.debug('locale', 'loaded locale from disk', {
              locale: langFilename,
              completeness
            })
          } else {
            CARDINAL.logger.debug('locale', 'db copy is newer, keeping it', {
              locale: langFilename
            })
          }
        } catch {
          missingOnDisk.push(langFilename)
        }
      }
      if (missingOnDisk.length > 0) {
        CARDINAL.logger.warn('locale', 'declared in the metadata file but not found on disk', {
          skipped: missingOnDisk.length,
          locales: missingOnDisk.join(', ')
        })
      }

      const sideload = await this.sideloadFromDataPath({ force })
      const count = localesMeta.languages.length
      CARDINAL.logger.info('locale', `loaded ${count} ${count === 1 ? 'locale' : 'locales'}`, {
        sideloaded: sideload.loaded.length,
        skipped: missingOnDisk.length
      })
    } catch (err: any) {
      CARDINAL.logger.warn('locale', 'loading locales from disk failed', { error: err })
      return false
    }
  }

  async getLocales({ cache = true }: { cache?: boolean } = {}): Promise<any[]> {
    if (!CARDINAL.cache.has('locales') || !cache) {
      const locales = await CARDINAL.db
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
      CARDINAL.cache.set('locales', locales)
    }
    return CARDINAL.cache.get('locales') as any[]
  }

  /**
   * Whether a path segment is reserved because it names an INSTALLED locale — installed, not merely
   * active on a site: on a site with `fr` active a root folder `fr/` is unreachable, shadowed by
   * `stripLocalePrefix`, and one created while `fr` is only installed becomes unreachable the day it
   * is activated. With `siteId`, an alias configured on that site is reserved too (per-site, where
   * the code half is global). Case-insensitive, matching URL parsing.
   */
  async isReservedLocaleCode(segment: string, siteId?: string): Promise<boolean> {
    if (!segment) {
      return false
    }
    if (isConfiguredLocaleAlias(siteId, segment)) {
      return true
    }
    const codes = (await this.getLocales()).map((lc: any) => String(lc.code).toLowerCase())
    return codes.includes(segment.toLowerCase())
  }

  /**
   * Read on every locale-strings request, so it is cached under `localeStrings:<locale>` and a hit
   * skips both the DB round trip and (via the route's ETag/304) the response serialization.
   *
   * `en` additionally merges onto the bundled `backend/locales/en.json` floor — the one locale
   * guaranteed to ship a complete file on a fresh install with nothing synced or sideloaded yet — so
   * a key missing from the stored row still resolves to real text rather than a blank/raw key. The
   * stored row wins on a shared key.
   */
  async getStrings(locale: string) {
    const cacheKey = `localeStrings:${locale}`
    if (!CARDINAL.cache.has(cacheKey)) {
      const results = await CARDINAL.db
        .select({ strings: localesTable.strings })
        .from(localesTable)
        .where(eq(localesTable.code, locale))
        .limit(1)
      let strings: unknown = results.length === 1 ? results[0].strings : []
      if (locale === 'en') {
        const bundled = JSON.parse(
          await readFile(path.join(CARDINAL.SERVERPATH, 'locales/en.json'), 'utf8')
        )
        const stored = isPlainObject(strings) ? (strings as Record<string, unknown>) : {}
        strings = mergeLocaleStrings(bundled, stored)
      }
      CARDINAL.cache.set(cacheKey, strings)
    }
    return CARDINAL.cache.get(cacheKey)
  }

  /** Every path that writes a `strings` column must call this, or a cached read outlives its row. */
  private invalidateStringsCache(code: string): void {
    CARDINAL.cache.delete(`localeStrings:${code}`)
  }

  /**
   * `en` for a missing/unknown `locale`, and `en` again for a key present in `locale` but blank,
   * matching {@link computeCompleteness}'s "present but blank does not count" rule. Returns the key
   * itself if even `en` has nothing, so a caller sees an obviously-wrong string rather than
   * `undefined` reaching a template.
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
   * Resolve one server-rendered string, for mail templates and the like. Client-rendered output
   * goes through the frontend's own i18n instead; this model otherwise only *serves* the
   * catalogue, with nothing on the server side to resolve a string out of it.
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
   * {@link resolveString} for a message stored as three pipe-delimited plural forms —
   * `<count=0 form> | <count=1 form> | <other form>` — selected by `count`. A plain cardinal split
   * rather than full CLDR plural-category matching, since English needs no more than these three
   * forms; a locale whose grammar needs more gains them when it is actually translated, without
   * changing this method's contract.
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

  async reloadCache(): Promise<void> {
    const locales = await CARDINAL.models.locales.getLocales({ cache: false })
    // -> Drops every known code's `getStrings()` entry rather than tracking which were ever
    //    requested: a reload triggered from another instance cannot know which one changed.
    for (const locale of locales) {
      this.invalidateStringsCache(locale.code)
    }
    CARDINAL.logger.debug('locale', 'reloaded the locales cache', { locales: locales.length })
  }
}

export const locales = new Locales()
