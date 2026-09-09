import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'

import NavSidebarItem from './NavSidebarItem.vue'
import WTooltip from './shared/WTooltip.vue'
import routes from '@/router/routes'
import { useProvideNavExpansionState } from '@/composables/navExpansionState'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Feature #2574/#2578: a `generated` (auto/mixed tree-walk) item's label is a deliberate override
 * of the tree row's own title when the site's path-display setting is on -- see
 * `NavSidebarItem.vue#displayLabel`'s own doc comment. A hand-authored `static` link (never
 * `generated`) always keeps its label, whatever the setting is, since it may not correspond to a
 * real path at all.
 */
async function mountItem(item, { pathDisplayCase, acronymMap } = {}) {
  const router = await createTestRouter(routes, '/')

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
      }
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
 * OpenProject #2826: a childless leaf `iconFor()` used to draw whenever `item.children?.length` was
 * falsy, which is also true of an empty or boundary folder (`generateFromTree` gives neither any
 * `children`) -- so both drew the page icon instead of the folder one. `item.isFolder` is what the
 * backend now surfaces to tell the two apart.
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

    // -> Simulates `w-expansion-item`'s own toggle emitting `update:modelValue` while staying
    //    uncontrolled -- see NavSidebarItem.vue's template comment on why this is never bound back.
    await wrapper.findComponent({ name: 'WExpansionItem' }).vm.$emit('update:modelValue', true)
    await wrapper.vm.$nextTick()

    expect(iconOf(wrapper)).toBe('tabler:folder-open')
  })
})

/**
 * OpenProject #2849: single-line ellipsis truncation + a tooltip shown ONLY when the label is
 * actually clipped -- `scrollWidth`/`clientWidth` reflect real CSS layout, which neither jsdom nor
 * happy-dom runs, so each case stubs both directly on the rendered label span (the same
 * `Object.defineProperty(el, 'offsetWidth', ...)` convention `anchoredFloat.test.js` uses) and
 * calls the exposed `checkTruncation()` in place of a `ResizeObserver` callback that would never
 * fire on its own here.
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
 * OpenProject #2848: middle-click a folder's header to isolate it -- open it plus its ancestor
 * chain, collapse every other folder in the whole tree. Mounted through a `Host` that provides the
 * shared expansion state itself (`useProvideNavExpansionState`, mirroring `NavSidebar.vue`), since a
 * standalone `NavSidebarItem` mount falls back to a fresh, UNSHARED map per instance -- the isolate
 * handler's writes to a nested folder's state would otherwise never reach that folder's own,
 * separate map. `siteStore.nav.items` is seeded with the same tree so the handler's whole-tree walk
 * has something real to read.
 *
 * `root` and `sibling` both start expanded (`expandByDefault: true`) so the test can observe
 * `sibling` actually closing and `root` staying open, rather than merely never having opened.
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

/** The rendered `NavSidebarItem` instance for one id, found among every recursive instance. */
function itemWrapper(wrapper, id) {
  return wrapper.findAllComponents(NavSidebarItem).find((w) => w.props('item').id === id)
}

/** Whether a folder's own arrow currently reads "open" -- `w-expansion-item`'s own tell, since its
 *  content is toggled by `v-show` rather than unmounted. */
function isExpanded(wrapper, id) {
  return itemWrapper(wrapper, id).find('.w-expansion-item__arrow').classes().includes('rotate-180')
}

/** Dispatches a real, bubbling middle-click (`auxclick`, button 1) on an element -- the same event a
 *  browser fires for a non-primary mouse button, never `click`. Returns `dispatchEvent`'s own
 *  boolean: `false` once something along the path called `preventDefault()`. */
function middleClick(element) {
  return element.dispatchEvent(
    new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  )
}

describe('NavSidebarItem: middle-click isolate (OpenProject #2848)', () => {
  it('opens the clicked folder and its ancestor chain, and collapses every sibling folder', async () => {
    const wrapper = await mountIsolateTree()
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'sibling')).toBe(true)

    const notPrevented = middleClick(
      itemWrapper(wrapper, 'target').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false) // -> preventDefault() was called
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'root')).toBe(true) // -> the clicked folder's own ancestor
    expect(isExpanded(wrapper, 'sibling')).toBe(false) // -> every other folder collapses
  })

  it('does not fire on a plain click (only a middle-click auxclick isolates)', async () => {
    const wrapper = await mountIsolateTree()

    itemWrapper(wrapper, 'target')
      .find('.w-expansion-item__header')
      .element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      )
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'sibling')).toBe(true) // -> unaffected
  })

  it('is scoped to the header row -- a middle-click on a nested leaf link does not isolate its parent folder, and does not preventDefault', async () => {
    const wrapper = await mountIsolateTree()

    const notPrevented = middleClick(itemWrapper(wrapper, 'sibling-leaf').element)
    await wrapper.vm.$nextTick()

    // -> Nothing along the bubble path (sibling's own folder, then root's) treated this as its own
    //    header being clicked, so the browser's native middle-click-opens-a-new-tab is left intact...
    expect(notPrevented).toBe(true)
    // -> ...and no folder's open/closed state changed as a side effect of the bubble.
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'root')).toBe(true)
  })

  it('a second isolate on a different folder re-collapses the first one', async () => {
    const wrapper = await mountIsolateTree()

    middleClick(itemWrapper(wrapper, 'target').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'target')).toBe(true)
    expect(isExpanded(wrapper, 'sibling')).toBe(false)

    middleClick(itemWrapper(wrapper, 'sibling').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'sibling')).toBe(true)
    expect(isExpanded(wrapper, 'target')).toBe(false)
    expect(isExpanded(wrapper, 'root')).toBe(true)
  })
})

/**
 * OpenProject #2847: ctrl+click a folder's header to cycle its own DESCENDANT folders between
 * fully expanded and fully collapsed -- the clicked folder's own open/closed state is deliberately
 * left untouched (Feature #2829's design section: "walk the clicked folder's own descendant
 * subtree"), so only `branch`/`midA`/`midB` below ever change from a ctrl+click on `branch`, never
 * `branch` itself.
 *
 * `midA` starts closed and `midB` starts open (`expandByDefault: true`) so a ctrl+click on `branch`
 * has a genuine mix to resolve ("not every descendant is open" -> expand all) before a second
 * ctrl+click has all of them open ("every descendant is open" -> collapse all). `midB` carries a
 * leaf-only child (`leafB`, no nested folder) so ctrl+clicking `midB` directly exercises the
 * "nothing to expand" no-op case, and doing so must not disturb `midA` -- which would only happen if
 * an ANCESTOR's capture handler (here `branch`'s, or `root`'s) wrongly treated the click as its own
 * rather than letting it travel inward to `midB`'s own instance.
 */
const CYCLE_TREE = [
  {
    id: 'root',
    label: 'Root Folder',
    expandByDefault: true,
    // -> `path` matters here, not just cosmetic: a folder item with neither `path` nor `target`
    //    falls back to `destination()`'s own `'/'` default, which -- since the test router starts
    //    at `/` -- would make `containsCurrent()` misread every such folder as "on the current
    //    page" and default it open. Every folder below carries a real `path`, the way a generated
    //    folder always does in production, so each one's initial open/closed state in these tests
    //    comes only from `expandByDefault`, not this fallback quirk.
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

/** Dispatches a real, bubbling, ctrl-held left click -- what a reader actually does to cycle a
 *  folder's subtree. */
function ctrlClick(element) {
  return element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
  )
}

/** A plain, bubbling left click with no modifier -- the ordinary single-folder toggle. */
function plainClick(element) {
  return element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  )
}

describe('NavSidebarItem: ctrl+click expand/collapse cycle (OpenProject #2847)', () => {
  it('expands every closed descendant folder when at least one is closed, leaving the clicked folder itself untouched', async () => {
    const wrapper = await mountCycleTree()
    expect(isExpanded(wrapper, 'branch')).toBe(false)
    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(true)

    const notPrevented = ctrlClick(
      itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false) // -> preventDefault() was called
    expect(isExpanded(wrapper, 'branch')).toBe(false) // -> the clicked folder's own state is untouched
    expect(isExpanded(wrapper, 'midA')).toBe(true)
    expect(isExpanded(wrapper, 'midB')).toBe(true)
    expect(isExpanded(wrapper, 'flatFolder')).toBe(false) // -> outside the clicked subtree, unaffected
  })

  it('collapses every descendant folder once all of them are open', async () => {
    const wrapper = await mountCycleTree()

    // -> First cycle opens midA (midB already open) -- see the test above.
    ctrlClick(itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()
    expect(isExpanded(wrapper, 'midA')).toBe(true)
    expect(isExpanded(wrapper, 'midB')).toBe(true)

    ctrlClick(itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'branch')).toBe(false) // -> still untouched by either cycle
    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(false)
  })

  it('does not fire on a plain click -- a plain click still only toggles the clicked row', async () => {
    const wrapper = await mountCycleTree()

    const notPrevented = plainClick(
      itemWrapper(wrapper, 'branch').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(true) // -> our handler never called preventDefault
    expect(isExpanded(wrapper, 'branch')).toBe(true) // -> the ordinary toggle still ran
    expect(isExpanded(wrapper, 'midA')).toBe(false) // -> untouched: this is a plain click, not a cycle
    expect(isExpanded(wrapper, 'midB')).toBe(true) // -> untouched (already open by default)
  })

  it('no-ops for a folder with no nested folder descendants, and still suppresses its own toggle', async () => {
    const wrapper = await mountCycleTree()

    const notPrevented = ctrlClick(
      itemWrapper(wrapper, 'flatFolder').find('.w-expansion-item__header').element
    )
    await wrapper.vm.$nextTick()

    expect(notPrevented).toBe(false) // -> still preventDefault()ed, even though there was nothing to cycle
    expect(isExpanded(wrapper, 'flatFolder')).toBe(false) // -> no plain-toggle fallback on a ctrl+click
  })

  it('is scoped to the clicked folder alone -- ctrl+clicking a deeper folder does not let an ancestor react instead', async () => {
    const wrapper = await mountCycleTree()

    // -> midB has only a leaf child, so this cycle has nothing to do -- but if `branch`'s (or
    //    `root`'s) capture handler wrongly claimed the click instead of letting it travel inward to
    //    midB's own instance, it would cycle midA too.
    ctrlClick(itemWrapper(wrapper, 'midB').find('.w-expansion-item__header').element)
    await wrapper.vm.$nextTick()

    expect(isExpanded(wrapper, 'midA')).toBe(false)
    expect(isExpanded(wrapper, 'midB')).toBe(true) // -> its own state untouched, same as before
    expect(isExpanded(wrapper, 'branch')).toBe(false)
  })
})
