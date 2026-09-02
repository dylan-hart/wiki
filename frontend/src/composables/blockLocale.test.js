import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import { useBlockLocale } from './blockLocale.js'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `useBlockLocale()` needs an active i18n instance (`useI18n()` throws outside one), so each case
 * mounts a throwaway host component rather than calling the composable bare -- the same reason
 * `BlockPropsForm.test.js` exercises it through the real component instead of in isolation.
 */
function mountHost(messages) {
  const i18n = createTestI18n(messages)
  let blockText
  const Host = defineComponent({
    setup() {
      ;({ blockText } = useBlockLocale())
      return () => h('div')
    }
  })
  mount(Host, { global: { plugins: [i18n] } })
  return (...args) => blockText(...args)
}

describe('useBlockLocale', () => {
  it('resolves a blocks.<tag>.* key when one exists', () => {
    const blockText = mountHost({ 'blocks.openapi.description': 'Translated description.' })
    expect(blockText('openapi', 'description', 'Raw fallback description.')).toBe(
      'Translated description.'
    )
  })

  it('falls back to the raw string, not the dotted key, when the key does not resolve', () => {
    const blockText = mountHost({})
    expect(blockText('openapi', 'description', 'Raw fallback description.')).toBe(
      'Raw fallback description.'
    )
  })

  it('falls back straight away for a falsy block tag, with no key even attempted', () => {
    const blockText = mountHost({ 'blocks..description': 'Should never match.' })
    expect(blockText('', 'description', 'Raw fallback.')).toBe('Raw fallback.')
    expect(blockText(null, 'description', 'Raw fallback.')).toBe('Raw fallback.')
  })

  it('resolves a prop label/hint key independently of the description key', () => {
    const blockText = mountHost({ 'blocks.openapi.props.url.label': 'Spec URL (translated)' })
    expect(blockText('openapi', 'props.url.label', 'Spec URL')).toBe('Spec URL (translated)')
    expect(blockText('openapi', 'props.url.hint', 'Fetched by the browser.')).toBe(
      'Fetched by the browser.'
    )
  })
})
