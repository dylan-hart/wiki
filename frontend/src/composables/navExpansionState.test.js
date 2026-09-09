import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { useNavExpansionState, useProvideNavExpansionState } from './navExpansionState'

/**
 * A minimal provider/consumer pair, mirroring the real `NavSidebar.vue` (provides once at the
 * root) / `NavSidebarItem.vue` (injects, possibly several levels deep) shape -- without pulling in
 * either component or this app's full mount harness (i18n/router/pinia), none of which this
 * composable depends on. Each `Consumer` records its own `{ isOpen, setOpen }` pair into `sink` as
 * it's created, so a test can address any id from any instance directly -- which is what proves the
 * state is shared rather than per-instance -- without relying on how `@vue/test-utils` happens to
 * expose a `setup()` component's `expose()`d members.
 */
function makeConsumer(sink) {
  return defineComponent({
    name: 'Consumer',
    setup() {
      sink.push(useNavExpansionState())
      return () => h('div')
    }
  })
}

function mountTree({ nestingDepth = 1 } = {}) {
  const sink = []
  const Consumer = makeConsumer(sink)

  // -> `nestingDepth` consumers nested one inside another, so a test can prove the shared state is
  //    the same Map at any depth below the provider, not only immediately under it.
  function nested(depth) {
    return depth <= 1 ? h(Consumer) : h('div', [h(Consumer), nested(depth - 1)])
  }

  const Provider = defineComponent({
    name: 'Provider',
    setup() {
      useProvideNavExpansionState()
      return () => h('div', [nested(nestingDepth), h(Consumer)])
    }
  })

  mount(Provider)
  return sink
}

describe('navExpansionState', () => {
  it('defaults to the given defaultValue for an id never written', () => {
    const [a] = mountTree()

    expect(a.isOpen('never-written', false)).toBe(false)
    expect(a.isOpen('never-written', true)).toBe(true)
  })

  it('remembers a value written for an id, across further reads', () => {
    const [a] = mountTree()

    a.setOpen('folder-1', true)

    expect(a.isOpen('folder-1', false)).toBe(true)
  })

  it('does not let a later defaultValue override an id already written', () => {
    const [a] = mountTree()

    a.setOpen('folder-1', false)

    // -> Even though the caller now claims a different default, the recorded value wins: this is
    //    what keeps a folder the reader closed from popping back open just because its
    //    `expandByDefault || containsCurrent(item)` expression happens to re-evaluate to `true` on
    //    a later render.
    expect(a.isOpen('folder-1', true)).toBe(false)
  })

  it('keeps each id independent -- writing one does not affect another', () => {
    const [a] = mountTree()

    a.setOpen('folder-1', true)

    expect(a.isOpen('folder-1', false)).toBe(true)
    expect(a.isOpen('folder-2', false)).toBe(false)
  })

  it('shares one Map across every depth of the tree, not one per component instance', () => {
    const consumers = mountTree({ nestingDepth: 3 })
    expect(consumers.length).toBeGreaterThan(1)
    const [first, ...rest] = consumers

    // -> Written through the first instance...
    first.setOpen('shared-id', true)

    // -> ...and read back as the same value through every other instance in the tree, proving they
    //    all share the one Map `useProvideNavExpansionState()` created rather than each injecting a
    //    fallback of its own.
    for (const consumer of rest) {
      expect(consumer.isOpen('shared-id', false)).toBe(true)
    }
  })

  it('falls back to a working, unshared Map when mounted with no provider (a standalone unit-test mount)', () => {
    const sink = []
    const Consumer = makeConsumer(sink)
    mount(Consumer)
    const [api] = sink

    expect(api.isOpen('x', false)).toBe(false)
    api.setOpen('x', true)
    expect(api.isOpen('x', false)).toBe(true)
  })

  it('gives two separately-mounted standalone instances independent state, not an accidentally shared module-level Map', () => {
    const sinkOne = []
    const sinkTwo = []
    mount(makeConsumer(sinkOne))
    mount(makeConsumer(sinkTwo))

    sinkOne[0].setOpen('x', true)

    expect(sinkTwo[0].isOpen('x', false)).toBe(false)
  })
})
