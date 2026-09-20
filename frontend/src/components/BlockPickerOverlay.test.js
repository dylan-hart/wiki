import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import BlockPickerOverlay from './BlockPickerOverlay.vue'
import WBtn from '@/components/shared/WBtn.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * The fixture carries a site `config` value and a different `prop.default` so the two tests below
 * can tell which of the two the picker starts a newly-selected block's form on.
 */

const BLOCK = {
  id: 'block-1',
  block: 'kroki',
  name: 'Kroki',
  description: 'Draws a diagram through a Kroki server.',
  icon: 'tabler:topology-star',
  isEnabled: true,
  isCustom: false,
  config: { server: 'https://kroki.example.com' },
  props: [{ name: 'server', type: 'string', label: 'Server', default: 'https://kroki.io' }],
  template: ''
}

async function mountPicker(blocks) {
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(blocks) })

  const { wrapper } = mountWithApp(BlockPickerOverlay)
  await flushPromises()
  return wrapper
}

function insertButton(wrapper) {
  return wrapper
    .findAllComponents(WBtn)
    .find((btn) => btn.props('label') === 'editor.blockPicker.insert')
}

describe('BlockPickerOverlay', () => {
  it("starts a selected block's form on the site's configured default, not the component's own", async () => {
    const wrapper = await mountPicker([BLOCK])

    await wrapper.find('.block-picker-card').trigger('click')

    expect(wrapper.find('.block-picker-output').text()).toContain(
      'server="https://kroki.example.com"'
    )
  })

  it("falls back to the component's own default when the site has not configured one", async () => {
    const wrapper = await mountPicker([{ ...BLOCK, config: {} }])

    await wrapper.find('.block-picker-card').trigger('click')

    // -> Equal to the prop's own default, so `blockAttributes` leaves it out of the markup entirely
    expect(wrapper.find('.block-picker-output').text()).not.toContain('server=')
  })

  // -> Custom blocks are this fork's own concept, not an upstream Wiki.js feature, so no docs
  //    site describes them and there is no `/guide/blocks` page to point a help button at
  it('has no help/docs button', async () => {
    const wrapper = await mountPicker([BLOCK])

    expect(wrapper.html()).not.toContain('/guide/blocks')
  })

  /**
   * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts; the
   * picker has no use for it, but must declare it all the same.
   */
  it('declares overlayOpts as a prop, so it does not fall through onto the rendered DOM root', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([BLOCK]) })
    const { wrapper } = mountWithApp(BlockPickerOverlay, {
      props: { overlayOpts: { unused: true } }
    })
    await flushPromises()

    expect(wrapper.attributes('overlay-opts')).toBeUndefined()
  })
})

/**
 * `ultraviolet-` is what an assembled `img:` icon path would look like: a name built by
 * concatenation is invisible to `scripts/generate-icons.mjs`, and `WIcon` draws nothing for a
 * reference with no Iconify prefix. `WIcon` stamps `data-icon` on all three of its branches, so
 * the selector holds whether the reference is inlined at build time or falls through at runtime.
 */
describe('the block icon', () => {
  it("renders the definition's own Iconify reference, unmodified", async () => {
    const wrapper = await mountPicker([BLOCK])

    expect(wrapper.find('[data-icon="tabler:topology-star"]').exists()).toBe(true)
    expect(wrapper.html()).not.toContain('ultraviolet-')
  })

  it('draws the one fallback glyph for a custom block, whose definition it cannot vouch for', async () => {
    const wrapper = await mountPicker([{ ...BLOCK, isCustom: true, icon: 'whatever-was-uploaded' }])

    expect(wrapper.find('[data-icon="tabler:puzzle"]').exists()).toBe(true)
    expect(wrapper.html()).not.toContain('whatever-was-uploaded')
  })
})

/**
 * A card is the only way to select or insert a block, so a disabled one must be absent rather than
 * merely unselected. Nothing stale survives either: the overlay's `<component :is>` rebuilds this
 * component on every open, and the block list is fetched fresh on mount.
 */
describe('the isEnabled filter', () => {
  const DISABLED = { ...BLOCK, id: 'block-2', block: 'diagram', name: 'Mermaid', isEnabled: false }
  const ENABLED = { ...BLOCK, id: 'block-1', isEnabled: true }

  it('never lists a block disabled for the current site', async () => {
    const wrapper = await mountPicker([ENABLED, DISABLED])

    const cards = wrapper.findAll('.block-picker-card')
    expect(cards).toHaveLength(1)
    expect(wrapper.text()).toContain('Kroki')
    expect(wrapper.text()).not.toContain('Mermaid')
  })

  it('leaves nothing selectable when every block on the site is disabled', async () => {
    const wrapper = await mountPicker([DISABLED])

    expect(wrapper.findAll('.block-picker-card')).toHaveLength(0)
    expect(wrapper.find('.block-picker-output').exists()).toBe(false)
  })
})

/**
 * The design's hard requirement is that NOTHING reflows as selection travels between cards. Only
 * the half a DOM emulator can answer is asserted here: that selection is a class swap over
 * identical children. The geometry is measured in a real browser by `blockPickerLayout.test.js`,
 * since neither `happy-dom` nor `jsdom` runs a layout engine and an assertion about position would
 * pass here against zeroed rects.
 */
describe('the selection treatment', () => {
  const FIRST = { ...BLOCK, id: 'block-1', block: 'kroki', name: 'Kroki' }
  const SECOND = { ...BLOCK, id: 'block-2', block: 'diagram', name: 'Mermaid' }

  it('marks exactly the picked card, and moves the mark rather than adding a second', async () => {
    const wrapper = await mountPicker([FIRST, SECOND])
    const cards = wrapper.findAll('.block-picker-card')

    expect(cards.filter((card) => card.classes('is-selected'))).toHaveLength(0)

    await cards[0].trigger('click')
    expect(cards[0].classes()).toContain('is-selected')
    expect(cards[1].classes()).not.toContain('is-selected')

    await cards[1].trigger('click')
    expect(cards[0].classes()).not.toContain('is-selected')
    expect(cards[1].classes()).toContain('is-selected')
  })

  /*
   * An element that appears on selection is exactly what could push the row around, so the marks
   * and the plate are on every card and only faded in by `is-selected`.
   */
  it('renders the four corner marks and the icon plate on every card, selected or not', async () => {
    const wrapper = await mountPicker([FIRST, SECOND])
    const cards = wrapper.findAll('.block-picker-card')

    const shapeOf = (card) => ({
      marks: card.findAll('.block-picker-mark').length,
      plates: card.findAll('.block-picker-plate').length,
      children: card.element.children.length
    })
    const before = cards.map(shapeOf)

    await cards[0].trigger('click')

    expect(before).toEqual([
      { marks: 4, plates: 1, children: 6 },
      { marks: 4, plates: 1, children: 6 }
    ])
    expect(cards.map(shapeOf)).toEqual(before)
  })

  it("follows the selection onto the card's own plate and tag line", async () => {
    const wrapper = await mountPicker([FIRST, SECOND])
    const cards = wrapper.findAll('.block-picker-card')

    await cards[0].trigger('click')

    // -> The tag name is what actually lands in the page, so it is the line that takes the accent
    expect(cards[0].find('.block-picker-tag').text()).toBe('<block-kroki>')
    expect(cards[0].find('.block-picker-plate').exists()).toBe(true)
  })

  it('draws the glyph inside the plate rather than loose on the card', async () => {
    const wrapper = await mountPicker([FIRST])

    const plate = wrapper.find('.block-picker-card .block-picker-plate')
    expect(plate.find('.w-icon').exists()).toBe(true)
  })

  /** Both tokens are `0`/`none` under Ledger, so only Cobalt shows whether the classes are there. */
  it('draws the card and its plate off --radius-card/--shadow-card', async () => {
    const wrapper = await mountPicker([FIRST])

    const card = wrapper.find('.block-picker-card')
    expect(card.classes()).toContain('rounded-card')
    expect(card.classes()).toContain('shadow-card')

    const plate = wrapper.find('.block-picker-plate')
    expect(plate.classes()).toContain('rounded-card')
    expect(plate.classes()).toContain('shadow-card')
  })

  /** `--corner-marks` is the gate that hides Ledger's registration marks under Cobalt. */
  it('gates the corner marks on --corner-marks, matching Login.vue/NavEditMenu.vue', () => {
    const source = readFileSync(join(import.meta.dirname, 'BlockPickerOverlay.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'))

    expect(styleBlock).toMatch(
      /\.block-picker-mark\s*{\s*position:\s*absolute;\s*display:\s*var\(--corner-marks\);/
    )
  })

  it('draws the empty-state glyph and hint until something is picked', async () => {
    const wrapper = await mountPicker([FIRST])

    expect(wrapper.find('.block-picker-empty').exists()).toBe(true)

    await wrapper.find('.block-picker-card').trigger('click')

    expect(wrapper.find('.block-picker-empty').exists()).toBe(false)
  })

  // -> `AdminBlocks.vue` already tags an uploaded block this way; the picker says the same thing
  it('tags a custom block on its card', async () => {
    const wrapper = await mountPicker([
      { ...FIRST, isCustom: false },
      { ...SECOND, isCustom: true }
    ])
    const cards = wrapper.findAll('.block-picker-card')

    expect(cards[0].find('.block-picker-name em').exists()).toBe(false)
    expect(cards[1].find('.block-picker-name em').exists()).toBe(true)
  })
})

/**
 * `accent`, not the brighter `accent-fill`: the label over it is white, and only the darker tone
 * clears 4.5:1 contrast under white.
 */
describe('the Insert action', () => {
  const REQUIRED_PROP = {
    ...BLOCK,
    props: [{ name: 'server', type: 'string', label: 'Server', required: true }],
    config: {}
  }

  it('takes the accent, not the source green', async () => {
    const wrapper = await mountPicker([BLOCK])

    expect(insertButton(wrapper).props('color')).toBe('accent')
    expect(insertButton(wrapper).props('textColor')).toBe('white')
  })

  it('is disabled before anything is picked', async () => {
    const wrapper = await mountPicker([BLOCK])

    expect(insertButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('stays disabled on a block whose required prop is still empty', async () => {
    const wrapper = await mountPicker([REQUIRED_PROP])

    await wrapper.find('.block-picker-card').trigger('click')

    expect(insertButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('enables once that required prop is filled in', async () => {
    const wrapper = await mountPicker([REQUIRED_PROP])

    await wrapper.find('.block-picker-card').trigger('click')
    await wrapper.find('.block-picker-form input').setValue('https://kroki.example.com')

    expect(insertButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('enables straight away on a block with no required prop to fill', async () => {
    const wrapper = await mountPicker([BLOCK])

    await wrapper.find('.block-picker-card').trigger('click')

    expect(insertButton(wrapper).attributes('disabled')).toBeUndefined()
  })
})

/*
 * Under Cobalt the buttons take a gap instead of `WBtnGroup`'s hairline seam. `gap` is a plain CSS
 * value `happy-dom` resolves with no layout engine; the seam is a logical `border-inline-end`,
 * which it does not resolve for `getComputedStyle` at all, so that half is asserted in a real
 * browser by `blockPickerLayout.test.js`.
 */
describe('BlockPickerOverlay Cancel/Insert button gap (OpenProject #2873)', () => {
  let wrapper

  // -> `attachTo: document.body` leaves the mounted tree attached, so it has to be torn down
  //    before the next mount or `document.body.querySelector` silently resolves the stale one
  afterEach(() => {
    wrapper?.unmount()
    document.body.classList.remove('body--cobalt', 'body--light', 'body--dark')
  })

  it('takes no gap outside Cobalt', async () => {
    document.body.classList.add('body--light')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([BLOCK]) })
    ;({ wrapper } = mountWithApp(BlockPickerOverlay, { attachTo: document.body }))
    await flushPromises()

    const group = document.body.querySelector('.block-picker-actions')
    expect(getComputedStyle(group).gap).not.toBe('8px')
  })

  it.each(['body--light', 'body--dark'])('takes the 8px gap under Cobalt (%s)', async (theme) => {
    document.body.classList.add('body--cobalt', theme)
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([BLOCK]) })
    ;({ wrapper } = mountWithApp(BlockPickerOverlay, { attachTo: document.body }))
    await flushPromises()

    const group = document.body.querySelector('.block-picker-actions')
    expect(getComputedStyle(group).gap).toBe('8px')
  })
})
