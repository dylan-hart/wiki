import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WIcon from './WIcon.vue'

describe('WIcon', () => {
  it('renders a bundled Iconify reference as an inline svg', () => {
    // -> `tabler:home` is inlined into icons.generated.js by `scripts/generate-icons.mjs` because
    //    this app's own source writes it literally somewhere.
    const wrapper = mount(WIcon, { props: { name: 'tabler:home' } })

    expect(wrapper.find('svg.w-icon').exists()).toBe(true)
    expect(wrapper.find('iconify-icon').exists()).toBe(false)
  })

  it('renders an unbundled Iconify reference via iconify-icon', () => {
    // -> Built by concatenation, not a literal: `scripts/generate-icons.mjs` scans quoted literals
    //    matching the ref shape and would otherwise try (and fail) to bundle this fake icon name.
    //    That is also the case under test — a reference the static scan never sees, the same as an
    //    icon a user picks at runtime.
    const unbundledRef = 'mdi:' + 'some-icon-nobody-picked-yet'
    const wrapper = mount(WIcon, { props: { name: unbundledRef } })

    const el = wrapper.find('iconify-icon')
    expect(el.exists()).toBe(true)
    expect(el.attributes('icon')).toBe(unbundledRef)
  })

  it('renders an img: reference as an image', () => {
    const wrapper = mount(WIcon, { props: { name: 'img:/_assets/icons/blueprint.svg' } })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/_assets/icons/blueprint.svg')
  })

  it('renders an img: reference with an empty alt inside an aria-hidden wrapper', () => {
    // -> Every `img:` caller depends on this: an auth strategy's or storage module's own icon
    //    (`ultraviolet-*`, named by the module's definition.yml and so only knowable at runtime)
    //    already sits beside a visible label, so the image itself must stay out of the
    //    accessibility tree rather than have assistive tech announce its filename.
    const wrapper = mount(WIcon, { props: { name: 'img:/_assets/icons/ultraviolet-local.svg' } })

    expect(wrapper.attributes('aria-hidden')).toBe('true')

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('alt')).toBe('')
  })

  it('renders nothing for a legacy webfont-style name', () => {
    // -> No webfont-name mapping exists in this component -- it recognizes only `img:` and the
    //    Iconify `prefix:name` shape -- and none is being added, since nothing here (nor the
    //    planned 2.5.x migration importer) produces that format. A webfont-style name must keep
    //    falling through to kind 'none' and drawing nothing.
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
