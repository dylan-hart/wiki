import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import { contrastRatio, WCAG_AA_CONTRAST } from '@/helpers/accessibility'
import WBtn from './WBtn.vue'

describe('WBtn', () => {
  it('renders a native button by default, and emits click', async () => {
    const wrapper = mount(WBtn, { props: { label: 'Save' } })

    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.text()).toBe('Save')

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('renders an anchor when href is set, carrying target and rel', () => {
    const wrapper = mount(WBtn, {
      props: { label: 'Docs', href: 'https://example.com', target: '_blank' }
    })

    expect(wrapper.element.tagName).toBe('A')
    expect(wrapper.attributes('href')).toBe('https://example.com')
    expect(wrapper.attributes('target')).toBe('_blank')
    expect(wrapper.attributes('rel')).toBe('noopener noreferrer')
  })

  it('blocks the click when disabled, without emitting', async () => {
    const wrapper = mount(WBtn, { props: { label: 'Save', disabled: true } })

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('blocks the click while loading, and shows the spinner instead of the label', async () => {
    const wrapper = mount(WBtn, { props: { label: 'Save', loading: true } })

    expect(wrapper.find('.w-spinner').exists()).toBe(true)
    expect(wrapper.attributes('aria-busy')).toBe('true')

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('renders no nameless button for an icon-only instance with an explicit aria-label', () => {
    // WBtn itself derives no accessible name from `icon` -- an icon-only caller must supply one,
    // either an `aria-label` (as here) or a `<w-tooltip labels>` naming it from the slot.
    const wrapper = mount(WBtn, {
      props: { icon: 'tabler:settings' },
      attrs: { 'aria-label': 'Settings' }
    })

    expect(wrapper.text()).toBe('')
    expect(wrapper.attributes('aria-label')).toBe('Settings')
  })

  it('takes its default corner from --radius-control, not a hardcoded value', () => {
    // -> `--radius-control` is `0` under Ledger and a real value under Cobalt -- one class, no
    //    aesthetic branch.
    const wrapper = mount(WBtn, { props: { label: 'Save' } })

    expect(wrapper.classes()).toContain('rounded-control')
    expect(wrapper.classes()).not.toContain('rounded-none')
  })

  it('keeps round/rounded as explicit shapes, not the aesthetic corner style', () => {
    const round = mount(WBtn, {
      props: { icon: 'tabler:settings', round: true },
      attrs: { 'aria-label': 'Settings' }
    })
    expect(round.classes()).toContain('rounded-full')

    const pill = mount(WBtn, { props: { label: 'Save', rounded: true } })
    expect(pill.classes()).toContain('rounded-[28px]')
  })
})

describe('WBtn solid-button foreground contrast', () => {
  /*
   * The solid palette colors `WBtn` is themed with, keyed to the default hex each resolves to with
   * no site customization. `tailwind.css` is not loaded under Vitest, so setting `--color-<name>` on
   * `documentElement` -- exactly what a themed site does -- is the only way these custom properties
   * become resolvable here.
   */
  const PALETTE_COLORS = {
    primary: '#1976D2',
    secondary: '#02c39a',
    accent: '#FF9800',
    positive: '#02C39A',
    negative: '#f03a47',
    warning: '#f99d4d',
    info: '#3e6990'
  }

  afterEach(() => {
    for (const name of Object.keys(PALETTE_COLORS)) {
      document.documentElement.style.removeProperty(`--color-${name}`)
    }
  })

  for (const [name, hex] of Object.entries(PALETTE_COLORS)) {
    it(`picks a foreground that meets WCAG AA against solid ${name} (${hex})`, async () => {
      document.documentElement.style.setProperty(`--color-${name}`, hex)
      const wrapper = mount(WBtn, { props: { label: 'Go', color: name } })
      await nextTick()
      await nextTick()

      const foreground = wrapper.element.style.color
      expect(foreground).toBeTruthy()
      expect(contrastRatio(foreground, hex)).toBeGreaterThanOrEqual(WCAG_AA_CONTRAST)
    })
  }

  it('honors an explicit textColor override instead of computing one', async () => {
    document.documentElement.style.setProperty('--color-accent', '#FF9800')
    const wrapper = mount(WBtn, { props: { label: 'Go', color: 'accent', textColor: 'white' } })
    await nextTick()
    await nextTick()

    expect(wrapper.element.style.color).toBe('var(--color-white)')
  })

  it('falls back to white when the color name resolves to nothing', async () => {
    const wrapper = mount(WBtn, { props: { label: 'Go', color: 'not-a-real-color' } })
    await nextTick()
    await nextTick()

    expect(wrapper.element.style.color).toBe('var(--color-white)')
  })

  it('leaves flat/outline buttons alone -- no background, no computed foreground', () => {
    const wrapper = mount(WBtn, { props: { label: 'Go', color: 'accent', flat: true } })

    expect(wrapper.element.style.backgroundColor).toBe('')
    expect(wrapper.element.style.color).toBe('var(--color-accent)')
  })
})

describe('WBtn --shadow-primary wiring', () => {
  it('applies --shadow-primary to a solid accent button', () => {
    const wrapper = mount(WBtn, { props: { label: 'Go', color: 'accent' } })

    expect(wrapper.element.style.boxShadow).toBe('var(--shadow-primary)')
  })

  it('does not apply it to a solid button in any other color', () => {
    const wrapper = mount(WBtn, { props: { label: 'Go', color: 'primary' } })

    expect(wrapper.element.style.boxShadow).toBe('')
  })

  it('does not apply it to an outline accent button', () => {
    const wrapper = mount(WBtn, { props: { label: 'Go', color: 'accent', outline: true } })

    expect(wrapper.element.style.boxShadow).toBe('')
  })

  it('does not apply it to a flat accent button', () => {
    const wrapper = mount(WBtn, { props: { label: 'Go', color: 'accent', flat: true } })

    expect(wrapper.element.style.boxShadow).toBe('')
  })

  it('does not apply it to an unthemed accent button (no color prop)', () => {
    const wrapper = mount(WBtn, { props: { label: 'Go' } })

    expect(wrapper.element.style.boxShadow).toBe('')
  })
})

// -> `title` and `tabindex` are declared props rather than left to `$attrs` fallthrough, so a call
//    site's use of either is visible on the component's own surface.
describe('WBtn native attribute props', () => {
  it('renders a native title tooltip', () => {
    const wrapper = mount(WBtn, { props: { label: 'Copy link', title: 'Copy link to clipboard' } })

    expect(wrapper.attributes('title')).toBe('Copy link to clipboard')
  })

  it('renders an explicit tabindex, e.g. to remove an inert preview button from the tab order', () => {
    const wrapper = mount(WBtn, { props: { label: 'Preview', tabindex: -1 } })

    expect(wrapper.attributes('tabindex')).toBe('-1')
  })

  it('renders no title/tabindex attribute when neither is given', () => {
    const wrapper = mount(WBtn, { props: { label: 'Save' } })

    expect(wrapper.attributes('title')).toBeUndefined()
    expect(wrapper.attributes('tabindex')).toBeUndefined()
  })
})
