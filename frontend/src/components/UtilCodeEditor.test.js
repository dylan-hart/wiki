import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import UtilCodeEditor from './UtilCodeEditor.vue'

/**
 * Regression coverage for upstream requarks/wiki #2150 (closed): the code-injection editor silently
 * stripped `<script>` tags out of some inputs before saving them. This field is Admin → Theme's
 * `injectHead`/`injectBody` editor — admin-trusted input, not user content, and a `<script>` tag is
 * the entire point of it (see `helpers/injectHtml.js`). `UtilCodeEditor` is a real `<textarea>`
 * driving a v-model, not a rich-text/contenteditable surface run through a sanitizer, so there is
 * nothing here that parses the value as HTML on its way through — this locks that down as a
 * regression test rather than leaving it as an inference from reading the component.
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
