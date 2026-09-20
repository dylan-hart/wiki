import { watch } from 'vue'

import { useSiteStore } from '@/stores/site'
import { ANALYTICS_PROVIDERS } from '@/helpers/analyticsProviders'
import { log } from '@/helpers/log'

/**
 * `index.html` is a static shell with no server-rendered per-page HTML, so `document.head` is the
 * only place these snippets can go.
 *
 * Injects once per page load: `siteStore.id` is set by the `bootstrap` call `App.vue`'s router
 * guard makes on the FIRST navigation and is never cleared afterwards, so the watcher fires at most
 * once and a later SPA route change cannot re-inject.
 */
export function initializeAnalytics(store) {
  const siteStore = useSiteStore(store)

  if (siteStore.id) {
    injectEnabledProviders(siteStore.analytics?.providers)
    return
  }

  const stop = watch(
    () => siteStore.id,
    (id) => {
      if (!id) {
        return
      }
      stop()
      injectEnabledProviders(siteStore.analytics?.providers)
    }
  )
}

function injectEnabledProviders(providers) {
  for (const [key, provider] of Object.entries(providers ?? {})) {
    if (!provider?.isEnabled) {
      continue
    }
    const template = ANALYTICS_PROVIDERS[key]
    if (!template) {
      // -> A provider key the site config stored that this build's map no longer has (a module
      //    removed since it was enabled) -- not worth throwing over.
      log.warn('analytics', `no snippet for the enabled provider ${key}; nothing injected`)
      continue
    }
    template.inject(provider.config)
  }
}
