import { setTimeout } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { locales as localesTable } from '../../db/schema.ts'

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
    const metadata = await fetch(
      'https://github.com/requarks/wiki-locales/raw/main/locales/metadata.json'
    ).then((r) => r.json() as Promise<LocaleMetadata>)
    for (const lang of metadata.languages) {
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
        `https://raw.githubusercontent.com/requarks/wiki-locales/main/locales/${langFilename}.json`
      )
      const strings = stringsResp.ok ? await stringsResp.json() : null

      if (strings) {
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
