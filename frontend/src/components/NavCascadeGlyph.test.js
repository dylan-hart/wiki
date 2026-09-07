import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import NavCascadeGlyph from './NavCascadeGlyph.vue'

/**
 * One bar-state assertion per row `NavEditMenu.vue`'s Ledger restyle draws (Task #2799), matching
 * the mode -> bar-state table in `ui-redesign-nav/HANDOFF.md` §1: parent / this page / descendants,
 * top to bottom.
 */
function barKinds(mode, root = false) {
  const wrapper = mount(NavCascadeGlyph, { props: { mode, root } })
  return wrapper.findAll('rect').map((rect) => {
    const kindClass = rect.classes().find((c) => c.startsWith('nav-cascade-glyph__bar--'))
    return kindClass.replace('nav-cascade-glyph__bar--', '')
  })
}

describe('NavCascadeGlyph', () => {
  it('draws three bars', () => {
    const wrapper = mount(NavCascadeGlyph, { props: { mode: 'inherit' } })
    expect(wrapper.findAll('rect')).toHaveLength(3)
  })

  it('fills only the parent bar, in slate, for inherit', () => {
    expect(barKinds('inherit')).toEqual(['slate', 'plain', 'plain'])
  })

  it('fills this-page and descendants, in accent, for override', () => {
    expect(barKinds('override')).toEqual(['plain', 'accent', 'accent'])
  })

  it('fills only this-page, in accent, for overrideExact', () => {
    expect(barKinds('overrideExact')).toEqual(['plain', 'accent', 'plain'])
  })

  it('dashes this-page and descendants for hide', () => {
    expect(barKinds('hide')).toEqual(['plain', 'dashed', 'dashed'])
  })

  it('dashes only this-page for hideExact', () => {
    expect(barKinds('hideExact')).toEqual(['plain', 'dashed', 'plain'])
  })

  it('fills every bar in accent for the root Show mode (inherit at root)', () => {
    expect(barKinds('inherit', true)).toEqual(['accent', 'accent', 'accent'])
  })

  it('dashes every bar for the root Hide mode', () => {
    expect(barKinds('hide', true)).toEqual(['dashed', 'dashed', 'dashed'])
  })

  it('sets stroke-dasharray only on dashed bars', () => {
    const wrapper = mount(NavCascadeGlyph, { props: { mode: 'hideExact' } })
    const rects = wrapper.findAll('rect')
    expect(rects[0].attributes('stroke-dasharray')).toBeUndefined()
    expect(rects[1].attributes('stroke-dasharray')).toBe('1.6 1.4')
    expect(rects[2].attributes('stroke-dasharray')).toBeUndefined()
  })

  it('is decorative, not announced to assistive tech', () => {
    const wrapper = mount(NavCascadeGlyph, { props: { mode: 'inherit' } })
    expect(wrapper.attributes('aria-hidden')).toBe('true')
  })
})
