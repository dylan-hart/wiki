import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import BlockParamsDialog from './BlockParamsDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #2634. This dialog is the third consumer of a block definition's `icon` — after
 * `AdminBlocks.vue` and `BlockPickerOverlay.vue` — and the one nothing was covering, so a rename of
 * the 26 in-repo declarations would have blanked its title band with nothing failing to say so.
 *
 * It draws the reference as-is rather than assembling an `img:/_assets/icons/ultraviolet-<name>.svg`
 * path out of it, which is what CLAUDE.md means under Icons by "a name assembled by concatenation is
 * therefore a bug: make it a literal": `scripts/generate-icons.mjs` cannot see a name built at
 * runtime, and `WIcon` draws nothing at all for a reference carrying no Iconify prefix.
 *
 * `WIcon` stamps `data-icon` on all three of its branches, so this reads the same whether the
 * reference happens to be in the inlined bundle or falls through to `iconify-icon` at runtime.
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
