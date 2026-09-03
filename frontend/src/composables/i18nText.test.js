import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'

import { useDictText } from './i18nText.js'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `useDictText()` wraps `useI18n()`, which only works inside a component's `setup()` -- mounting a
 * tiny probe component through `@vue/test-utils` is how `dark.test.js` and `screen.test.js`'s
 * siblings exercise composables with the same constraint.
 */
function mountProbe({ plugins = [] } = {}) {
  let resolved
  const Probe = defineComponent({
    setup() {
      const dictText = useDictText()
      resolved = dictText('common.probe.label', 'English fallback')
      return () => h('div', resolved)
    }
  })
  mount(Probe, { global: { plugins } })
  return () => resolved
}

describe('useDictText', () => {
  it('returns the dictionary value when the key resolves', () => {
    const i18n = createTestI18n({ 'common.probe.label': 'Dictionary Value' })

    const getResolved = mountProbe({ plugins: [i18n] })

    expect(getResolved()).toBe('Dictionary Value')
  })

  it('falls back to the English literal when the key is missing from every loaded dictionary', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      fallbackLocale: 'en',
      messages: { en: {} }
    })

    const getResolved = mountProbe({ plugins: [i18n] })

    expect(getResolved()).toBe('English fallback')
  })

  it('falls back to the English literal when no vue-i18n plugin is installed at all', () => {
    const getResolved = mountProbe()

    expect(getResolved()).toBe('English fallback')
  })
})
