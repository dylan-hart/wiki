import { watch } from 'vue'

import { useSiteStore } from '@/stores/site'
import { ANALYTICS_PROVIDERS } from '@/helpers/analyticsProviders'
import { log } from '@/helpers/log'

/**
 * Inject every enabled analytics provider's tracking snippet into `document.head`, once the site
 * store has loaded the current site's config.
 *
 * There is no server-rendered per-page HTML to inject into (`index.html` is a static shell — see
 * the dead, commented-out `req.locals.analyticsCode` hook this replaces around
 * `backend/index.ts`'s `initHTTPServer`), so this is the only place the snippets can go.
 *
 * `site.id` (and the rest of the site config, `analytics.providers` included) only exists after the
 * `bootstrap` call `App.vue`'s router guard makes on the FIRST navigation of the page load — never
 * again after that, since the guard itself is gated on `!siteStore.id`. Runs once per page load:
 * if the site is already loaded (e.g. this ever runs after that first navigation), inject
 * immediately; otherwise wait for the one `id` transition from empty to set, then stop watching. A
 * later SPA route change never touches `siteStore.id` again, so it can never re-fire from here.
 *
 * This instance has no cookie-consent gate to check (confirmed by grep — nothing in the codebase
 * references "consent"), so there is nothing to wait on beyond the site config itself.
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
      // -> A provider key the site config has stored that this build's map doesn't know about
      //    (e.g. a module removed since it was enabled). Nothing to inject; not worth throwing over.
      log.warn('analytics', `no snippet for the enabled provider ${key}; nothing injected`)
      continue
    }
    template.inject(provider.config)
  }
}
