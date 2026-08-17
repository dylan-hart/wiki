import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WIcon from './WIcon.vue'

describe('WIcon', () => {
  it('renders a bundled Iconify reference as an inline svg', () => {
    // -> `mdi:home` is inlined into icons.generated.js by `scripts/generate-icons.mjs` because it is
    //    written literally elsewhere in this app's own source (e.g. nav/menu defaults).
    const wrapper = mount(WIcon, { props: { name: 'mdi:home' } })

    expect(wrapper.find('svg.w-icon').exists()).toBe(true)
    expect(wrapper.find('iconify-icon').exists()).toBe(false)
  })

  it('renders an unbundled Iconify reference via iconify-icon', () => {
    const wrapper = mount(WIcon, { props: { name: 'mdi:some-icon-nobody-picked-yet' } })

    const el = wrapper.find('iconify-icon')
    expect(el.exists()).toBe(true)
    expect(el.attributes('icon')).toBe('mdi:some-icon-nobody-picked-yet')
  })

  it('renders an img: reference as an image', () => {
    const wrapper = mount(WIcon, { props: { name: 'img:/_assets/icons/blueprint.svg' } })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/_assets/icons/blueprint.svg')
  })

  it('renders nothing for a legacy webfont-style name', () => {
    // -> Regression case for the CLAUDE.md/WIcon.vue discrepancy (task 470): CLAUDE.md used to claim
    //    `las la-cog` / `mdi-check` webfont names were mapped onto Iconify equivalents. No such mapping
    //    ever existed in this component -- it only recognizes `img:` and the Iconify `prefix:name`
    //    shape -- and none is being added, since nothing in this fork (or the planned 2.5.x migration
    //    importer, OpenProject #416) ever produces or carries forward that format. A webfont-style name
    //    correctly falls through to kind 'none' and draws nothing.
    for (const name of ['las la-cog', 'mdi-check', 'fa fa-cog', 'la-cog']) {
      const wrapper = mount(WIcon, { props: { name } })

      expect(wrapper.find('svg').exists()).toBe(false)
      expect(wrapper.find('iconify-icon').exists()).toBe(false)
      expect(wrapper.find('img').exists()).toBe(false)
      expect(wrapper.html()).toBe('<!--v-if-->')
    }
  })

  it('renders nothing for an empty or "none" name', () => {
    for (const name of ['', 'none']) {
      const wrapper = mount(WIcon, { props: { name } })

      expect(wrapper.html()).toBe('<!--v-if-->')
    }
  })
})
