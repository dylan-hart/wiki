import { setTimeout } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { locales as localesTable } from '../../db/schema.ts'

/**
 * Upper bound on how many languages a single `metadata.json` response may drive this task to fetch
 * and insert. `requarks/wiki-locales` currently ships ~60; this is deliberately generous headroom
 * rather than a tight fit, so a legitimate future addition never trips it — its purpose is only to
 * stop one compromised or malformed metadata response from multiplying this task's outbound
 * requests without limit.
 */
const MAX_LANGUAGES = 200

/**
 * Guards the one shape the `locales.strings` jsonb column is ever supposed to hold: a flat mapping
 * of translation key to translated string. `update-locales`'s `strings` payload comes straight off
 * `raw.githubusercontent.com` with no signature, so this is what stands between a compromised
 * `requarks/wiki-locales` and arbitrary values landing in every instance's `locales` table on the
 * next daily run (OpenProject #2255) -- a nested object, an array, or a non-string value is refused
 * rather than inserted as-is.
 */
export function isFlatStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === 'string')
}

export async function task(): Promise<void> {
  if (WIKI.config.offline) {
    // -> `debug`: this runs daily and says the same thing every time on a deployment that is
    //    deliberately offline. Sideload locale packs into <dataPath>/locales/ instead — see
    //    docs/offline-deployment.md.
    WIKI.logger.debug('locale', 'skipping localization data update, offline mode')
    return
  }
  if (WIKI.config.update?.locales === false) {
    return
  }

  interface LocaleMetadata {
    languages: {
      language: string
      region?: string
      script?: string
      name: string
      localizedName: string
      isRtl: boolean
    }[]
  }
  const metadataResp = await fetch(
    'https://github.com/requarks/wiki-locales/raw/main/locales/metadata.json',
    { signal: AbortSignal.timeout(15_000) }
  )
  if (!metadataResp.ok) {
    throw new Error(
      `Fetching locale metadata failed: ${metadataResp.status} ${metadataResp.statusText}`
    )
  }
  const metadata = (await metadataResp.json()) as LocaleMetadata

  const languages = metadata.languages.slice(0, MAX_LANGUAGES)
  if (metadata.languages.length > MAX_LANGUAGES) {
    WIKI.logger.warn('locale', 'metadata listed more languages than one run processes', {
      listed: metadata.languages.length,
      processing: MAX_LANGUAGES
    })
  }

  let updated = 0
  for (const lang of languages) {
    // -> Build filename
    const langFilenameParts = [lang.language]
    if (lang.region) {
      langFilenameParts.push(lang.region)
    }
    if (lang.script) {
      langFilenameParts.push(lang.script)
    }
    const langFilename = langFilenameParts.join('-')

    WIKI.logger.debug('locale', 'fetching updates', { locale: langFilename })

    const stringsResp = await fetch(
      `https://raw.githubusercontent.com/requarks/wiki-locales/main/locales/${encodeURIComponent(langFilename)}.json`,
      { signal: AbortSignal.timeout(15_000) }
    )
    const strings = stringsResp.ok ? await stringsResp.json() : null

    if (strings && isFlatStringMap(strings)) {
      await WIKI.db
        .insert(localesTable)
        .values({
          code: langFilename,
          name: lang.name,
          nativeName: lang.localizedName,
          language: lang.language,
          region: lang.region ?? '',
          script: lang.script ?? '',
          isRTL: lang.isRtl,
          strings
        })
        .onConflictDoUpdate({
          target: localesTable.code,
          set: { strings, updatedAt: sql`now()` }
        })
      updated++
      WIKI.logger.debug('locale', 'updated strings', { locale: langFilename })
    } else if (strings) {
      WIKI.logger.warn('locale', 'rejected a strings payload that is not a flat string map', {
        locale: langFilename
      })
    } else {
      WIKI.logger.warn('locale', 'no strings file on wiki-locales', { locale: langFilename })
    }

    await setTimeout(100)
  }

  // -> Without this, `postBoot()`'s `locales.reloadCache()` call had already populated the
  //    `'locales'`/`locale:<code>` cache entries by the time this nightly sync ran, and nothing here
  //    ever refreshed them: a newly-synced language stayed invisible to `GET /_api/locales`, and
  //    `api/sites.ts`'s installed-codes validation rejected activating it as "not installed", until
  //    the next restart -- on every instance, including this one. Broadcasts too, so a peer instance
  //    picks it up without waiting for its own restart.
  if (updated > 0) {
    await WIKI.models.locales.broadcastReload()
    WIKI.logger.info('locale', 'synced localization data', { updated, of: languages.length })
  } else {
    WIKI.logger.debug('locale', 'localization data unchanged', { of: languages.length })
  }
}
