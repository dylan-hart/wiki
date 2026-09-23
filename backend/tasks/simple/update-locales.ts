import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Generous headroom, not a tight fit: its only job is to stop one malformed or compromised
 * `metadata.json` from multiplying this task's outbound requests without limit.
 */
const MAX_LANGUAGES = 200

/**
 * The `strings` payload comes off `raw.githubusercontent.com` unsigned, so this is what stands
 * between a compromised `requarks/wiki-locales` and arbitrary values landing in every instance's
 * `locales.strings` jsonb column on the next daily run.
 */
export function isFlatStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === 'string')
}

export async function task(): Promise<TaskResult | void> {
  if (CARDINAL.config.offline) {
    CARDINAL.logger.debug('locale', 'skipping localization data update, offline mode')
    return
  }
  if (CARDINAL.config.update?.locales === false) {
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
    CARDINAL.logger.warn('locale', 'metadata listed more languages than one run processes', {
      listed: metadata.languages.length,
      processing: MAX_LANGUAGES
    })
  }

  let updated = 0
  let baseStrings: Record<string, unknown> | undefined
  for (const lang of languages) {
    const langFilenameParts = [lang.language]
    if (lang.region) {
      langFilenameParts.push(lang.region)
    }
    if (lang.script) {
      langFilenameParts.push(lang.script)
    }
    const langFilename = langFilenameParts.join('-')

    CARDINAL.logger.debug('locale', 'fetching updates', { locale: langFilename })

    const stringsResp = await fetch(
      `https://raw.githubusercontent.com/requarks/wiki-locales/main/locales/${encodeURIComponent(langFilename)}.json`,
      { signal: AbortSignal.timeout(15_000) }
    )
    const strings = stringsResp.ok ? await stringsResp.json() : null

    if (strings && isFlatStringMap(strings)) {
      baseStrings ??= JSON.parse(
        await readFile(path.join(CARDINAL.SERVERPATH, 'locales/en.json'), 'utf8')
      ) as Record<string, unknown>
      await CARDINAL.models.locales.mergeDownloadedStrings(
        langFilename,
        {
          name: lang.name,
          nativeName: lang.localizedName,
          language: lang.language,
          region: lang.region ?? '',
          script: lang.script ?? '',
          isRTL: lang.isRtl
        },
        strings,
        baseStrings
      )
      updated++
      CARDINAL.logger.debug('locale', 'updated strings', { locale: langFilename })
    } else if (strings) {
      CARDINAL.logger.warn('locale', 'rejected a strings payload that is not a flat string map', {
        locale: langFilename
      })
    } else {
      CARDINAL.logger.warn('locale', 'no strings file on wiki-locales', { locale: langFilename })
    }

    await setTimeout(100)
  }

  // -> The locales cache is filled at boot, so without this a newly-synced language stays invisible
  //    to `GET /_api/locales` — and unactivatable as "not installed" — until the next restart.
  //    Broadcast rather than a local reload, so peer instances pick it up too.
  if (updated > 0) {
    await CARDINAL.models.locales.broadcastReload()
    return { summary: 'synced localization data', updated, of: languages.length }
  }
  // -> Not an `info` summary, but distinct from the scheduler's bare `finished`: this is the line
  //    that says the sync reached upstream at all.
  CARDINAL.logger.debug('locale', 'localization data unchanged', { of: languages.length })
}
