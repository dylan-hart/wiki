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
 * An edge's endpoint as fetched is a plain node-id string (the composite `${locale}:${path}` id --
 * OpenProject #1621/#1632), but `d3-force`'s `forceLink` mutates `edge.source`/`edge.target` in
 * place into a reference to the actual node object the moment `.links()` resolves ids against
 * `.nodes()` (Task 26 feeds `Graph.vue`'s live `allEdges`/`edges` arrays straight into it, so this
 * same edge array is what the simulation mutates) -- normalizing both shapes here is what keeps a
 * re-filter after the first tick from comparing a node object against a Set of id strings and
 * dropping every edge.
 */
function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint
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
  // -> Keyed on the composite `id` (OpenProject #1621/#1632), not the bare `path` -- translations
  //    share a path by design, so a path-keyed Set here let a single-locale filter's edges survive
  //    on a target that only existed in the OTHER, now-filtered-out locale.
  const visibleIds = new Set(visibleNodes.map((n) => n.id))
  const visibleEdges = edges.filter(
    (e) => visibleIds.has(endpointId(e.source)) && visibleIds.has(endpointId(e.target))
  )

  return { visibleNodes, visibleEdges }
}

/**
 * Path-hierarchy synthetic nodes/edges (OpenProject #998, `edgeMode: 'paths'`, the default): every
 * node connects to its immediate parent path segment, climbed all the way up to a synthetic root
 * (`''`) -- "root fans out to everything," so even a wiki with zero authored relations/links renders
 * a fully connected graph. A real page is reused as a folder's node when one exists at that exact
 * path (so an index-style page at `docs` doesn't get a duplicate dot next to a synthetic `docs`
 * marker); otherwise a bare `{ id, path, locale, title, synthetic: true }` stand-in is synthesized.
 * Edges are de-duped via a `Set` keyed on `"parentId targetId"`, since many sibling pages under the
 * same folder all climb through the same parent segment -- cheap to always climb every node fully to
 * root rather than short-circuiting on "already wired," given the graph's confirmed real-world scale
 * (low hundreds to low thousands of pages).
 *
 * Every id here is the composite `${locale}:${path}` (OpenProject #1621/#1632), synthetic folder
 * nodes included: translations share `path` by design, so a folder segment climbed from an `en` page
 * gets its own `en:docs`-shaped id, distinct from the `fr:docs` folder climbed from an `fr` page --
 * each locale grows its own hierarchy rather than merging into one tree keyed on the bare path.
 */
export function buildPathHierarchyEdges(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
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
      return id
    }
    synthesized.set(id, {
      id,
      path,
      locale,
      title: path === '' ? '(root)' : path.split('/').at(-1),
      synthetic: true
    })
    return id
  }

  for (const node of nodes) {
    let currentPath = node.path
    let currentId = node.id
    while (currentPath !== '') {
      const parentPath = parentOf(currentPath)
      const parentId = ensureFolderNode(node.locale, parentPath)
      const key = `${parentId} ${currentId}`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push({ source: parentId, target: currentId, type: 'path' })
      }
      currentPath = parentPath
      currentId = parentId
    }
  }

  return { syntheticNodes: [...synthesized.values()], edges }
}

/**
 * Tag-hub synthetic nodes/edges (OpenProject #999, `edgeMode: 'tags'`): one synthetic hub node per
 * distinct tag (`id: '__tag__' + tag`, already globally unique -- no locale needed since a tag isn't
 * locale-scoped), with an edge from the hub to every page carrying that tag. Unlike Feature 874's
 * clustering (which buckets a node under only its first tag for a color group), a multi-tagged page
 * gets one edge per tag here -- simpler than `buildPathHierarchyEdges` above, since there's no
 * chaining and no root. The edge's `target` is the page's composite `id` (OpenProject #1621/#1632),
 * not its bare `path` -- otherwise an `en`/`fr` pair sharing a path would both wire to whichever one
 * `forceLink`'s id map happened to keep last.
 */
export function buildTagHubEdges(nodes) {
  const hubs = new Map()
  const edges = []

  for (const node of nodes) {
    for (const tag of node.tags ?? []) {
      const hubId = `__tag__${tag}`
      if (!hubs.has(hubId)) {
        hubs.set(hubId, { id: hubId, path: hubId, title: tag, synthetic: true })
      }
      edges.push({ source: hubId, target: node.id, type: 'tag' })
    }
  }

  return { syntheticNodes: [...hubs.values()], edges }
}

/**
 * Classification-hub synthetic nodes/edges (OpenProject #1217, `edgeMode: 'classification'`): one
 * synthetic hub node per distinct classification (`id: '__classification__' + name`, already
 * globally unique -- no locale needed), with an edge from the hub to every page carrying it. Every
 * page carries exactly one classification (unlike the zero-or-more tags `buildTagHubEdges` handles
 * above), so this always produces exactly one edge per node -- closer in shape to
 * `buildPathHierarchyEdges`'s one-edge-per-node than to `buildTagHubEdges`'s variable fan-out. A
 * node with no resolved classification name (backend `GraphNode.classification` is null when the id
 * no longer matches a configured level) is grouped under a shared `'(unclassified)'` hub rather than
 * dropped, the same fallback `Graph.vue`'s `groupKeyFor()` uses for the Classification grouping. The
 * edge's `target` is the page's composite `id` (OpenProject #1621/#1632), not its bare `path` -- same
 * same-path-collision reasoning as `buildTagHubEdges` above.
 */
export function buildClassificationHubEdges(nodes) {
  const hubs = new Map()
  const edges = []

  for (const node of nodes) {
    const classification = node.classification ?? '(unclassified)'
    const hubId = `__classification__${classification}`
    if (!hubs.has(hubId)) {
      hubs.set(hubId, { id: hubId, path: hubId, title: classification, synthetic: true })
    }
    edges.push({ source: hubId, target: node.id, type: 'classification' })
  }

  return { syntheticNodes: [...hubs.values()], edges }
}
