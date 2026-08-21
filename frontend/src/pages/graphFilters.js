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
 * every non-empty filter, and an edge survives only if both endpoints do. `null`/`undefined` on
 * any filter means "no restriction" for that dimension -- `folderDepth` in particular must use
 * this explicit check rather than truthiness, because `0` (root-only) is itself a real, active
 * filter value and must not be treated the same as "unset" (OpenProject #898/#900).
 */
export function computeVisibleSubset(nodes, edges, filters) {
  const passesTag = (node) =>
    filters.tags.length === 0 || filters.tags.some((t) => node.tags?.includes(t))
  const passesLocale = (node) => !filters.locale || node.locale === filters.locale
  // -> Depth is the number of DIRECTORY segments in the node's full `path`, not `node.folder`.
  //    `node.folder` (backend `folderOf()`) is deliberately just the path's first segment, coarse
  //    on purpose for Feature 874's clustering buckets -- it can only ever be "empty" or
  //    "non-empty" and can't distinguish `guides/one` from `guides/deep/two`. The depth filter is
  //    a different concept (progressive reveal by path depth), so it derives depth from `path`
  //    directly: `guides/deep/two` has 2 directory segments (depth 2), a root-level page like
  //    `standalone` has 0 (depth 0). `node.folder` itself stays untouched for grouping.
  const folderDepthOf = (node) => node.path.split('/').length - 1
  const passesFolderDepth = (node) =>
    filters.folderDepth == null || folderDepthOf(node) <= filters.folderDepth

  const visibleNodes = nodes.filter((n) => passesTag(n) && passesLocale(n) && passesFolderDepth(n))
  const visiblePaths = new Set(visibleNodes.map((n) => n.path))
  const visibleEdges = edges.filter(
    (e) => visiblePaths.has(endpointId(e.source)) && visiblePaths.has(endpointId(e.target))
  )

  return { visibleNodes, visibleEdges }
}

/**
 * Path-hierarchy synthetic nodes/edges (OpenProject #998, `edgeMode: 'paths'`, the default): every
 * node connects to its immediate parent path segment, climbed all the way up to a synthetic root
 * (`''`) -- "root fans out to everything," so even a wiki with zero authored relations/links renders
 * a fully connected graph. A real page is reused as a folder's node when one exists at that exact
 * path (so an index-style page at `docs` doesn't get a duplicate dot next to a synthetic `docs`
 * marker); otherwise a bare `{ path, title, synthetic: true }` stand-in is synthesized. Edges are
 * de-duped via a `Set` keyed on `"parent target"`, since many sibling pages under the same folder all
 * climb through the same parent segment -- cheap to always climb every node fully to root rather than
 * short-circuiting on "already wired," given the graph's confirmed real-world scale (low hundreds to
 * low thousands of pages).
 */
export function buildPathHierarchyEdges(nodes) {
  const byPath = new Map(nodes.map((n) => [n.path, n]))
  const synthesized = new Map()
  const edgeKeys = new Set()
  const edges = []

  function parentOf(path) {
    const idx = path.lastIndexOf('/')
    return idx === -1 ? '' : path.slice(0, idx)
  }

  function ensureFolderNode(path) {
    if (byPath.has(path) || synthesized.has(path)) {
      return
    }
    synthesized.set(path, {
      path,
      title: path === '' ? '(root)' : path.split('/').at(-1),
      synthetic: true
    })
  }

  const sorted = [...nodes].sort(
    (a, b) => (b.path.match(/\//g) ?? []).length - (a.path.match(/\//g) ?? []).length
  )

  for (const node of sorted) {
    let current = node.path
    while (current !== '') {
      const parent = parentOf(current)
      ensureFolderNode(parent)
      const key = `${parent} ${current}`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push({ source: parent, target: current, type: 'path' })
      }
      current = parent
    }
  }

  return { syntheticNodes: [...synthesized.values()], edges }
}
