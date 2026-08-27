import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WDialog from './WDialog.vue'
import tailwindCss from '@/css/tailwind.css?raw'

describe('WDialog', () => {
  /**
   * OpenProject #2106: the panel's own clamp lives in `tailwind.css` (a `.w-dialog-panel` component
   * class, not a scoped rule in this SFC -- see the comment on it), because every one of the 19
   * dialog cards sets `min-width` as an inline style on the panel's child, which would otherwise beat
   * a scoped rule at the same specificity tier depending on source order. Asserted against the
   * stylesheet source directly, since that inline style wins the CASCADE in jsdom/happy-dom the same
   * way it would in a real layout -- the clamp only actually holds because it comes from a different
   * property (`max-width` vs. the child's `min-width`) on a different element (the panel vs. its
   * slotted child), not because one rule beats the other.
   */
  it('clamps .w-dialog-panel to the viewport width, matching the p-4 gutter', () => {
    expect(tailwindCss).toMatch(/\.w-dialog-panel\s*\{[^}]*max-width:\s*calc\(100vw - 2rem\)/)
  })

  /**
   * A wide inner card (e.g. `WebhookEditDialog`'s 850px `min-width`) still overflows the clamped
   * panel on a narrow viewport -- the clamp caps the panel, not the child asking for more room
   * inside it. Plain `justify-center` would center that overflow too, pushing the panel's start
   * edge off both sides of the screen with no way to scroll back to it. `justify-center-safe` falls
   * back to start-alignment exactly when the content overflows, which is what keeps the start edge
   * reachable through the viewport's own `overflow-auto`.
   */
  it('centers the standard viewport with safe alignment, not plain centering', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true },
      global: { stubs: { teleport: true } }
    })

    const viewport = wrapper.find('.w-dialog-viewport')
    expect(viewport.classes()).toContain('justify-center-safe')
    expect(viewport.classes()).not.toContain('justify-center')
  })

  it('renders the panel with the clamp class regardless of a wide inner card', () => {
    const wrapper = mount(WDialog, {
      props: { modelValue: true },
      slots: { default: '<div style="min-width: 850px">wide card</div>' },
      global: { stubs: { teleport: true } }
    })

    const panel = wrapper.find('.w-dialog-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.classes()).toContain('w-dialog-panel')
    expect(panel.find('div[style*="min-width"]').exists()).toBe(true)
  })
})
