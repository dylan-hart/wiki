import { afterEach, describe, expect, it } from 'vitest'

import { useDark } from '@/composables/dark'
import { mountGraph } from './graphFixtures.js'

/**
 * OpenProject #3364 (Feature #3362's "Graph canvas -- selected node" scope, blocked-by-then-unblocked
 * #3363): paints the graph's `selectedNodeId` (OpenProject #3363) using the exact same visual
 * language as the nav sidebar's "current row" style (`.router-link-exact-active`, `NavSidebar.vue`
 * lines 248-304) -- `--color-accent-fill`/`--color-ink` under light, `--color-accent-dark`/
 * `--color-text-dark` under dark.
 *
 * The actual ring/bold-title PAINTING is covered at the pure-function level in `graphDraw.test.js`
 * (`drawNodes: selected-node ring`, `drawLabels: selected-node bold title`, and `paintGraph
 * (OpenProject #3364)` for the wiring between the two) -- real canvas pixel output isn't practically
 * assertable here, the same project-wide limitation `Graph.rendering.test.js` documents. This suite
 * covers the one piece of genuinely new LOGIC `Graph.vue` itself gained: resolving the right token
 * pair off `document.body` for whichever mode is active, which is what makes the on-canvas ring
 * automatically track Cobalt too, with no aesthetic-name branch of its own -- `getComputedStyle`
 * reads whatever is actually set on `document.body`'s custom properties, exactly as the sidebar's own
 * CSS cascade would, regardless of which aesthetic set them.
 */
afterEach(() => {
  document.body.classList.remove('body--dark', 'body--light')
  for (const prop of [
    '--color-accent-fill',
    '--color-ink',
    '--color-accent-dark',
    '--color-text-dark'
  ]) {
    document.body.style.removeProperty(prop)
  }
})

describe('Graph.vue selected-node highlight colors (OpenProject #3364)', () => {
  it('resolves --color-accent-fill/--color-ink (the light "current row" pair) when dark mode is inactive', async () => {
    document.body.style.setProperty('--color-accent-fill', '#e4676b')
    document.body.style.setProperty('--color-ink', '#1c2233')
    document.body.style.setProperty('--color-accent-dark', '#f08287')
    document.body.style.setProperty('--color-text-dark', '#e6eaf2')

    const wrapper = await mountGraph()
    const dark = useDark()
    dark.set(false)

    expect(wrapper.vm.selectedNodeColors).toEqual({ ring: '#e4676b', label: '#1c2233' })
  })

  it('resolves --color-accent-dark/--color-text-dark (the dark "current row" pair) when dark mode is active', async () => {
    document.body.style.setProperty('--color-accent-fill', '#e4676b')
    document.body.style.setProperty('--color-ink', '#1c2233')
    document.body.style.setProperty('--color-accent-dark', '#f08287')
    document.body.style.setProperty('--color-text-dark', '#e6eaf2')

    const wrapper = await mountGraph()
    const dark = useDark()
    dark.set(true)

    expect(wrapper.vm.selectedNodeColors).toEqual({ ring: '#f08287', label: '#e6eaf2' })
  })

  // -> OpenProject #2764/#2766: Cobalt overrides these same four token names wholesale on
  //    `body.body--cobalt`/`body.body--cobalt.body--dark` (`css/tailwind.css`) rather than defining
  //    any Cobalt-specific token of its own -- resolving off `document.body`'s LIVE computed value,
  //    with no aesthetic name ever appearing in `Graph.vue`, is what makes this pick up Cobalt's own
  //    figures automatically. Setting the tokens directly here (as every test in this file does)
  //    stands in for that cascade without needing `tailwind.css` itself loaded under happy-dom.
  it("tracks whatever aesthetic actually set the tokens (e.g. Cobalt's own light-mode figures), with no aesthetic-name branch of its own", async () => {
    document.body.style.setProperty('--color-accent-fill', '#ff4d5a')
    document.body.style.setProperty('--color-ink', '#10194a')

    const wrapper = await mountGraph()
    const dark = useDark()
    dark.set(false)

    expect(wrapper.vm.selectedNodeColors).toEqual({ ring: '#ff4d5a', label: '#10194a' })
  })

  it('selecting a node via a canvas click repaints with that node as selectedNodeId, with no thrown error', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    nodeA.x = 500
    nodeA.y = 500
    wrapper.vm.relayout()

    await wrapper.find('canvas').trigger('click', { clientX: 500, clientY: 500 })

    expect(wrapper.vm.selectedNodeId).toBe('en:a')
    expect(wrapper.find('canvas').exists()).toBe(true)
  })
})
