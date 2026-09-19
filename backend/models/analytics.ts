import path from 'node:path'
import { readModuleDefinitions } from '../helpers/moduleRegistry.ts'
import type { ModuleProp } from '../helpers/moduleProps.ts'

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
 * Discovery only, with no db table behind it: unlike an auth strategy or a storage target, an
 * analytics provider holds no instance-wide config — a site's own `config.analytics.providers`
 * carries the enabled/config state.
 */
class Analytics {
  getModules(): AnalyticsModule[] {
    return [...((CARDINAL.data.analytics ?? []) as AnalyticsModule[])].sort((a, b) =>
      a.title.localeCompare(b.title)
    )
  }

  getModule(key: string): AnalyticsModule | null {
    return this.getModules().find((m) => m.key === key) ?? null
  }

  async refreshFromDisk(): Promise<void> {
    // -> Emptied before the scan, not reassigned on success: `base.yml` declares no `analytics`
    //    key, so a failed scan would otherwise leave the field `undefined` for readers that index
    //    into it unguarded.
    CARDINAL.data.analytics = []
    try {
      // -> `skipUnavailable`: a definition on disk this build ships no provider for must not reach
      //    a site's analytics settings.
      CARDINAL.data.analytics = await readModuleDefinitions<AnalyticsModule>(
        path.join(CARDINAL.SERVERPATH, 'modules/analytics'),
        {
          label: 'analytics module',
          parseProps: true,
          skipUnavailable: true,
          logEach: true
        }
      )

      CARDINAL.logger.debug('ext', 'loaded module definitions', {
        kind: 'analytics',
        modules: CARDINAL.data.analytics.length
      })
    } catch (err: any) {
      CARDINAL.logger.error('ext', 'reading the module definitions failed', {
        kind: 'analytics',
        error: err
      })
    }
  }
}

export const analytics = new Analytics()
