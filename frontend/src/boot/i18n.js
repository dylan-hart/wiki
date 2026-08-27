import { createI18n } from 'vue-i18n'
import { useCommonStore } from '@/stores/common'

// Module-scope so non-component code (Pinia store actions, plain helpers) can reach translations
// through `i18n.global.t(...)` -- `i18n.global` is a real Composer instance even in Composition-API
// (`legacy: false`) mode, so calling `.t()` on it directly needs no active component/setup context.
// `initializeI18n()` still does the one-time locale/store wiring and `app.use(i18n)`.
export let i18n

export function initializeI18n(app, store) {
  const commonStore = useCommonStore(store)

  i18n = createI18n({
    legacy: false,
    locale: commonStore.locale || 'en',
    fallbackLocale: 'en',
    fallbackWarn: false,
    messages: {}
  })

  // Set i18n instance on app
  app.use(i18n)
}
