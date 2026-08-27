import { describe, expect, it } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'

import WForm from './WForm.vue'
import WInput from './WInput.vue'

const required = (v) => !!v || 'Required'

/**
 * A form with two WInput fields plus a submit button, wired the way a real call site would be
 * (`v-model` + `rules`), so the test exercises WForm's real registration/validate/focus path rather
 * than a hand-rolled mock field.
 */
function mountForm({ first = '', second = '' } = {}) {
  const Host = defineComponent({
    components: { WForm, WInput },
    // Declared so @vue/test-utils doesn't ALSO auto-capture the native 'submit' DOM event
    // bubbling to this root (it only skips that for names a component's own `emits` declares).
    emits: ['submit', 'validation-error'],
    setup() {
      return { first: ref(first), second: ref(second) }
    },
    template: `
      <w-form @submit="$emit('submit')" @validation-error="$emit('validation-error')">
        <w-input v-model="first" label="First" :rules="[required]" lazy-rules="ondemand" />
        <w-input v-model="second" label="Second" :rules="[required]" lazy-rules="ondemand" />
        <button type="submit">Submit</button>
      </w-form>
    `,
    methods: { required }
  })
  return mount(Host, { attachTo: document.body })
}

describe('WForm', () => {
  it('moves focus to the first invalid control on a failed submit, not the second field and not the submit button', async () => {
    const wrapper = mountForm({ first: 'ok', second: '' })

    await wrapper.find('form').trigger('submit')

    const inputs = wrapper.findAll('input')
    expect(inputs).toHaveLength(2)
    expect(document.activeElement).toBe(inputs[1].element)
    expect(document.activeElement).not.toBe(inputs[0].element)
    expect(document.activeElement).not.toBe(wrapper.find('button').element)

    wrapper.unmount()
  })

  it('does not move focus when every field is valid, and emits submit', async () => {
    const wrapper = mountForm({ first: 'ok', second: 'also ok' })
    const before = document.activeElement

    await wrapper.find('form').trigger('submit')

    expect(document.activeElement).toBe(before)
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('validation-error')).toBeUndefined()

    wrapper.unmount()
  })
})
