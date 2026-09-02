import { createI18n } from 'vue-i18n'

/**
 * The one `createI18n` every suite mounts against.
 *
 * 196 call sites in 127 files used to spell this out by hand, in 62 distinct variations of the same
 * three options -- `legacy: false`, `locale: 'en'`, `messages: { en: … }` -- and about half of them
 * were the byte-identical empty-messages one-liner. Only `messages` ever genuinely differed between
 * them, so that is the only thing this takes.
 *
 * `messages` is nested under `en` here rather than by the caller, and both shapes the corpus uses
 * keep working: nested objects (`{ common: { actions: { apply: 'Apply' } } }`) and flat dotted keys
 * (`{ 'admin.cluster.title': 'Cluster' }`) -- vue-i18n resolves a dotted `t()` argument against
 * either, and `components/NavSidebar.test.js` alone passes one of each.
 *
 * `missingWarn`/`fallbackWarn` are off because a test's message set is deliberately partial: it
 * carries the handful of strings the assertions actually read and nothing else, so leaving the
 * warnings on buries a real failure under a wall of "Not found 'x.y.z' key" noise. Four suites had
 * already turned them off by hand for exactly that reason. No test loads the real `en.json` into
 * i18n, so nothing here is asserting against production strings.
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
