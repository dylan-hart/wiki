import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ModuleConfigForm from './ModuleConfigForm.vue'
import WToggle from '@/components/shared/WToggle.vue'
import WSelect from '@/components/shared/WSelect.vue'
import WInput from '@/components/shared/WInput.vue'
import { buildConfigEditor } from '@/helpers/moduleConfig'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `ModuleConfigForm.vue`, extracted (task #556) out of two previously-identical inline template
 * blocks in `AdminStorage.vue` and `AdminSearch.vue`. Renders `buildConfigEditor()`'s output --
 * `frontend/src/helpers/moduleConfig.test.js` covers that half separately.
 */
function mountForm(config) {
  const i18n = createTestI18n()
  return mount(ModuleConfigForm, {
    props: { config },
    global: { plugins: [i18n] }
  })
}

describe('ModuleConfigForm', () => {
  it('renders a toggle for a boolean prop', () => {
    const config = buildConfigEditor(
      { termHighlighting: { type: 'boolean', title: 'Term Highlighting', default: false } },
      {}
    )
    const wrapper = mountForm(config)
    expect(wrapper.findComponent(WToggle).exists()).toBe(true)
  })

  it('renders a select for an enum prop', () => {
    const config = buildConfigEditor(
      {
        mode: {
          type: 'string',
          title: 'Mode',
          default: 'fast',
          enum: ['fast|Fast', 'accurate|Accurate']
        }
      },
      {}
    )
    const wrapper = mountForm(config)
    expect(wrapper.findComponent(WSelect).exists()).toBe(true)
  })

  it('renders a plain input for a string prop with no enum', () => {
    const config = buildConfigEditor(
      { apiKey: { type: 'string', title: 'API Key', default: '' } },
      { apiKey: 'k' }
    )
    const wrapper = mountForm(config)
    const input = wrapper.findComponent(WInput)
    expect(input.exists()).toBe(true)
    expect(input.props('modelValue')).toBe('k')
  })

  it('renders a password-type input for a sensitive prop', () => {
    const config = buildConfigEditor(
      { apiKey: { type: 'string', title: 'API Key', default: '', sensitive: true } },
      {}
    )
    const wrapper = mountForm(config)
    expect(wrapper.findComponent(WInput).props('type')).toBe('password')
  })

  it('disables the field for a readOnly prop', () => {
    const config = buildConfigEditor(
      { indexName: { type: 'string', title: 'Index Name', default: 'wiki', readOnly: true } },
      {}
    )
    const wrapper = mountForm(config)
    expect(wrapper.findComponent(WInput).props('disabled')).toBe(true)
  })

  it('draws a readOnly boolean row as a plain div, not a label with an inoperable control', () => {
    const config = buildConfigEditor(
      { managed: { type: 'boolean', title: 'Managed', default: true, readOnly: true } },
      {}
    )
    const wrapper = mountForm(config)
    expect(wrapper.find('label').exists()).toBe(false)
    expect(wrapper.find('div.w-settings-row').exists()).toBe(true)
  })

  it('draws an editable boolean row as a label, so the whole row toggles it', () => {
    const config = buildConfigEditor(
      { managed: { type: 'boolean', title: 'Managed', default: true } },
      {}
    )
    const wrapper = mountForm(config)
    expect(wrapper.find('label').exists()).toBe(true)
  })

  it("sets a readOnly prop's hint in orange, since that hint is why the value is fixed", () => {
    const config = buildConfigEditor(
      {
        indexName: {
          type: 'string',
          title: 'Index Name',
          default: 'wiki',
          hint: 'Fixed by the module.',
          readOnly: true
        }
      },
      {}
    )
    const wrapper = mountForm(config)
    const caption = wrapper.findAll('span').find((el) => el.text() === 'Fixed by the module.')
    expect(caption).toBeDefined()
    expect(caption.classes()).toContain('text-orange')
  })

  it('hides a field whose `if` condition on a sibling value is not met', () => {
    const config = buildConfigEditor(
      {
        mode: { type: 'string', title: 'Mode', default: 'manual' },
        hosts: {
          type: 'string',
          title: 'Host(s)',
          default: '',
          if: [{ key: 'mode', eq: 'manual' }]
        }
      },
      { mode: 'auto' }
    )
    const wrapper = mountForm(config)
    // -> Only `mode` (a plain string field, no `if`) renders; `hosts`' condition (`mode === 'manual'`)
    //    is false since `mode` was stored as `'auto'`
    expect(wrapper.findAllComponents(WInput)).toHaveLength(1)
  })

  it('shows a field whose `if` condition on a sibling value is met', () => {
    const config = buildConfigEditor(
      {
        mode: { type: 'string', title: 'Mode', default: 'manual' },
        hosts: {
          type: 'string',
          title: 'Host(s)',
          default: '',
          if: [{ key: 'mode', eq: 'manual' }]
        }
      },
      { mode: 'manual' }
    )
    const wrapper = mountForm(config)
    expect(wrapper.findAllComponents(WInput)).toHaveLength(2)
  })
})
