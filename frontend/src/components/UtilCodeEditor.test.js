import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import UtilCodeEditor from './UtilCodeEditor.vue'

/**
 * Guards upstream requarks/wiki #2150, where a code-injection editor silently stripped `<script>`
 * tags before saving. This field backs Admin → Theme's `injectHead`/`injectBody`, where a `<script>`
 * tag is the entire point, so the value must survive byte-for-byte.
 */
describe('UtilCodeEditor raw script tag round-trip', () => {
  it('renders a raw <script> value in the textarea unmodified', () => {
    const raw = '<script>alert(1)</script>'
    const wrapper = mount(UtilCodeEditor, { props: { modelValue: raw, language: 'html' } })

    expect(wrapper.find('textarea').element.value).toBe(raw)
  })

  it('emits back exactly what the user typed, including script tags, via update:modelValue', async () => {
    const wrapper = mount(UtilCodeEditor, { props: { modelValue: '', language: 'html' } })
    const raw = '<script>window.__probe = 1</script><div onclick="x()">hi</div>'

    const textarea = wrapper.find('textarea')
    textarea.element.value = raw
    await textarea.trigger('input')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0]).toBe(raw)
  })

  it('a full set → read round trip through modelValue leaves a raw script tag byte-for-byte intact', async () => {
    const raw = '<script src="/probe.js" async></script>'
    const wrapper = mount(UtilCodeEditor, { props: { modelValue: '', language: 'html' } })

    const textarea = wrapper.find('textarea')
    textarea.element.value = raw
    await textarea.trigger('input')
    const roundTripped = wrapper.emitted('update:modelValue')[0][0]

    await wrapper.setProps({ modelValue: roundTripped })

    expect(roundTripped).toBe(raw)
    expect(wrapper.find('textarea').element.value).toBe(raw)
  })
})
