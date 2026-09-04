/**
 * The tag and locale values a viewer can filter the graph by, derived from whichever nodes are
 * currently loaded — no separate endpoint (OpenProject #875's design). Folder depth has no
 * discrete "options" list the way tags/locale do (it's a numeric range), so it isn't part of this
 * function; see `deriveMaxFolderDepth` below for the graph's actual max folder depth instead.
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
 * Mirrors `backend/models/tree.ts`'s `MAX_DEPTH = 10` -- the folder-nesting ceiling
 * `createFolder`/`moveFolder` enforce there. `frontend/` and `backend/` are independently-installed
 * workspaces with no shared import path, so this is a hand-kept frontend-side copy, the same
 * convention `frontend/src/helpers/systemIds.js` already uses for mirroring `backend/base.yml`'s
 * `systemIds` -- it must be kept in step by hand if the backend value ever changes (OpenProject
 * #2514/#2520).
 */
export const MAX_DEPTH = 10

/**
 * The deepest folder actually present in `nodes` (OpenProject #2514/#2520's Feature: replacing the
 * graph's folder-depth number input with a slider) -- reality, capped at the `MAX_DEPTH` ceiling
 * above, so a graph deep enough to hit it never offers more slots than the reasonable maximum, and
 * a shallower graph never offers more slots than it could possibly use. Uses the same `path`-based
 * depth definition `computeVisibleSubset`'s folder-depth filter already applies (`folderDepthOf`
 * below) -- a root-level page (`path` with no `/`) is depth `0`.
 *
 * An empty `nodes` array (nothing loaded yet, or a graph with genuinely zero pages) returns `0` --
 * indistinguishable, by design, from a real, fully-flat graph. `Graph.vue`'s `actualMaxFolderDepth`
 * computed wraps this over `allNodes.value` (the full loaded graph, not the currently-filtered
 * `nodes.value` -- same "narrowing one filter shouldn't shrink another's own range" reasoning
 * `deriveFilterOptions` above documents), so before the initial graph fetch resolves it also reads
 * `0`. A caller building a UI control off this value (the depth slider, #2521) must gate on the
 * page's own loading state rather than trust `0` alone as meaning "this graph has no folders."
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
 * The composite node id every function below keys nodes and edges by: `${locale}:${path}`
 * (OpenProject #1629/#1632). A bare `path` alone is not unique -- two locales' translations of the
 * same page share it by design (`docs/decisions/locale-translation-linking.md`,
 * "Same-path-by-convention") -- so filtering, d3-force's `nodeById` map, or hierarchy-building on
 * `path` alone would collapse them onto whichever the map kept last, with no error: N duplicate
 * dots on top of each other, all edges attached to just one of them. A real node (one carrying a
 * `locale`) is therefore keyed on `${locale}:${path}`, matching what the graph API already emits
 * (`backend/api/graph.ts#assembleGraph`, OpenProject #1626) and what `Graph.vue`'s d3-force layout
 * resolves nodes by (OpenProject #1629). A synthetic node (tag/classification hub) has no `locale`
 * of its own and keeps its already-unique synthetic `path` as its id, unchanged -- which is also
 * why a node fixture with no `locale` field round-trips through this function as its own bare
 * `path`, byte-for-byte.
 */
export function nodeId(node) {
  return node.locale ? `${node.locale}:${node.path}` : node.path
}

/**
 * An edge's endpoint as fetched is already the composite id string above, but `d3-force`'s
 * `forceLink` mutates `edge.source`/`edge.target` in place into a reference to the actual node
 * object the moment `.links()` resolves ids against `.nodes()` (Task 26 feeds `Graph.vue`'s live
 * `allEdges`/`edges` arrays straight into it, so this same edge array is what the simulation
 * mutates) -- normalizing both shapes here is what keeps a re-filter after the first tick from
 * comparing a node object against a Set of id strings and dropping every edge.
 */
function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? nodeId(endpoint) : endpoint
}

// -> Depth is the number of DIRECTORY segments in a node's full `path`, not `node.folder`.
//    `node.folder` (backend `folderOf()`) is deliberately just the path's first segment, coarse on
//    purpose for Feature 874's clustering buckets -- it can only ever be "empty" or "non-empty" and
//    can't distinguish `guides/one` from `guides/deep/two`. The depth filter (and `MAX_DEPTH`/
//    `deriveMaxFolderDepth` above) is a different concept (progressive reveal by path depth), so it
//    derives depth from `path` directly: `guides/deep/two` has 2 directory segments (depth 2), a
//    root-level page like `standalone` has 0 (depth 0). `node.folder` itself stays untouched for
//    grouping. Module-scope (not local to `computeVisibleSubset`) so `deriveMaxFolderDepth` shares
//    this one definition rather than re-deriving it.
function folderDepthOf(node) {
  return node.path.split('/').length - 1
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
  const passesFolderDepth = (node) =>
    filters.folderDepth == null || folderDepthOf(node) <= filters.folderDepth

  const visibleNodes = nodes.filter((n) => passesTag(n) && passesLocale(n) && passesFolderDepth(n))
  const visibleIds = new Set(visibleNodes.map(nodeId))
  const visibleEdges = edges.filter(
    (e) => visibleIds.has(endpointId(e.source)) && visibleIds.has(endpointId(e.target))
  )

  return { visibleNodes, visibleEdges }
}

/**
 * Node ids to highlight in the graph render (OpenProject #2480, Feature #2414's third task): the
 * composite `${locale}:${path}` id (`nodeId()`) of every keyword search match, as a `Set` for O(1)
 * membership checks per node drawn (`graphDraw.js#drawNodes`/`drawLabels`). Distinct from
 * `computeVisibleSubset` above -- this never removes a node from what's visible, it only tells the
 * canvas layer which already-visible nodes to draw emphasized, per Feature #2414's scope ("highlight
 * matching nodes rather than filtering them out of view"). `matches` needs only `path`/`locale` on
 * each entry, the same two fields `GET sites/:siteId/pages/search` returns per result
 * (`backend/modules/search/shared.ts#SearchDocument`), so the keyword input's search results
 * (OpenProject #2478/#2479) can be passed straight through with no reshaping. `null`/`undefined`
 * (no active search yet) and `[]` (a search that matched nothing) both yield an empty `Set` --
 * callers distinguish "no search active" from "search matched nothing" by other means if they need
 * to; this function only ever answers "which ids, if any, should draw highlighted."
 */
export function computeHighlightedNodeIds(matches) {
  return new Set((matches ?? []).map((match) => nodeId(match)))
}

/**
 * Path-hierarchy synthetic nodes/edges (OpenProject #998, `edgeMode: 'paths'`, the default): every
 * node connects to its immediate parent path segment, climbed all the way up to a synthetic root
 * (`''`) -- "root fans out to everything," so even a wiki with zero authored relations/links renders
 * a fully connected graph. A real page is reused as a folder's node when one exists at that exact
 * path (so an index-style page at `docs` doesn't get a duplicate dot next to a synthetic `docs`
 * marker); otherwise a bare `{ path, locale, title, synthetic: true }` stand-in is synthesized.
 * Edges are de-duped via a `Set` keyed on `"parent target"` composite ids, since many sibling pages
 * under the same folder all climb through the same parent segment -- cheap to always climb every
 * node fully to root rather than short-circuiting on "already wired," given the graph's confirmed
 * real-world scale (low hundreds to low thousands of pages).
 *
 * Everything here -- the `byId` reuse lookup, the de-dupe key, the synthesized folder nodes
 * (including the root) and the emitted edges -- is keyed on the composite `${locale}:${path}` id,
 * not the bare path (OpenProject #1632): two locales sharing a folder path must climb to two
 * distinct folder nodes and a locale-qualified root each, not merge into one shared tree. A
 * synthetic folder node therefore carries its climbing node's `locale`, same as a real page node.
 */
export function buildPathHierarchyEdges(nodes) {
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
    synthesized.set(id, {
      path,
      locale,
      title: path === '' ? '(root)' : path.split('/').at(-1),
      synthetic: true
    })
  }

  for (const node of nodes) {
    const { locale } = node
    let current = node.path
    while (current !== '') {
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
