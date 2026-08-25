import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import WTooltip from './WTooltip.vue'

// WTooltip resolves its trigger by climbing from its own placeholder to the nearest
// `button, a, .w-btn, .w-item, .w-badge` ancestor, so mount it inside a real <button> the same
// way every real caller does (`<w-btn icon="..."><w-tooltip>...</w-tooltip></w-btn>`).
function mountTrigger(props = {}) {
  const TestHost = defineComponent({
    render() {
      return h('button', { type: 'button' }, [h(WTooltip, props, () => 'Settings')])
    }
  })
  return mount(TestHost, { attachTo: document.body })
}

describe('WTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets aria-describedby on the trigger pointing at the shown panel, and clears it on hide', async () => {
    const wrapper = mountTrigger()
    const button = wrapper.element

    expect(button.hasAttribute('aria-describedby')).toBe(false)

    button.dispatchEvent(new Event('mouseenter'))
    await vi.advanceTimersByTimeAsync(250)

    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const panel = document.getElementById(describedBy)
    expect(panel).not.toBeNull()
    expect(panel.getAttribute('role')).toBe('tooltip')
    expect(panel.textContent).toBe('Settings')

    button.dispatchEvent(new Event('mouseleave'))

    expect(button.hasAttribute('aria-describedby')).toBe(false)

    wrapper.unmount()
  })

  it('restores a pre-existing aria-describedby value on hide rather than clobbering it', async () => {
    const wrapper = mountTrigger()
    const button = wrapper.element
    button.setAttribute('aria-describedby', 'existing-id')

    button.dispatchEvent(new Event('focusin'))
    await vi.advanceTimersByTimeAsync(250)

    expect(button.getAttribute('aria-describedby')).not.toBe('existing-id')

    button.dispatchEvent(new Event('focusout'))

    expect(button.getAttribute('aria-describedby')).toBe('existing-id')

    wrapper.unmount()
  })

  it('clears aria-describedby on unmount if the tooltip was still shown', async () => {
    const wrapper = mountTrigger()
    const button = wrapper.element

    button.dispatchEvent(new Event('mouseenter'))
    await vi.advanceTimersByTimeAsync(250)

    expect(button.hasAttribute('aria-describedby')).toBe(true)

    wrapper.unmount()

    expect(button.hasAttribute('aria-describedby')).toBe(false)
  })

  it('the labels prop uses aria-labelledby instead of aria-describedby', async () => {
    const wrapper = mountTrigger({ labels: true })
    const button = wrapper.element

    button.dispatchEvent(new Event('mouseenter'))
    await vi.advanceTimersByTimeAsync(250)

    expect(button.hasAttribute('aria-describedby')).toBe(false)
    const labelledBy = button.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy)?.textContent).toBe('Settings')

    button.dispatchEvent(new Event('mouseleave'))
    expect(button.hasAttribute('aria-labelledby')).toBe(false)

    wrapper.unmount()
  })
})
