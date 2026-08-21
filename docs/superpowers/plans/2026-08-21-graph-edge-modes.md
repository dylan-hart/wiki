# Knowledge Graph Edge-Mode Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the knowledge graph's default edge source — authored `relation`/`link` edges, which a real wiki rarely maintains reliably — with a selectable, entirely client-side `edgeMode`: `paths` (path-hierarchy, default) or `tags` (tag-hub), each synthesizing zero-authoring nodes/edges from data the graph endpoint already returns.

**Architecture:** No backend changes. `frontend/src/pages/graphFilters.js` gains two pure functions, `buildPathHierarchyEdges(nodes)` and `buildTagHubEdges(nodes)`, each returning `{ syntheticNodes, edges }` built from the currently-visible (post-filter) real node set. `frontend/src/pages/Graph.vue` gains an `edgeMode` ref driving a second `w-btn-toggle`, folds the synthetic overlay into `applyFilters()`'s existing `nodes.value`/`edges.value` assignment (replacing, not appending to, the 872 `relation`/`link` edges — which stay fetched into `allEdges` but unused for now), and makes every consumer of `nodes.value` that assumes a real page (`legendEntries`, `groupCentroids`, `computeClusters`, the clustering force, `onCanvasClick`, `drawNodes`) treat a `node.synthetic` entry as inert.

**Tech Stack:** Frontend only — Vue 3 `<script setup>`, `d3-force` (already a dependency), Vitest + `@vue/test-utils`.

**Spec:** `docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md` (amended by Task 6 of this plan) and OpenProject Feature #997's description — read both before starting. `docs/superpowers/plans/2026-08-21-graph-edge-modes-handoff.md` carries the full design reasoning this plan is built from.

**Epic:** OpenProject #848. **Feature:** #997. **Tasks:** #998 (path builder), #999 (tag builder), #1000 (edgeMode wiring), #1001 (synthetic-node inertness), #1002 (combined-scenario tests), #1003 (spec amendment).

---

## Global Constraints

- **Formatting/linting, scoped to touched files only, after each task:** `npx oxfmt <touched files>` then `npx oxlint <touched files>` from `frontend/`.
- **Tests, scoped, never the full suite:** `npx vitest run src/pages/graphFilters.test.js` (or `src/pages/Graph.test.js` if/when one exists) from `frontend/`.
- **No i18n for the new `edgeMode` toggle** — its option labels (`'Paths'`/`'Tags'`) and both toggles' new captions (`'Group by'`/`'Connect by'`) are bare literal strings, matching this file's existing `groupBy` toggle (`'Folder'`/`'Tag'`, not `t()`). Do not add `t()` calls or new `backend/locales/en.json` keys for them.
- **Synthetic node shape is exactly `{ path, title, synthetic: true }`** — no `folder`, no `tags`, no other fields. Every place that reads `node.folder`/`node.tags` for grouping (`groupKeyFor`, `legendEntries`, `groupCentroids`, `computeClusters`) must skip synthetic nodes before reaching those reads, not rely on the fields being present-but-empty.
- **The 872 endpoint and its `relation`/`link` edges are untouched** — `backend/api/graph.ts`, `pages.relations`/`pages.links`, and `Graph.vue`'s `allEdges` fetch/state are not modified by this plan. Only what `applyFilters()` assigns into the live `edges.value` (what the simulation and canvas actually use) changes.
- **Commit messages carry a `(OpenProject #NNN)` suffix** naming the Task WP the commit closes out.
- **Manual browser verification before calling #1000/#1001 done** — Dylan is actively testing this feature; each of those two tasks' steps includes a manual check against a running dev server, not just `vitest run`.

---

# Task 1: `buildPathHierarchyEdges()` (OpenProject #998)

**Files:**
- Modify: `frontend/src/pages/graphFilters.js` (append after `computeVisibleSubset`, line 65)
- Modify: `frontend/src/pages/graphFilters.test.js` (append new `describe` block)

**Interfaces:**
- Produces: `buildPathHierarchyEdges(nodes: {path: string, ...}[]): { syntheticNodes: {path, title, synthetic: true}[], edges: {source: string, target: string, type: 'path'}[] }`. Consumed by Task 3 (`Graph.vue#applyFilters`).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/pages/graphFilters.test.js`:

```js
import { buildPathHierarchyEdges, buildTagHubEdges, computeVisibleSubset, deriveFilterOptions } from './graphFilters.js'
```

(Replace the existing `import { computeVisibleSubset, deriveFilterOptions } from './graphFilters.js'` at line 2 with the line above — both new functions land in the same import.)

```js
describe('buildPathHierarchyEdges (OpenProject #998)', () => {
  it('climbs a nested path to a synthetic root, synthesizing every missing segment', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: 'docs/child/page' }])
    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs', 'docs/child'])
    expect(edges).toEqual([
      { source: 'docs/child', target: 'docs/child/page', type: 'path' },
      { source: 'docs', target: 'docs/child', type: 'path' },
      { source: '', target: 'docs', type: 'path' }
    ])
  })

  it('gives a root-level page a single edge straight to the synthetic root', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: 'about' }])
    expect(syntheticNodes).toEqual([{ path: '', title: '(root)', synthetic: true }])
    expect(edges).toEqual([{ source: '', target: 'about', type: 'path' }])
  })

  it('de-dupes the shared parent edge for sibling pages under the same folder', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: 'docs/a' }, { path: 'docs/b' }])
    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs'])
    expect(edges).toEqual([
      { source: 'docs', target: 'docs/a', type: 'path' },
      { source: '', target: 'docs', type: 'path' },
      { source: 'docs', target: 'docs/b', type: 'path' }
    ])
  })

  it('reuses a real page as its own folder node instead of synthesizing a duplicate', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: 'docs', title: 'Docs Index' },
      { path: 'docs/child' }
    ])
    expect(syntheticNodes).toEqual([{ path: '', title: '(root)', synthetic: true }])
    expect(edges).toEqual([
      { source: 'docs', target: 'docs/child', type: 'path' },
      { source: '', target: 'docs', type: 'path' }
    ])
  })

  it('reuses a real home page (path "") as the root instead of synthesizing one', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: '', title: 'Home' }, { path: 'about' }])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([{ source: '', target: 'about', type: 'path' }])
  })

  it('produces nothing for an empty node set', () => {
    expect(buildPathHierarchyEdges([])).toEqual({ syntheticNodes: [], edges: [] })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: FAIL — `buildPathHierarchyEdges` does not exist yet (import error / `undefined is not a function`).

- [ ] **Step 3: Implement `buildPathHierarchyEdges()`**

Append to `frontend/src/pages/graphFilters.js`, after `computeVisibleSubset` (line 65):

```js
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

  for (const node of nodes) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: PASS, all tests including the pre-existing `deriveFilterOptions`/`computeVisibleSubset` suites (unaffected).

- [ ] **Step 5: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/graphFilters.js src/pages/graphFilters.test.js
npx oxlint src/pages/graphFilters.js src/pages/graphFilters.test.js
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/graphFilters.js frontend/src/pages/graphFilters.test.js
git commit -m "feat: add buildPathHierarchyEdges for the paths edgeMode (OpenProject #998)"
```

---

# Task 2: `buildTagHubEdges()` (OpenProject #999)

**Files:**
- Modify: `frontend/src/pages/graphFilters.js` (append after Task 1's `buildPathHierarchyEdges`)
- Modify: `frontend/src/pages/graphFilters.test.js` (append new `describe` block)

**Interfaces:**
- Produces: `buildTagHubEdges(nodes: {path: string, tags?: string[], ...}[]): { syntheticNodes: {path, title, synthetic: true}[], edges: {source: string, target: string, type: 'tag'}[] }`. Consumed by Task 3.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/pages/graphFilters.test.js`:

```js
describe('buildTagHubEdges (OpenProject #999)', () => {
  it('creates one hub per distinct tag, with an edge from the hub to each carrying page', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([
      { path: 'a', tags: ['foo'] },
      { path: 'b', tags: ['bar'] }
    ])
    expect(syntheticNodes).toEqual([
      { path: '__tag__foo', title: 'foo', synthetic: true },
      { path: '__tag__bar', title: 'bar', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'a', type: 'tag' },
      { source: '__tag__bar', target: 'b', type: 'tag' }
    ])
  })

  it('gives a multi-tagged page one edge per tag, not just its first', () => {
    const { edges } = buildTagHubEdges([{ path: 'a', tags: ['foo', 'bar'] }])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'a', type: 'tag' },
      { source: '__tag__bar', target: 'a', type: 'tag' }
    ])
  })

  it('shares one hub node across every page carrying the same tag', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([
      { path: 'a', tags: ['foo'] },
      { path: 'b', tags: ['foo'] }
    ])
    expect(syntheticNodes).toEqual([{ path: '__tag__foo', title: 'foo', synthetic: true }])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'a', type: 'tag' },
      { source: '__tag__foo', target: 'b', type: 'tag' }
    ])
  })

  it('produces no hubs or edges for an untagged page', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([{ path: 'a', tags: [] }])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([])
  })

  it('treats a missing tags array the same as an empty one', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([{ path: 'a' }])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: FAIL — `buildTagHubEdges` does not exist yet.

- [ ] **Step 3: Implement `buildTagHubEdges()`**

Append to `frontend/src/pages/graphFilters.js`, after `buildPathHierarchyEdges`:

```js
/**
 * Tag-hub synthetic nodes/edges (OpenProject #999, `edgeMode: 'tags'`): one synthetic hub node per
 * distinct tag (`path: '__tag__' + tag`), with an edge from the hub to every page carrying that tag.
 * Unlike Feature 874's clustering (which buckets a node under only its first tag for a color group),
 * a multi-tagged page gets one edge per tag here -- simpler than `buildPathHierarchyEdges` above,
 * since there's no chaining and no root.
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
      edges.push({ source: hubPath, target: node.path, type: 'tag' })
    }
  }

  return { syntheticNodes: [...hubs.values()], edges }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: PASS, all tests.

- [ ] **Step 5: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/graphFilters.js src/pages/graphFilters.test.js
npx oxlint src/pages/graphFilters.js src/pages/graphFilters.test.js
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/graphFilters.js frontend/src/pages/graphFilters.test.js
git commit -m "feat: add buildTagHubEdges for the tags edgeMode (OpenProject #999)"
```

---

# Task 3: `edgeMode` selector wired into `Graph.vue`'s simulation/draw pipeline (OpenProject #1000)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`
  - imports (line 85): pull in `buildPathHierarchyEdges`, `buildTagHubEdges`
  - new `edgeMode` ref, placed after the `groupBy` ref (line 114)
  - template controls block (lines 14–22): second `w-btn-toggle`, both wrapped with a caption
  - `applyFilters()` (lines 531–539): fold in the synthetic overlay
  - `activeFilters` watcher (lines 553–565): extract the simulation-sync body into a shared helper
  - new `edgeMode` watcher, alongside the `activeFilters` watcher
  - `<style>` `.graph-view-controls` (lines 598–603): stack two control groups vertically, new `.graph-view-control-group`/`.graph-view-control-caption` rules

**Interfaces:**
- Consumes: `buildPathHierarchyEdges`, `buildTagHubEdges` (Tasks 1–2).
- Produces: `edgeMode` ref (`'paths' | 'tags'`), `syncSimulationToVisibleSet()` — consumed by Task 4, which reads `node.synthetic` off the nodes this task now folds into `nodes.value`.

- [ ] **Step 1: Update the import**

In `frontend/src/pages/Graph.vue`, line 85:

```js
import { computeVisibleSubset, deriveFilterOptions } from './graphFilters.js'
```

becomes:

```js
import { buildPathHierarchyEdges, buildTagHubEdges, computeVisibleSubset, deriveFilterOptions } from './graphFilters.js'
```

- [ ] **Step 2: Add the `edgeMode` ref**

After the `groupBy` ref and its comment (line 114):

```js
/** 'site' is deliberately not an option here -- see the spec's architecture note: a single loaded
 *  graph has exactly one site value, so grouping by it would be a no-op UI control. */
const groupBy = ref('folder')

/** Which zero-authoring edge source drives the graph's connections (OpenProject #997): `paths`
 *  (default) chains every page to its parent path segment up to a synthetic root; `tags` connects
 *  every page to a synthetic hub per tag it carries. The 872 endpoint's `relation`/`link` edges
 *  (`allEdges` below) are still fetched but not wired into either mode's rendering. */
const edgeMode = ref('paths')
```

- [ ] **Step 3: Update the template controls block**

Replace lines 14–22:

```html
    <div class="graph-view-controls">
      <w-btn-toggle
        v-model="groupBy"
        no-caps
        :options="[
          { label: 'Folder', value: 'folder' },
          { label: 'Tag', value: 'tag' }
        ]" />
    </div>
```

with:

```html
    <div class="graph-view-controls">
      <div class="graph-view-control-group">
        <span class="graph-view-control-caption">Group by</span>
        <w-btn-toggle
          v-model="groupBy"
          no-caps
          :options="[
            { label: 'Folder', value: 'folder' },
            { label: 'Tag', value: 'tag' }
          ]" />
      </div>
      <div class="graph-view-control-group">
        <span class="graph-view-control-caption">Connect by</span>
        <w-btn-toggle
          v-model="edgeMode"
          no-caps
          :options="[
            { label: 'Paths', value: 'paths' },
            { label: 'Tags', value: 'tags' }
          ]" />
      </div>
    </div>
```

- [ ] **Step 4: Fold the synthetic overlay into `applyFilters()`**

Replace `applyFilters()` (lines 531–539):

```js
function applyFilters() {
  const { visibleNodes, visibleEdges } = computeVisibleSubset(
    allNodes.value,
    allEdges.value,
    activeFilters
  )
  nodes.value = visibleNodes
  edges.value = visibleEdges
}
```

with:

```js
/** Recomputes `nodes.value`/`edges.value` (what the simulation actually runs on) from `allNodes`
 *  against `activeFilters`, then layers on the current `edgeMode`'s synthetic nodes/edges -- the 872
 *  endpoint's `relation`/`link` edges (`computeVisibleSubset`'s `visibleEdges`) are deliberately not
 *  used here; see OpenProject #997. Called on initial load, by the `activeFilters` watcher, and by
 *  the `edgeMode` watcher below. Does not touch the live simulation itself; that's
 *  `syncSimulationToVisibleSet`'s job, since the initial call here runs before `startSimulation()`
 *  has created one. */
function applyFilters() {
  const { visibleNodes } = computeVisibleSubset(allNodes.value, allEdges.value, activeFilters)
  const { syntheticNodes, edges: syntheticEdges } =
    edgeMode.value === 'tags' ? buildTagHubEdges(visibleNodes) : buildPathHierarchyEdges(visibleNodes)
  nodes.value = [...visibleNodes, ...syntheticNodes]
  edges.value = syntheticEdges
}
```

- [ ] **Step 5: Extract the simulation-sync helper and add the `edgeMode` watcher**

Replace the `activeFilters` watcher (lines 553–565):

```js
/*
  A node re-added after being filtered back in loses whatever `x`/`y`/velocity it had before removal
  (it is a fresh entry to `d3-force` as far as the simulation is concerned) -- accepted per the
  spec's own framing ("removed nodes exit the simulation so the remainder re-settles, rather than
  just being drawn hidden"): re-settling is the explicitly wanted behavior, not a bug to work around.
*/
watch(
  activeFilters,
  () => {
    applyFilters()
    if (simulation) {
      simulation.nodes(nodes.value)
      simulation.force('link')?.links(edges.value)
      recomputeClusters()
      simulation.alpha(0.5).restart()
    }
  },
  { deep: true }
)
```

with:

```js
/*
  A node re-added after being filtered back in loses whatever `x`/`y`/velocity it had before removal
  (it is a fresh entry to `d3-force` as far as the simulation is concerned) -- accepted per the
  spec's own framing ("removed nodes exit the simulation so the remainder re-settles, rather than
  just being drawn hidden"): re-settling is the explicitly wanted behavior, not a bug to work around.
  Synthetic nodes (OpenProject #997) are freshly constructed objects on every `applyFilters()` call
  too, so they re-settle on every `edgeMode`/`activeFilters` change alike, for the same reason.
*/
function syncSimulationToVisibleSet() {
  if (!simulation) {
    return
  }
  simulation.nodes(nodes.value)
  simulation.force('link')?.links(edges.value)
  recomputeClusters()
  simulation.alpha(0.5).restart()
}

watch(
  activeFilters,
  () => {
    applyFilters()
    syncSimulationToVisibleSet()
  },
  { deep: true }
)

watch(edgeMode, () => {
  applyFilters()
  syncSimulationToVisibleSet()
})
```

- [ ] **Step 6: Update `.graph-view-controls` styling and add the new rules**

Replace the `.graph-view-controls` block (lines 598–603):

```scss
.graph-view-controls {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
}
```

with:

```scss
.graph-view-controls {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.graph-view-control-group {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.graph-view-control-caption {
  font-size: 11px;
  opacity: 0.7;
}
```

- [ ] **Step 7: Manual smoke check in a real browser**

```bash
cd frontend
npm run dev
```

Navigate to `/_graph` on a site with a handful of pages spread across at least two folder levels and a couple of tags. Confirm:
- With no authored relations/links at all, the graph is fully connected (every page reachable from a visible center/root cluster) — this is the entire point of the pivot.
- The "Connect by" toggle switches between `Paths` and `Tags` and the layout visibly re-settles each time.
- Switching folder depth/tag/locale filters still re-settles correctly under both edge modes.
- Nothing throws in the console.

- [ ] **Step 8: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: wire edgeMode selector into Graph.vue's simulation/draw pipeline (OpenProject #1000)"
```

---

# Task 4: Synthetic nodes are non-navigable, visually distinct, excluded from clustering (OpenProject #1001)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`
  - `CATEGORICAL_PALETTE` area (after line 168): new `SYNTHETIC_NODE_COLOR` constant
  - `legendEntries` (lines 187–196)
  - `drawNodes` (lines 267–277)
  - `onCanvasClick` (lines 343–355)
  - `groupCentroids` (lines 395–413)
  - `applyClusteringForce` (lines 417–425)
  - `computeClusters` (lines 449–479)
  - `recomputeClusters` (lines 484–489)

**Interfaces:**
- Consumes: `node.synthetic` (Tasks 1–3).
- Produces: nothing new consumed elsewhere — last task touching `Graph.vue`'s simulation/draw code in this plan.

- [ ] **Step 1: Add the synthetic-node color constant**

After `CATEGORICAL_PALETTE` (line 168), before `const groupColors = new Map()`:

```js
/** Fixed neutral color for every synthetic node (OpenProject #997/#1001) -- deliberately outside
 *  `CATEGORICAL_PALETTE` so a synthetic folder/tag-hub marker never gets mistaken for a real group. */
const SYNTHETIC_NODE_COLOR = '#9e9e9e'
```

- [ ] **Step 2: Exclude synthetic nodes from the legend**

In `legendEntries` (lines 187–196), add the skip at the top of the loop:

```js
const legendEntries = computed(() => {
  const seen = new Map()
  for (const node of nodes.value) {
    if (node.synthetic) {
      continue
    }
    const key = groupKeyFor(node)
    if (!seen.has(key)) {
      seen.set(key, colorForGroup(key))
    }
  }
  return [...seen.entries()].map(([key, color]) => ({ key, color }))
})
```

- [ ] **Step 3: Draw synthetic nodes smaller**

In `drawNodes` (lines 267–277), size the arc off `node.synthetic`:

```js
function drawNodes() {
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.synthetic ? 3 : 5, 0, Math.PI * 2)
    ctx.fillStyle = node.color ?? '#888'
    ctx.fill()
  }
}
```

- [ ] **Step 4: Make synthetic nodes non-navigable**

In `onCanvasClick` (lines 343–355), bail out on a synthetic hit:

```js
function onCanvasClick(event) {
  const node = findNodeAt(event.clientX, event.clientY)
  if (!node || node.synthetic) {
    return
  }
  router.push(
    localizedPagePath(node.path, node.locale, {
      useLocales: siteStore.useLocales,
      primary: siteStore.locales.primary,
      forcePrefix: siteStore.locales.forcePrefix
    })
  )
}
```

(`onCanvasMouseMove`/the hover tooltip are unchanged — synthetic nodes carry `title`, so hovering one still shows a tooltip, which is correct: inert means non-navigable, not undiscoverable.)

- [ ] **Step 5: Exclude synthetic nodes from centroid and cluster computation**

In `groupCentroids` (lines 395–413), skip synthetic nodes alongside the existing `x === undefined` guard:

```js
function groupCentroids() {
  const sums = new Map()
  for (const node of nodes.value) {
    if (node.x === undefined || node.synthetic) {
      continue
    }
    const key = groupKeyFor(node)
    const entry = sums.get(key) ?? { x: 0, y: 0, count: 0 }
    entry.x += node.x
    entry.y += node.y
    entry.count += 1
    sums.set(key, entry)
  }
  const centroids = new Map()
  for (const [key, { x, y, count }] of sums) {
    centroids.set(key, { x: x / count, y: y / count })
  }
  return centroids
}
```

In `computeClusters` (lines 449–479), same guard in its own loop:

```js
function computeClusters() {
  const byGroup = new Map()
  for (const node of nodes.value) {
    if (node.x === undefined || node.synthetic) {
      continue
    }
    const key = groupKeyFor(node)
    const list = byGroup.get(key) ?? []
    list.push(node)
    byGroup.set(key, list)
  }

  const result = []
  for (const [key, groupNodes] of byGroup) {
    const color = colorForGroup(key)
    if (groupNodes.length >= 3) {
      const hull = polygonHull(groupNodes.map((n) => [n.x, n.y]))
      if (hull) {
        result.push({ key, color, hullPoints: padHull(hull, HULL_PADDING) })
        continue
      }
    }
    const cx = groupNodes.reduce((s, n) => s + n.x, 0) / groupNodes.length
    const cy = groupNodes.reduce((s, n) => s + n.y, 0) / groupNodes.length
    const maxDist = Math.max(...groupNodes.map((n) => Math.hypot(n.x - cx, n.y - cy)), 0)
    result.push({ key, color, circle: { x: cx, y: cy, r: maxDist + HULL_PADDING } })
  }
  clusters.value = result
}
```

- [ ] **Step 6: Zero out the clustering force's pull on synthetic nodes**

In `applyClusteringForce` (lines 417–425), replace the flat `0.05` strength with a per-node function:

```js
function applyClusteringForce() {
  if (!simulation) {
    return
  }
  centroids = groupCentroids()
  simulation
    .force(
      'clusterX',
      forceX((d) => centroids.get(groupKeyFor(d))?.x ?? 0).strength((d) => (d.synthetic ? 0 : 0.05))
    )
    .force(
      'clusterY',
      forceY((d) => centroids.get(groupKeyFor(d))?.y ?? 0).strength((d) => (d.synthetic ? 0 : 0.05))
    )
}
```

- [ ] **Step 7: Color synthetic nodes with the fixed neutral gray**

In `recomputeClusters` (lines 484–489):

```js
function recomputeClusters() {
  for (const node of nodes.value) {
    node.color = node.synthetic ? SYNTHETIC_NODE_COLOR : colorForGroup(groupKeyFor(node))
  }
  computeClusters()
}
```

- [ ] **Step 8: Manual verification in a real browser**

```bash
cd frontend
npm run dev
```

Navigate to `/_graph`. Confirm: synthetic folder/tag-hub nodes render smaller and in a consistent gray, never a group color; clicking one does nothing (no navigation, no console error); hovering one still shows its tooltip; the legend lists only real groups, never a synthetic marker; synthetic nodes sit at/near the visual center of the pages that connect to them rather than being dragged toward some group's centroid.

- [ ] **Step 9: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 10: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "fix: exclude synthetic nodes from navigation and clustering (OpenProject #1001)"
```

---

# Task 5: Combined-scenario unit tests for both synthetic edge builders (OpenProject #1002)

**Files:**
- Modify: `frontend/src/pages/graphFilters.test.js` (append new `describe` blocks)

**Interfaces:**
- Consumes: `buildPathHierarchyEdges`, `buildTagHubEdges` (Tasks 1–2, already implemented and unit-tested in isolation there).
- Produces: nothing new — this task hardens existing coverage with larger, mixed fixtures closer to a real wiki's shape than Tasks 1–2's single-purpose cases.

- [ ] **Step 1: Write the tests**

Append to `frontend/src/pages/graphFilters.test.js`:

```js
describe('buildPathHierarchyEdges: combined scenario (OpenProject #1002)', () => {
  it('produces exactly one synthetic node per distinct missing folder and one edge per parent-child pair, across a mixed real/synthetic tree', () => {
    const nodes = [
      { path: 'docs', title: 'Docs Index' }, // real page reused as its own folder node
      { path: 'docs/guides/intro' },
      { path: 'docs/guides/advanced' },
      { path: 'about' }
    ]
    const { syntheticNodes, edges } = buildPathHierarchyEdges(nodes)

    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs/guides'])
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'docs/guides', target: 'docs/guides/intro', type: 'path' },
        { source: 'docs', target: 'docs/guides', type: 'path' },
        { source: 'docs/guides', target: 'docs/guides/advanced', type: 'path' },
        { source: '', target: 'docs', type: 'path' },
        { source: '', target: 'about', type: 'path' }
      ])
    )
    // -> One edge per distinct parent-child pair, no more: 4 real pages climbing a shared tree
    //    produce exactly 5 edges once the shared `docs -> docs/guides` and `'' -> docs` legs are
    //    de-duped across every page that climbs through them.
    expect(edges).toHaveLength(5)
  })
})

describe('buildTagHubEdges: combined scenario (OpenProject #1002)', () => {
  it('produces exactly one hub per distinct tag and one edge per (page, tag) pair, across shared and multi-tagged pages', () => {
    const nodes = [
      { path: 'a', tags: ['guide', 'beginner'] },
      { path: 'b', tags: ['guide'] },
      { path: 'c', tags: ['beginner', 'reference'] },
      { path: 'd', tags: [] }
    ]
    const { syntheticNodes, edges } = buildTagHubEdges(nodes)

    expect(syntheticNodes.map((n) => n.path).sort()).toEqual([
      '__tag__beginner',
      '__tag__guide',
      '__tag__reference'
    ])
    expect(edges).toHaveLength(5)
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: '__tag__guide', target: 'a', type: 'tag' },
        { source: '__tag__beginner', target: 'a', type: 'tag' },
        { source: '__tag__guide', target: 'b', type: 'tag' },
        { source: '__tag__beginner', target: 'c', type: 'tag' },
        { source: '__tag__reference', target: 'c', type: 'tag' }
      ])
    )
  })
})
```

- [ ] **Step 2: Run the tests**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: PASS — Tasks 1–2 already implemented both builders correctly; this step confirms that holds under larger, mixed fixtures too, not just the isolated single-purpose cases. If either test fails, the failure is a real bug in Task 1's or Task 2's implementation (most likely the de-dup key or the `byPath` reuse check) — fix the implementation, not the test, then re-run.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/graphFilters.test.js
npx oxlint src/pages/graphFilters.test.js
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/graphFilters.test.js
git commit -m "test: add combined-scenario coverage for path/tag synthetic edge builders (OpenProject #1002)"
```

---

# Task 6: Design spec amendment (OpenProject #1003)

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md` (append new section at the end, after the existing "Out of scope" section)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Append the amendment**

Append to the end of `docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md`:

```markdown

## Edge-mode pivot (OpenProject #997) — supersedes the pure-link edge model above

The original 872 design above sources edges only from authored `pages.relations` and extracted
`pages.links`. In practice neither gets reliably authored across a whole real wiki, so a
lightly-linked wiki's graph rendered correctly, but uselessly, almost empty — confirmed by testing
the shipped 872–876 implementation.

**`edgeMode` is now a client-side selector**, entirely within `frontend/src/pages/Graph.vue` /
`frontend/src/pages/graphFilters.js` — no backend changes, since every field either mode needs
(`node.path`, `node.folder`, `node.tags`) is already in the existing endpoint's response.

- **`paths` (default)** — `graphFilters.js#buildPathHierarchyEdges`: every visible page connects to
  its immediate parent path segment, climbed to a synthetic root (`''`). A real page is reused as
  its own folder's node when one exists at that exact path; otherwise a `{ path, title, synthetic:
  true }` stand-in is synthesized. "Root fans out to everything" — a fully connected graph for free,
  even with zero authored relations/links.
- **`tags`** — `graphFilters.js#buildTagHubEdges`: one synthetic hub node per distinct tag
  (`path: '__tag__' + tag`); every page connects to the hub for **each** tag it carries (unlike
  874's clustering, which buckets a node under only its first tag for its color group).
- **`glossary`** — explicitly deferred until OpenProject #870 (Glossary epic) ships real term→page
  links. No placeholder/disabled UI slot for it.

The 872 endpoint's `relation`/`link` edges are unchanged and still fetched (`allEdges` in
`Graph.vue`) but are **not** wired into either mode's rendering — available to revisit as a future
third/fourth mode, not deleted.

**Synthetic nodes are inert**: excluded from `legendEntries`/`groupCentroids`/`computeClusters`
(874's grouping), the clustering force's per-node `.strength()` returns `0` for them, `onCanvasClick`
never navigates for one, and `drawNodes` renders them smaller (radius `3` vs `5`) in a fixed neutral
gray (`#9e9e9e`) rather than a group color.

**UI**: a second `w-btn-toggle` ("Connect by": Paths | Tags) alongside 874's existing grouping
toggle ("Group by": Folder | Tag) in `.graph-view-controls`, both bare-literal-label per this file's
existing `groupBy` toggle convention — no i18n for either toggle's option labels or the new
captions.

**Known pre-existing limitation, not introduced by this pivot**: a multi-locale path collision (the
same `path` value in two locales) already violates `computeVisibleSubset`'s and `forceLink`'s
assumption that `path` is globally unique across the visible node set (Feature 873) — out of scope
for #997.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md
git commit -m "docs: amend knowledge graph spec with the edgeMode pivot (OpenProject #1003)"
```

**Feature #997 status:** once Tasks 1–6 are all checked off and committed, close Tasks #998–1003 in OpenProject, then advance Feature #997's workflow state to "review" → verify (repeat Task 3/4's manual browser checks against the final committed state) → advance to "Tested", stopping short of "Closed" until this also merges to `scarlett` — matching how the previous session closed out Features 872–876.
