import { describe, expect, it } from 'vitest'

import TreeNav from './TreeNav.vue'
import TreeNode from './TreeNode.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #3064 ("Bring File Manager tree visual styling to parity with the main navbar").
 * Fast, jsdom-level companion to the CSS itself: what a mounted tree can actually assert without a
 * real layout engine is the `--tree-depth` custom property `TreeNode.vue#indentStyle` drives (the
 * same mechanism, and the same per-level 10px unit, `NavSidebarItem.vue#depthStyle`/`--nav-depth`
 * drives for the main navbar -- see that file's own `NavSidebarItem: depth prop (OpenProject
 * #2932)` describe for the pattern this one follows) and the folder icon's muted `slate-faint`
 * color, matching `NavSidebarItem.vue`'s own icon exactly. The rendered depth-cue dot geometry
 * itself (a `background-image` tiled per lane) needs a real layout engine to verify and is not
 * asserted here, the same reasoning that test's own header comment gives for its equivalent navbar
 * rule.
 */

const CHAIN_NODES = {
  n1: { title: 'Folder A', children: ['n2'] },
  n2: { title: 'Folder B', children: ['n3'] },
  n3: { title: 'Folder C', children: [] }
}

/**
 * Three folders deep, with `selected: 'n3'` so `TreeNav.vue`'s own `onMounted` auto-expands n3's
 * whole ancestor chain (n1, n2) -- the same trick the app itself relies on to open on a page buried
 * a few levels down -- which is what gets n2 and n3 into the DOM at all without a manual toggle
 * click first.
 */
function mountChainTree() {
  return mountWithApp(TreeNav, {
    props: {
      nodes: CHAIN_NODES,
      roots: ['n1'],
      selected: 'n3'
    }
  }).wrapper
}

function nodeWrapper(wrapper, id) {
  return wrapper.findAllComponents(TreeNode).find((w) => w.props('node').id === id)
}

describe('TreeNode: --tree-depth (OpenProject #3064)', () => {
  it("sets the depth it was passed as the row's own `--tree-depth` inline style, unconditionally -- including at depth 0, the same as `NavSidebarItem.vue`'s `--nav-depth`", async () => {
    const wrapper = mountChainTree()
    await wrapper.vm.$nextTick()

    expect(nodeWrapper(wrapper, 'n1').attributes('style')).toMatch(/--tree-depth:\s*0/)
    expect(nodeWrapper(wrapper, 'n2').attributes('style')).toMatch(/--tree-depth:\s*1/)
    expect(nodeWrapper(wrapper, 'n3').attributes('style')).toMatch(/--tree-depth:\s*2/)
  })
})

describe('TreeNode: folder icon color parity with NavSidebarItem (OpenProject #3064)', () => {
  it("draws its folder icon muted (`slate-faint`), matching `NavSidebarItem.vue`'s own folder/page icon exactly", async () => {
    const wrapper = mountChainTree()
    await wrapper.vm.$nextTick()

    for (const id of ['n1', 'n2', 'n3']) {
      const icon = nodeWrapper(wrapper, id).find('.w-icon')
      expect(icon.classes(), `${id}'s folder icon`).toContain('text-slate-faint')
    }
  })
})
