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
 * and a page reached via a redirect. See `NavSidebar.vue`'s own comments for the intent each case is
 * checked against.
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
