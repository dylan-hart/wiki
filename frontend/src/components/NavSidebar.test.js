import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import NavSidebar from './NavSidebar.vue'
import NavSidebarItem from './NavSidebarItem.vue'
import PageNewMenu from './PageNewMenu.vue'
import BlueprintIcon from './BlueprintIcon.vue'
import routes from '@/router/routes'
import { useSiteStore } from '@/stores/site'
import { usePageStore } from '@/stores/page'
import { useDark } from '@/composables/dark'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { openDialogs } from '@/composables/dialog'
import { CHROMIUM_TIMEOUT, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * Stubs `WItem` so a test reads exactly what `destination()` handed it (`to` vs `href`/`target`)
 * rather than re-deriving that from the rendered `<a>`'s `href`, which coincides for some cases (a
 * routed page path and its non-routed fallback resolve to the same string) and would hide the very
 * distinction under test.
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

/**
 * Like `mountNav`, but with the real `WItem`/`WExpansionItem` -- registered globally by
 * `test/setup.js`, so simply not overriding them here is enough. `CapturingWItem` has no `.w-item`
 * class or hover styling of its own, which the real-browser describe below needs.
 */
async function mountRealTree(items, { path = '/' } = {}) {
  const router = await createTestRouter(routes, path)

  const { wrapper } = mountWithApp(NavSidebar, {
    messages: { common: { sidebar: { browse: 'Browse' } } },
    router,
    stores: {
      site: (store) => {
        store.nav.items = items
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

function rowFor(wrapper, label) {
  const row = wrapper.findAllComponents(CapturingWItem).find((w) => w.text().includes(label))
  if (!row) {
    throw new Error(`no rendered row for label "${label}"`)
  }
  return row
}

describe('NavSidebar destination()', () => {
  const CASES = [
    {
      label: 'Same-origin page',
      target: '/target-page',
      expect: { to: '/target-page' }
    },
    {
      label: 'External https URL',
      target: 'https://example.org/x',
      expect: { href: 'https://example.org/x' }
    },
    {
      label: 'mailto link',
      target: 'mailto:hello@example.org',
      /*
        `mailto:` fails `routableHref`'s `/^https?:$/` check, so it takes the non-routable branch --
        but is on `SAFE_TARGET_PROTOCOLS` there, so it comes out as a plain `href` rather than being
        refused the way `javascript:` is below.
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
        Refused outright, `{}` -- neither `to` nor `href`. Vue does not sanitize a dynamically bound
        `href`, so handing it out verbatim would let a `site:navigation` holder (a delegated,
        non-administrator permission) plant script that runs for any reader who clicks the row.
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
      expect: { href: '#section-two' }
    },
    {
      label: 'Bare domain without protocol',
      target: 'example.com',
      /*
        Typed without a scheme, `new URL('example.com', location.href)` resolves it as a PATH
        relative to the current page -- exactly how a plain `<a href="example.com">` behaves in any
        HTML document. Deliberate, not a bug: guessing "looks like a domain" here and not in
        rendered page content (same `routableHref`) would make the two inconsistent.
      */
      expect: { to: '/example.com' }
    }
  ]

  const items = CASES.flatMap(({ label, target }, i) => [
    { id: `${i}-off`, type: 'link', icon: 'tabler:link', label, target, openInNewWindow: false },
    {
      id: `${i}-on`,
      type: 'link',
      icon: 'tabler:link',
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
        browser's context to open, not the router's to swap in. A refused scheme stays refused
        either way: a new tab is still this app's own `<a>` binding running the click.
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
      `router.resolve()` does not normalize a trailing slash: the catch-all `/:catchAll(.*)*`
      captures the trailing empty segment, so `/foo/bar` and `/foo/bar/` are genuinely different
      pages to the router. An authoring concern (don't type a trailing slash into a nav target),
      not a bug in `isCurrent()`, which deliberately asks the router rather than comparing strings.
    */
    const items = [
      {
        id: 'group',
        type: 'link',
        icon: 'tabler:folder',
        label: 'Group',
        children: [
          {
            id: 'child',
            type: 'link',
            icon: 'tabler:link',
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
    const items = [
      {
        id: 'group',
        type: 'link',
        icon: 'tabler:folder',
        label: 'Group',
        children: [
          {
            id: 'child',
            type: 'link',
            icon: 'tabler:link',
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
      `/a/:alias`'s `beforeEnter` guard resolves the alias and redirects, so once it settles
      `router.currentRoute.value.path` is the page's REAL path, not the alias that was typed. A nav
      item addressing that real path -- the only address the navigation picker can produce --
      therefore tracks with no special-casing.
    */
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ id: 1, path: 'actual/page' })
    })

    const items = [
      {
        id: 'group',
        type: 'link',
        icon: 'tabler:folder',
        label: 'Group',
        children: [
          {
            id: 'child',
            type: 'link',
            icon: 'tabler:link',
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
 * An intermediate depth renders a `w-expansion-item` header rather than a leaf `w-item`, so it is
 * not findable through `rowFor()`'s component-tree search.
 */
function headerFor(wrapper, label) {
  const header = wrapper.findAll('.w-expansion-item__header').find((h) => h.text().includes(label))
  if (!header) {
    throw new Error(`no rendered expansion header for label "${label}"`)
  }
  return header
}

/**
 * The fixture nests one level deeper than `NavSidebarItem.vue`'s recursion strictly needs, so a
 * regression to a fixed nesting ceiling still fails here.
 */
describe('NavSidebar recursive nesting (OpenProject #814)', () => {
  const deepTree = [
    {
      id: 'level-0',
      type: 'link',
      icon: 'tabler:folder',
      label: 'Level 0',
      children: [
        {
          id: 'level-1',
          type: 'link',
          icon: 'tabler:folder',
          label: 'Level 1',
          children: [
            {
              id: 'level-2',
              type: 'link',
              icon: 'tabler:folder',
              label: 'Level 2',
              children: [
                {
                  id: 'level-3-leaf',
                  type: 'link',
                  icon: 'tabler:file',
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
        icon: 'tabler:folder',
        label: 'Top',
        children: [
          {
            id: 'nested',
            type: 'link',
            icon: 'tabler:folder',
            label: 'Nested',
            expandByDefault: true,
            children: [
              {
                id: 'nested-leaf',
                type: 'link',
                icon: 'tabler:file',
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
 * The deep-chain fixtures above chain a SINGLE child per level, so they never exercise two
 * different item kinds as siblings under one parent -- the shape a real generated menu produces
 * once a folder holds both pages of its own and sub-folders.
 */
describe('NavSidebar mixed folder/page side-tree (OpenProject #832)', () => {
  const mixedTree = [
    {
      id: 'parent-folder',
      type: 'link',
      icon: 'tabler:folder',
      label: 'Parent Folder',
      children: [
        {
          id: 'direct-page',
          type: 'link',
          icon: 'tabler:file',
          label: 'Direct Page',
          target: '/parent-folder/direct-page'
        },
        {
          id: 'sub-folder',
          type: 'link',
          icon: 'tabler:folder',
          label: 'Sub Folder',
          children: [
            {
              id: 'nested-page',
              type: 'link',
              icon: 'tabler:file',
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

    expect(rowFor(wrapper, 'Direct Page').exists()).toBe(true)
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
        icon: 'tabler:folder',
        label: 'Docs',
        path: 'docs',
        folderId: null,
        generated: true,
        children: [
          {
            id: 'page-1',
            type: 'link',
            icon: 'tabler:file',
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
      {
        id: 'static-1',
        type: 'link',
        icon: 'tabler:link',
        label: 'Static Link',
        target: '/somewhere'
      }
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
      resolve to 'docs', so an unscoped match across every rendered `PageNewMenu` would pass even
      with the leaf's own `basePathFor` broken -- its ancestor's menu already produces that value.
      Hence the scope to `page-1`'s own `NavSidebarItem` instance.
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
    A tree entry with its own navigation override (`navigationMode` of `override`/`overrideExact`)
    is a FOLDER, but `generateFromTree` (`backend/models/navigation.ts`) deliberately gives it no
    `children` -- its subtree is a separate menu, not walked into. So folder-vs-page cannot be
    discriminated on `children`: a generated page always carries `target` and a generated folder,
    boundary or not, never does. The fixture is exactly what `generateFromTree` emits for one.
  */
  it('resolves basePath/parentId for a boundary folder (own nav override, no children in the payload) as "create inside it"', async () => {
    const boundaryItems = [
      {
        id: 'boundary-1',
        type: 'link',
        icon: 'tabler:folder',
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
    Every test above fires `new-folder` directly, which proves the wiring but never that the menu
    item renders at all -- a `show-new-folder` prop missing at every call site would leave all of
    them passing. This one clicks the real rendered row.

    `WMenu` is stubbed to always render its slot (the same stub `PageNewMenu.test.js` uses): its
    real open/close gating is `WMenu`'s own concern, covered by its own suite, and all this test
    needs is for "New Folder" to be present once the menu is open.
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
      Scoped to folder-1's own header row, not `folderItem`'s whole subtree: that subtree also
      holds page-1's row and ITS "New Folder" item, and in this fixture a direct child's `folderId`
      coincides with its parent's `id`, so a broader search would pass on the wrong row. Matched on
      EXACT text, not `.includes()`, because `.w-item` nests -- the ancestor's aggregated text
      contains "New Folder" too, alongside every other menu item's label.
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
   * For a page/folder-level navigation override the resolved menu's generator root is that
   * override's own section, not the locale root, so `base-path` has to follow
   * `siteStore.nav.rootPath` rather than assume the site-wide menu's empty root.
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
 * happy-dom's CSS engine does not resolve logical properties against `direction` the way a real
 * layout engine does, so RTL mirroring itself cannot be asserted here at all -- the source-scanning
 * tests below are what keep a physical `left`/`right` declaration out of the `<style>` block.
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

describe('NavSidebar landmark', () => {
  it('wraps the nav list in a named <nav> landmark', async () => {
    const router = await createTestRouter(['/'])

    // -> A real message, unlike `mountSidebar`'s harness: vue-i18n returns the bare key for a
    //    missing one, and this test reads the resolved label.

    const { wrapper } = mountWithApp(NavSidebar, {
      messages: { 'common.sidebar.browse': 'Browse' },
      router
    })
    await wrapper.vm.$nextTick()

    const nav = wrapper.find('nav')
    expect(nav.exists()).toBe(true)
    expect(nav.attributes('aria-label')).toBe('Browse')
    expect(nav.find('.sidebar-nav-list').exists()).toBe(true)
  })
})

/**
 * A non-content route (the graph, tags browse) never sets `pageStore.navigationId` -- only
 * `pageStore.pageLoad()` does -- so the sidebar falls back to the site's own default menu id there.
 * Driven by real routes from the app's route table, since which routes carry `meta.contentPage` is
 * the whole of what this distinguishes.
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
   * The accessible name has to be the resolved translation, not a hardcoded string: it is what
   * tells this landmark apart from `PageToc.vue`'s own `<nav>` in a screen reader's rotor.
   */
  it('wraps the sidebar list in a named <nav> landmark', async () => {
    const wrapper = await mountSidebar('left')

    const nav = wrapper.find('nav')
    expect(nav.exists()).toBe(true)
    expect(nav.attributes('aria-label')).toBe('Browse')
    expect(nav.find('.sidebar-nav-list').exists()).toBe(true)
  })

  /*
    `sidebarPosition` reaches this component's markup not at all: the current-page marker is an
    accent bar on the edge the READER starts from, which is the reading direction's question rather
    than the site setting's. `WLayout`'s grid still places the sidebar on the side the setting
    names.
  */
  it('renders identically whichever side the site puts the sidebar on', async () => {
    const left = await mountSidebar('left')
    const right = await mountSidebar('right')

    expect(right.classes()).toEqual(left.classes())
    expect(right.classes()).not.toContain('sidebar-nav--flipped')
  })

  /**
   * A source grep rather than a rendered assertion, for the reason `mountSidebar` gives: happy-dom
   * cannot resolve a logical property against `direction`. Scoped to the `<style>` block, since a
   * script-side `left`/`right` property name would otherwise false-match.
   */
  it('keeps the open-group indent on a logical (inline-start) property, not a physical one', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).not.toMatch(/border-left\s*:/)
    expect(styleBlock).not.toMatch(/border-right\s*:/)
    expect(styleBlock).not.toMatch(/padding-left\s*:/)
    expect(styleBlock).not.toMatch(/padding-right\s*:/)
    expect(styleBlock).toMatch(
      /padding-inline-start:\s*calc\(1rem \+ var\(--nav-depth,\s*0\)\s*\*\s*10px\)/
    )
  })

  it('keeps the indent to plain padding, with no rail/wash of its own', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
    // -> Matched with its opening brace, since a bare `.w-item` also occurs in compound selectors
    //    (`.w-item.router-link-exact-active {`, no space) and in the stylesheet's comment prose.
    const itemRuleStart = styleBlock.indexOf('.w-item {')
    expect(itemRuleStart).toBeGreaterThanOrEqual(0)
    // -> A window generous enough to cover the whole rule, checked against the source not to reach
    //    a later, unrelated rule's own `background-color`.
    const itemRule = styleBlock.slice(itemRuleStart, itemRuleStart + 3000)

    expect(itemRule).toMatch(
      /padding-inline-start:\s*calc\(1rem \+ var\(--nav-depth,\s*0\)\s*\*\s*10px\)/
    )
    expect(itemRule).not.toMatch(/background-color/)
    expect(itemRule).not.toMatch(/background-clip/)
    // -> Indentation is the row's own padding, so the ancestor wrapper needs no rule at all here.
    expect(styleBlock).not.toMatch(/\.w-expansion-item__content\s*{/)
  })

  /**
   * The dot belongs on each ROW's own `.w-item`, scoped by a plain `&:hover`: on an ancestor
   * wrapper, `:has(:hover)` matches for a descendant hovered at any depth and lights every
   * ancestor's lane at once.
   *
   * A source assertion because happy-dom resolves neither logical properties nor layout; whether
   * the dots land where this says is the real-browser describe right below.
   */
  it('anchors the depth-cue dot at a flat 6px inset (OpenProject #3031) and tightens its reach with --nav-depth', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
    const itemRuleStart = styleBlock.indexOf('.w-item {')
    const beforeRuleStart = styleBlock.indexOf('.w-item::before', itemRuleStart)
    const itemRule = styleBlock.slice(beforeRuleStart, beforeRuleStart + 700)

    // -> Rules only: a stylesheet comment naming `:has(:hover)` -- one explaining why it is not
    //    used, say -- would otherwise false-match.
    const codeOnly = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly).not.toMatch(/:has\(:hover\)/)
    expect(styleBlock.slice(itemRuleStart, itemRuleStart + 200)).toMatch(/position:\s*relative/)
    expect(itemRule).toMatch(/opacity:\s*0;/)
    expect(itemRule).toMatch(/\.w-item:hover::before\s*{\s*opacity:\s*0\.5/)
    // -> A flat constant, deliberately aesthetic-independent: `inset-inline-start` resolves against
    //    `.w-item`'s PADDING box, which never sees that element's own `margin-inline:
    //    var(--nav-item-inset)`, so a formula built on that token compensates for the row margin
    //    only by coincidence. The token stays in use elsewhere, e.g. `margin-inline`.
    expect(itemRule).toMatch(/inset-inline-start:\s*6px;/)
    expect(itemRule).not.toMatch(/--nav-item-inset/)
    expect(itemRule).toMatch(/width:\s*max\(0px,\s*var\(--nav-depth,\s*0\)\s*\*\s*10px\s*-\s*4px\)/)
    // -> One dot PER lane: a `repeat-x` tile exactly one lane (10px) wide, not a single centered
    //    image for the whole depth-scaled box.
    expect(itemRule).toMatch(/background-repeat:\s*repeat-x/)
    expect(itemRule).toMatch(/background-size:\s*10px\s+100%/)
  })

  /**
   * Hover scoping and a per-lane offset are both things neither `jsdom` nor `happy-dom` can be
   * trusted to emulate, so this hovers real markup in a real headless Chromium page.
   *
   * `top`/`middle`/`deep`/`leaf` sit at depth 0/1/2/3: the leaf, not an intermediate folder, is
   * the row with three ancestor lanes to light, and `top` has none at all.
   */
  describe(
    'depth-cue dot hover scoping, anchor point & depth scaling — real behavior (OpenProject #2906, #2932, #2951, #2996, #3031)',
    { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
    () => {
      const nestedTree = [
        {
          id: 'top',
          type: 'link',
          label: 'Top folder',
          expandByDefault: true,
          children: [
            {
              id: 'middle',
              type: 'link',
              label: 'Middle folder',
              expandByDefault: true,
              children: [
                {
                  id: 'deep',
                  type: 'link',
                  label: 'Deep folder',
                  expandByDefault: true,
                  children: [
                    {
                      id: 'leaf',
                      type: 'link',
                      label: 'Leaf page',
                      target: '/leaf'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]

      let browser
      let compiledCss

      beforeAll(async () => {
        browser = await chromium.launch()
        const source = readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), 'NavSidebar.vue'),
          'utf-8'
        )
        const styleStart = source.indexOf('<style')
        const scss = source.slice(
          source.indexOf('>', styleStart) + 1,
          source.lastIndexOf('</style>')
        )
        compiledCss = `:root { --color-slate-faint: #94a3b8; }\n${scss}`
      })

      afterAll(async () => {
        await browser?.close()
      })

      it('lights a reach-back box spanning exactly N lanes for a row nested N levels deep, scoped to only the hovered row', async () => {
        const wrapper = await mountRealTree(nestedTree)
        const html = wrapper.html()
        const page = await browser.newPage()
        try {
          await page.setContent(
            `<!doctype html><html><head><style>${compiledCss}</style></head>` +
              `<body class="sidebar-nav"><div class="w-list">${html}</div></body></html>`
          )

          const topHeader = page.locator('.w-expansion-item__header:has-text("Top folder")')
          const middleHeader = page.locator('.w-expansion-item__header:has-text("Middle folder")')
          const deepHeader = page.locator('.w-expansion-item__header:has-text("Deep folder")')
          const leaf = page.locator('.w-item:has-text("Leaf page")')
          const dotStyle = (locator) =>
            locator.evaluate((el) => {
              const style = getComputedStyle(el, '::before')
              return {
                opacity: Number.parseFloat(style.opacity),
                width: style.width,
                left: style.left
              }
            })
          const rowLeft = (locator) => locator.evaluate((el) => el.getBoundingClientRect().left)

          // -> Sized to its own depth even at rest, nothing lit yet: `width` is
          //    `max(0px, depth * 10px - 4px)`, not a fixed lane regardless of nesting.
          expect((await dotStyle(middleHeader)).width).toBe('6px')
          expect((await dotStyle(deepHeader)).width).toBe('16px')
          expect((await dotStyle(leaf)).width).toBe('26px')

          // -> The trail's NEAR edge (`left`, off `inset-inline-start`) sits at the same absolute
          //    position at every depth: it is the box's `width` that grows toward the icon as
          //    depth increases, never this edge. No `--nav-item-inset` is set in this CSS, so this
          //    is the Ledger case; Cobalt's is the sibling test below.
          expect((await dotStyle(topHeader)).left).toBe('6px')
          expect((await dotStyle(middleHeader)).left).toBe('6px')
          expect((await dotStyle(deepHeader)).left).toBe('6px')
          expect((await dotStyle(leaf)).left).toBe('6px')

          // -> Every row spans the navbar's full width at every depth, so its own left edge lands
          //    at the SAME page position however deep it is nested -- which is what makes the
          //    fixed `left` above mean "anchored at the navbar edge" rather than "anchored wherever
          //    this particular row renders".
          const topLeft = await rowLeft(topHeader)
          expect(await rowLeft(middleHeader)).toBe(topLeft)
          expect(await rowLeft(deepHeader)).toBe(topLeft)
          expect(await rowLeft(leaf)).toBe(topLeft)

          // -> Hovering a row 3 levels deep lights all 3 of its ancestor lanes, not just the
          //    closest one.
          await leaf.hover()
          const leafDot = await dotStyle(leaf)
          expect(leafDot.opacity).toBeCloseTo(0.5)
          expect(leafDot.width).toBe('26px')
          // -> Still scoped to the hovered row alone: neither ancestor folder's own lane lights.
          expect((await dotStyle(middleHeader)).opacity).toBe(0)
          expect((await dotStyle(deepHeader)).opacity).toBe(0)

          // -> An intermediate folder lights only ITS own 2 lanes, and the unrelated leaf stays
          //    dark.
          await deepHeader.hover()
          const deepDot = await dotStyle(deepHeader)
          expect(deepDot.opacity).toBeCloseTo(0.5)
          expect(deepDot.width).toBe('16px')
          expect((await dotStyle(leaf)).opacity).toBe(0)
          expect((await dotStyle(middleHeader)).opacity).toBe(0)
        } finally {
          await page.close()
        }
      })

      /**
       * Cobalt insets every row by `--nav-item-inset: 10px`, so the dot's true distance from the
       * navbar edge is that row margin plus the flat 6px offset -- the same 16px Ledger reaches
       * from the offset alone, and the same 10px gap before the icon in both aesthetics.
       */
      it("gives Cobalt's row gutter the same edge breathing room at every depth", async () => {
        const wrapper = await mountRealTree(nestedTree)
        const html = wrapper.html()
        const source = readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), 'NavSidebar.vue'),
          'utf-8'
        )
        const styleStart = source.indexOf('<style')
        const scss = source.slice(
          source.indexOf('>', styleStart) + 1,
          source.lastIndexOf('</style>')
        )
        const cobaltCss = `:root { --color-slate-faint: #94a3b8; --nav-item-inset: 10px; }\n${scss}`
        const page = await browser.newPage()
        try {
          await page.setContent(
            `<!doctype html><html><head><style>${cobaltCss}` +
              // -> This suite injects only `NavSidebar.vue`'s own CSS, not Tailwind's, so
              //    `.w-item`'s `flex` utility class never takes effect here. Harmless for the
              //    pseudo-element reads elsewhere in this describe, but a MARGIN-based gap read off
              //    the leaf's `<a>` needs block-level layout: left `display: inline`, the browser
              //    folds the anchor's box around its block children instead of applying its margin.
              `.w-item { display: flex; }</style></head>` +
              `<body class="sidebar-nav"><div class="w-list">${html}</div></body></html>`
          )

          // -> `.first()`: this page's own outermost wrapper div, not one of the nested `.w-list`s
          //    the recursive markup renders one of per open folder.
          const container = page.locator('.w-list').first()
          const topHeader = page.locator('.w-expansion-item__header:has-text("Top folder")')
          const leaf = page.locator('.w-item:has-text("Leaf page")')
          const gapFromContainer = async (locator) => {
            const containerLeft = await container.evaluate((el) => el.getBoundingClientRect().left)
            const rowLeft = await locator.evaluate((el) => el.getBoundingClientRect().left)
            return rowLeft - containerLeft
          }

          expect(await gapFromContainer(topHeader)).toBe(10)
          expect(await gapFromContainer(leaf)).toBe(10)

          // -> Row's rendered left plus the pseudo-element's own `left` (`.w-item` is its
          //    `position: relative` anchor): `inset-inline-start` alone is the same flat 6px here
          //    as in the Ledger-like context above, so only a `getBoundingClientRect()` read picks
          //    up Cobalt's row margin on top of it.
          const dotAbsoluteLeft = async (locator) => {
            const rowLeft = await locator.evaluate((el) => el.getBoundingClientRect().left)
            const dotOffset = await locator.evaluate((el) =>
              Number.parseFloat(getComputedStyle(el, '::before').left)
            )
            return rowLeft + dotOffset
          }
          const containerLeft = await container.evaluate((el) => el.getBoundingClientRect().left)
          expect((await dotAbsoluteLeft(topHeader)) - containerLeft).toBe(16)
          expect((await dotAbsoluteLeft(leaf)) - containerLeft).toBe(16)
        } finally {
          await page.close()
        }
      })

      /**
       * A row's `font-size`/`font-weight` is identical in both aesthetics (only `color` differs),
       * so this is asserted once rather than per-aesthetic. Real Chromium because happy-dom leaves
       * an unset property's inherited fallback indistinguishable from its own defaults.
       */
      it('sizes a plain row 400/13.5px and the active row 600/13.5px', async () => {
        const items = [
          { id: 'a', type: 'link', label: 'Item A', target: '/a' },
          { id: 'b', type: 'link', label: 'Item B', target: '/b' }
        ]
        const wrapper = await mountRealTree(items, { path: '/a' })
        const html = wrapper.html()
        const page = await browser.newPage()
        try {
          await page.setContent(
            `<!doctype html><html><head><style>${compiledCss}</style></head>` +
              `<body class="sidebar-nav"><div class="w-list">${html}</div></body></html>`
          )

          const activeRow = page.locator('.w-item:has-text("Item A")')
          const plainRow = page.locator('.w-item:has-text("Item B")')
          const readFont = (locator) =>
            locator.evaluate((el) => {
              const style = getComputedStyle(el)
              return {
                className: el.className,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight
              }
            })

          const active = await readFont(activeRow)
          const plain = await readFont(plainRow)

          // -> The production selector keys off vue-router's own exact-active class; checked here
          //    because a mismatch would leave the assertions below comparing the wrong two rows.
          expect(active.className).toMatch(/router-link-exact-active/)
          expect(plain.className).not.toMatch(/router-link-exact-active/)

          expect(plain.fontSize).toBe('13.5px')
          expect(plain.fontWeight).toBe('400')
          expect(active.fontSize).toBe('13.5px')
          expect(active.fontWeight).toBe('600')
        } finally {
          await page.close()
        }
      })
    }
  )

  /**
   * A percentage height on `nav` resolves against `.sidebar-nav`'s own flex-computed, possibly
   * fractional-pixel height in a separate layout pass, and the two can round differently -- enough
   * to leave `nav` a hair too tall and trip `w-scroll-area`'s `overflow-auto` with nothing
   * actually cut off. Flex-growing it keeps both figures in one pass. Static, since happy-dom has
   * no layout engine to reproduce the sub-pixel symptom with.
   */
  it('sizes the nav landmark by flex-growing it, not by a percentage height, to avoid sub-pixel scrollbars', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
    const sidebarNavStart = styleBlock.indexOf('.sidebar-nav {')
    const navRuleStart = styleBlock.indexOf('.sidebar-nav > nav {', sidebarNavStart)
    const sidebarNavBlock = styleBlock.slice(sidebarNavStart, navRuleStart)
    const navRule = styleBlock.slice(navRuleStart, styleBlock.indexOf('}', navRuleStart) + 1)

    expect(sidebarNavBlock).toMatch(/display:\s*flex/)
    expect(sidebarNavBlock).toMatch(/flex-direction:\s*column/)
    expect(navRule).toMatch(/flex:\s*1\s+0\s+auto/)
    expect(sidebarNavBlock).not.toMatch(/min-height:\s*100%/)
  })

  /**
   * `MainLayout.vue`'s `.sidebar-actions { border-bottom }` sits directly above this element, so a
   * `border-top` here would double that seam to 2px against the app's 1px hairline elsewhere: the
   * upper band owns the line. Scoped to `.sidebar-nav`'s own rule body and to the `.body--dark &`
   * twin nested in it, not the whole style block; the rendered counterpart is the last describe.
   */
  it('draws no border-top of its own on the nav list, light or dark (OpenProject #2726)', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
    const sidebarNavStart = styleBlock.indexOf('.sidebar-nav {')
    const darkStart = styleBlock.indexOf('.body--dark &', sidebarNavStart)
    const darkEnd = styleBlock.indexOf('\n  }', darkStart)

    const lightBlock = styleBlock.slice(
      sidebarNavStart,
      sidebarNavStart + styleBlock.slice(sidebarNavStart).indexOf('&-list >')
    )
    // -> `.sidebar-nav`'s dark twin, nested inside the same rule: native CSS nesting resolves `&`
    //    here to `.body--dark .sidebar-nav`.
    const darkBlock = styleBlock.slice(darkStart, darkEnd)

    expect(lightBlock).not.toMatch(/border-top\s*:/)
    expect(darkBlock).not.toMatch(/border-top-color\s*:/)
  })
})

/**
 * The rendered counterpart to the source check above, which cannot tell "no rule" from "a rule
 * that resolves to 0". Attached to `document.body`: the `<style>` block is unscoped and the dark
 * case's `.body--dark &` ancestor combinator needs a real body to match against.
 *
 * `Number.parseFloat(...) || 0` rather than comparing to `'0px'`: happy-dom reports an EMPTY string
 * for `borderTopWidth` when no border rule applies at all. Either reading means no border drawn.
 */
describe('NavSidebar sidebar-nav border-top (OpenProject #2726)', () => {
  afterEach(() => {
    document.body.classList.remove('body--dark', 'body--light')
  })

  async function mountAttached(theme) {
    useDark().set(theme === 'dark')
    const router = await createTestRouter(['/'])
    return mountWithApp(NavSidebar, {
      messages: { common: { sidebar: { browse: 'Browse' } } },
      router,
      attachTo: document.body
    }).wrapper
  }

  it('draws no top border on .sidebar-nav in light mode', async () => {
    const wrapper = await mountAttached('light')
    const el = wrapper.find('.sidebar-nav').element
    expect(Number.parseFloat(getComputedStyle(el).borderTopWidth) || 0).toBe(0)
    wrapper.unmount()
  })

  it('draws no top border on .sidebar-nav in dark mode either', async () => {
    const wrapper = await mountAttached('dark')
    const el = wrapper.find('.sidebar-nav').element
    expect(Number.parseFloat(getComputedStyle(el).borderTopWidth) || 0).toBe(0)
    wrapper.unmount()
  })
})

/**
 * A folder's open/closed state lives in the tree-wide `navExpansionState` composable -- provided at
 * `NavSidebar.vue`'s root, injected by every `NavSidebarItem` -- not in `WExpansionItem`'s own
 * per-instance uncontrolled state.
 */
describe('NavSidebar shared folder expansion state (OpenProject #2846)', () => {
  function twoFolders() {
    return [
      {
        id: 'folder-a',
        type: 'link',
        icon: 'tabler:folder',
        label: 'Folder A',
        children: [
          { id: 'leaf-a', type: 'link', icon: 'tabler:file', label: 'Leaf A', target: '/a' }
        ]
      },
      {
        id: 'folder-b',
        type: 'link',
        icon: 'tabler:folder',
        label: 'Folder B',
        children: [
          { id: 'leaf-b', type: 'link', icon: 'tabler:file', label: 'Leaf B', target: '/b' }
        ]
      }
    ]
  }

  it('a plain click still toggles exactly that folder, open then closed -- the controlled binding changes the mechanism, not this behavior', async () => {
    const { wrapper } = await mountNav(twoFolders())
    expect(headerFor(wrapper, 'Folder A').attributes('aria-expanded')).toBe('false')

    await headerFor(wrapper, 'Folder A').trigger('click')
    expect(headerFor(wrapper, 'Folder A').attributes('aria-expanded')).toBe('true')

    await headerFor(wrapper, 'Folder A').trigger('click')
    expect(headerFor(wrapper, 'Folder A').attributes('aria-expanded')).toBe('false')
  })

  it('toggling one folder leaves an unrelated sibling folder unaffected', async () => {
    const { wrapper } = await mountNav(twoFolders())

    await headerFor(wrapper, 'Folder A').trigger('click')

    expect(headerFor(wrapper, 'Folder A').attributes('aria-expanded')).toBe('true')
    expect(headerFor(wrapper, 'Folder B').attributes('aria-expanded')).toBe('false')
  })

  it("keeps a folder's toggled-open state after it is removed from the tree and later reappears, proving the state outlives the item's own component instance", async () => {
    const items = twoFolders()
    const { wrapper } = await mountNav(items)
    const siteStore = useSiteStore()

    await headerFor(wrapper, 'Folder A').trigger('click')
    expect(headerFor(wrapper, 'Folder A').attributes('aria-expanded')).toBe('true')

    // -> Genuinely unmounts Folder A's own `NavSidebarItem` instance -- out of the `v-for`
    //    entirely, not re-rendered in place with the same key.
    siteStore.nav.items = items.filter((item) => item.id !== 'folder-a')
    await wrapper.vm.$nextTick()
    expect(
      wrapper.findAll('.w-expansion-item__header').some((h) => h.text().includes('Folder A'))
    ).toBe(false)

    // -> ...and reappears as a fresh instance, seeded from `expandByDefault ||
    //    containsCurrent(item)`: were the state `WExpansionItem`'s own, it would come back closed.
    siteStore.nav.items = items
    await wrapper.vm.$nextTick()

    expect(headerFor(wrapper, 'Folder A').attributes('aria-expanded')).toBe('true')
  })
})

/*
  Cobalt's hover/press tint must NOT inherit the surrounding `.sidebar-nav .w-list .w-item.is-active`
  nesting, so both rules sit flat at the top level of the stylesheet. Anchoring the match at column 0
  is what checks that: re-nesting either rule under that ancestor would indent it off the line start.
*/
describe('NavSidebar Cobalt hover/press tint, hand-converted from @at-root (OpenProject #3011/#3252)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'NavSidebar.vue'),
    'utf-8'
  )
  const styleStart = source.indexOf('<style')
  const css = source.slice(source.indexOf('>', styleStart) + 1, source.lastIndexOf('</style>'))

  it('keeps the hover/press tint as flat, top-level rules -- never nested under .sidebar-nav .w-list .w-item.is-active, which they were written to escape', () => {
    expect(css).toMatch(/^body\.body--cobalt \.sidebar-nav \.w-item--clickable \{$/m)
    expect(css).toMatch(/^body\.body--cobalt\.body--dark \.sidebar-nav \.w-item--clickable \{$/m)
    expect(css).toContain('&:hover {\n    background-color: rgba(31, 79, 214, 0.12) !important;')
    expect(css).toContain('&:active {\n    background-color: rgba(31, 79, 214, 0.2) !important;')
    expect(css).toContain('&:hover {\n    background-color: rgba(143, 176, 255, 0.16) !important;')
    expect(css).toContain('&:active {\n    background-color: rgba(143, 176, 255, 0.26) !important;')
  })
})
