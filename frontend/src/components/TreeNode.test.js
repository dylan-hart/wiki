import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import TreeNav from './TreeNav.vue'
import TreeNode from './TreeNode.vue'

import { isolateOnLeftClick, setIsolateOnLeftClick } from '@/composables/navIsolatePreference'

import { mountWithApp } from '../../test/mount.js'

/**
 * The rendered depth-cue dot geometry (a `background-image` tiled per lane) needs a real layout
 * engine and is deliberately not asserted here -- only the `--tree-depth` property driving it and
 * the icon color. `TreeNav.indentation.test.js` scans the stylesheet for the geometry instead.
 */

const CHAIN_NODES = {
  n1: { title: 'Folder A', children: ['n2'] },
  n2: { title: 'Folder B', children: ['n3'] },
  n3: { title: 'Folder C', children: [] }
}

/**
 * `selected: 'n3'` makes `TreeNav.vue`'s `onMounted` auto-expand n3's ancestor chain, which is what
 * gets n2 and n3 into the DOM at all without a manual toggle click first.
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

/**
 * `root` and `sibling` are pre-opened via `setOpened` (there is no `expandByDefault` prop here), so
 * a test can observe `sibling` actually closing rather than merely never having opened. Every node
 * carries a nested folder child so open/closed state has a visible tell -- the folder icon glyph,
 * since a childless row renders identically either way.
 */
const ISOLATE_NODES = {
  root: { title: 'Root', children: ['target', 'sibling'] },
  target: { title: 'Target', children: ['target-child'] },
  'target-child': { title: 'Target Child', children: [] },
  sibling: { title: 'Sibling', children: ['sibling-child'] },
  'sibling-child': { title: 'Sibling Child', children: [] }
}

async function mountIsolateTree() {
  const wrapper = mountWithApp(TreeNav, {
    props: { nodes: ISOLATE_NODES, roots: ['root'] }
  }).wrapper
  wrapper.vm.setOpened('root')
  wrapper.vm.setOpened('sibling')
  await wrapper.vm.$nextTick()
  return wrapper
}

function isExpanded(wrapper, id) {
  return nodeWrapper(wrapper, id).find('.w-icon').attributes('data-icon') === 'tabler:folder-open'
}

function labelClick(element, modifiers = {}) {
  return element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...modifiers })
  )
}

function shiftClick(element) {
  return labelClick(element, { shiftKey: true })
}
function ctrlClick(element) {
  return labelClick(element, { ctrlKey: true })
}
function plainClick(element) {
  return labelClick(element)
}

function middleClick(element) {
  return element.dispatchEvent(
    new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  )
}

function labelEl(wrapper, id) {
  return nodeWrapper(wrapper, id).find('.treeview-label').element
}

// -> The toggle is module-level state, not per-test: reset it so order never leaks it forward.
afterEach(() => {
  setIsolateOnLeftClick(false)
})

describe('TreeNode: shift+click isolate (OpenProject #3063), toggle OFF (default)', () => {
  it('the isolate-on-left-click toggle defaults to OFF', () => {
    expect(isolateOnLeftClick()).toBe(false)
  })

  it('opens the clicked folder and its ancestor chain, and collapses every other known folder', async () => {
    const wrapper = await mountIsolateTree()
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)

    shiftClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'root')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)
  })

  it('does not fire on a plain click (only shift+click isolates) -- the existing select/toggle stays unaffected', async () => {
    const wrapper = await mountIsolateTree()

    plainClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })

  it('no longer fires on a middle-click', async () => {
    const wrapper = await mountIsolateTree()

    middleClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })

  it('a second isolate on a different folder re-collapses the first one', async () => {
    const wrapper = await mountIsolateTree()

    shiftClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)

    shiftClick(labelEl(wrapper, 'sibling'))
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'root')).toBe(true)
  })

  it('shift-clicking an already-open folder just closes it, like a plain left click -- no isolation', async () => {
    const wrapper = await mountIsolateTree()
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
    expect(isExpanded(wrapper, 'root')).toBe(true)

    shiftClick(labelEl(wrapper, 'sibling'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'sibling')).toBe(false)
    expect(isExpanded(wrapper, 'root')).toBe(true) // -> not isolated: no OTHER folder was touched
    expect(isExpanded(wrapper, 'target')).toBe(false)
  })
})

describe('TreeNode: isolate-on-left-click toggle ON', () => {
  it('a bare left-click isolates the clicked folder and its ancestor chain', async () => {
    setIsolateOnLeftClick(true)
    const wrapper = await mountIsolateTree()
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)

    plainClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'root')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)
  })

  it('shift+click instead behaves as the regular open/close toggle -- no isolation', async () => {
    setIsolateOnLeftClick(true)
    const wrapper = await mountIsolateTree()

    shiftClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })
})

describe('TreeNode: ctrl+click takes priority over shift+click isolate', () => {
  it('ctrl+shift+click on a folder cycles its descendants rather than isolating it', async () => {
    const wrapper = await mountIsolateTree()

    labelEl(wrapper, 'target').dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: true,
        shiftKey: true
      })
    )
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })

  it('still cycles with the isolate-on-left-click toggle ON', async () => {
    setIsolateOnLeftClick(true)
    const wrapper = await mountIsolateTree()

    ctrlClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })
})

const CYCLE_NODES = {
  root: { title: 'Root', children: ['branch', 'flatFolder'] },
  branch: { title: 'Branch', children: ['midA', 'midB'] },
  midA: { title: 'Mid A', children: [] },
  midB: { title: 'Mid B', children: [] },
  flatFolder: { title: 'Flat Folder', children: [] }
}

/**
 * `TreeLevel`/`TreeNode` render descendants with `v-if`, so a folder's children are in the DOM only
 * while that folder is open: `midA`/`midB` cannot be inspected before `branch` has been opened
 * once. `midB` is pre-set open so the cycle's "not every descendant already open" branch runs
 * rather than the trivial all-closed case.
 */
async function mountCycleTree() {
  const wrapper = mountWithApp(TreeNav, { props: { nodes: CYCLE_NODES, roots: ['root'] } }).wrapper
  wrapper.vm.setOpened('root')
  wrapper.vm.setOpened('midB')
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('TreeNode: ctrl+click expand/collapse cycle', () => {
  it('expands every closed descendant folder when at least one is closed, and force-opens the clicked folder itself', async () => {
    const wrapper = await mountCycleTree()
    expect(isExpanded(wrapper, 'branch')).toBe(false)

    ctrlClick(labelEl(wrapper, 'branch'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'branch')).toBe(true)
    expect(isExpanded(wrapper, 'midA')).toBe(true)
    expect(isExpanded(wrapper, 'midB')).toBe(true) // -> pre-set open, left alone by the cycle
    expect(isExpanded(wrapper, 'flatFolder')).toBe(false) // -> outside the clicked subtree
  })

  it('collapses every descendant folder once all of them are open, while the clicked folder itself stays open', async () => {
    const wrapper = await mountCycleTree()

    ctrlClick(labelEl(wrapper, 'branch')) // -> first cycle: not all open yet, expands all
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'midA')).toBe(true)
    expect(isExpanded(wrapper, 'midB')).toBe(true)

    ctrlClick(labelEl(wrapper, 'branch')) // -> second cycle: all open now, collapses all
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'branch')).toBe(true)
    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(false)
  })

  it('a folder with no descendant folders still force-opens on ctrl+click, without disturbing a sibling subtree', async () => {
    const wrapper = await mountCycleTree()

    ctrlClick(labelEl(wrapper, 'flatFolder'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'flatFolder')).toBe(true)
    expect(isExpanded(wrapper, 'branch')).toBe(false)
  })
})

describe('TreeNode: ctrl+click expand-cycle depth cap', () => {
  it('does not reach past 3 levels below the clicked node', async () => {
    const deepNodes = {
      root: { title: 'Root', children: ['l1'] },
      l1: { title: 'L1', children: ['l2'] },
      l2: { title: 'L2', children: ['l3'] },
      l3: { title: 'L3', children: ['l4'] },
      l4: { title: 'L4', children: [] }
    }
    const wrapper = mountWithApp(TreeNav, { props: { nodes: deepNodes, roots: ['root'] } }).wrapper
    wrapper.vm.setOpened('root')
    await wrapper.vm.$nextTick()

    ctrlClick(labelEl(wrapper, 'root'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'root')).toBe(true)
    expect(isExpanded(wrapper, 'l1')).toBe(true)
    expect(isExpanded(wrapper, 'l2')).toBe(true)
    expect(isExpanded(wrapper, 'l3')).toBe(true) // -> 3 levels below root, the cap
    // -> l4 is one level past the cap: it renders (l3 is open) but the cycle never touched its own
    //    state, so it stays closed.
    expect(isExpanded(wrapper, 'l4')).toBe(false)
  })
})

describe('TreeNode: keyboard activation (OpenProject #3063)', () => {
  it('is a keyboard-operable button -- focusable, with an accessible role', async () => {
    const wrapper = await mountIsolateTree()
    const label = labelEl(wrapper, 'target')

    expect(label.getAttribute('tabindex')).toBe('0')
    expect(label.getAttribute('role')).toBe('button')
  })

  it('Enter activates the row exactly like a plain click', async () => {
    const wrapper = await mountIsolateTree()

    labelEl(wrapper, 'target').dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
    )
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
  })

  it('a held shift key on Enter isolates, exactly like shift+click', async () => {
    const wrapper = await mountIsolateTree()

    labelEl(wrapper, 'target').dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        shiftKey: true
      })
    )
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)
  })

  it('Space is treated the same as Enter, and does not scroll the page', async () => {
    const wrapper = await mountIsolateTree()
    const label = labelEl(wrapper, 'target')

    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' })
    const notPrevented = label.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false) // -> preventDefault() was called
    expect(isExpanded(wrapper, 'target')).toBe(true)
  })

  it('ignores every other key', async () => {
    const wrapper = await mountIsolateTree()

    labelEl(wrapper, 'target').dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a' })
    )
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(false)
  })
})

/**
 * A transition's enter/leave classes exist only mid-flight, and jsdom runs no real CSS
 * transitions to catch them there, so the absence of a wrapper is checked against the template
 * source rather than the rendered DOM.
 */
describe('TreeNode: no expand/collapse transition wrapper (OpenProject #3090)', () => {
  it('does not wrap its sub-level in a <transition>, matching the main navbar', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'TreeNode.vue'),
      'utf-8'
    )

    expect(source).not.toMatch(/<transition\b/)
  })
})
