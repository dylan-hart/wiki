import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'

import { useFooterBarHeight } from './footerBarHeight.js'

const PROPERTY = '--footer-bar-height'

let observers

class StubResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.observed = []
    this.disconnected = false
    observers.push(this)
  }
  observe(el) {
    this.observed.push(el)
  }
  disconnect() {
    this.disconnected = true
  }
}

const Probe = defineComponent({
  props: { position: { type: String, default: 'fixed' }, height: { type: Number, default: 40 } },
  setup(props) {
    const rootEl = ref(null)
    useFooterBarHeight(rootEl)
    return () =>
      h('footer', { class: 'w-footer', style: { position: props.position } }, [
        h('div', { ref: rootEl, class: 'site-footer' })
      ])
  }
})

function mountProbe(position = 'fixed', height = 40) {
  const proto = Element.prototype
  const original = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    return { height: this.classList.contains('w-footer') ? height : 0 }
  }
  try {
    const wrapper = mount(Probe, { props: { position }, attachTo: document.body })
    return { wrapper, footer: wrapper.element }
  } finally {
    proto.getBoundingClientRect = original
  }
}

function setHeight(footer, height) {
  footer.getBoundingClientRect = () => ({ height })
}

const read = () => document.body.style.getPropertyValue(PROPERTY)

describe('useFooterBarHeight', () => {
  beforeEach(() => {
    observers = []
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    document.body.style.removeProperty(PROPERTY)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.style.removeProperty(PROPERTY)
  })

  it('writes the measured height of a fixed footer bar to body on mount', () => {
    const { wrapper, footer } = mountProbe('fixed', 40)

    expect(observers[0].observed).toEqual([footer])
    expect(read()).toBe('40px')
    wrapper.unmount()
  })

  it('rounds a fractional height up so the clearance never falls short', () => {
    const { wrapper, footer } = mountProbe('fixed')
    setHeight(footer, 32.5)
    observers[0].callback()

    expect(read()).toBe('33px')
    wrapper.unmount()
  })

  it('follows the footer as it grows, e.g. a long unbroken value wrapping onto more lines', () => {
    const { wrapper, footer } = mountProbe('fixed')
    setHeight(footer, 140)
    observers[0].callback()

    expect(read()).toBe('140px')
    wrapper.unmount()
  })

  it('never sets a value when the footer is not fixed (Ledger keeps 0)', () => {
    const { wrapper, footer } = mountProbe('static', 60)
    setHeight(footer, 60)
    observers[0].callback()

    expect(read()).toBe('')
    wrapper.unmount()
  })

  it('drops its value when the footer stops being fixed', () => {
    const { wrapper, footer } = mountProbe('fixed')
    expect(read()).toBe('40px')

    footer.style.position = 'static'
    observers[0].callback()

    expect(read()).toBe('')
    wrapper.unmount()
  })

  it('reacts to a body class change with no resize, as a Ledger/Cobalt switch is', async () => {
    const { wrapper, footer } = mountProbe('static')
    setHeight(footer, 40)
    expect(read()).toBe('')

    footer.style.position = 'fixed'
    document.body.classList.add('body--cobalt')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(read()).toBe('40px')
    document.body.classList.remove('body--cobalt')
    wrapper.unmount()
  })

  it('disconnects the observer and clears the property on unmount', () => {
    const { wrapper } = mountProbe('fixed')
    expect(read()).toBe('40px')

    wrapper.unmount()

    expect(observers[0].disconnected).toBe(true)
    expect(read()).toBe('')
  })

  it('does not clear a value an incoming footer already wrote when the outgoing one unmounts', () => {
    const first = mountProbe('fixed', 40)
    const second = mountProbe('fixed', 90)
    expect(read()).toBe('90px')

    first.wrapper.unmount()

    expect(read()).toBe('90px')
    second.wrapper.unmount()
    expect(read()).toBe('')
  })

  it('degrades to the stylesheet fallback when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { wrapper } = mountProbe('fixed', 40)

    expect(observers).toHaveLength(0)
    wrapper.unmount()
  })

  it('does nothing when the target is not inside a .w-footer', () => {
    const Bare = defineComponent({
      setup() {
        const rootEl = ref(null)
        useFooterBarHeight(rootEl)
        return () => h('div', { ref: rootEl })
      }
    })
    const wrapper = mount(Bare, { attachTo: document.body })

    expect(observers).toHaveLength(0)
    expect(read()).toBe('')
    wrapper.unmount()
  })
})
