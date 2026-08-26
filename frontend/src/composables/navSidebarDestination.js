import { useRouter, useRoute } from 'vue-router'

import { routableHref } from '@/helpers/renderedContent'

/**
 * Where a nav item points, and whether it is the page being read -- used by `NavSidebarItem.vue`,
 * which renders itself once per nesting level (OpenProject #814). Kept as a composable rather than
 * methods on that component so every recursive instance calls the same implementation instead of
 * each one closing over its own copy.
 */
export function useNavSidebarDestination() {
  const router = useRouter()
  const route = useRoute()

  /**
   * Where a nav item points, as the props that take a reader there.
   *
   * An administrator types this address by hand and it can be anything: a path in this wiki, a URL on
   * another site, a `mailto:`. Only the first of those is the router's, and handing it the others is what
   * made an external link land on "This page does not exist yet" -- vue-router matched
   * `https://example.com/x` as a PATH, found nothing, and fell through to the catch-all page view.
   *
   * The question is the one `routableHref` already answers for the links inside a rendered page, so it is
   * the same function that answers it here rather than a second opinion that can drift from it. Which also
   * settles two cases beyond the reported one: an item pointing into `/_files/` now downloads the file
   * instead of 404ing, and one pointing at `#a-heading` on this page jumps to it.
   *
   * `openInNewWindow`, set per link in the navigation editor, is fed into the same question rather than
   * added on afterwards: a link asking for a new tab is one `routableHref` declines whatever it points at,
   * on the grounds that a new context is the browser's to open and not the router's to swap in. So such an
   * item goes out as a plain anchor -- which loads this app fresh in the new tab, which is what a new tab
   * does in any case.
   *
   * Mind the two meanings of "target" in here: a nav item's is the address to go to, an anchor's is the
   * window to open it in.
   *
   * Two typed-address cases worth calling out explicitly (task 466 verified both rather than assuming):
   *
   *   - `mailto:`/`tel:` need no special-casing here beyond being named in the plain-`href` branch's own
   *     protocol allowlist below. `routableHref`'s protocol check (`/^https?:$/`) already declines
   *     anything that is not http(s), so either falls straight through to that branch and the browser
   *     opens it with the reader's mail or phone app, same as any other link on the page.
   *   - A bare domain typed without a scheme -- `example.com` rather than `https://example.com` -- is NOT
   *     declined. `new URL('example.com', location.href)` resolves it as a same-origin PATH relative to
   *     whatever page is open, so `routableHref` hands it to the router, which then renders "page not
   *     found" for an address the author meant as external. This is not a bug to fix here: it is exactly
   *     how a bare `<a href="example.com">` behaves in any HTML document, including this wiki's own
   *     rendered page content, which asks `routableHref` the identical question for the identical reason.
   *     Guessing "this looks like a domain" would be a heuristic this codebase does not apply to content
   *     links, and applying it only to nav items would make the two inconsistent. Typing the full address
   *     with its scheme is the author's responsibility, the same as it is when writing a link into a page.
   */
  function destination(item) {
    const address = item.target ?? '/'
    const target = item.openInNewWindow ? '_blank' : undefined
    let url
    try {
      url = new URL(address, globalThis.location.href)
    } catch {
      // -> Not a URL at all: nothing to route to, and nothing safe to hand the browser either
      return {}
    }
    const routable = routableHref({ href: url.href, target }, globalThis.location)
    if (routable) {
      return { to: routable }
    }
    /*
      Not routable: only hand it to the browser as a plain link when it is a scheme the browser will
      navigate to rather than execute -- mirrors `Index.vue`'s `relationLink()`. An administrator types
      this address by hand, so a stray `javascript:` (or `javascript://%0a...`, which still parses as
      a URL) must not reach `<a href>` verbatim the way it did here before this check existed.
    */
    return /^(https?|mailto|tel):$/.test(url.protocol) ? { href: address, target } : {}
  }

  /**
   * Whether a nav item points at the page being read.
   *
   * Only a routed item can be: an address that leaves the wiki is never where the reader already is, and
   * one that opens in a new tab is not asking to be here either. Asked of the router rather than compared
   * as strings, so a trailing slash, an escape or a redirect is settled the same way the router settles it
   * when the reader actually clicks.
   *
   * This is only used to decide which groups open on arrival. The dent itself is drawn off
   * `router-link-exact-active`, the class `RouterLink` puts on the row it has taken the reader to -- the
   * same question, answered by the same router, but kept up to date by the link itself as the reader moves
   * around rather than recomputed here.
   *
   * Confirmed (task 466), not assumed, against two cases that both go through `router.resolve()`:
   *
   *   - A trailing-slash variant of a target's path (`/foo/bar/` typed where the page is `/foo/bar`, or
   *     vice-versa) does NOT match. `router.resolve()` does not normalize a trailing slash -- it is a
   *     genuinely different path to the router, not an ambiguity this function is getting wrong -- so
   *     typing one correctly is on the author, same as the address cases in `destination()`'s own doc.
   *   - A page reached through a redirect (this wiki's alias route, `/a/:alias`, whose `beforeEnter`
   *     resolves and redirects to the page's real path) DOES match, with no special-casing needed: once
   *     the redirect has settled, `route.path` is the real page's path, and a nav item -- which can only
   *     ever be authored with that real path, since the navigation editor's picker addresses pages by it,
   *     never by an alias -- resolves to the same string through the same router.
   */
  function isCurrent(item) {
    const { to } = destination(item)
    return Boolean(to) && router.resolve(to).path === route.path
  }

  /**
   * Whether one of a group's children -- at any depth -- is the page being read, which is what opens
   * the group. Recurses through nested `children` so a group auto-opens for a reader who arrived
   * several folders deep, not only when the current page is a direct child.
   */
  function containsCurrent(item) {
    return (item.children ?? []).some((child) => isCurrent(child) || containsCurrent(child))
  }

  return { destination, isCurrent, containsCurrent }
}
