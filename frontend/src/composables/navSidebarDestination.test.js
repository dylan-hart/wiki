import { describe, expect, it } from 'vitest'

import { useNavSidebarDestination } from './navSidebarDestination.js'

/*
  OpenProject #2221: `destination()`'s non-routable fallback used to hand `{ href: address, target }`
  to `<w-item v-bind>` -> `WItem.vue` -> `<a :href>` for ANYTHING `routableHref` declined, with no
  protocol check of its own. `routableHref` only ever declines a same-origin http(s) address (a
  different origin, a non-http(s) scheme, a server path, or a same-page fragment all fall through to
  it), so an administrator typing `javascript:alert(1)` -- or the same payload dressed up with `://`
  and an encoded newline, which still parses fine as a URL -- reached a live `<a href>` no click-guard
  covered. `destination()` now refuses anything that isn't http(s)/mailto/tel before falling back to a
  plain href, mirroring `Index.vue`'s `relationLink()`.

  `useRouter`/`useRoute` are not mocked: neither `destination()` nor the two cases exercised here
  (`isCurrent`/`containsCurrent`) call into the router, so the real `vue-router` composables are used
  under an injected router instance where a case needs one, and left untouched otherwise.
*/
describe('useNavSidebarDestination destination()', () => {
  it('refuses a javascript: target -- no href and no to', () => {
    const { destination } = useNavSidebarDestination()

    expect(destination({ target: 'javascript:alert(1)' })).toEqual({})
  })

  it('refuses a javascript: target disguised with :// and an encoded newline', () => {
    const { destination } = useNavSidebarDestination()

    // -> Satisfies the old scheme-prefix regex (`^[a-z][a-z0-9+.-]*:\/\//i`) App.vue's logout handler
    //    used to rely on -- included here too since it is the sharpest bypass case for this sink
    expect(destination({ target: 'javascript://%0aalert(1)' })).toEqual({})
  })

  it('still routes a rooted, same-origin target', () => {
    const { destination } = useNavSidebarDestination()

    expect(destination({ target: '/some/page' })).toEqual({ to: '/some/page' })
  })

  it('still hands out an external https:// target as a plain href', () => {
    const { destination } = useNavSidebarDestination()

    expect(destination({ target: 'https://example.org/x' })).toEqual({
      href: 'https://example.org/x',
      target: undefined
    })
  })

  it('still hands out a mailto: target as a plain href', () => {
    const { destination } = useNavSidebarDestination()

    expect(destination({ target: 'mailto:hello@example.org' })).toEqual({
      href: 'mailto:hello@example.org',
      target: undefined
    })
  })

  it('respects openInNewWindow for a refused target too -- still no href, still no to', () => {
    const { destination } = useNavSidebarDestination()

    expect(destination({ target: 'javascript:alert(1)', openInNewWindow: true })).toEqual({})
  })
})
