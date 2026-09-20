import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import NavSidebarItem from './NavSidebarItem.vue'
import WTooltip from './shared/WTooltip.vue'
import routes from '@/router/routes'
import { useProvideNavExpansionState } from '@/composables/navExpansionState'
import { isolateOnLeftClick, setIsolateOnLeftClick } from '@/composables/navIsolatePreference'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

async function mountItem(
  item,
  { pathDisplayCase, acronymMap, initialPath = '/', selectedPath } = {}
) {
  const router = await createTestRouter(routes, initialPath)

  const { wrapper } = mountWithApp(NavSidebarItem, {
    props: { item },
    router,
    stores: {
      site: (store) => {
        if (pathDisplayCase !== undefined) {
          store.pathDisplayCase = pathDisplayCase
        }
        if (acronymMap !== undefined) {
          store.acronymMap = acronymMap
        }
      },
      ...(selectedPath !== undefined ? { graph: { selectedPath } } : {})
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('NavSidebarItem: leaf label', () => {
  it('renders item.label unchanged when the setting is off', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'USS Enterprise',
      path: 'uss-enterprise',
      generated: true,
      target: '/uss-enterprise'
    })

    expect(wrapper.text()).toContain('USS Enterprise')
  })

  it('renders item.label unchanged for a generated item when the setting is on but the item has no path', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'Hand Label', generated: true, target: '/x' },
      { pathDisplayCase: 'title' }
    )

    expect(wrapper.text()).toContain('Hand Label')
  })

  it('never humanizes a hand-authored (non-generated) link, even when the setting is on', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'Hand Authored Link', target: '/x' },
      { pathDisplayCase: 'title' }
    )

    expect(wrapper.text()).toContain('Hand Authored Link')
  })

  it('overrides a generated leaf item’s label with its humanized last path segment when the setting is on', async () => {
    const wrapper = await mountItem(
      {
        id: '1',
        type: 'link',
        label: 'Whatever The Tree Row Title Was',
        path: 'guides/uss-enterprise',
        generated: true,
        target: '/guides/uss-enterprise'
      },
      { pathDisplayCase: 'title', acronymMap: { uss: 'USS' } }
    )

    expect(wrapper.text()).toContain('USS Enterprise')
    expect(wrapper.text()).not.toContain('Whatever The Tree Row Title Was')
  })
})

describe('NavSidebarItem: folder (expansion header) label', () => {
  it('overrides a generated folder’s header label the same way a leaf item’s is overridden', async () => {
    const wrapper = await mountItem(
      {
        id: '1',
        type: 'link',
        label: 'Whatever The Folder Title Was',
        path: 'getting-started',
        generated: true,
        children: [
          { id: '2', type: 'link', label: 'Child', path: 'getting-started/child', generated: true }
        ]
      },
      { pathDisplayCase: 'upper' }
    )

    expect(wrapper.text()).toContain('GETTING-STARTED')
    expect(wrapper.text()).not.toContain('Whatever The Folder Title Was')
  })
})

/**
 * `generateFromTree` gives an empty or boundary folder no `children` at all, so `children?.length`
 * cannot tell one from a page -- `item.isFolder` is the only thing that can.
 */
describe('NavSidebarItem: folder vs. page icon', () => {
  function iconOf(wrapper) {
    return wrapper.findComponent({ name: 'WIcon' }).props('name')
  }

  it('draws the page icon for a genuine leaf page item', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'A Page',
      path: 'a-page',
      generated: true,
      target: '/a-page'
    })

    expect(iconOf(wrapper)).toBe('tabler:file-text')
  })

  it('draws the folder icon for an empty (childless) folder item marked isFolder', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'Empty Folder',
      path: 'empty-folder',
      generated: true,
      isFolder: true
    })

    expect(iconOf(wrapper)).toBe('tabler:folder')
  })

  it('draws the folder icon for a folder item that does have children', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'Folder With Children',
      path: 'folder-with-children',
      generated: true,
      isFolder: true,
      children: [{ id: '2', type: 'link', label: 'Child', target: '/folder-with-children/child' }]
    })

    expect(iconOf(wrapper)).toBe('tabler:folder')
  })

  it('an explicit item.icon always wins over the folder/page inference', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'Custom Icon Folder',
      path: 'custom-icon-folder',
      generated: true,
      isFolder: true,
      icon: 'mdi:star',
      children: [{ id: '2', type: 'link', label: 'Child', target: '/custom-icon-folder/child' }]
    })

    expect(iconOf(wrapper)).toBe('mdi:star')
  })

  it('swaps to the folder-open icon once the expansion item reports itself open', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'Folder With Children',
      path: 'folder-with-children',
      generated: true,
      isFolder: true,
      children: [{ id: '2', type: 'link', label: 'Child', target: '/folder-with-children/child' }]
    })

    expect(iconOf(wrapper)).toBe('tabler:folder')

    // -> `w-expansion-item` is left uncontrolled here, so its open state only ever arrives as this
    //    emit; there is nothing bound back to drive from the outside.
    await wrapper.findComponent({ name: 'WExpansionItem' }).vm.$emit('update:modelValue', true)
    await wrapper.vm.$nextTick()

    expect(iconOf(wrapper)).toBe('tabler:folder-open')
  })
})

/**
 * `scrollWidth`/`clientWidth` reflect real CSS layout, which happy-dom does not run, so each case
 * stubs both on the label span and calls `checkTruncation()` in place of a `ResizeObserver`
 * callback that would never fire here.
 */
describe('NavSidebarItem: label truncation tooltip', () => {
  function stubWidths(wrapper, { scrollWidth, clientWidth }) {
    const label = wrapper.get('span.truncate').element
    Object.defineProperty(label, 'scrollWidth', { value: scrollWidth, configurable: true })
    Object.defineProperty(label, 'clientWidth', { value: clientWidth, configurable: true })
  }

  it('renders no tooltip for a leaf item whose label is not clipped', async () => {
    const wrapper = await mountItem({ id: '1', type: 'link', label: 'Short', target: '/x' })

    stubWidths(wrapper, { scrollWidth: 80, clientWidth: 80 })
    wrapper.vm.checkTruncation()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(WTooltip).exists()).toBe(false)
  })

  it('renders a tooltip for a leaf item whose label is clipped', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'A Very Long Page Title That Does Not Fit In The Sidebar',
      target: '/x'
    })

    stubWidths(wrapper, { scrollWidth: 400, clientWidth: 120 })
    wrapper.vm.checkTruncation()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(WTooltip).exists()).toBe(true)
  })

  it('renders no tooltip for a folder header label that is not clipped', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'Short Folder',
      children: [{ id: '2', type: 'link', label: 'Child', target: '/child' }]
    })

    stubWidths(wrapper, { scrollWidth: 80, clientWidth: 80 })
    wrapper.vm.checkTruncation()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(WTooltip).exists()).toBe(false)
  })

  it('renders a tooltip for a folder header label that is clipped', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'A Very Long Folder Title That Does Not Fit In The Sidebar',
      children: [{ id: '2', type: 'link', label: 'Child', target: '/child' }]
    })

    stubWidths(wrapper, { scrollWidth: 400, clientWidth: 120 })
    wrapper.vm.checkTruncation()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(WTooltip).exists()).toBe(true)
  })

  it('re-hides the tooltip once the label no longer needs clipping', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'A Very Long Page Title That Does Not Fit In The Sidebar',
      target: '/x'
    })

    stubWidths(wrapper, { scrollWidth: 400, clientWidth: 120 })
    wrapper.vm.checkTruncation()
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(WTooltip).exists()).toBe(true)

    stubWidths(wrapper, { scrollWidth: 120, clientWidth: 120 })
    wrapper.vm.checkTruncation()
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(WTooltip).exists()).toBe(false)
  })
})

/**
 * Mounted through a `Host` that provides the shared expansion state itself, mirroring
 * `NavSidebar.vue`: a standalone `NavSidebarItem` mount falls back to a fresh, UNSHARED map per
 * instance, so the isolate handler's writes would never reach a nested folder's own map.
 * `siteStore.nav.items` carries the same tree because the handler walks it.
 *
 * `root` and `sibling` start expanded so the test can observe `sibling` actually closing and
 * `root` staying open, rather than merely never having opened.
 */
const ISOLATE_TREE = [
  {
    id: 'root',
    label: 'Root Folder',
    expandByDefault: true,
    children: [
      {
        id: 'target',
        label: 'Target Folder',
        children: [{ id: 'target-leaf', label: 'Target Leaf', target: '/target-leaf' }]
      },
      {
        id: 'sibling',
        label: 'Sibling Folder',
        expandByDefault: true,
        children: [{ id: 'sibling-leaf', label: 'Sibling Leaf', target: '/sibling-leaf' }]
      }
    ]
  }
]

async function mountIsolateTree() {
  const Host = defineComponent({
    name: 'IsolateTestHost',
    setup() {
      useProvideNavExpansionState()
      return () => h(NavSidebarItem, { item: ISOLATE_TREE[0] })
    }
  })

  const router = await createTestRouter(routes, '/')
  const { wrapper } = mountWithApp(Host, {
    router,
    stores: {
      site: (store) => {
        store.nav.items = ISOLATE_TREE
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

function itemWrapper(wrapper, id) {
  return wrapper.findAllComponents(NavSidebarItem).find((w) => w.props('item').id === id)
}

/** Read off the arrow, not the content's presence: `w-expansion-item` toggles with `v-show`. */
function isExpanded(wrapper, id) {
  return itemWrapper(wrapper, id).find('.w-expansion-item__arrow').classes().includes('rotate-180')
}

/** `auxclick` because a browser never fires `click` for a non-primary button. Like every dispatch
 *  helper here, returns `dispatchEvent`'s boolean: `false` once something called `preventDefault`. */
function middleClick(element) {
  return element.dispatchEvent(
    new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  )
}

function shiftClick(element) {
  return element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true })
  )
}

// -> The toggle is persisted in localStorage, which outlives a test: reset it or suite order leaks.
afterEach(() => {
  setIsolateOnLeftClick(false)
})

describe('NavSidebarItem: shift+click isolate (OpenProject #2848/#3062), toggle OFF (default)', () => {
  it('the isolate-on-left-click toggle defaults to OFF', () => {
    expect(isolateOnLeftClick()).toBe(false)
  })

  it('opens the clicked folder and its ancestor chain, and collapses every sibling folder', async () => {
    const wrapper = await mountIsolateTree()
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)

    const notPrevented = shiftClick(
      itemWrapper(wrapper, 'target').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false)
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'root')).toBe(true) // -> the clicked folder's own ancestor
    expect(isExpanded(wrapper, 'sibling')).toBe(false)
  })

  it('does not fire on a plain click (only shift+click isolates)', async () => {
    const wrapper = await mountIsolateTree()

    itemWrapper(wrapper, 'target')
      .find('.w-expansion-item__header')
      .element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      )
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })

  it('no longer fires on a middle-click (OpenProject #3062: middle-click isolation was retired)', async () => {
    const wrapper = await mountIsolateTree()

    const notPrevented = middleClick(
      itemWrapper(wrapper, 'target').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })

  it('is scoped to the header row -- a shift+click on a nested leaf link does not isolate its parent folder, and does not preventDefault', async () => {
    const wrapper = await mountIsolateTree()

    const notPrevented = shiftClick(itemWrapper(wrapper, 'sibling-leaf').element)
    await wrapper.vm.$nextTick()

    // -> No listener on the capture path (root's, then sibling's) claimed this click as its own
    //    header, so native handling ran and no folder's state changed.
    expect(notPrevented).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'root')).toBe(true)
  })

  it('a second isolate on a different folder re-collapses the first one', async () => {
    const wrapper = await mountIsolateTree()

    shiftClick(itemWrapper(wrapper, 'target').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)

    shiftClick(itemWrapper(wrapper, 'sibling').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'root')).toBe(true)
  })

  it('shift-clicking an already-open folder just closes it, like a plain left click -- no isolation', async () => {
    const wrapper = await mountIsolateTree()
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
    expect(isExpanded(wrapper, 'root')).toBe(true)

    const notPrevented = shiftClick(
      itemWrapper(wrapper, 'sibling').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)
    expect(isExpanded(wrapper, 'root')).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(false)
  })
})

describe('NavSidebarItem: isolate-on-left-click toggle ON', () => {
  it('a bare left-click isolates the clicked folder and its ancestor chain', async () => {
    setIsolateOnLeftClick(true)
    const wrapper = await mountIsolateTree()
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)

    const notPrevented = itemWrapper(wrapper, 'target')
      .find('.w-expansion-item__header')
      .element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false)
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'root')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)
  })

  it('shift+click instead behaves as the regular open/close toggle -- no isolation', async () => {
    setIsolateOnLeftClick(true)
    const wrapper = await mountIsolateTree()

    const notPrevented = shiftClick(
      itemWrapper(wrapper, 'target').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })
})

describe('NavSidebarItem: ctrl+click takes priority over shift+click isolate', () => {
  it('ctrl+shift+click on a folder cycles its descendants rather than isolating it', async () => {
    const wrapper = await mountIsolateTree()
    // -> `target` has only a leaf child, so the cycle has nothing to open below it and shows up
    //    solely as `target` force-opening. Had shift won instead, `sibling` would have collapsed.
    const notPrevented = itemWrapper(wrapper, 'target')
      .find('.w-expansion-item__header')
      .element.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: true,
          shiftKey: true
        })
      )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false)
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })

  it('still cycles with the isolate-on-left-click toggle ON', async () => {
    setIsolateOnLeftClick(true)
    const wrapper = await mountIsolateTree()

    const notPrevented = itemWrapper(wrapper, 'target')
      .find('.w-expansion-item__header')
      .element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
      )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false)
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
  })
})

/**
 * Shaped so each half of the cycle has something real to resolve: `midA` starts closed and `midB`
 * open, so a first ctrl+click on `branch` sees a mix ("not all open" -> expand all) and a second
 * sees them all open ("all open" -> collapse all). `midB`'s only child is a leaf, so ctrl+clicking
 * `midB` itself exercises "nothing to cycle, still force-open the clicked folder" -- and must
 * leave `midA` alone, which it only would not if an ancestor's capture handler wrongly claimed the
 * click instead of letting it reach `midB`'s own instance.
 */
const CYCLE_TREE = [
  {
    id: 'root',
    label: 'Root Folder',
    expandByDefault: true,
    // -> Every folder needs a real `path`: with neither `path` nor `target`, `destination()`
    //    falls back to `'/'`, and since the test router starts there `containsCurrent()` would
    //    misread the folder as current and default it open, masking `expandByDefault`.
    path: 'root',
    children: [
      {
        id: 'branch',
        label: 'Branch Folder',
        path: 'root/branch',
        children: [
          {
            id: 'midA',
            label: 'Mid A',
            path: 'root/branch/mid-a',
            children: [{ id: 'leafA', label: 'Leaf A', target: '/leaf-a' }]
          },
          {
            id: 'midB',
            label: 'Mid B',
            path: 'root/branch/mid-b',
            expandByDefault: true,
            children: [{ id: 'leafB', label: 'Leaf B', target: '/leaf-b' }]
          }
        ]
      },
      {
        id: 'flatFolder',
        label: 'Flat Folder',
        path: 'root/flat-folder',
        children: [{ id: 'flatLeaf', label: 'Flat Leaf', target: '/flat-leaf' }]
      }
    ]
  }
]

async function mountCycleTree() {
  const Host = defineComponent({
    name: 'CycleTestHost',
    setup() {
      useProvideNavExpansionState()
      return () => h(NavSidebarItem, { item: CYCLE_TREE[0] })
    }
  })

  const router = await createTestRouter(routes, '/')
  const { wrapper } = mountWithApp(Host, {
    router,
    stores: {
      site: (store) => {
        store.nav.items = CYCLE_TREE
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

function ctrlClick(element) {
  return element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
  )
}

function plainClick(element) {
  return element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  )
}

describe('NavSidebarItem: ctrl+click expand/collapse cycle (OpenProject #2847)', () => {
  it('expands every closed descendant folder when at least one is closed, and force-opens the clicked folder itself', async () => {
    const wrapper = await mountCycleTree()
    expect(isExpanded(wrapper, 'branch')).toBe(false)
    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(true)

    const notPrevented = ctrlClick(
      itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false)
    expect(isExpanded(wrapper, 'branch')).toBe(true)
    expect(isExpanded(wrapper, 'midA')).toBe(true)
    expect(isExpanded(wrapper, 'midB')).toBe(true)
    expect(isExpanded(wrapper, 'flatFolder')).toBe(false) // -> outside the clicked subtree
  })

  it('collapses every descendant folder once all of them are open, while the clicked folder itself stays open', async () => {
    const wrapper = await mountCycleTree()

    ctrlClick(itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'midA')).toBe(true)
    expect(isExpanded(wrapper, 'midB')).toBe(true)

    ctrlClick(itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'branch')).toBe(true)
    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(false)
  })

  it('does not fire on a plain click -- a plain click still only toggles the clicked row', async () => {
    const wrapper = await mountCycleTree()

    const notPrevented = plainClick(
      itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(true)
    expect(isExpanded(wrapper, 'branch')).toBe(true)
    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(true) // -> open by default, so unchanged either way
  })

  it('force-opens a folder with no nested folder descendants instead of being a no-op (OpenProject #2890)', async () => {
    const wrapper = await mountCycleTree()
    expect(isExpanded(wrapper, 'flatFolder')).toBe(false)

    const notPrevented = ctrlClick(
      itemWrapper(wrapper, 'flatFolder').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false)
    expect(isExpanded(wrapper, 'flatFolder')).toBe(true)
  })

  it('is scoped to the clicked folder alone -- ctrl+clicking a deeper folder does not let an ancestor react instead', async () => {
    const wrapper = await mountCycleTree()

    // -> midB's own cycle has nothing to do (leaf child only), so the only way any of these could
    //    change is an ancestor's capture handler claiming the click instead of letting it reach it.
    ctrlClick(itemWrapper(wrapper, 'midB').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(true)
    expect(isExpanded(wrapper, 'branch')).toBe(false)
  })
})

/**
 * Six folders deep, so ctrl+click's 3-levels-below cap has something to cut off. Every folder
 * starts closed and every one has a folder child, so an uncapped walk would open the whole chain.
 */
const DEEP_CHAIN_TREE = [
  {
    id: 'deepRoot',
    label: 'Deep Root',
    path: 'deep-root',
    children: [
      {
        id: 'deepL1',
        label: 'Deep L1',
        path: 'deep-root/l1',
        children: [
          {
            id: 'deepL2',
            label: 'Deep L2',
            path: 'deep-root/l1/l2',
            children: [
              {
                id: 'deepL3',
                label: 'Deep L3',
                path: 'deep-root/l1/l2/l3',
                children: [
                  {
                    id: 'deepL4',
                    label: 'Deep L4',
                    path: 'deep-root/l1/l2/l3/l4',
                    children: [
                      {
                        id: 'deepL5',
                        label: 'Deep L5',
                        path: 'deep-root/l1/l2/l3/l4/l5',
                        children: [{ id: 'deepLeaf', label: 'Deep Leaf', target: '/deep-leaf' }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
]

async function mountDeepChainTree() {
  const Host = defineComponent({
    name: 'DeepChainTestHost',
    setup() {
      useProvideNavExpansionState()
      return () => h(NavSidebarItem, { item: DEEP_CHAIN_TREE[0] })
    }
  })

  const router = await createTestRouter(routes, '/')
  const { wrapper } = mountWithApp(Host, {
    router,
    stores: {
      site: (store) => {
        store.nav.items = DEEP_CHAIN_TREE
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('NavSidebarItem: ctrl+click expand-all is capped to 3 levels below the clicked node (OpenProject #2909)', () => {
  it('expands only the first 3 levels below the clicked node, leaving deeper folders collapsed', async () => {
    const wrapper = await mountDeepChainTree()

    ctrlClick(itemWrapper(wrapper, 'deepRoot').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'deepRoot')).toBe(true)
    expect(isExpanded(wrapper, 'deepL1')).toBe(true)
    expect(isExpanded(wrapper, 'deepL2')).toBe(true)
    expect(isExpanded(wrapper, 'deepL3')).toBe(true)
    expect(isExpanded(wrapper, 'deepL4')).toBe(false)
    expect(isExpanded(wrapper, 'deepL5')).toBe(false)
  })

  it('caps relative to the CLICKED node, not the overall tree root -- clicking 1 level down still reaches 3 further levels', async () => {
    const wrapper = await mountDeepChainTree()

    // -> deepL1 sits 1 level below the tree root, so a cap measured from the root would stop at
    //    deepL3; measured from the clicked node it has to reach deepL4.
    ctrlClick(itemWrapper(wrapper, 'deepL1').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'deepL1')).toBe(true)
    expect(isExpanded(wrapper, 'deepL2')).toBe(true) // -> 1 level below deepL1
    expect(isExpanded(wrapper, 'deepL3')).toBe(true) // -> 2 levels below deepL1
    expect(isExpanded(wrapper, 'deepL4')).toBe(true) // -> 3 levels below deepL1, the last inside the cap
    expect(isExpanded(wrapper, 'deepL5')).toBe(false) // -> 4 levels below deepL1, past it
    expect(isExpanded(wrapper, 'deepRoot')).toBe(false) // -> the clicked node's own ancestor
  })
})

/**
 * Mounted on a real router at `/_graph?path=...` so `reanchorGraphOnFolder()` reads a genuine
 * `/_graph` route rather than a stub.
 */
const GRAPH_TREE = [
  {
    id: 'docs',
    label: 'Docs',
    path: 'docs',
    children: [{ id: 'docs-leaf', label: 'Setup', path: 'docs/setup', target: '/docs/setup' }]
  }
]

async function mountGraphTree(initialPath) {
  const Host = defineComponent({
    name: 'GraphTestHost',
    setup() {
      useProvideNavExpansionState()
      return () => h(NavSidebarItem, { item: GRAPH_TREE[0] })
    }
  })

  const router = await createTestRouter(routes, initialPath)
  const { wrapper } = mountWithApp(Host, {
    router,
    stores: {
      site: (store) => {
        store.nav.items = GRAPH_TREE
      }
    }
  })
  await wrapper.vm.$nextTick()
  return { wrapper, router }
}

describe('NavSidebarItem: plain click on a populated folder re-anchors the graph (OpenProject #3353)', () => {
  it('toggles expand/collapse AND replaces the route query while /_graph is open', async () => {
    const { wrapper, router } = await mountGraphTree('/_graph?path=other/page')
    const replaceSpy = vi.spyOn(router, 'replace')
    expect(isExpanded(wrapper, 'docs')).toBe(false)

    plainClick(itemWrapper(wrapper, 'docs').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'docs')).toBe(true)
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: 'docs' } })
  })

  it('toggling closed again still no-ops the router once already the active anchor', async () => {
    const { wrapper, router } = await mountGraphTree('/_graph?path=docs')
    const replaceSpy = vi.spyOn(router, 'replace')

    plainClick(itemWrapper(wrapper, 'docs').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'docs')).toBe(true)
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('does not touch the router outside /_graph -- plain click still only toggles', async () => {
    const { wrapper, router } = await mountGraphTree('/')
    const replaceSpy = vi.spyOn(router, 'replace')

    plainClick(itemWrapper(wrapper, 'docs').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'docs')).toBe(true)
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('never binds a navigable `to`/`href` on the folder header -- ctrl/shift clicks still only toggle or isolate', async () => {
    const { wrapper, router } = await mountGraphTree('/_graph?path=other/page')
    const replaceSpy = vi.spyOn(router, 'replace')

    const header = itemWrapper(wrapper, 'docs').find('.w-expansion-item__header').element
    header.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    )
    await wrapper.vm.$nextTick()
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(isExpanded(wrapper, 'docs')).toBe(true)
  })
})

/**
 * Covers the prop threading and the `--nav-depth` style it drives, NOT the dot geometry that style
 * feeds: real background-image tiling needs a layout engine, so `NavSidebar.test.js` asserts that
 * half in Chromium.
 */
describe('NavSidebarItem: depth prop (OpenProject #2932)', () => {
  it('starts at 0 for the row mounted directly (no depth passed), and increments by exactly 1 per recursive level', async () => {
    const wrapper = await mountDeepChainTree()

    expect(itemWrapper(wrapper, 'deepRoot').props('depth')).toBe(0)
    expect(itemWrapper(wrapper, 'deepL1').props('depth')).toBe(1)
    expect(itemWrapper(wrapper, 'deepL2').props('depth')).toBe(2)
    expect(itemWrapper(wrapper, 'deepL3').props('depth')).toBe(3)
    expect(itemWrapper(wrapper, 'deepL4').props('depth')).toBe(4)
    expect(itemWrapper(wrapper, 'deepL5').props('depth')).toBe(5)
    // -> `deepLeaf` renders through the leaf `<w-item>` branch, not `<w-expansion-item>`, so the
    //    increment is covered on both branches.
    expect(itemWrapper(wrapper, 'deepLeaf').props('depth')).toBe(6)
  })

  it("sets the depth it was passed as the row's own `--nav-depth` inline style, on both the folder and leaf branches", async () => {
    const wrapper = await mountDeepChainTree()

    // -> Folder branch: attrs-fallthrough lands the style on `.w-expansion-item`, not on the header
    //    row nested inside it, which picks the custom property up by ordinary inheritance.
    const deepL2Style = itemWrapper(wrapper, 'deepL2').find('.w-expansion-item').attributes('style')
    expect(deepL2Style).toMatch(/--nav-depth:\s*2/)

    const leafStyle = itemWrapper(wrapper, 'deepLeaf').find('.w-item').attributes('style')
    expect(leafStyle).toMatch(/--nav-depth:\s*6/)
  })
})

describe('NavSidebarItem: graph anchor indicator (OpenProject #3362/#3365)', () => {
  it('marks a leaf item as the anchor when its path matches the graph anchor query', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'A Page', path: 'docs/setup', target: '/docs/setup' },
      { initialPath: '/_graph?path=docs/setup' }
    )

    expect(wrapper.get('.w-item').classes()).toContain('is-graph-anchor')
  })

  it('does not mark a leaf item whose path is not the current graph anchor', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'A Page', path: 'other', target: '/other' },
      { initialPath: '/_graph?path=docs/setup' }
    )

    expect(wrapper.get('.w-item').classes()).not.toContain('is-graph-anchor')
  })

  it('does not mark a leaf item as the anchor outside /_graph, even with a matching path', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'A Page', path: 'docs/setup', target: '/docs/setup' },
      { initialPath: '/some/page' }
    )

    expect(wrapper.get('.w-item').classes()).not.toContain('is-graph-anchor')
  })

  it('marks a populated folder as the anchor when its own path matches the graph anchor query', async () => {
    const wrapper = await mountItem(
      {
        id: '1',
        type: 'link',
        label: 'Docs Folder',
        path: 'docs',
        isFolder: true,
        children: [{ id: '2', type: 'link', label: 'Child', target: '/docs/child' }]
      },
      { initialPath: '/_graph?path=docs' }
    )

    expect(wrapper.get('.w-expansion-item').classes()).toContain('is-graph-anchor')
  })

  it('does not mark a populated folder whose path is not the current graph anchor', async () => {
    const wrapper = await mountItem(
      {
        id: '1',
        type: 'link',
        label: 'Docs Folder',
        path: 'docs',
        isFolder: true,
        children: [{ id: '2', type: 'link', label: 'Child', target: '/docs/child' }]
      },
      { initialPath: '/_graph?path=other' }
    )

    expect(wrapper.get('.w-expansion-item').classes()).not.toContain('is-graph-anchor')
  })
})

describe('NavSidebarItem: graph selection indicator (OpenProject #3364)', () => {
  it('marks a leaf item as selected when its path matches the graph selection', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'A Page', path: 'docs/setup', target: '/docs/setup' },
      { initialPath: '/_graph', selectedPath: 'docs/setup' }
    )

    expect(wrapper.get('.w-item').classes()).toContain('is-graph-selected')
  })

  it('does not mark a leaf item whose path is not the current graph selection', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'A Page', path: 'other', target: '/other' },
      { initialPath: '/_graph', selectedPath: 'docs/setup' }
    )

    expect(wrapper.get('.w-item').classes()).not.toContain('is-graph-selected')
  })

  it('does not mark a leaf item as selected outside /_graph, even with a matching path', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'A Page', path: 'docs/setup', target: '/docs/setup' },
      { initialPath: '/some/page', selectedPath: 'docs/setup' }
    )

    expect(wrapper.get('.w-item').classes()).not.toContain('is-graph-selected')
  })

  /*
   * Structural, not conditional: the expansion-item branch binds no `isSelected` class at all, so
   * selection reaches only leaf rows, the same reach `.router-link-exact-active` has. That also
   * leaves "anchor trumps selected" unexercised here -- the class is absent either way.
   */
  it('never marks a populated folder as selected, even when its own path matches the graph selection', async () => {
    const wrapper = await mountItem(
      {
        id: '1',
        type: 'link',
        label: 'Docs Folder',
        path: 'docs',
        isFolder: true,
        children: [{ id: '2', type: 'link', label: 'Child', target: '/docs/child' }]
      },
      { initialPath: '/_graph', selectedPath: 'docs' }
    )

    expect(wrapper.get('.w-expansion-item').classes()).not.toContain('is-graph-selected')
  })

  it('does not mark a leaf item as selected on /_graph with nothing selected', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'A Page', path: 'docs/setup', target: '/docs/setup' },
      { initialPath: '/_graph' }
    )

    expect(wrapper.get('.w-item').classes()).not.toContain('is-graph-selected')
  })
})
