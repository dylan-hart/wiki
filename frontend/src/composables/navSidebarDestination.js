import { useRouter, useRoute } from 'vue-router'

import { routableHref } from '@/helpers/renderedContent'
import { localizedPagePath } from '@/helpers/pagePaths'

import { useGraphStore } from '@/stores/graph'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * The schemes `destination()` still hands out as a plain `href` once `routableHref` has declined an
 * address. Anything else -- `javascript:` above all -- gets no `href` at all: Vue does not sanitize
 * a dynamically bound one, and a nav item's address is author-typed.
 */
const SAFE_TARGET_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** The knowledge graph's fixed route path -- no locale prefix, unlike an ordinary content page. */
const GRAPH_ROUTE_PATH = '/_graph'

export function useNavSidebarDestination() {
  const router = useRouter()
  const route = useRoute()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const graphStore = useGraphStore()

  /**
   * A nav item's address is author-typed and can be anything: a path in this wiki, a URL on another
   * site, a `mailto:`. Handed to the router, the latter two match as PATHS and fall through to "this
   * page does not exist yet", so `routableHref` -- the same question rendered page content asks --
   * decides, and whatever it declines goes out as a plain anchor. `openInNewWindow` feeds into that
   * question rather than being applied afterwards: `routableHref` declines a new-tab link whatever
   * it points at, a new context being the browser's to open rather than the router's to swap in.
   *
   * Mind the two meanings of "target": a nav item's is the address, an anchor's is the window.
   *
   * An item with no `target` -- a generated empty folder -- falls back to its own `path` rather than
   * to `/`, which would resolve every empty folder to the home route and make them all read as
   * current at once. `pageStore.locale` is the locale to build it in: the tree is fetched for one
   * locale at a time, so there is no per-row locale to read.
   *
   * A bare domain (`example.com`, no scheme) resolves as a same-origin path and 404s. That is what a
   * bare `<a href="example.com">` does in any document, rendered page content included; guessing
   * "this looks like a domain" for nav items alone would make the two inconsistent.
   */
  function destination(item) {
    const address =
      item.target ??
      (item.path ? localizedPagePath(item.path, pageStore.locale, siteStore.localeRouting) : '/')
    const target = item.openInNewWindow ? '_blank' : undefined
    let url = null
    try {
      url = new URL(address, globalThis.location.href)
    } catch {
      // -> Not a URL at all: nothing to route to, and nothing safe to bind as an href
      return {}
    }
    const routable = routableHref({ href: url.href, target }, globalThis.location)
    if (routable) {
      return graphSidebarBranch(item) ?? { to: routable }
    }
    return SAFE_TARGET_PROTOCOLS.has(url.protocol) ? { href: address, target } : {}
  }

  /**
   * While `/_graph` is open, clicking a page item re-roots the graph (`route.query.path`) instead of
   * navigating away. The item that IS the active root falls through to `destination()`'s ordinary
   * `{ to }` and navigates, as clicking it from anywhere else does.
   *
   * A PAGE anchors on its parent folder, not on itself: a page has no descendants, so anchoring on
   * it draws that page alone rather than the folder of related pages the reader wants, and a
   * top-level page would have no useful anchor at all. An empty FOLDER also reaches this branch
   * (`NavSidebarItem.vue` renders one as a leaf) and anchors on ITSELF, which is why the split is on
   * `item.isFolder` rather than on having children.
   *
   * `route.query.path` holds the raw, un-prefixed form `item.path` carries, never a localized one.
   * `router.replace`, not `push`: re-rooting from the sidebar must not spam the browser history. A
   * `static` link carries no `item.path` and may not be a real page, so it navigates normally even
   * inside the graph.
   *
   * @returns {{ clickable: true, onClick: Function } | null}
   */
  function graphSidebarBranch(item) {
    if (route.path !== GRAPH_ROUTE_PATH || !item.path || isAnchor(item)) {
      return null
    }
    const anchorPath = item.isFolder ? item.path : item.path.split('/').slice(0, -1).join('/')
    return {
      clickable: true,
      onClick: () => {
        graphStore.select(item.path)
        router.replace({ path: GRAPH_ROUTE_PATH, query: { path: anchorPath } })
      }
    }
  }

  /**
   * Asked of the router rather than compared as strings, so an escape or a redirect settles the way
   * it does when the reader clicks. A trailing-slash variant does not match: `router.resolve()` does
   * not normalize one, and typing the address correctly is the author's job.
   *
   * Only used to decide which groups open on arrival -- the active row's own dent is drawn off
   * `router-link-exact-active`, which the link keeps current as the reader moves around.
   */
  function isCurrent(item) {
    const { to } = destination(item)
    return Boolean(to) && router.resolve(to).path === route.path
  }

  /** Recurses, so a group auto-opens for a reader who arrived several folders deep. */
  function containsCurrent(item) {
    return (item.children ?? []).some((child) => isCurrent(child) || containsCurrent(child))
  }

  /**
   * Compares the RAW, un-prefixed `item.path` against `route.query.path`, never through
   * `localizedPagePath()` or any other normalization, which would drift from the anchor
   * `pages/Graph.vue` reads and writes.
   */
  function isAnchor(item) {
    return route.path === GRAPH_ROUTE_PATH && Boolean(item.path) && item.path === route.query.path
  }

  /**
   * ANCHOR TRUMPS SELECTED: `!isAnchor(item)` is load-bearing, not a redundant guard. A clicked
   * empty folder anchors on itself and so sets `selectedPath` to that same path, and one row cannot
   * show both states at once -- a folder becoming the anchor never also reads as selected.
   */
  function isSelected(item) {
    return (
      route.path === GRAPH_ROUTE_PATH &&
      Boolean(item.path) &&
      item.path === graphStore.selectedPath &&
      !isAnchor(item)
    )
  }

  /**
   * The folder-click counterpart to `graphSidebarBranch()`. A populated folder's header must keep
   * its ordinary expand/collapse and re-anchor the graph, but must never be navigable in its own
   * right, so this re-anchors directly instead of handing back a `{ clickable, onClick }` pair a
   * caller would bind in place of the toggle.
   *
   * The guard no-ops on a folder that is already the anchor, so repeat clicks keep toggling it open
   * and closed without restarting the graph's re-center animation.
   */
  function reanchorGraphOnFolder(item) {
    if (route.path !== GRAPH_ROUTE_PATH || !item.path || isAnchor(item)) {
      return
    }
    router.replace({ path: GRAPH_ROUTE_PATH, query: { path: item.path } })
  }

  return { destination, isCurrent, isAnchor, isSelected, containsCurrent, reanchorGraphOnFolder }
}

/**
 * A folder here means "renders as a `w-expansion-item`", i.e. carries at least one child, rather
 * than `item.isFolder`: an empty or boundary folder has nothing to expand or collapse.
 */
export function folderIds(items) {
  const ids = []
  for (const item of items ?? []) {
    if (item.children?.length > 0) {
      ids.push(item.id, ...folderIds(item.children))
    }
  }
  return ids
}

/**
 * Outer-to-inner, excluding `targetId` itself -- what an isolate click keeps open alongside the
 * clicked folder while collapsing every other id `folderIds` names.
 */
export function ancestorIds(items, targetId) {
  function walk(list) {
    for (const item of list ?? []) {
      if (item.id === targetId) {
        return []
      }
      if (item.children?.length > 0) {
        const nested = walk(item.children)
        if (nested !== null) {
          return [item.id, ...nested]
        }
      }
    }
    return null
  }
  return walk(items) ?? []
}
