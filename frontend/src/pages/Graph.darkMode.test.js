import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDark } from '@/composables/dark'
import { mountGraph } from './graphFixtures.js'

const componentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'Graph.vue'),
  'utf8'
)

/**
 * Canvas pixel output is not practically assertable, so node colors here come from an explicit
 * `recomputeClusters()` call rather than a d3-force tick, which under test runs on its own async
 * timer this suite does not drive.
 *
 * The `dark.isActive` watch job can land a turn of the event loop later than a chained
 * `await nextTick()` captures, especially with several `Graph.vue` instances across sibling files
 * sharing the one module-level `dark.isActive`. `vi.waitFor()` polls instead of guessing a tick
 * count.
 */
afterEach(() => {
  document.body.classList.remove('body--dark', 'body--light')
})

describe('Graph.vue dark mode (OpenProject #2412)', () => {
  // -> `colorForGroup()` reads `dark.isActive` synchronously at call time, so unlike the repaint
  //    cases below this needs no waiting at all.
  it('colorForGroup() returns a color from the dark palette once dark mode is active, and from the light palette otherwise', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()

    dark.set(false)
    const lightColor = wrapper.vm.colorForGroup('')
    expect(wrapper.vm.CATEGORICAL_PALETTE_LIGHT).toContain(lightColor)
    expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).not.toContain(lightColor)

    dark.set(true)
    const darkColor = wrapper.vm.colorForGroup('')
    expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).toContain(darkColor)
    expect(darkColor).not.toBe(lightColor)
  })

  it('recomputeClusters() re-colors already-assigned node/cluster colors to the new palette, not just newly-seen groups', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()
    const realNodes = () => wrapper.vm.nodes.filter((node) => !node.synthetic)

    dark.set(false)
    wrapper.vm.recomputeClusters()
    const lightColors = realNodes().map((node) => node.color)
    expect(lightColors.length).toBeGreaterThan(0)
    for (const color of lightColors) {
      expect(wrapper.vm.CATEGORICAL_PALETTE_LIGHT).toContain(color)
    }

    dark.set(true)
    wrapper.vm.recomputeClusters()
    const darkColors = realNodes().map((node) => node.color)
    expect(darkColors).not.toEqual(lightColors)
    for (const color of darkColors) {
      expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).toContain(color)
    }
  })

  it('toggling dark.isActive alone (no manual recompute) repaints node colors via the watcher', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()
    const realNodes = () => wrapper.vm.nodes.filter((node) => !node.synthetic)

    dark.set(false)
    wrapper.vm.recomputeClusters()
    const lightColors = realNodes().map((node) => node.color)

    // -> The mode flip alone, with no recompute call: what is under test is the watcher itself.
    dark.set(true)
    await vi.waitFor(() => {
      expect(realNodes().map((node) => node.color)).not.toEqual(lightColors)
    })

    const darkColors = realNodes().map((node) => node.color)
    for (const color of darkColors) {
      expect(wrapper.vm.CATEGORICAL_PALETTE_DARK).toContain(color)
    }
  })

  it('leaves the fixed synthetic-node color untouched by the mode toggle', async () => {
    const wrapper = await mountGraph()
    const dark = useDark()

    dark.set(false)
    wrapper.vm.recomputeClusters()
    const syntheticNode = wrapper.vm.nodes.find((node) => node.synthetic)
    expect(syntheticNode?.color).toBe(wrapper.vm.SYNTHETIC_NODE_COLOR)

    dark.set(true)
    wrapper.vm.recomputeClusters()
    expect(syntheticNode.color).toBe(wrapper.vm.SYNTHETIC_NODE_COLOR)
  })
})

/**
 * A source-text assertion, not a computed style: happy-dom's cascade support for `<style scoped>`
 * plus native `.body--dark &` nesting is not dependable as a pass/fail signal. What is guarded is a
 * `color` declaration going missing from one of these selectors' light/dark blocks.
 */
describe('Graph.vue legend/filter panel dark-mode text color (OpenProject #2497)', () => {
  // -> Walks to the balanced closing brace, so the rule's own nested blocks come with it.
  const ruleBodyFor = (selector) => {
    const opener = `${selector} {`
    const start = componentSource.indexOf(opener)
    expect(start, `expected to find "${opener}" in Graph.vue`).toBeGreaterThan(-1)

    let depth = 0
    let index = start + opener.length - 1
    do {
      if (componentSource[index] === '{') depth += 1
      else if (componentSource[index] === '}') depth -= 1
      index += 1
    } while (depth > 0 && index < componentSource.length)

    return componentSource.slice(start, index)
  }

  it.each([['.graph-view-filters'], ['.graph-view-control-caption'], ['.graph-view-legend-label']])(
    '%s declares a color under both .body--light and .body--dark',
    (selector) => {
      let body = ruleBodyFor(selector)
      const hasBoth = () =>
        /\.body--light\s+&\s*\{[^}]*\}/.test(body) && /\.body--dark\s+&\s*\{[^}]*\}/.test(body)
      // -> A rule may take its colours from the shared `graph-panel` class rather than declaring
      //    them itself, so follow that class when the selector's own body has neither block.
      if (!hasBoth()) {
        body += ruleBodyFor('.graph-panel')
      }

      const lightMatch = body.match(/\.body--light\s+&\s*\{([^}]*)\}/)
      expect(
        lightMatch,
        `expected a .body--light block in ${selector} (or the shared .graph-panel class)`
      ).not.toBeNull()
      expect(lightMatch[1]).toMatch(/color:\s*[^;]+;/)

      const darkMatch = body.match(/\.body--dark\s+&\s*\{([^}]*)\}/)
      expect(
        darkMatch,
        `expected a .body--dark block in ${selector} (or the shared .graph-panel class)`
      ).not.toBeNull()
      expect(darkMatch[1]).toMatch(/color:\s*[^;]+;/)
    }
  )
})
