import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import NavSidebar from './NavSidebar.vue'
import NavSidebarItem from './NavSidebarItem.vue'
import PageNewMenu from './PageNewMenu.vue'
import BlueprintIcon from './BlueprintIcon.vue'
import routes from '@/router/routes'
import { useSiteStore } from '@/stores/site'
import { usePageStore } from '@/stores/page'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { openDialogs } from '@/composables/dialog'

/**
 * Task 466 (feature 362): verify -- rather than assume -- every combination `destination()` feeds
 * through `routableHref()`, plus `isCurrent()`/`containsCurrent()` against a trailing-slash variant
 * and a page reached via a redirect. See `composables/navSidebarDestination.js`'s own comments (moved
 * there from this component under OpenProject #814, once a nav item's rendering became recursive) for
 * the intent each case is checked against.
 *
 * `WItem` is stubbed so a test reads exactly what `destination()` handed it (`to` vs `href`/`target`)
 * rather than re-deriving that from the rendered `<a>`'s `href` attribute, which coincides for some
 * cases (a routed page path and its non-routed fallback resolve to the same string) and would hide
 * the very distinction under test -- "routed by vue-router" vs "a plain anchor" IS the `to`-vs-`href`
 * choice `destination()` makes.
 */
const CapturingWItem = {
  name: 'CapturingWItem',
  props: ['to', 'href', 'target'],
  template: '<div :data-to="to" :data-href="href" :data-target="target"><slot /></div>'
}

async function mountNav(items, { path = '/' } = {}) {
  const router = await createTestRouter(routes, path)

  const { wrapper } = mountWithApp(NavSidebar, {
    messages: { common: { sidebar: { browse: 'Browse' } } },
    router,
    stores: {
      site: (store) => {
        store.nav.items = items
      }
    },
    components: { 'w-item': CapturingWItem }
  })
  await wrapper.vm.$nextTick()
  return { wrapper, router }
}

/** The stubbed row whose label matches, however deep it is nested. */
function rowFor(wrapper, label) {
  const row = wrapper.findAllComponents(CapturingWItem).find((w) => w.text().includes(label))
  if (!row) {
    throw new Error(`no rendered row for label "${label}"`)
  }
  return row
}

describe('NavSidebar destination()', () => {
  // -> One flat link per case; mounted once and read back per assertion below.
  const CASES = [
    {
      label: 'Same-origin page',
      target: '/target-page',
      // -> Routed: same origin, https, not a server path, not the page already open
      expect: { to: '/target-page' }
    },
    {
      label: 'External https URL',
      target: 'https://example.org/x',
      // -> Declined: another origin -- goes out as the author wrote it, a plain browser navigation
      expect: { href: 'https://example.org/x' }
    },
    {
      label: 'mailto link',
      target: 'mailto:hello@example.org',
      /*
        `mailto:` fails `routableHref`'s `/^https?:$/` check, so this falls through to the
        non-routable branch -- and is explicitly on `SAFE_TARGET_PROTOCOLS` there, so it still comes
        out as a plain `href` rather than being refused the way `javascript:` now is below. Verified
        rather than assumed -- see `destination()`'s JSDoc for where this is now documented.
      */
      expect: { href: 'mailto:hello@example.org' }
    },
    {
      label: 'tel link',
      target: 'tel:+15555550100',
      expect: { href: 'tel:+15555550100' }
    },
    {
      label: 'javascript: scheme',
      target: 'javascript:alert(1)',
      /*
        OpenProject #2208 §3: refused outright, `{}` -- neither `to` nor `href` -- rather than the old
        behavior of handing it out verbatim as a plain anchor's `href`. Vue does not sanitize a
        dynamically bound `href`, so that used to mean a `site:navigation` holder (a delegated,
        non-administrator permission) could plant script that ran for any reader who clicked the row.
        Refused regardless of `openInNewWindow` too -- see `blocked` below.
      */
      expect: {},
      blocked: true
    },
    {
      label: 'data: scheme',
      target: 'data:text/html,<script>alert(1)</script>',
      expect: {},
      blocked: true
    },
    {
      label: 'Files download',
      target: '/_files/report.pdf',
      // -> A server path: declined, so it downloads as a plain navigation rather than 404ing in the SPA
      expect: { href: '/_files/report.pdf' }
    },
    {
      label: 'Static asset',
      target: '/_assets/logo.png',
      expect: { href: '/_assets/logo.png' }
    },
    {
      label: 'In-page heading',
      target: '#section-two',
      // -> Same page (both sides read off `location`), different fragment: a native browser jump
      expect: { href: '#section-two' }
    },
    {
      label: 'Bare domain without protocol',
      target: 'example.com',
      /*
        The edge case task 466 calls out by name: typed without a scheme, `new URL('example.com',
        location.href)` resolves it as a PATH relative to the current page, same-origin -- exactly
        how a plain `<a href="example.com">` behaves in any HTML document, this app's own rendered
        page content included (`routableHref`'s whole reason for being the same function in both
        places). Not a NavSidebar bug: fixing it would mean heuristically guessing "looks like a
        domain", which the doc comment already declines to do for content links, and doing it only
        for nav items would make the two inconsistent. Locked in here as the documented,
        author's-responsibility behavior `destination()`'s JSDoc now calls out explicitly.
      */
      expect: { to: '/example.com' }
    }
  ]

  const items = CASES.flatMap(({ label, target }, i) => [
    { id: `${i}-off`, type: 'link', icon: 'mdi:link', label, target, openInNewWindow: false },
    {
      id: `${i}-on`,
      type: 'link',
      icon: 'mdi:link',
      label: `${label} (new tab)`,
      target,
      openInNewWindow: true
    }
  ])

  it.each(CASES)(
    '$label, openInNewWindow off: routed as documented',
    async ({ label, expect: exp }) => {
      const { wrapper } = await mountNav(items)
      const row = rowFor(wrapper, label)
      if (exp.to) {
        expect(row.props('to')).toBe(exp.to)
        expect(row.props('href')).toBeFalsy()
        expect(row.props('target')).toBeFalsy()
      } else {
        expect(row.props('href')).toBe(exp.href)
        expect(row.props('to')).toBeFalsy()
        expect(row.props('target')).toBeFalsy()
      }
    }
  )

  it.each(CASES)(
    '$label, openInNewWindow on: always a plain anchor targeting _blank (unless the scheme is refused)',
    async ({ label, target, blocked }) => {
      const { wrapper } = await mountNav(items)
      const row = rowFor(wrapper, `${label} (new tab)`)
      /*
        `routableHref` declines any `target` other than `_self` on principle -- a new tab is the
        browser's context to open, not the router's to swap in -- so `openInNewWindow` always wins
        out to a plain `href`/`target="_blank"` pair, for every category above except a refused
        scheme (`javascript:`, `data:`): that one stays refused regardless of window mode, since a
        new tab is still this app's `<a>` binding the click runs through.
      */
      expect(row.props('to')).toBeFalsy()
      if (blocked) {
        expect(row.props('href')).toBeFalsy()
        expect(row.props('target')).toBeFalsy()
      } else {
        expect(row.props('href')).toBe(target)
        expect(row.props('target')).toBe('_blank')
      }
    }
  )
})

describe('NavSidebar isCurrent()/containsCurrent()', () => {
  it('does not treat a trailing-slash nav target as the current page', async () => {
    /*
      `router.resolve()` does not normalize a trailing slash: `/foo/bar` and `/foo/bar/` resolve to
      different `.path` values (confirmed directly against this app's real routes -- the catch-all
      `/:catchAll(.*)*` captures a trailing empty segment as part of the match). So `isCurrent()`
      -- which asks the router rather than comparing strings, exactly so a real ambiguity like a
      redirect or an escaped character is settled the way a click would settle it -- correctly
      reports "not current" here: the two addresses genuinely are different pages to the router, not
      an ambiguity it silently gets right. This is an authoring concern (don't type a trailing
      slash into a nav target), not a bug in `isCurrent()` -- confirmed here rather than assumed.
    */
    const items = [
      {
        id: 'group',
        type: 'link',
        icon: 'mdi:folder',
        label: 'Group',
        children: [
          {
            id: 'child',
            type: 'link',
            icon: 'mdi:link',
            label: 'Trailing slash child',
            target: '/foo/bar/'
          }
        ]
      }
    ]
    const { wrapper } = await mountNav(items, { path: '/foo/bar' })

    const header = wrapper.find('.w-expansion-item__header')
    expect(header.attributes('aria-expanded')).toBe('false')
  })

  it('does treat an exact-path nav target as current, trailing slash and all', async () => {
    // -> Sanity check for the case above: when the router target genuinely IS the current page
    //    (slash for slash), the group opens.
    const items = [
      {
        id: 'group',
        type: 'link',
        icon: 'mdi:folder',
        label: 'Group',
        children: [
          {
            id: 'child',
            type: 'link',
            icon: 'mdi:link',
            label: 'Matching child',
            target: '/foo/bar/'
          }
        ]
      }
    ]
    const { wrapper } = await mountNav(items, { path: '/foo/bar/' })

    const header = wrapper.find('.w-expansion-item__header')
    expect(header.attributes('aria-expanded')).toBe('true')
  })

  it('tracks a page reached via an alias redirect, by construction', async () => {
    /*
      A reader can arrive at a page through `/a/:alias`, whose `beforeEnter` guard resolves the
      alias and redirects to the page's real path -- confirmed directly (not assumed) that
      `router.currentRoute.value.path` ends up as that REAL path once the redirect has settled, not
      the alias address that was typed into the URL bar. A nav item addressing the real page path --
      the only address the navigation editor's picker can ever produce, since it targets pages by
      their actual path -- therefore tracks correctly with no special-casing: `isCurrent()` resolves
      the same real path through the same router and the two agree.
    */
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ id: 1, path: 'actual/page' })
    })

    const items = [
      {
        id: 'group',
        type: 'link',
        icon: 'mdi:folder',
        label: 'Group',
        children: [
          {
            id: 'child',
            type: 'link',
            icon: 'mdi:link',
            label: 'Real page',
            target: '/actual/page'
          }
        ]
      }
    ]
    const { wrapper } = await mountNav(items, { path: '/a/some-alias' })

    const header = wrapper.find('.w-expansion-item__header')
    expect(header.attributes('aria-expanded')).toBe('true')
  })
})

/**
 * The row for a given label may not be a `CapturingWItem` -- an intermediate depth is a
 * `w-expansion-item` header, not a leaf `w-item` -- so this reads the header directly off the DOM
 * rather than through `rowFor()`'s component-tree search.
 */
function headerFor(wrapper, label) {
  const header = wrapper.findAll('.w-expansion-item__header').find((h) => h.text().includes(label))
  if (!header) {
    throw new Error(`no rendered expansion header for label "${label}"`)
  }
  return header
}

/**
 * OpenProject #814: automatic (tree-based) navigation only rendered one level of nested folders --
 * `NavSidebar.vue`'s template drew a top-level group's children as plain, non-recursive `w-item`s
 * with no check for a grandchild's own `children`, so anything past the second level was silently
 * dropped even though `generateFromTree()` on the backend returns it. `NavSidebarItem.vue` now
 * renders itself once per nesting level, which is what these cases exercise: a leaf four levels
 * deep (one level further than the fix strictly needs, to leave a margin past the old two-level
 * ceiling) must actually reach the DOM, and every ancestor group along the way must still
 * auto-open for it, not only the top-level one the old template happened to handle.
 */
describe('NavSidebar recursive nesting (OpenProject #814)', () => {
  const deepTree = [
    {
      id: 'level-0',
      type: 'link',
      icon: 'mdi:folder',
      label: 'Level 0',
      children: [
        {
          id: 'level-1',
          type: 'link',
          icon: 'mdi:folder',
          label: 'Level 1',
          children: [
            {
              id: 'level-2',
              type: 'link',
              icon: 'mdi:folder',
              label: 'Level 2',
              children: [
                {
                  id: 'level-3-leaf',
                  type: 'link',
                  icon: 'mdi:file',
                  label: 'Level 3 leaf',
                  target: '/deep/page'
                }
              ]
            }
          ]
        }
      ]
    }
  ]

  it('renders a leaf nested three groups deep, past the old two-level ceiling', async () => {
    const { wrapper } = await mountNav(deepTree)

    expect(rowFor(wrapper, 'Level 3 leaf').exists()).toBe(true)
  })

  it('auto-opens every ancestor group down to a deep current page, not only the top level', async () => {
    const { wrapper } = await mountNav(deepTree, { path: '/deep/page' })

    expect(headerFor(wrapper, 'Level 0').attributes('aria-expanded')).toBe('true')
    expect(headerFor(wrapper, 'Level 1').attributes('aria-expanded')).toBe('true')
    expect(headerFor(wrapper, 'Level 2').attributes('aria-expanded')).toBe('true')
  })

  it('leaves every ancestor group closed when nothing in its subtree is the current page', async () => {
    const { wrapper } = await mountNav(deepTree, { path: '/elsewhere' })

    expect(headerFor(wrapper, 'Level 0').attributes('aria-expanded')).toBe('false')
    expect(headerFor(wrapper, 'Level 1').attributes('aria-expanded')).toBe('false')
    expect(headerFor(wrapper, 'Level 2').attributes('aria-expanded')).toBe('false')
  })

  it('honors expandByDefault at a nested (non-top-level) group, not only at the root', async () => {
    const items = [
      {
        id: 'top',
        type: 'link',
        icon: 'mdi:folder',
        label: 'Top',
        // -> Not expandByDefault and not containing the current page: stays closed
        children: [
          {
            id: 'nested',
            type: 'link',
            icon: 'mdi:folder',
            label: 'Nested',
            expandByDefault: true,
            children: [
              {
                id: 'nested-leaf',
                type: 'link',
                icon: 'mdi:file',
                label: 'Nested leaf',
                target: '/somewhere/else'
              }
            ]
          }
        ]
      }
    ]
    const { wrapper } = await mountNav(items, { path: '/not-a-match' })

    expect(headerFor(wrapper, 'Top').attributes('aria-expanded')).toBe('false')
    expect(headerFor(wrapper, 'Nested').attributes('aria-expanded')).toBe('true')
  })
})

/**
 * OpenProject #832 (upstream discussion #5311): a folder whose direct children mix a page (a leaf,
 * no `children`) alongside a sub-folder (its own `children`) didn't render its nested content
 * correctly, unlike the OpenProject #814 cases above -- every one of which chains a SINGLE child
 * per level, so a folder's `children` array there is always uniform (one link, or one link with its
 * own nested single child). That shape never exercises two DIFFERENT item kinds as siblings under
 * the same parent, which is exactly what a real generated menu produces once a folder holds both
 * pages of its own and sub-folders (`generateFromTree`'s `compareFoldersFirst` sorts folders before
 * pages, but does not stop a folder from holding both at once).
 *
 * `NavSidebarItem.vue` has no special-casing by item kind -- every child is handed to a fresh
 * recursive `<nav-sidebar-item>` and each one independently decides `w-expansion-item` vs. plain
 * `w-item` off its OWN `children.length` -- so this is confirmed correct here rather than assumed
 * safe merely because the deep-chain cases above pass.
 */
describe('NavSidebar mixed folder/page side-tree (OpenProject #832)', () => {
  const mixedTree = [
    {
      id: 'parent-folder',
      type: 'link',
      icon: 'mdi:folder',
      label: 'Parent Folder',
      children: [
        {
          id: 'direct-page',
          type: 'link',
          icon: 'mdi:file',
          label: 'Direct Page',
          target: '/parent-folder/direct-page'
        },
        {
          id: 'sub-folder',
          type: 'link',
          icon: 'mdi:folder',
          label: 'Sub Folder',
          children: [
            {
              id: 'nested-page',
              type: 'link',
              icon: 'mdi:file',
              label: 'Nested Page',
              target: '/parent-folder/sub-folder/nested-page'
            }
          ]
        }
      ]
    }
  ]

  it('renders a direct page sibling alongside a direct sub-folder sibling', async () => {
    const { wrapper } = await mountNav(mixedTree)

    // -> The page child is a leaf row, not an expansion header
    expect(rowFor(wrapper, 'Direct Page').exists()).toBe(true)
    // -> The folder child is an expansion header, not a leaf row
    expect(headerFor(wrapper, 'Sub Folder')).toBeTruthy()
  })

  it("renders the sub-folder's own nested page, not just the folder header", async () => {
    const { wrapper } = await mountNav(mixedTree)

    expect(rowFor(wrapper, 'Nested Page').exists()).toBe(true)
  })

  it('auto-opens only the sub-folder branch that holds the current page, leaving the page sibling unaffected', async () => {
    const { wrapper } = await mountNav(mixedTree, {
      path: '/parent-folder/sub-folder/nested-page'
    })

    expect(headerFor(wrapper, 'Parent Folder').attributes('aria-expanded')).toBe('true')
    expect(headerFor(wrapper, 'Sub Folder').attributes('aria-expanded')).toBe('true')
  })

  it('leaves the sub-folder branch closed when the current page is its direct-page sibling instead', async () => {
    const { wrapper } = await mountNav(mixedTree, { path: '/parent-folder/direct-page' })

    expect(headerFor(wrapper, 'Parent Folder').attributes('aria-expanded')).toBe('true')
    expect(headerFor(wrapper, 'Sub Folder').attributes('aria-expanded')).toBe('false')
  })
})

describe('NavSidebarItem context menu', () => {
  function generatedTree() {
    return [
      {
        id: 'folder-1',
        type: 'link',
        icon: 'mdi:folder',
        label: 'Docs',
        path: 'docs',
        folderId: null,
        generated: true,
        children: [
          {
            id: 'page-1',
            type: 'link',
            icon: 'mdi:file',
            label: 'Setup',
            path: 'docs/setup',
            folderId: 'folder-1',
            target: '/docs/setup',
            generated: true
          }
        ]
      }
    ]
  }

  async function mountWithPermission(items, canWrite, { path = '/' } = {}) {
    const router = await createTestRouter(routes, path)
    const { wrapper } = mountWithApp(NavSidebar, {
      messages: { common: { sidebar: { browse: 'Browse' } } },
      router,
      stores: {
        site: (store) => {
          store.nav.items = items
        },
        user: (store) => {
          store.permissions = canWrite ? ['write:pages'] : []
        }
      }
    })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('renders a PageNewMenu on a generated item when the viewer can write pages', async () => {
    const wrapper = await mountWithPermission(generatedTree(), true)
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(true)
  })

  it('renders no PageNewMenu when the viewer cannot write pages', async () => {
    const wrapper = await mountWithPermission(generatedTree(), false)
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })

  it('renders no PageNewMenu on a non-generated (static) item, even when the viewer can write pages', async () => {
    const staticItems = [
      { id: 'static-1', type: 'link', icon: 'mdi:link', label: 'Static Link', target: '/somewhere' }
    ]
    const wrapper = await mountWithPermission(staticItems, true)
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })

  it('resolves basePath/parentId for a folder item as "create inside it"', async () => {
    const wrapper = await mountWithPermission(generatedTree(), true)
    const folderMenu = wrapper.findComponent(PageNewMenu)
    expect(folderMenu.props('basePath')).toBe('docs')
  })

  it('resolves basePath for a page item as "create as a sibling", scoped to its own PageNewMenu', async () => {
    /*
      For a DIRECT child, "create inside the folder" and "create as a sibling of the page" both
      resolve to the same string ('docs') -- by design, since a direct child's sibling folder IS
      its parent. Matching on that string alone across every rendered PageNewMenu would therefore
      pass even if the PAGE item's own `basePathFor` were broken (e.g. returned `undefined`), since
      the FOLDER's own menu already produces the same value. Scoped instead to the specific
      `NavSidebarItem` instance backing `page-1` (the leaf, not its `folder-1` ancestor) and its
      own `PageNewMenu`, so this only passes if that leaf's own computation is correct.
    */
    const wrapper = await mountWithPermission(generatedTree(), true, { path: '/docs/setup' })

    const pageItem = wrapper
      .findAllComponents(NavSidebarItem)
      .find((w) => w.props('item').id === 'page-1')
    expect(pageItem).toBeTruthy()

    const pageMenu = pageItem.findComponent(PageNewMenu)
    expect(pageMenu.exists()).toBe(true)
    expect(pageMenu.props('basePath')).toBe('docs')
  })

  it('resolves parentId for a folder\'s own "new folder" action as the folder\'s own id', async () => {
    const wrapper = await mountWithPermission(generatedTree(), true)
    const folderItem = wrapper
      .findAllComponents(NavSidebarItem)
      .find((w) => w.props('item').id === 'folder-1')
    const folderMenu = folderItem.findComponent(PageNewMenu)

    openDialogs.length = 0
    await folderMenu.vm.$emit('new-folder')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toEqual({ parentId: 'folder-1' })
  })

  it('resolves parentId for a page\'s own "new folder" action as the page\'s containing folderId', async () => {
    const wrapper = await mountWithPermission(generatedTree(), true, { path: '/docs/setup' })

    const pageItem = wrapper
      .findAllComponents(NavSidebarItem)
      .find((w) => w.props('item').id === 'page-1')
    const pageMenu = pageItem.findComponent(PageNewMenu)

    openDialogs.length = 0
    await pageMenu.vm.$emit('new-folder')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toEqual({ parentId: 'folder-1' })
  })

  /*
    Final whole-branch review, Finding 3: a tree entry with its own navigation override
    (`navigationMode` of `override`/`overrideExact`) is a FOLDER, but `generateFromTree`
    (`backend/models/navigation.ts`) deliberately gives it no `children` in the payload -- its own
    subtree is a separate menu, not walked into. The old `item.children?.length > 0` discriminator
    misclassified a boundary folder like this as a leaf/page, computing "create as a sibling"
    instead of "create inside it". A generated PAGE item always carries `target` (only
    `row.type === 'page'` rows get one); a generated FOLDER item -- boundary or not -- never does,
    so `!item.target` is the correct discriminator for both cases. Simulated here with the exact
    shape `generateFromTree` emits for a boundary folder: `generated: true`, no `target`, no
    `children`.
  */
  it('resolves basePath/parentId for a boundary folder (own nav override, no children in the payload) as "create inside it"', async () => {
    const boundaryItems = [
      {
        id: 'boundary-1',
        type: 'link',
        icon: 'mdi:folder',
        label: 'Boundary Folder',
        path: 'boundary',
        folderId: null,
        generated: true
      }
    ]
    const wrapper = await mountWithPermission(boundaryItems, true)

    const menu = wrapper.findComponent(PageNewMenu)
    expect(menu.exists()).toBe(true)
    expect(menu.props('basePath')).toBe('boundary')

    openDialogs.length = 0
    await menu.vm.$emit('new-folder')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toEqual({ parentId: 'boundary-1' })
  })

  /*
    Final whole-branch review, Finding 5: every test above that exercises "New Folder" fires
    `PageNewMenu`'s `new-folder` event directly (`.vm.$emit('new-folder')`), which proves the WIRING
    (event handler -> dialog-open path) works but never proves the menu item itself is actually
    rendered and clickable -- exactly the class of bug Finding 1 was (`show-new-folder` never passed
    at any of the three call sites, so the item never rendered at all, yet every existing test still
    passed). This one mounts the real component tree, finds the actual rendered "New Folder" row by
    its resolved i18n label, and clicks it for real.

    `WMenu` is stubbed to always render its slot -- the same stub `PageNewMenu.test.js`'s own suite
    uses -- because its real open/close gating (a genuine `contextmenu` DOM event, teleported
    content) is `WMenu`'s own concern, covered by its own suite and by `PageNewMenu.test.js`'s
    "forwards the contextMenu prop" case; what this test cares about is whether "New Folder" is
    actually PRESENT once the menu is open.
  */
  it('clicks the real rendered "New Folder" row (not just the emit) to open the create-folder dialog', async () => {
    const router = await createTestRouter(routes, '/')
    const { wrapper } = mountWithApp(NavSidebar, {
      messages: {
        common: {
          sidebar: { browse: 'Browse' },
          actions: { newFolder: 'New Folder' }
        }
      },
      router,
      components: { BlueprintIcon },
      stores: {
        site: (store) => {
          store.nav.items = generatedTree()
        },
        user: (store) => {
          store.permissions = ['write:pages']
        }
      },
      stubs: { teleport: true, WMenu: { template: '<div><slot /></div>' } }
    })
    await wrapper.vm.$nextTick()

    const folderItem = wrapper
      .findAllComponents(NavSidebarItem)
      .find((w) => w.props('item').id === 'folder-1')
    expect(folderItem).toBeTruthy()

    /*
      Scoped to folder-1's own header row (`.w-expansion-item__header`), not `folderItem`'s whole
      subtree: that subtree also contains page-1's own nested row and ITS OWN "New Folder" item
      (both rendered inside `folderItem`'s `<w-list>` of children), and -- purely by coincidence in
      this fixture -- a direct child's `folderId` ('folder-1') equals its parent folder's own `id`
      ('folder-1'), so a search too broad to tell the two apart would still pass even if THIS
      finding's own fix regressed. Matched on the row's own EXACT text, not `.includes()`, for the
      same reason: `.w-item` nests (the header's own outer `w-item` wraps the whole menu), so a
      substring match would find that ancestor first -- its aggregated text contains "New Folder"
      too, as part of a much longer string alongside every other menu item's label.
    */
    const header = folderItem.find('.w-expansion-item__header')
    expect(header.exists()).toBe(true)
    const newFolderRow = header.findAll('.w-item').find((row) => row.text() === 'New Folder')
    expect(newFolderRow).toBeTruthy()

    openDialogs.length = 0
    await newFolderRow.trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toEqual({ parentId: 'folder-1' })
  })
})

describe('NavSidebar empty-space context menu', () => {
  async function mountRoot({
    mode = 'static',
    canWrite = true,
    rootPath = '',
    rootId = null
  } = {}) {
    const router = await createTestRouter(routes, '/')
    const { wrapper } = mountWithApp(NavSidebar, {
      messages: { common: { sidebar: { browse: 'Browse' } } },
      router,
      stores: {
        site: (store) => {
          store.nav.items = []
          store.nav.mode = mode
          store.nav.rootPath = rootPath
          store.nav.rootId = rootId
        },
        user: (store) => {
          store.permissions = canWrite ? ['write:pages'] : []
        }
      }
    })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('offers a root-level create menu when the resolved mode is auto', async () => {
    const wrapper = await mountRoot({ mode: 'auto' })
    const menu = wrapper.findComponent(PageNewMenu)
    expect(menu.exists()).toBe(true)
    expect(menu.props('basePath')).toBe('')
  })

  it('offers a root-level create menu when the resolved mode is mixed', async () => {
    const wrapper = await mountRoot({ mode: 'mixed' })
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(true)
  })

  it('offers no root-level create menu on a static menu -- nothing to create "into"', async () => {
    const wrapper = await mountRoot({ mode: 'static' })
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })

  it('offers no root-level create menu when the viewer cannot write pages', async () => {
    const wrapper = await mountRoot({ mode: 'auto', canWrite: false })
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })

  /**
   * OpenProject #2442: for a page/folder-level navigation override, the resolved menu's generator
   * root is that override's own section, not the locale root -- so this action's `base-path` must
   * follow `siteStore.nav.rootPath` (whatever the API resolved it to for THIS menu) rather than
   * always being the empty, site-wide-menu root the old hardcoded `base-path=""` assumed.
   */
  it("targets the resolved menu's own generator root, not always the locale root", async () => {
    const wrapper = await mountRoot({ mode: 'auto', rootPath: 'docs/section', rootId: 'section-1' })
    const menu = wrapper.findComponent(PageNewMenu)
    expect(menu.props('basePath')).toBe('docs/section')

    openDialogs.length = 0
    await menu.vm.$emit('new-folder')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toEqual({ parentId: 'section-1' })
  })

  it("still targets the site root when the resolved menu's own root IS the site root", async () => {
    const wrapper = await mountRoot({ mode: 'auto' })

    openDialogs.length = 0
    await wrapper.findComponent(PageNewMenu).vm.$emit('new-folder')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toEqual({ parentId: null })
  })
})
/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721. Mounting at all is
 * itself a meaningful check: this component's `<style lang="scss">` was rewritten from physical
 * `left`/`right`/`border-left` declarations to logical `inset-inline-*`/`border-inline-*` ones (the
 * current-page bar and the open-group rail), and Vite's Sass pipeline would fail the whole render on
 * a malformed declaration -- a compile error here, not a failed assertion, is what would catch a
 * typo in that rewrite.
 *
 * The actual mirroring under `dir="rtl"` cannot be asserted from here: happy-dom's CSS engine does
 * not resolve logical properties against `direction` the way a real layout engine does (verified
 * separately, against real Chromium, while making this change -- see the task's notes). What IS
 * asserted here is that `sidebarPosition` reaches this component's markup not at all any more: the
 * one thing it used to drive (the current-page notch's edge) is now an accent bar on the reader's
 * own starting edge, which is pure CSS and a different axis entirely.
 */
async function mountSidebar(sidebarPosition) {
  const router = await createTestRouter(['/'])

  return mountWithApp(NavSidebar, {
    messages: { common: { sidebar: { browse: 'Browse' } } },
    router,
    stores: {
      site: (store) => {
        store.theme.sidebarPosition = sidebarPosition
      }
    }
  }).wrapper
}

/**
 * OpenProject #1630 (task 1640): the primary navigation had no `<nav>` element and no accessible
 * name at all, so it was unreachable through the landmarks rotor and indistinguishable from
 * `PageToc`'s own `<nav>` even if it had been one. `common.sidebar.browse` ("Browse") is the label
 * the fix's own spec names, already used elsewhere in this sidebar for the tree-browser button.
 */
describe('NavSidebar landmark', () => {
  it('wraps the nav list in a named <nav> landmark', async () => {
    const router = await createTestRouter(['/'])

    // -> A real message this time (`mountSidebar`'s own harness intentionally leaves `en` empty,
    //    since none of ITS assertions read a translated string) -- vue-i18n returns the bare key
    //    for a missing one, and this test needs the resolved label.

    const { wrapper } = mountWithApp(NavSidebar, {
      messages: { 'common.sidebar.browse': 'Browse' },
      router
    })
    await wrapper.vm.$nextTick()

    const nav = wrapper.find('nav')
    expect(nav.exists()).toBe(true)
    expect(nav.attributes('aria-label')).toBe('Browse')
    // -> The list itself lives INSIDE the landmark, not merely beside it
    expect(nav.find('.sidebar-nav-list').exists()).toBe(true)
  })
})

/**
 * OpenProject #2527: loading or refreshing directly on a non-content `MainLayout` route (the
 * knowledge graph, tags browse) used to leave the sidebar expanded but permanently empty, because the
 * nav-loading watcher only ever read `pageStore.navigationId` -- which those routes never set (only
 * `pageStore.pageLoad()` does, and neither route calls it) -- so `siteStore.fetchNavigation(null)`
 * silently no-opped forever. Fixed by falling back to `siteStore.navigationId` (the site's own
 * default menu id, carried on the bootstrap/site payload) whenever the current route is not one of
 * the three that resolve a page-inherited id (`route.meta.contentPage`, `router/routes.js`).
 *
 * Real routes from the app's own route table drive each case, matching `MainLayout.test.js`'s own
 * `mountLayout` convention, since the bug is precisely about which routes carry `meta.contentPage`.
 */
describe('NavSidebar navigationId fallback (OpenProject #2527)', () => {
  async function mountAt(path, { site } = {}) {
    const router = await createTestRouter(routes, path)
    const { wrapper } = mountWithApp(NavSidebar, {
      messages: { common: { sidebar: { browse: 'Browse' } } },
      router,
      stores: {
        site: (store) => {
          store.id = 'site-1'
          if (site) {
            Object.assign(store, site)
          }
        }
      }
    })
    await wrapper.vm.$nextTick()
    return { wrapper, router }
  }

  it('loads the site default navigation on a non-content route with no page-inherited id (the graph)', async () => {
    await mountAt('/_graph', { site: { navigationId: 'site-default-nav' } })

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/site-default-nav')
  })

  it('loads the site default navigation on a non-content route (tags browse)', async () => {
    await mountAt('/_tags', { site: { navigationId: 'site-default-nav' } })

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/site-default-nav')
  })

  it('does not fetch on a non-content route before the site default id has arrived (pre-bootstrap)', async () => {
    await mountAt('/_graph')

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('starts fetching once the site default id arrives after mount', async () => {
    const { wrapper } = await mountAt('/_graph')
    expect(API_CLIENT.get).not.toHaveBeenCalled()

    const siteStore = useSiteStore()
    siteStore.navigationId = 'site-default-nav-late'
    await wrapper.vm.$nextTick()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/site-default-nav-late')
  })

  it('prefers a page-inherited navigationId over the site default on a content route', async () => {
    const router = await createTestRouter(routes, '/some/wiki/page')
    const { wrapper } = mountWithApp(NavSidebar, {
      messages: { common: { sidebar: { browse: 'Browse' } } },
      router,
      stores: {
        site: (store) => {
          store.id = 'site-1'
          store.navigationId = 'site-default-nav'
        },
        page: { navigationId: 'page-own-nav' }
      }
    })
    await wrapper.vm.$nextTick()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/page-own-nav')
    expect(API_CLIENT.get).not.toHaveBeenCalledWith('sites/site-1/navigation/site-default-nav')
  })

  it('does not fetch on a content route with no navigationId yet, even when the site default is available', async () => {
    await mountAt('/some/wiki/page', { site: { navigationId: 'site-default-nav' } })

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('switches from the site default to a stale page id becoming current on an in-app navigation to a content route', async () => {
    const router = await createTestRouter(routes, '/_graph')
    const { wrapper } = mountWithApp(NavSidebar, {
      messages: { common: { sidebar: { browse: 'Browse' } } },
      router,
      stores: {
        site: (store) => {
          store.id = 'site-1'
          store.navigationId = 'site-default-nav'
        }
      }
    })
    await wrapper.vm.$nextTick()
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/site-default-nav')

    const pageStore = usePageStore()
    pageStore.navigationId = 'content-page-nav'
    await router.push('/some/wiki/page')
    await wrapper.vm.$nextTick()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/content-page-nav')
  })
})

describe('NavSidebar', () => {
  /**
   * OpenProject #1640: the sidebar had no `<nav>` landmark at all -- a screen reader's landmarks
   * rotor had nothing to jump to for the primary navigation, distinct from the page's own `<nav
   * class="page-toc">` (`PageToc.vue`). Asserted here that a `<nav>` wraps the rendered list AND
   * carries the resolved (not hardcoded) accessible name, so the two landmarks are both present and
   * distinguishable.
   */
  it('wraps the sidebar list in a named <nav> landmark', async () => {
    const wrapper = await mountSidebar('left')

    const nav = wrapper.find('nav')
    expect(nav.exists()).toBe(true)
    expect(nav.attributes('aria-label')).toBe('Browse')
    expect(nav.find('.sidebar-nav-list').exists()).toBe(true)
  })

  /*
    `sidebarPosition` no longer reaches this component's own markup at all. It existed here to drive
    a `sidebar-nav--flipped` class, and that class existed to bite the current-page notch out of
    whichever edge faced the content column. Cardinal marks the current page with an accent bar on
    the edge the READER starts from instead, which is the reading direction's question and not the
    site setting's -- so the class, its rule, and the JS that applied it are all gone together.
    `WLayout`'s grid still places the sidebar itself on whichever side the setting names.
  */
  it('renders identically whichever side the site puts the sidebar on', async () => {
    const left = await mountSidebar('left')
    const right = await mountSidebar('right')

    expect(right.classes()).toEqual(left.classes())
    expect(right.classes()).not.toContain('sidebar-nav--flipped')
  })

  /**
   * A static check on the source rather than a rendered assertion, for the reason the file header
   * above gives: happy-dom cannot resolve a logical property against `direction`, so the only way
   * left to catch a stray physical declaration sneaking back into this `<style>` block is to grep
   * for one. Specifically the open-group rail's own border: it sits right next to two pseudo-element
   * "elbows" that already read `inset-inline-start`, and a `border-left` here would point the
   * straight run of the rail at a different edge than its own turns once `dir="rtl"` moves them.
   *
   * Scoped to the `<style>` block specifically rather than the whole file, since a script-side
   * `right`/`left` property name (positioning, not a physical border) would otherwise false-match.
   */
  it('keeps the open-group rail on a logical (inline-start) border, not a physical one', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).not.toMatch(/border-left\s*:/)
    expect(styleBlock).not.toMatch(/border-right\s*:/)
    expect(styleBlock).toMatch(/border-inline-start\s*:\s*10px/)
  })

  /**
   * OpenProject #2535: `.sidebar-nav > nav { min-height: 100% }` resolved a percentage height
   * against `.sidebar-nav`'s own flex-computed (`flex: 1 1 0`), potentially fractional-pixel
   * height in a separate layout pass, and the two passes could round that value differently --
   * enough to leave `nav` a hair taller than the actual available space and trip `w-scroll-area`'s
   * `overflow-auto`, even though nothing was actually cut off. happy-dom has no real layout engine
   * (see the file header above), so the sub-pixel scrollbar symptom itself can't be reproduced here
   * -- this asserts, statically, that the fix (flex-growing `nav` inside `.sidebar-nav`'s own flex
   * column, so both figures are resolved by the same layout pass) is in place and the old
   * percentage-height rule -- the actual source of the rounding mismatch -- is gone.
   */
  it('sizes the nav landmark by flex-growing it, not by a percentage height, to avoid sub-pixel scrollbars', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
    const sidebarNavBlock = styleBlock.slice(
      styleBlock.indexOf('.sidebar-nav {'),
      styleBlock.indexOf('.sidebar-nav {') +
        styleBlock.slice(styleBlock.indexOf('.sidebar-nav {')).indexOf('&-list >')
    )

    expect(sidebarNavBlock).toMatch(/display:\s*flex/)
    expect(sidebarNavBlock).toMatch(/flex-direction:\s*column/)
    expect(sidebarNavBlock).toMatch(/>\s*nav\s*{\s*[^}]*flex:\s*1\s+0\s+auto/)
    expect(sidebarNavBlock).not.toMatch(/min-height:\s*100%/)
  })
})
