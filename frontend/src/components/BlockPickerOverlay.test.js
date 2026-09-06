import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import BlockPickerOverlay from './BlockPickerOverlay.vue'
import WBtn from '@/components/shared/WBtn.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * Regression coverage for the picker starting a newly-selected block's form on the site's configured
 * default (`block.config`, written by the admin "Blocks" page's per-block "Server" field —
 * see `models/blocks.ts#setBlocksState`) rather than always on the component's own hardcoded
 * `prop.default`. `helpers/blocks.js#propDefault` carries the actual precedence logic and has its own
 * direct unit coverage via `helpers/markdownBlocks.test.js`; this locks down that the picker's
 * `select()` really calls it, by reading the generated markdown back out of the panel.
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

/** The header's Insert button — the second of the two, and the only one that can be disabled. */
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

  // -> OpenProject #1929: `/guide/blocks` names a concept this fork invented (custom blocks are not
  //    an upstream Wiki.js feature), so no docs site can describe it -- the help button was deleted
  //    rather than left pointing at a page that does not exist.
  it('has no help/docs button', async () => {
    const wrapper = await mountPicker([BLOCK])

    expect(wrapper.html()).not.toContain('/guide/blocks')
  })

  /**
   * OpenProject #2530: `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it
   * mounts as this prop -- the picker has no use for it, but must still declare it, or the value
   * falls through onto its rendered DOM root as a stray attribute.
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
 * OpenProject #2634. Every card used to draw its icon by concatenating the definition's bare name
 * into `img:/_assets/icons/ultraviolet-<name>.svg` — which worked only for as long as those names
 * stayed unprefixed, and so was the one thing standing in the way of the same value resolving on
 * Admin Blocks and in the params dialog, where it drew nothing at all. Both halves are asserted
 * here: the reference reaches `WIcon` untouched, and no path is assembled from it.
 *
 * `WIcon` stamps `data-icon` on all three of its branches, so this reads the same whether the
 * reference happens to be in the inlined bundle or falls through to `iconify-icon` at runtime.
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
 * `blocks` is computed straight off `state.isEnabled` with no other gate, so a block the site has
 * switched off must never appear as a card at all -- not just unselected, but literally absent, since
 * a card is the only way to select or insert one. This is also what rules out the "stale, insertable
 * entry" the task asks about: the picker fetches the block list fresh every time it mounts (see
 * `onMounted`), and a component instance is torn down and rebuilt each time the overlay dialog closes
 * and reopens (`MainOverlayDialog.vue`'s `<component :is>` unmounts it the moment
 * `siteStore.overlay` stops naming it) -- so a block disabled after the picker was last open is
 * simply never in the list the next mount fetches, and nothing here can hold a reference to it.
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
 * OpenProject #2698. Selection stopped being a coloured glow and became line weight — an accent
 * hairline, four corner marks and a tinted icon plate — and the design's hard requirement is that
 * NOTHING reflows as selection travels between cards.
 *
 * What is asserted here is the half a DOM emulator can actually answer: that selection is a class
 * swap on an element whose children are identical in both states, so there is nothing for the
 * browser to add or remove and therefore nothing to reflow. The geometry itself — that the boxes
 * really are pixel-identical, and that the grid really does hold two cards to a row — is measured
 * in a real browser by `blockPickerLayout.test.js`; neither `happy-dom` nor `jsdom` runs a layout
 * engine, so an assertion about position written here would pass against zeroed rects.
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
   * The corner marks are rendered on every card and faded in by the `is-selected` class, never
   * added to the picked one -- an element that appears on selection is exactly the thing that
   * could push the row around. Same for the icon plate: one per card, always.
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

  // -> #2634 owns the icon reference itself; this only pins the plate it now sits inside
  it('draws the glyph inside the plate rather than loose on the card', async () => {
    const wrapper = await mountPicker([FIRST])

    const plate = wrapper.find('.block-picker-card .block-picker-plate')
    expect(plate.find('.w-icon').exists()).toBe(true)
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
 * OpenProject #2698. Insert is this screen's primary action, so it takes the accent rather than the
 * `positive` green it was drawn in — `accent` (#c14a52), not the brighter `accent-fill`, because the
 * label over it is white and only the darker tone clears 4.5:1 under white.
 *
 * Its disabled rule is unchanged and already correct (`canInsert` → `blockPropsFilled`); what is
 * pinned here is that the rule really is what the button is bound to, in both directions.
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
