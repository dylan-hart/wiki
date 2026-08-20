import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import NavSidebar from './NavSidebar.vue'
import routes from '@/router/routes'
import { useSiteStore } from '@/stores/site'

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
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.nav.items = items

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(NavSidebar, {
    global: {
      plugins: [router, i18n],
      components: { 'w-item': CapturingWItem }
    }
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
        Not explicitly called out in `routableHref`'s own comment, but already covered by its
        protocol check: `mailto:` fails `/^https?:$/`, so this falls straight through to the
        non-routable branch with no special-casing needed. Verified rather than assumed -- see
        `destination()`'s JSDoc for where this is now documented.
      */
      expect: { href: 'mailto:hello@example.org' }
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
    '$label, openInNewWindow on: always a plain anchor targeting _blank',
    async ({ label, target }) => {
      const { wrapper } = await mountNav(items)
      const row = rowFor(wrapper, `${label} (new tab)`)
      /*
        `routableHref` declines any `target` other than `_self` on principle -- a new tab is the
        browser's context to open, not the router's to swap in -- so `openInNewWindow` always wins
        out to a plain `href`/`target="_blank"` pair, for every category above without exception.
      */
      expect(row.props('to')).toBeFalsy()
      expect(row.props('href')).toBe(target)
      expect(row.props('target')).toBe('_blank')
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

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721. Mounting at all is
 * itself a meaningful check: this component's `<style lang="scss">` was rewritten from physical
 * `left`/`right`/`border-left` declarations to logical `inset-inline-*`/`border-inline-*` ones (the
 * edge-notch triangle and the open-group rail), and Vite's Sass pipeline would fail the whole render
 * on a malformed declaration -- a compile error here, not a failed assertion, is what would catch a
 * typo in that rewrite.
 *
 * The actual mirroring under `dir="rtl"` cannot be asserted from here: happy-dom's CSS engine does
 * not resolve logical properties against `direction` the way a real layout engine does (verified
 * separately, against real Chromium, while making this change -- see the task's notes). What IS
 * asserted here is the one thing that stayed JS-driven rather than becoming pure CSS: `sidebarPosition`
 * (a SITE setting) and the reader's text direction are two independent axes, and `sidebarPosition`
 * alone must still be what decides whether `sidebar-nav--flipped` is applied -- switching locale must
 * not silently flip it too.
 */
async function mountSidebar(sidebarPosition) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.theme.sidebarPosition = sidebarPosition

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(NavSidebar, {
    global: {
      plugins: [router, i18n]
    }
  })
}

describe('NavSidebar', () => {
  it('applies sidebar-nav--flipped only when sidebarPosition is "right"', async () => {
    const defaultSidebar = await mountSidebar('left')
    expect(defaultSidebar.classes()).not.toContain('sidebar-nav--flipped')

    const flippedSidebar = await mountSidebar('right')
    expect(flippedSidebar.classes()).toContain('sidebar-nav--flipped')
  })

  /**
   * A static check on the source rather than a rendered assertion, for the reason the file header
   * above gives: happy-dom cannot resolve a logical property against `direction`, so the only way
   * left to catch a stray physical declaration sneaking back into this `<style>` block is to grep
   * for one. Specifically the open-group rail's own border: it sits right next to two pseudo-element
   * "elbows" that already read `inset-inline-start`, and a `border-left` here would point the
   * straight run of the rail at a different edge than its own turns once `dir="rtl"` moves them.
   *
   * Excludes the `<script>` block's `thumbStyle.right` (the scroll-thumb's position within its own
   * track, a native-scrollbar convention this custom control is matching -- not a text-direction
   * concern), which is why this greps the `<style>` block specifically rather than the whole file.
   */
  it('keeps the open-group rail on a logical (inline-start) border, not a physical one', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).not.toMatch(/border-left\s*:/)
    expect(styleBlock).not.toMatch(/border-right\s*:/)
    expect(styleBlock).toMatch(/border-inline-start\s*:\s*10px/)
  })
})
