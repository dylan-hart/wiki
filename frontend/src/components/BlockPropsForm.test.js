import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import BlockPropsForm from './BlockPropsForm.vue'
import WInput from '@/components/shared/WInput.vue'
import WSelect from '@/components/shared/WSelect.vue'
import WToggle from '@/components/shared/WToggle.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * A field's label/hint resolve through the `blocks.<tag>.props.<name>.*` key
 * (`composables/blockLocale.js`), falling back to the definition's raw `field.label`/`field.hint`
 * -- never to the dotted key path itself. No separate `aria-label` binding: a `WInput`/`WSelect`
 * given a `label` renders a real associated `<label for>` and suppresses its own `ariaLabel` prop.
 */
function mountForm({ block, fields, messages = {} }) {
  const i18n = createTestI18n(messages)
  return mount(BlockPropsForm, {
    props: { block, fields, values: {} },
    global: { plugins: [i18n] }
  })
}

describe('BlockPropsForm i18n', () => {
  it('resolves a blocks.<tag>.props.<name>.label/.hint key for a text field', () => {
    const wrapper = mountForm({
      block: 'openapi',
      fields: [{ name: 'url', type: 'string', label: 'Spec URL', hint: 'Raw hint.' }],
      messages: {
        'blocks.openapi.props.url.label': 'Translated Spec URL',
        'blocks.openapi.props.url.hint': 'Translated hint.'
      }
    })

    const input = wrapper.findComponent(WInput)
    expect(input.props('label')).toBe('Translated Spec URL')
    const label = wrapper.find('label')
    expect(label.text()).toContain('Translated Spec URL')
    expect(label.attributes('for')).toBe(wrapper.find('input').attributes('id'))
    expect(input.props('hint')).toBe('Translated hint.')
  })

  it("falls back to the field's own raw label/hint, not the dotted key path, when unresolved", () => {
    const wrapper = mountForm({
      block: 'openapi',
      fields: [{ name: 'url', type: 'string', label: 'Spec URL', hint: 'Raw hint.' }]
    })

    const input = wrapper.findComponent(WInput)
    expect(input.props('label')).toBe('Spec URL')
    expect(input.props('label')).not.toContain('blocks.')
    expect(input.props('hint')).toBe('Raw hint.')
  })

  it('falls back to the raw label for a boolean (toggle) field the same way', () => {
    const wrapper = mountForm({
      block: 'openapi',
      fields: [{ name: 'tryItOut', type: 'boolean', label: 'Enable "Try it out"' }]
    })

    const toggle = wrapper.findComponent(WToggle)
    expect(toggle.props('label')).toBe('Enable "Try it out"')
  })

  it('resolves nothing when no block tag is given, leaving every field on its raw label', () => {
    const wrapper = mountForm({
      block: '',
      fields: [{ name: 'url', type: 'string', label: 'Spec URL' }],
      messages: { 'blocks.openapi.props.url.label': 'Should never be reached' }
    })

    expect(wrapper.findComponent(WInput).props('label')).toBe('Spec URL')
  })
})

/**
 * The block picker's Insert button is disabled until every required prop is filled
 * (`helpers/blocks.js#blockPropsFilled`), so the form has to say WHICH props those are or the
 * disabled state is unexplained.
 *
 * Both halves are asserted because they come from different places — the marker from
 * `WFieldFrame.vue`'s label, `aria-required` from the control — and because it is this form's job
 * to pass `required` through in the first place. The glyph itself belongs to the shared component:
 * the block picker must not be the one screen where a required field is marked differently.
 */
describe('a required prop', () => {
  it('is marked on a text field, and announced as required', () => {
    const wrapper = mountForm({
      block: 'kroki',
      fields: [{ name: 'server', type: 'string', label: 'Server', required: true }]
    })

    expect(wrapper.findComponent(WInput).props('required')).toBe(true)
    expect(wrapper.find('input').attributes('aria-required')).toBe('true')
    // -> The shared field frame's own marker, hidden from the accessible name it sits beside
    expect(wrapper.find('label span[aria-hidden="true"]').exists()).toBe(true)
  })

  it('is marked on a select field the same way', () => {
    const wrapper = mountForm({
      block: 'kroki',
      fields: [
        {
          name: 'type',
          type: 'select',
          label: 'Diagram type',
          required: true,
          options: ['mermaid']
        }
      ]
    })

    expect(wrapper.findComponent(WSelect).props('required')).toBe(true)
    expect(wrapper.find('label span[aria-hidden="true"]').exists()).toBe(true)
  })

  it('leaves an optional prop unmarked', () => {
    const wrapper = mountForm({
      block: 'kroki',
      fields: [{ name: 'caption', type: 'string', label: 'Caption' }]
    })

    expect(wrapper.findComponent(WInput).props('required')).toBe(false)
    expect(wrapper.find('input').attributes('aria-required')).toBeUndefined()
    expect(wrapper.find('label span[aria-hidden="true"]').exists()).toBe(false)
  })
})
