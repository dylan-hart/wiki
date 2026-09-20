import { createI18n } from 'vue-i18n'

/**
 * The one `createI18n` every suite mounts against. `messages` is the only option that differs
 * between callers, so it's the only thing this takes; both nested objects
 * (`{ common: { actions: { apply: 'Apply' } } }`) and flat dotted keys
 * (`{ 'admin.cluster.title': 'Cluster' }`) work, since vue-i18n resolves a dotted `t()` argument
 * against either.
 *
 * `missingWarn`/`fallbackWarn` are off because a test's message set is deliberately partial --
 * carrying only the strings its assertions read -- so leaving them on would bury a real failure
 * under "Not found 'x.y.z' key" noise. No test loads the real `en.json`, so nothing here asserts
 * against production strings.
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
