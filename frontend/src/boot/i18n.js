import { createI18n } from 'vue-i18n'
import { useCommonStore } from '@/stores/common'

/*
  Created at module scope, not inside `initializeI18n()`, so that `i18n.global.t(...)` is a real
  Composer the moment anything imports it -- Pinia store actions and plain helpers translate through
  it, and they run in unit tests where no app has been built and `initializeI18n()` never ran. Left
  undefined until boot, those call sites throw on the way to reporting some other failure, hiding
  it. `i18n.global` is a Composer even in Composition-API (`legacy: false`) mode, so calling `.t()`
  on it needs no active component or setup context.

  Messages start empty and are loaded at runtime, so a key translated before they arrive resolves to
  the key itself -- vue-i18n's own behaviour for a missing key.
*/
export const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  fallbackWarn: false,
  messages: {}
})

export function initializeI18n(app, store) {
  const commonStore = useCommonStore(store)

  i18n.global.locale.value = commonStore.locale || 'en'

  app.use(i18n)
}
