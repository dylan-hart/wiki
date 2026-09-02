import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { useAnchoredFloat } from './anchoredFloat'

/**
 * Mounts the composable inside a trigger that matches `closest`, the way `WMenu`/`WTooltip` sit
 * inside the button they open from.
 */
function mountWithTrigger({ closest = 'button, a, .w-btn, .w-item', ...options } = {}) {
  const floatEl = ref(null)
  let api = null
  const wrapper = mount(
    defineComponent({
      setup() {
        const placeholderEl = ref(null)
        api = useAnchoredFloat({ placeholderEl, floatEl, closest, ...options })
        return () =>
          h('button', { class: 'w-btn' }, [h('span', [h('span', { ref: placeholderEl })])])
      }
    }),
    { attachTo: document.body }
  )
  return { wrapper, api, floatEl }
}

/** A float element big enough to be measurable, with the sizes `anchoredPosition` reads. */
function makeFloat({ width = 100, height = 50 } = {}) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'offsetWidth', { value: width })
  Object.defineProperty(el, 'offsetHeight', { value: height })
  document.body.appendChild(el)
  return el
}

describe('useAnchoredFloat', () => {
  it('climbs past the wrapping span to the real control', () => {
    const { wrapper, api } = mountWithTrigger()
    expect(api.triggerEl.value).toBe(wrapper.element)
    wrapper.unmount()
  })

  it('falls back to the immediate parent when nothing matches the selector', () => {
    const { wrapper, api } = mountWithTrigger({ closest: '.nothing-matches' })
    expect(api.triggerEl.value?.tagName).toBe('SPAN')
    wrapper.unmount()
  })

  it('starts at the origin before anything has been measured', () => {
    const { wrapper, api } = mountWithTrigger()
    expect(api.floatStyle.value).toEqual({ left: '0px', top: '0px' })
    wrapper.unmount()
  })

  it('writes px coordinates once repositioned', async () => {
    const { wrapper, api, floatEl } = mountWithTrigger({
      anchor: () => 'bottom left',
      self: () => 'top left'
    })
    floatEl.value = makeFloat()
    await api.reposition()
    expect(api.floatStyle.value.left).toMatch(/^-?\d+(\.\d+)?px$/)
    expect(api.floatStyle.value.top).toMatch(/^-?\d+(\.\d+)?px$/)
    wrapper.unmount()
  })

  it('does nothing when there is no float element to place', async () => {
    const { wrapper, api } = mountWithTrigger()
    await api.reposition()
    expect(api.floatStyle.value).toEqual({ left: '0px', top: '0px' })
    wrapper.unmount()
  })

  it('lets beforeMeasure size the float and override the rect it is measured against', async () => {
    const beforeMeasure = vi.fn(() => ({ left: 500, top: 400, width: 0, height: 0 }))
    const { wrapper, api, floatEl } = mountWithTrigger({ beforeMeasure })
    floatEl.value = makeFloat({ width: 10, height: 10 })
    await api.reposition()
    expect(beforeMeasure).toHaveBeenCalledWith(floatEl.value, api.triggerEl.value)
    expect(api.floatStyle.value).toEqual({ left: '500px', top: '400px' })
    wrapper.unmount()
  })

  it('measures the trigger itself when beforeMeasure returns nothing', async () => {
    const { wrapper, api, floatEl } = mountWithTrigger({ beforeMeasure: () => undefined })
    floatEl.value = makeFloat()
    await api.reposition()
    expect(api.floatStyle.value.left).toBe('8px')
    wrapper.unmount()
  })
})
