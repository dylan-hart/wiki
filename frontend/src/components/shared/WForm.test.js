import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WForm from './WForm.vue'
import WInput from './WInput.vue'

function isNonEmpty(v) {
  return String(v ?? '').length > 0 || 'Required'
}

describe('WForm', () => {
  it('emits submit when every field passes', async () => {
    const wrapper = mount({
      components: { WForm, WInput },
      data: () => ({ value: 'ok' }),
      template: `<w-form><w-input v-model="value" :rules="[rule]" /></w-form>`,
      methods: { rule: isNonEmpty }
    })

    await wrapper.find('form').trigger('submit')

    expect(wrapper.findComponent(WForm).emitted('submit')).toHaveLength(1)
    expect(wrapper.findComponent(WForm).emitted('validation-error')).toBeUndefined()
  })

  it('emits validation-error, not submit, when a field fails', async () => {
    const wrapper = mount({
      components: { WForm, WInput },
      data: () => ({ value: '' }),
      template: `<w-form><w-input v-model="value" :rules="[rule]" /></w-form>`,
      methods: { rule: isNonEmpty }
    })

    await wrapper.find('form').trigger('submit')

    expect(wrapper.findComponent(WForm).emitted('submit')).toBeUndefined()
    expect(wrapper.findComponent(WForm).emitted('validation-error')).toHaveLength(1)
  })

  it('moves focus to the first invalid control on a failed submit, not the second and not the submit button', async () => {
    const wrapper = mount(
      {
        components: { WForm, WInput },
        data: () => ({ first: 'ok', second: '' }),
        template: `
          <w-form>
            <w-input v-model="first" :rules="[rule]" />
            <w-input v-model="second" :rules="[rule]" />
            <button type="submit">Submit</button>
          </w-form>
        `,
        methods: { rule: isNonEmpty }
      },
      { attachTo: document.body }
    )

    await wrapper.find('form').trigger('submit')

    const inputs = wrapper.findAll('input')
    expect(document.activeElement).toBe(inputs[1].element)
    expect(document.activeElement).not.toBe(inputs[0].element)
    wrapper.unmount()
  })

  it('leaves focus alone on a successful submit', async () => {
    const wrapper = mount(
      {
        components: { WForm, WInput },
        data: () => ({ value: 'ok' }),
        template: `<w-form><w-input v-model="value" :rules="[rule]" /></w-form>`,
        methods: { rule: isNonEmpty }
      },
      { attachTo: document.body }
    )

    await wrapper.find('form').trigger('submit')

    expect(document.activeElement).not.toBe(wrapper.find('input').element)
    wrapper.unmount()
  })
})
