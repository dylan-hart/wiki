import { stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { locales as localesTable } from '../db/schema.ts'
import { eq, sql } from 'drizzle-orm'
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
 * Locales model
 */
class Locales {
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
                set: { strings: flStrings, completeness, updatedAt: sql`now()` }
              })
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
      for (const locale of locales) {
        WIKI.cache.set(`locale:${locale.code}`, locale)
      }
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

  async getStrings(locale: string) {
    const results = await WIKI.db
      .select({ strings: localesTable.strings })
      .from(localesTable)
      .where(eq(localesTable.code, locale))
      .limit(1)
    return results.length === 1 ? results[0].strings : []
  }

  async reloadCache(): Promise<void> {
    WIKI.logger.info('Reloading locales cache...')
    const locales = await WIKI.models.locales.getLocales({ cache: false })
    WIKI.logger.info(`Loaded ${locales.length} locales into cache [ OK ]`)
  }
}

export const locales = new Locales()
