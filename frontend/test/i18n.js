import { createI18n } from 'vue-i18n'

/**
 * Both nested objects (`{ common: { actions: { apply: 'Apply' } } }`) and flat dotted keys
 * (`{ 'admin.cluster.title': 'Cluster' }`) work, since vue-i18n resolves a dotted `t()` argument
 * against either.
 *
 * `missingWarn`/`fallbackWarn` are off because a test's message set is deliberately partial --
 * only the strings its assertions read -- so leaving them on would bury a real failure under
 * "Not found 'x.y.z' key" noise.
 */
export function createTestI18n(messages = {}) {
  return createI18n({
    legacy: false,
    locale: 'en',
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: messages }
  })
}
