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
 * The id a node is addressed by inside the d3-force simulation (`Graph.vue`'s `forceLink().id()`
 * accessor) and, below, from every synthetic edge's `source`/`target` this module builds. A real
 * node's `path` alone is not unique -- two locales' translations of the same page share it by
 * design (`docs/decisions/locale-translation-linking.md`, "Same-path-by-convention"), so d3-force's
 * `nodeById` map would otherwise collapse them onto whichever the map kept last, with no error: N
 * duplicate dots on top of each other, all edges attached to just one of them (OpenProject
 * #1629/#1632). A real node (one carrying a `locale`) is therefore keyed on `${locale}:${path}`; a
 * synthetic node (folder/tag/classification hub) has no `locale` of its own and keeps its
 * already-unique synthetic `path` as its id, unchanged -- which is also why a node fixture with no
 * `locale` field (every pre-existing test in this file) round-trips through this function as its
 * own bare `path`, byte-for-byte.
 */
export function nodeId(node) {
  return node.locale ? `${node.locale}:${node.path}` : node.path
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
 *
 * Every edge endpoint is addressed by `nodeId()`, not the bare `path` a plain climb would produce
 * (OpenProject #1629/#1632) -- otherwise two locales' same-path pages would climb into edges whose
 * `target` collides on the same string, which is exactly the bug this module exists to not have.
 * The node actually being climbed FROM is always known precisely (it's `node` itself), so its own
 * leaf edge uses `nodeId(node)` directly; an ancestor folder is looked up by `byPath`'s bare-path
 * key alone (`idForPath`, below) since nothing at this point remembers which specific locale's page
 * a shared folder path belongs to -- picking whichever one `byPath` retained is enough to avoid
 * handing d3-force an id that resolves to no node at all, but not enough to give two locales fully
 * separate hierarchies; that separation is OpenProject #1632's own scope.
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

  function idForPath(path) {
    return nodeId(byPath.get(path) ?? synthesized.get(path))
  }

  for (const node of nodes) {
    let current = node.path
    let currentId = nodeId(node)
    while (current !== '') {
      const parent = parentOf(current)
      ensureFolderNode(parent)
      const parentId = idForPath(parent)
      const key = `${parentId} ${currentId}`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push({ source: parentId, target: currentId, type: 'path' })
      }
      current = parent
      currentId = parentId
    }
  }

  return { syntheticNodes: [...synthesized.values()], edges }
}

/**
 * Tag-hub synthetic nodes/edges (OpenProject #999, `edgeMode: 'tags'`): one synthetic hub node per
 * distinct tag (`path: '__tag__' + tag`), with an edge from the hub to every page carrying that tag.
 * Unlike Feature 874's clustering (which buckets a node under only its first tag for a color group),
 * a multi-tagged page gets one edge per tag here -- simpler than `buildPathHierarchyEdges` above,
 * since there's no chaining and no root. Each edge's `target` is `nodeId(node)`, not the bare
 * `node.path` (OpenProject #1629/#1632), so two locales' same-path pages carrying the same tag get
 * two distinct edges instead of colliding on one.
 */
export function buildTagHubEdges(nodes) {
  const hubs = new Map()
  const edges = []

  for (const node of nodes) {
    for (const tag of node.tags ?? []) {
      const hubPath = `__tag__${tag}`
      if (!hubs.has(hubPath)) {
        hubs.set(hubPath, { path: hubPath, title: tag, synthetic: true })
      }
      edges.push({ source: hubPath, target: nodeId(node), type: 'tag' })
    }
  }

  return { syntheticNodes: [...hubs.values()], edges }
}

/**
 * Classification-hub synthetic nodes/edges (OpenProject #1217, `edgeMode: 'classification'`): one
 * synthetic hub node per distinct classification (`path: '__classification__' + name`), with an
 * edge from the hub to every page carrying it. Every page carries exactly one classification
 * (unlike the zero-or-more tags `buildTagHubEdges` handles above), so this always produces exactly
 * one edge per node -- closer in shape to `buildPathHierarchyEdges`'s one-edge-per-node than to
 * `buildTagHubEdges`'s variable fan-out. A node with no resolved classification name (backend
 * `GraphNode.classification` is null when the id no longer matches a configured level) is grouped
 * under a shared `'(unclassified)'` hub rather than dropped, the same fallback `Graph.vue`'s
 * `groupKeyFor()` uses for the Classification grouping. Each edge's `target` is `nodeId(node)`, not
 * the bare `node.path` (OpenProject #1629/#1632), so two locales' same-path pages sharing a
 * classification get two distinct edges instead of colliding on one.
 */
export function buildClassificationHubEdges(nodes) {
  const hubs = new Map()
  const edges = []

  for (const node of nodes) {
    const classification = node.classification ?? '(unclassified)'
    const hubPath = `__classification__${classification}`
    if (!hubs.has(hubPath)) {
      hubs.set(hubPath, { path: hubPath, title: classification, synthetic: true })
    }
    edges.push({ source: hubPath, target: nodeId(node), type: 'classification' })
  }

  return { syntheticNodes: [...hubs.values()], edges }
}
