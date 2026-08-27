import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import BlockPropsForm from './BlockPropsForm.vue'

/**
 * Regression coverage for Task #1631: `BlockPropsForm` resolves a field's label and hint through the
 * `blocks.<tag>.props.<name>.label` / `.hint` i18n keys Task #1628 mints, rather than always rendering
 * the raw string the block definition carries.
 */

function mountForm(overrides = {}) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    ...overrides.i18n
  })

  return mount(BlockPropsForm, {
    props: {
      tag: 'kroki',
      fields: [{ name: 'server', type: 'string', label: 'Server', hint: 'The raw hint.' }],
      values: { server: '' },
      ...overrides.props
    },
    global: { plugins: [i18n] }
  })
}

describe('BlockPropsForm', () => {
  it('renders a field label and aria-label from its minted blocks.<tag>.* i18n key', () => {
    const wrapper = mountForm({
      i18n: {
        messages: {
          en: {
            blocks: {
              kroki: {
                props: {
                  server: {
                    label: 'Localized Server',
                    hint: 'Localized hint.'
                  }
                }
              }
            }
          }
        }
      }
    })

    // -> The localized label and hint render
    expect(wrapper.text()).toContain('Localized Server')
    expect(wrapper.text()).toContain('Localized hint.')

    // -> The raw hint does not: it was replaced, not merely supplemented
    expect(wrapper.text()).not.toContain('The raw hint.')

    // -> The localized label is a real <label for> associated with the field, not just visible text
    const label = wrapper.find('label')
    expect(label.attributes('for')).toBe(wrapper.find('input').attributes('id'))
    expect(label.text()).toContain('Localized Server')
  })

  it("falls back to the definition's raw string when the key does not resolve", () => {
    const wrapper = mountForm()

    // -> Neither the dotted key path itself nor a blank label leaks into the rendered form
    expect(wrapper.text()).not.toContain('blocks.kroki.props.server.label')
    expect(wrapper.text()).toContain('Server')
    expect(wrapper.text()).toContain('The raw hint.')
    expect(wrapper.find('label').text()).toContain('Server')
  })

  it('falls back to the raw string when no tag is given at all', () => {
    const wrapper = mountForm({ props: { tag: null } })

    expect(wrapper.find('label').text()).toContain('Server')
  })
})
