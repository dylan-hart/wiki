/**
 * The tag and locale values a viewer can filter the graph by, derived from whichever nodes are
 * currently loaded — no separate endpoint (OpenProject #875's design). Folder depth has no
 * discrete "options" list the way tags/locale do (it's a numeric range), so it isn't part of this
 * function; `Graph.vue`'s folder-depth control just clamps against the graph's max folder depth.
 */
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
 * An edge's endpoint as fetched is a plain node-id string, but `d3-force`'s `forceLink` mutates
 * `edge.source`/`edge.target` in place into a reference to the actual node object the moment
 * `.links()` resolves ids against `.nodes()` (Task 26 feeds `Graph.vue`'s live `allEdges`/`edges`
 * arrays straight into it, so this same edge array is what the simulation mutates) -- normalizing
 * both shapes here is what keeps a re-filter after the first tick from comparing a node object
 * against a Set of path strings and dropping every edge.
 */
function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.path : endpoint
}

/**
 * The AND of every active filter (OpenProject #875's design) — a node passes only if it passes
 * every non-empty filter, and an edge survives only if both endpoints do. `folderDepth` counts
 * path segments (`docs/child` has depth 2); `null`/`0` on any filter means "no restriction" for
 * that dimension.
 */
export function computeVisibleSubset(nodes, edges, filters) {
  const passesTag = (node) =>
    filters.tags.length === 0 || filters.tags.some((t) => node.tags?.includes(t))
  const passesLocale = (node) => !filters.locale || node.locale === filters.locale
  // -> Depth is the FOLDER's segment count, not the page path's -- `docs/child` is depth 2, and a
  //    root-level page (`folder === ''`) is depth 0, not 1 (`''.split('/')` is `['']`, length 1).
  const folderDepthOf = (node) => (node.folder ? node.folder.split('/').length : 0)
  const passesFolderDepth = (node) =>
    !filters.folderDepth || folderDepthOf(node) <= filters.folderDepth

  const visibleNodes = nodes.filter((n) => passesTag(n) && passesLocale(n) && passesFolderDepth(n))
  const visiblePaths = new Set(visibleNodes.map((n) => n.path))
  const visibleEdges = edges.filter(
    (e) => visiblePaths.has(endpointId(e.source)) && visiblePaths.has(endpointId(e.target))
  )

  return { visibleNodes, visibleEdges }
}
