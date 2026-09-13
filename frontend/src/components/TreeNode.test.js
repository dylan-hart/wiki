import { afterEach, describe, expect, it } from 'vitest'

import TreeNav from './TreeNav.vue'
import TreeNode from './TreeNode.vue'

import { isolateOnLeftClick, setIsolateOnLeftClick } from '@/composables/navIsolatePreference'

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

/**
 * OpenProject #3063 ("Bring File Manager tree click/keyboard behavior to parity with the main
 * navbar"): shift+click isolate, ctrl+click expand-cycle and keyboard activation -- ported from
 * `NavSidebarItem.vue`'s own click-handling (OpenProject #2847/#2848/#2890/#2909/#3057/#3062), but
 * over this component's flat `id -> node` map + `opened`/`loaded` state rather than the navbar's
 * nested item tree + shared expansion `Map`.
 *
 * `root` and `sibling` are pre-opened via `TreeNav`'s own exposed `setOpened` (there is no
 * `expandByDefault` prop here to seed it declaratively the way `NavSidebarItem.test.js` does), so a
 * test can observe `sibling` actually closing rather than merely never having opened. Every node
 * here carries a nested folder child of its own precisely so open/closed state has a visible
 * indicator with no children rendered either way to fall back on -- `TreeNode.vue`'s icon glyph
 * (`tabler:folder` vs `tabler:folder-open`, read off `WIcon`'s own `data-icon` attribute) rather
 * than DOM presence of content, unlike `NavSidebarItem.test.js`'s arrow-rotation check.
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

/** Whether a folder's own icon currently reads "open" -- `TreeNode.vue`'s own tell, since there is
 *  no arrow to read the way `NavSidebarItem.test.js` does. */
function isExpanded(wrapper, id) {
  return nodeWrapper(wrapper, id).find('.w-icon').attributes('data-icon') === 'tabler:folder-open'
}

/** Dispatches a real, bubbling click on a `.treeview-label` element with the given modifiers. */
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

/** A real, bubbling middle-click (`auxclick`, button 1) -- what this tree never listens for at all. */
function middleClick(element) {
  return element.dispatchEvent(
    new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  )
}

function labelEl(wrapper, id) {
  return nodeWrapper(wrapper, id).find('.treeview-label').element
}

// -> Every describe below that touches the toggle restores it to the documented OFF default
//    afterwards, so test order never leaks one suite's toggle state into the next.
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
    expect(isExpanded(wrapper, 'root')).toBe(true) // -> the clicked folder's own ancestor
    expect(isExpanded(wrapper, 'sibling')).toBe(false) // -> every other folder collapses
  })

  it('does not fire on a plain click (only shift+click isolates) -- the existing select/toggle stays unaffected', async () => {
    const wrapper = await mountIsolateTree()

    plainClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true) // -> the ordinary toggle still ran
    expect(isExpanded(wrapper, 'sibling')).toBe(true) // -> unaffected -- not isolated
  })

  it('no longer fires on a middle-click', async () => {
    const wrapper = await mountIsolateTree()

    middleClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(false) // -> unaffected
    expect(isExpanded(wrapper, 'sibling')).toBe(true) // -> unaffected
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

    expect(isExpanded(wrapper, 'sibling')).toBe(false) // -> closed, exactly as a left click would
    expect(isExpanded(wrapper, 'root')).toBe(true) // -> not isolated: no OTHER folder was touched
    expect(isExpanded(wrapper, 'target')).toBe(false) // -> already closed, still closed
  })
})

/**
 * OpenProject #3063: the profile toggle swaps which gesture isolates -- the exact mirror image of
 * the OFF-default suite above, over the same `ISOLATE_NODES`.
 */
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

    expect(isExpanded(wrapper, 'target')).toBe(true) // -> the ordinary toggle still ran
    expect(isExpanded(wrapper, 'sibling')).toBe(true) // -> unaffected -- not isolated
  })
})

/**
 * OpenProject #3063's own risk note: shift+click must not fight the existing ctrl+click
 * expand-cycle. Ctrl+click always wins and always cycles, regardless of shift or the toggle's value.
 */
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

    expect(isExpanded(wrapper, 'target')).toBe(true) // -> force-opened by the cycle, not isolation
    expect(isExpanded(wrapper, 'sibling')).toBe(true) // -> untouched: isolation never ran
  })

  it('still cycles with the isolate-on-left-click toggle ON', async () => {
    setIsolateOnLeftClick(true)
    const wrapper = await mountIsolateTree()

    ctrlClick(labelEl(wrapper, 'target'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'target')).toBe(true) // -> force-opened by the cycle
    expect(isExpanded(wrapper, 'sibling')).toBe(true) // -> untouched: isolation never ran even though ON
  })
})

/**
 * OpenProject #2847-equivalent for File Manager: ctrl+click cycles a folder's own descendant
 * folders between fully expanded and fully collapsed, and force-opens the clicked folder itself
 * (never toggled).
 */
const CYCLE_NODES = {
  root: { title: 'Root', children: ['branch', 'flatFolder'] },
  branch: { title: 'Branch', children: ['midA', 'midB'] },
  midA: { title: 'Mid A', children: [] },
  midB: { title: 'Mid B', children: [] },
  flatFolder: { title: 'Flat Folder', children: [] }
}

/**
 * Unlike `NavSidebarItem.vue`'s `WExpansionItem`, whose content is `v-show`-hidden rather than
 * unmounted (so a closed folder's descendants stay in the DOM the whole time), `TreeLevel`/
 * `TreeNode` render descendants with `v-if` -- a folder's children exist in the DOM at all only
 * once THAT folder is open. So `midA`/`midB` (branch's own children) cannot be inspected before
 * `branch` itself has been opened at least once; `midB` is pre-set open via `setOpened` anyway
 * (exercising the "not every descendant already open" cycle branch, rather than the trivial
 * all-closed case), it is just not independently OBSERVABLE via the DOM until branch's own click
 * mounts it.
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

    expect(isExpanded(wrapper, 'branch')).toBe(true) // -> force-opened
    expect(isExpanded(wrapper, 'midA')).toBe(true) // -> was closed, now expanded by the cycle
    expect(isExpanded(wrapper, 'midB')).toBe(true) // -> was already open (pre-set), stays open
    expect(isExpanded(wrapper, 'flatFolder')).toBe(false) // -> outside the clicked subtree, unaffected
  })

  it('collapses every descendant folder once all of them are open, while the clicked folder itself stays open', async () => {
    const wrapper = await mountCycleTree()

    ctrlClick(labelEl(wrapper, 'branch')) // -> first cycle: not all open yet, expands all
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'midA')).toBe(true)
    expect(isExpanded(wrapper, 'midB')).toBe(true)

    ctrlClick(labelEl(wrapper, 'branch')) // -> second cycle: all open now, collapses all
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'branch')).toBe(true) // -> the clicked folder itself stays open
    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(false)
  })

  it('a folder with no descendant folders still force-opens on ctrl+click, without disturbing a sibling subtree', async () => {
    const wrapper = await mountCycleTree()

    ctrlClick(labelEl(wrapper, 'flatFolder'))
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'flatFolder')).toBe(true)
    expect(isExpanded(wrapper, 'branch')).toBe(false) // -> unaffected sibling subtree
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
    expect(isExpanded(wrapper, 'l3')).toBe(true) // -> 3 levels below root
    // -> l4 is a 4th level below root, one level past the cap: it renders as a row (its own parent,
    //    l3, is now open) but the cycle never touched ITS state, so it stays closed -- a reader can
    //    ctrl+click again, on l3 or l4 itself, to keep expanding incrementally.
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

    expect(isExpanded(wrapper, 'target')).toBe(true) // -> the ordinary toggle ran
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
    expect(isExpanded(wrapper, 'sibling')).toBe(false) // -> isolated, not just toggled
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
