import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { parseModuleProps } from '../helpers/common.ts'
import type { ModuleProp } from '../helpers/common.ts'

/** An analytics module, as declared by its `definition.yml`. */
export interface AnalyticsModule {
  key: string
  title: string
  description: string
  logo?: string
  website?: string
  isAvailable: boolean
  props: Record<string, ModuleProp>
}

/**
 * Analytics model
 *
 * Unlike authentication strategies or storage targets, an analytics provider has no configuration of
 * its own to keep track of instance-wide: a site either has it enabled or does not, and that lives
 * directly in the site's own `config.analytics.providers` — see `models/sites.ts`. This model only
 * discovers what providers `modules/analytics` declares on disk, the same way
 * `models/authentication.ts` discovers auth modules.
 */
class Analytics {
  /**
   * The analytics modules found on disk, alphabetically by title.
   */
  getModules(): AnalyticsModule[] {
    return [...((WIKI.data.analytics ?? []) as AnalyticsModule[])].sort((a, b) =>
      a.title.localeCompare(b.title)
    )
  }

  /**
   * A single module definition, or null when nothing on disk declares that key
   */
  getModule(key: string): AnalyticsModule | null {
    return this.getModules().find((m) => m.key === key) ?? null
  }

  async refreshFromDisk(): Promise<void> {
    try {
      // -> Fetch definitions from disk
      const analyticsDirs = await fs.readdir(path.join(WIKI.SERVERPATH, 'modules/analytics'))
      WIKI.data.analytics = []
      for (const dir of analyticsDirs) {
        const def = await fs.readFile(
          path.join(WIKI.SERVERPATH, 'modules/analytics', dir, 'definition.yml'),
          'utf8'
        )
        const defParsed = load(def) as Record<string, any>
        if (!defParsed.isAvailable) {
          continue
        }
        defParsed.key = dir
        defParsed.props = parseModuleProps(defParsed.props)
        WIKI.data.analytics.push(defParsed)
        WIKI.logger.debug(`Loaded analytics module definition ${dir} [ OK ]`)
      }

      WIKI.logger.info(`Loaded ${WIKI.data.analytics.length} analytics module definitions [ OK ]`)
    } catch (err: any) {
      WIKI.logger.error('Failed to scan or load analytics module definitions [ FAILED ]')
      WIKI.logger.error(err)
    }
  }
}

export const analytics = new Analytics()
