/** Derived from whichever nodes are loaded -- there is deliberately no endpoint for these. */
export function deriveFilterOptions(nodes) {
  const tags = new Set()
  const locales = new Set()
  for (const node of nodes) {
    for (const tag of node.tags ?? []) {
      tags.add(tag)
    }
    if (node.locale) {
      locales.add(node.locale)
    }
  }
  return {
    tags: [...tags].sort(),
    locales: [...locales].sort()
  }
}

/**
 * Hand-kept mirror of `backend/models/tree.ts`'s `MAX_DEPTH` -- the two workspaces share no import
 * path, so changing the backend ceiling means changing this too.
 */
export const MAX_DEPTH = 10

/**
 * Sizes the depth slider: reality, capped at `MAX_DEPTH`, so the control never offers more slots
 * than either the ceiling or the graph itself could use. Feed it the FULL loaded node set, not the
 * filtered one -- narrowing one filter must not shrink another's range.
 *
 * `0` is ambiguous: an unloaded graph and a genuinely flat one both produce it, so a caller must
 * gate on its own loading state rather than read `0` as "this graph has no folders".
 */
export function deriveMaxFolderDepth(nodes) {
  let max = 0
  for (const node of nodes) {
    const depth = folderDepthOf(node)
    if (depth > max) {
      max = depth
    }
  }
  return Math.min(max, MAX_DEPTH)
}

/**
 * The composite id every function below keys nodes and edges by. A bare `path` is not unique --
 * two locales' translations of a page share it by design -- so keying on it silently collapses them
 * onto whichever the map kept last: duplicate dots stacked, all edges attached to one. A synthetic
 * node has no `locale` and keeps its already-unique `path` as its id.
 */
export function nodeId(node) {
  return node.locale ? `${node.locale}:${node.path}` : node.path
}

/**
 * Resolves the `/_graph?path=` anchor. Scoped to `locale` because `path` alone is ambiguous across
 * locales (see `nodeId`). A synthetic folder/root node is not a match by default -- it is no page a
 * reader could have arrived from -- so a caller anchoring on a containing folder opts in with
 * `includeSynthetic`.
 *
 * The explicit null/undefined check is load-bearing: `''` is the synthetic root's own path and a
 * real request, which a falsy check would swallow.
 */
export function resolveFocusNode(nodes, path, locale, { includeSynthetic = false } = {}) {
  if (path === null || path === undefined) {
    return null
  }
  return (
    nodes.find(
      (node) =>
        (includeSynthetic || !node.synthetic) && node.path === path && node.locale === locale
    ) ?? null
  )
}

/**
 * An endpoint arrives as a composite id string, but `d3-force`'s `forceLink` rewrites
 * `edge.source`/`edge.target` in place into node object references as soon as it resolves links
 * against nodes -- and it is handed these very arrays. Without normalizing both shapes, a re-filter
 * after the first tick compares objects against a Set of strings and drops every edge.
 */
function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? nodeId(endpoint) : endpoint
}

// -> Derived from `path`, deliberately NOT from `node.folder`: the backend's `folder` is only the
//    path's first segment, coarse on purpose for clustering buckets, and cannot distinguish
//    `guides/one` from `guides/deep/two`.
function folderDepthOf(node) {
  return node.path.split('/').length - 1
}

/**
 * A segment-wise prefix match, not a substring one: `guides/one` is a descendant of `guides`,
 * `guides-other` is not. `''` is the root, whose descendants are the whole tree.
 */
function isDescendantPath(path, anchorPath) {
  return anchorPath === '' || path === anchorPath || path.startsWith(`${anchorPath}/`)
}

/**
 * The AND of every active filter; an edge survives only if both endpoints do. `null`/`undefined`
 * means "no restriction", and `folderDepth` must be checked that way rather than by truthiness --
 * `0` (root only) is a real, active filter value.
 *
 * With an `anchor` (`{ path, locale }`), `folderDepth` is reinterpreted as hops from the anchor
 * rather than segments from the site root -- valid because a descendant's path is always the
 * anchor's plus whole extra segments. A root anchor therefore computes identically to no anchor at
 * all, by construction rather than by a special case.
 */
export function computeVisibleSubset(nodes, edges, filters, anchor = null) {
  const passesTag = (node) =>
    filters.tags.length === 0 || filters.tags.some((t) => node.tags?.includes(t))
  const passesLocale = (node) => !filters.locale || node.locale === filters.locale
  const passesAnchor = (node) =>
    !anchor || (node.locale === anchor.locale && isDescendantPath(node.path, anchor.path))
  const anchorDepth = anchor ? folderDepthOf({ path: anchor.path }) : 0
  const passesFolderDepth = (node) =>
    filters.folderDepth == null || folderDepthOf(node) - anchorDepth <= filters.folderDepth

  const visibleNodes = nodes.filter(
    (n) => passesTag(n) && passesLocale(n) && passesAnchor(n) && passesFolderDepth(n)
  )
  const visibleIds = new Set(visibleNodes.map(nodeId))
  const visibleEdges = edges.filter(
    (e) => visibleIds.has(endpointId(e.source)) && visibleIds.has(endpointId(e.target))
  )

  return { visibleNodes, visibleEdges }
}

/**
 * A keyword search emphasizes rather than filters, so unlike `computeVisibleSubset` this never
 * removes a node -- it only tells the canvas layer which visible ones to draw highlighted. Only
 * `path`/`locale` are read, so a search response passes straight through unreshaped. "No search
 * active" and "search matched nothing" both answer an empty `Set`; a caller needing to tell them
 * apart must do so elsewhere.
 */
export function computeHighlightedNodeIds(matches) {
  return new Set((matches ?? []).map((match) => nodeId(match)))
}

/**
 * A client-side substring pass to be UNIONED with the backend search, never to replace it: the
 * backend's `websearch_to_tsquery` matches stemmed lexemes, so a partial word ("onboard" against
 * "Onboarding Guide") does not reliably highlight a title that plainly contains it. Works off
 * already-loaded nodes, so it costs no request.
 */
export function computeTitleMatchNodeIds(nodes, query) {
  const trimmed = (query ?? '').trim().toLowerCase()
  if (!trimmed) {
    return new Set()
  }
  return new Set(
    (nodes ?? [])
      .filter((node) => node.title?.toLowerCase().includes(trimmed))
      .map((node) => nodeId(node))
  )
}

/**
 * Object identity is what carries a synthetic node's d3-assigned `x`/`y`/`vx`/`vy` across a
 * re-filter. Rebuilding the literal each time sends a still-visible folder marker back to
 * d3-force's default origin-centered spiral placement, which reads on screen as a flash-jitter.
 * The caller owns the cache: create it once, pass it on every call, discard it on a full reload.
 */
function internSyntheticNode(cache, id, factory) {
  let node = cache.get(id)
  if (!node) {
    node = factory()
    cache.set(id, node)
  }
  return node
}

/**
 * The graph's sole edge source: every node climbs to its parent path segment, up to a synthetic
 * root, so a wiki with zero authored relations still renders as one connected, strict tree. An
 * existing real page at a folder's exact path is reused as that folder's node, so an index-style
 * page at `docs` gets no duplicate dot beside a synthetic `docs` marker.
 *
 * Every key here -- reuse lookup, de-dupe, synthesized folders, emitted edges -- is the composite
 * `${locale}:${path}`, never the bare path: two locales sharing a folder path must climb to two
 * distinct folder nodes and their own roots rather than merge into one tree.
 *
 * `anchorPath` stops the climb there instead of at true root. Without it, calling this against an
 * already anchor-restricted node set re-synthesizes every ancestor above the anchor straight back
 * into the rendered set, silently defeating `computeVisibleSubset`'s anchor restriction.
 */
export function buildPathHierarchyEdges(nodes, cache = new Map(), anchorPath = '') {
  const byId = new Map(nodes.map((n) => [nodeId(n), n]))
  const synthesized = new Map()
  const edgeKeys = new Set()
  const edges = []

  function parentOf(path) {
    const idx = path.lastIndexOf('/')
    return idx === -1 ? '' : path.slice(0, idx)
  }

  function ensureFolderNode(locale, path) {
    const id = `${locale}:${path}`
    if (byId.has(id) || synthesized.has(id)) {
      return
    }
    synthesized.set(
      id,
      internSyntheticNode(cache, id, () => ({
        path,
        locale,
        title: path === '' ? '(root)' : path.split('/').at(-1),
        synthetic: true,
        // -> Lets `drawNodes` ring the climb's terminus without re-deriving "is this the root" at
        //    the draw layer. Absent entirely (not `false`) on every other synthetic node, so a
        //    `toEqual` fixture for the non-root shape need not mention it.
        ...(path === '' ? { root: true } : {})
      }))
    )
  }

  for (const node of nodes) {
    const { locale } = node
    let current = node.path
    while (current !== '' && current !== anchorPath) {
      const parent = parentOf(current)
      ensureFolderNode(locale, parent)
      const key = `${locale}:${parent} ${locale}:${current}`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push({ source: `${locale}:${parent}`, target: `${locale}:${current}`, type: 'path' })
      }
      current = parent
    }
  }

  return { syntheticNodes: [...synthesized.values()], edges }
}
