import path from 'node:path'
import { readModuleDefinitions } from '../helpers/moduleRegistry.ts'
import type { ModuleProp } from '../helpers/moduleProps.ts'

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
    // -> Emptied before the scan, not merely reassigned on success: `base.yml` declares no
    //    `analytics` key, so a failed scan would otherwise leave the field `undefined` for every
    //    reader of it -- see the same note in `models/authentication.ts`, whose consumers call
    //    `.find(...)` on it unguarded.
    WIKI.data.analytics = []
    try {
      // -> Only a module declaring `isAvailable` is loaded: a definition on disk that this build does
      //    not actually ship a provider for must not reach a site's analytics settings.
      WIKI.data.analytics = await readModuleDefinitions<AnalyticsModule>(
        path.join(WIKI.SERVERPATH, 'modules/analytics'),
        {
          label: 'analytics module',
          parseProps: true,
          skipUnavailable: true,
          logEach: true
        }
      )

      WIKI.logger.debug('ext', 'loaded module definitions', {
        kind: 'analytics',
        modules: WIKI.data.analytics.length
      })
    } catch (err: any) {
      WIKI.logger.error('ext', 'reading the module definitions failed', {
        kind: 'analytics',
        error: err
      })
    }
  }
}

export const analytics = new Analytics()
