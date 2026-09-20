import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import BlockParamsDialog from './BlockParamsDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Regression: nothing else exercises this dialog's icon, so a broken reference here would blank
 * its title band with nothing failing to say so.
 *
 * Draws the reference as-is rather than assembling an `img:/_assets/icons/ultraviolet-<name>.svg`
 * path from it -- a name built by concatenation is invisible to `scripts/generate-icons.mjs`, and
 * `WIcon` draws nothing for a reference with no Iconify prefix.
 *
 * `WIcon` stamps `data-icon` on all three of its branches, so this assertion reads the same
 * whether the reference is in the inlined bundle or falls through to `iconify-icon` at runtime.
 */

const DEFINITION = {
  block: 'kroki',
  name: 'Kroki',
  icon: 'tabler:topology-star',
  isCustom: false,
  props: [{ name: 'server', type: 'string', label: 'Server', default: 'https://kroki.io' }]
}

async function mountDialog(definition, values = {}) {
  const wrapper = mount(BlockParamsDialog, {
    props: { definition, values },
    global: { plugins: [createTestI18n()], stubs: { teleport: true } }
  })
  await flushPromises()
  return wrapper
}

describe('BlockParamsDialog', () => {
  it("titles itself with the block's own Iconify reference, unmodified", async () => {
    const wrapper = await mountDialog(DEFINITION)

    expect(wrapper.find('[data-icon="tabler:topology-star"]').exists()).toBe(true)
    expect(wrapper.html()).not.toContain('ultraviolet-')
  })

  it('draws the one fallback glyph for a custom block, whose definition it cannot vouch for', async () => {
    const wrapper = await mountDialog({
      ...DEFINITION,
      isCustom: true,
      icon: 'whatever-was-uploaded'
    })

    expect(wrapper.find('[data-icon="tabler:puzzle"]').exists()).toBe(true)
    expect(wrapper.html()).not.toContain('whatever-was-uploaded')
  })
})
