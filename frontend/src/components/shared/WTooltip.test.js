import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import WTooltip from './WTooltip.vue'

/*
  WTooltip's panel is teleported to document.body, outside the mounted wrapper's own root, so it
  is read off `document`, not `wrapper.find()`. The trigger is whatever DOM element wraps the
  placeholder span WTooltip renders at its own position -- here a plain <button>, mirroring how
  every real caller writes <w-tooltip> as the last child of the control it describes.
*/

function mountTooltip(props = {}, slotContent = 'Settings') {
  const wrapper = mount(
    {
      components: { WTooltip },
      props: Object.keys(props),
      template: `<button>Trigger<w-tooltip v-bind="$props">${slotContent}</w-tooltip></button>`
    },
    { props, attachTo: document.body }
  )
  return { wrapper, trigger: wrapper.element }
}

function panel() {
  return document.querySelector('[role="tooltip"]')
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('WTooltip', () => {
  it('associates the trigger with the shown panel via aria-describedby', async () => {
    vi.useFakeTimers()
    const { trigger } = mountTooltip({ delay: 0 })

    expect(trigger.hasAttribute('aria-describedby')).toBe(false)

    trigger.dispatchEvent(new MouseEvent('mouseenter'))
    await vi.runAllTimersAsync()

    const shownPanel = panel()
    expect(shownPanel).not.toBeNull()
    expect(shownPanel.id).toBeTruthy()
    expect(trigger.getAttribute('aria-describedby')).toBe(shownPanel.id)
  })

  it('clears aria-describedby on hide', async () => {
    vi.useFakeTimers()
    const { trigger } = mountTooltip({ delay: 0 })

    trigger.dispatchEvent(new MouseEvent('mouseenter'))
    await vi.runAllTimersAsync()
    expect(trigger.hasAttribute('aria-describedby')).toBe(true)

    trigger.dispatchEvent(new MouseEvent('mouseleave'))
    expect(trigger.hasAttribute('aria-describedby')).toBe(false)
  })

  it('clears aria-describedby on unmount', async () => {
    vi.useFakeTimers()
    const { wrapper, trigger } = mountTooltip({ delay: 0 })

    trigger.dispatchEvent(new MouseEvent('mouseenter'))
    await vi.runAllTimersAsync()
    expect(trigger.hasAttribute('aria-describedby')).toBe(true)

    wrapper.unmount()
    expect(trigger.hasAttribute('aria-describedby')).toBe(false)
  })

  it('restores a pre-existing trigger attribute instead of clobbering it', async () => {
    vi.useFakeTimers()
    const { trigger } = mountTooltip({ delay: 0 })
    trigger.setAttribute('aria-describedby', 'some-other-id')

    trigger.dispatchEvent(new MouseEvent('mouseenter'))
    await vi.runAllTimersAsync()
    expect(trigger.getAttribute('aria-describedby')).toBe(panel().id)

    trigger.dispatchEvent(new MouseEvent('mouseleave'))
    expect(trigger.getAttribute('aria-describedby')).toBe('some-other-id')
  })

  it('uses aria-labelledby instead when labels is set', async () => {
    vi.useFakeTimers()
    const { trigger } = mountTooltip({ delay: 0, labels: true })

    trigger.dispatchEvent(new MouseEvent('mouseenter'))
    await vi.runAllTimersAsync()

    expect(trigger.hasAttribute('aria-describedby')).toBe(false)
    expect(trigger.getAttribute('aria-labelledby')).toBe(panel().id)

    trigger.dispatchEvent(new MouseEvent('mouseleave'))
    expect(trigger.hasAttribute('aria-labelledby')).toBe(false)
  })
})
