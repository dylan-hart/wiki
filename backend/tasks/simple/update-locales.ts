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
    WIKI.logger.info(
      'Skipping localization data update: this instance is in offline mode. Sideload locale packs into <dataPath>/locales/ instead — see docs/offline-deployment.md.'
    )
    return
  }
  if (WIKI.config.update?.locales === false) {
    return
  }

  WIKI.logger.info('Fetching latest localization data...')

  try {
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
      WIKI.logger.warn(
        `Locale metadata listed ${metadata.languages.length} languages, more than the ${MAX_LANGUAGES} this task will process in one run. Processing the first ${MAX_LANGUAGES} only.`
      )
    }

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

      WIKI.logger.debug(`Fetching updates for language ${langFilename}...`)

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
        WIKI.logger.debug(`Updated strings for language ${langFilename}.`)
      } else if (strings) {
        WIKI.logger.warn(
          `Strings payload for language ${langFilename} was not a flat string map. [ REJECTED ]`
        )
      } else {
        WIKI.logger.warn(
          `No strings file found for language ${langFilename} on wiki-locales. [ SKIPPED ]`
        )
      }

      await setTimeout(100)
    }

    WIKI.logger.info('Fetched latest localization data: [ COMPLETED ]')
  } catch (err: any) {
    WIKI.logger.error('Fetching latest localization data: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
