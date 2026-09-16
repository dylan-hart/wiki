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
 * same page share it by design ("same-path-by-convention") -- so filtering, d3-force's `nodeById`
 * map, or hierarchy-building on
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
 * The node named by a `path`/`locale` pair, or `null` when nothing matches (OpenProject #3312,
 * Feature #3311) -- `Graph.vue`'s resolution for the `/_graph?path=` query param that centers and
 * highlights the page (or, per OpenProject #3337, the folder/root anchor) the reader arrived from.
 * `path` alone is ambiguous on a multi-locale site (see `nodeId()`'s own doc comment above: two
 * locales' translations of a page share a `path` by design), so this always scopes the match to the
 * given `locale` too, rather than returning the first node whose `path` happens to match.
 *
 * By default a synthetic folder/root node (`node.synthetic`) is never a valid match: it has no page
 * of its own for a reader to have arrived from, the same reasoning `navigateToNode()`/`fallbackNodes`
 * already apply. `Graph.vue#applyRouteFocus()` opts into matching one too, via `includeSynthetic:
 * true` (OpenProject #3337) -- the header's Graph button now anchors on the current page's nearest
 * containing folder (root for a top-level page), which is commonly a synthetic node rather than a
 * real page. Any other/future caller not passing the option keeps today's page-only behavior.
 *
 * `path` missing entirely (`null`/`undefined`, i.e. no query param at all) returns `null` with no
 * further work, same as "no match" -- but a `path` of `''` is a DELIBERATE, distinct request (the
 * synthetic root node's own path) and is not short-circuited the same way, unlike a plain falsy
 * check would. `nodes` empty (the graph hasn't loaded yet) also returns `null`, same as any other
 * no-match case.
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
 * Whether `node` is the anchor itself or nested under it (OpenProject #3333) -- `anchorPath` is a
 * directory-style prefix match against `node.path`, the same "path segments" notion `folderDepthOf`
 * already uses, not a substring match: `guides/one` is a descendant of `guides`, but `guides-other`
 * is not. `anchorPath === ''` (the site/locale root) matches every path -- a root anchor's
 * "descendants" is the entire tree, which is also why anchoring at the root is a no-op compared to
 * having no anchor at all (see `computeVisibleSubset`'s own doc comment).
 */
function isDescendantPath(path, anchorPath) {
  return anchorPath === '' || path === anchorPath || path.startsWith(`${anchorPath}/`)
}

/**
 * The AND of every active filter (OpenProject #875's design) — a node passes only if it passes
 * every non-empty filter, and an edge survives only if both endpoints do. `null`/`undefined` on
 * any filter means "no restriction" for that dimension -- `folderDepth` in particular must use
 * this explicit check rather than truthiness, because `0` (root-only) is itself a real, active
 * filter value and must not be treated the same as "unset" (OpenProject #898/#900).
 *
 * `anchor` (OpenProject #3333, Task #3312's own follow-up scope correction) is `{ path, locale }`
 * naming the page the graph is currently anchored to via `?path=` (`Graph.vue#applyRouteFocus()`),
 * or `null`/`undefined` when no anchor is active -- matching every pre-#3333 call site unchanged.
 * With an anchor active, the visible set is additionally restricted to the anchor node itself plus
 * its descendants (same-locale nodes nested under its path, `isDescendantPath` above) -- a node in a
 * different locale, or outside the anchor's own subtree, never passes regardless of the other
 * filters. `folderDepth` is reinterpreted alongside it: instead of measuring path segments from the
 * site root, it measures hops from the anchor (`folderDepthOf(node) - folderDepthOf(anchor)`, valid
 * because a descendant's path is always the anchor's path plus whole extra segments). Anchoring at
 * the root (`anchor.path === ''`) leaves both of these unchanged from the no-anchor case: every node
 * is a "descendant" of the root, and hops-from-root-anchor is the same number `folderDepthOf` always
 * computed, so root-anchored and un-anchored behavior are computed identically on purpose, not as a
 * special case.
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
 * The composite ids of every currently-loaded node whose `title` case-insensitively CONTAINS
 * `query` (OpenProject #2533) -- a thin, purely client-side second pass alongside the backend
 * full-text search `computeHighlightedNodeIds` above draws from. The backend's
 * `websearch_to_tsquery` engine matches stemmed lexemes, not substrings, so typing a partial word
 * (e.g. "onboard" against a page titled "Onboarding Guide") doesn't reliably highlight a page whose
 * title plainly contains it -- this fills exactly that gap, unioned into the same highlighted set
 * by the caller (`Graph.vue`'s `highlightedNodeIds`), never replacing the backend pass. Takes
 * `nodes` (the caller's `allNodes.value`, already in memory -- no extra request) rather than
 * `matches`, since there is no search response here to draw ids from; a node with no `title` at all
 * (synthetic hub nodes never carry one) simply never matches. `query` is trimmed the same way
 * `searchKeyword`'s own watcher trims `keywordQuery` before firing (`Graph.vue`, ~line 511), so an
 * empty or whitespace-only query yields an empty `Set` here too, same as the backend pass does for
 * an unfired search.
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
 * Reuses a previously-synthesized folder/root node across `applyFilters()` calls instead of always
 * building a fresh literal (OpenProject #2538): a synthetic node that's still visible after a filter
 * change keeps the same object identity, so it keeps whatever `x`/`y`/`vx`/`vy` d3-force has since
 * assigned it rather than being handed back to `initializeNodes()`'s origin-centered phyllotaxis
 * spiral and yanked back into place over the first several ticks (the "flash-jitter" this bug
 * describes). `cache` is keyed by the synthetic node's own id and is the caller's responsibility to
 * create once and pass into `buildPathHierarchyEdges` on every call, then discard on a wholesale
 * reload -- see `Graph.vue`'s `syntheticNodeCache`. A key not yet in the cache still gets a
 * brand-new object with no `x`/`y`, which falls through to d3-force's default placement exactly as
 * before -- matching the already-accepted behavior for a real node that reappears after being
 * filtered out.
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
 * Path-hierarchy synthetic nodes/edges (OpenProject #998, later made the graph's sole edge source
 * by OpenProject #2580, which removed the sibling `'tags'`/`'classification'` hub builders that used
 * to live alongside this one): every node connects to its immediate parent path segment, climbed all
 * the way up to a synthetic root (`''`) -- "root fans out to everything," so even a wiki with zero
 * authored relations/links renders a fully connected graph, and every non-root node has exactly one
 * incoming `type: 'path'` edge, making the result a strict tree. A real page is reused as a folder's
 * node when one exists at that exact path (so an index-style page at `docs` doesn't get a duplicate
 * dot next to a synthetic `docs` marker); otherwise a bare `{ path, locale, title, synthetic: true }`
 * stand-in is synthesized -- reused by identity across calls via `cache` (`internSyntheticNode`,
 * OpenProject #2538) rather than always freshly built, so an already-settled folder/root marker
 * doesn't jitter on the next `activeFilters` change. Edges are de-duped via a `Set` keyed on "parent
 * target" composite ids, since many sibling pages under the same folder all climb through the same
 * parent segment -- cheap to always climb every node fully to root rather than short-circuiting on
 * "already wired," given the graph's confirmed real-world scale (low hundreds to low thousands of
 * pages).
 *
 * Everything here -- the `byId` reuse lookup, the de-dupe key, the synthesized folder nodes
 * (including the root) and the emitted edges -- is keyed on the composite `${locale}:${path}` id,
 * not the bare path (OpenProject #1632): two locales sharing a folder path must climb to two
 * distinct folder nodes and a locale-qualified root each, not merge into one shared tree. A
 * synthetic folder node therefore carries its climbing node's `locale`, same as a real page node.
 *
 * `cache` defaults to a fresh, empty `Map` when the caller doesn't pass one (e.g. every existing
 * unit test call site) -- with nothing to reuse, behavior is identical to before this cache existed.
 */
export function buildPathHierarchyEdges(nodes, cache = new Map()) {
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
        // -> Marks the one synthetic node per locale that is the climb's terminus (OpenProject
        //    #2563), so `graphDraw.js#drawNodes` can give it a distinct, always-visible ring
        //    without re-deriving "is this the root" from `path === ''` at the draw layer. Every
        //    other synthetic folder node has no `root` key at all (not `root: false`), so this
        //    stays invisible to `toEqual` fixtures asserting the non-root shape.
        ...(path === '' ? { root: true } : {})
      }))
    )
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
