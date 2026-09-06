import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import BlockPickerOverlay from './BlockPickerOverlay.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * Regression coverage for the picker starting a newly-selected block's form on the site's configured
 * default (`block.config`, written by the admin "Content Blocks" page's per-block "Server" field —
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
