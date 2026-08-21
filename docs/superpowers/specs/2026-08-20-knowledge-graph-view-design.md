# Interactive Knowledge Graph View — Design

**Epic:** OpenProject #848. **Features covered:** #872 (backend endpoint), #873 (graph component), #874
(clustering & color), #875 (drill-down filters), #876 (placement). Spike #871 already resolved edge
sources, rendering approach, and reader-facing placement — this spec builds on those decisions rather
than re-litigating them.

## Scope

Global graph only — the whole wiki (one site at a time), opened as its own view. Obsidian's *local*
graph (a mini "related pages" widget embedded while reading a page) is explicitly out of scope; if
wanted later, it's a separate future epic.

## Architecture: fetch once, filter live in the browser

The backend returns the *entire* permitted graph for the current site (all locales) in one response.
Every drill-down filter and every re-cluster/re-color operation after that happens entirely
client-side, against data already in memory — no round trip per filter tweak. This is what makes
"re-clusters live as you drill down" actually feel live, and it's viable specifically because the
spike established real-world scale (low hundreds to low thousands of pages) is small as JSON.

**Design note — "site" is not a filter.** The epic's scope list includes "site" among the drill-down
filter dimensions, but also says the graph defaults to one site at a time. Those two statements are in
tension: within a single loaded graph there is only ever one site value, so filtering by it is
meaningless. Wiki.js 3.x also has no site-switcher UI anywhere else in the app — switching sites means
navigating to a different hostname. Resolution: **drop "site" as both a filter dimension (875) and a
grouping/color dimension (874).** The graph always reflects whatever site the browsing session is
currently on; there is no in-view site switcher. Locale and tag and folder depth remain genuine live
filters, since the endpoint fetches all locales for the current site in one response.

## 872 — Backend: graph data endpoint

**Storage.** Add a `links` jsonb column to `pages` (`backend/db/schema.ts`), holding the internal-link
target paths extracted from rendered content. Computed in `backend/models/rendering.ts`'s existing
save-time `cheerio.load()` post-processing pipeline, as a new `extractInternalLinks($, pagePath)` step
sibling to `anchorHeadings`/`extractText`. This runs in Node, not a browser, so it ports (rather than
reuses as-is) the internal/external resolution logic from `frontend/src/renderers/markdown.js`'s
`isExternalHref`, taking `pagePath` as an explicit parameter the way `fileSrc` already does in that
file.

**Endpoint.** `GET /_api/sites/:siteId/graph`, matching the existing `sites/:siteId/...` route
convention (e.g. `sites/${id}/notifications/unread-count`). No filter query params — everything the
session can read for that site, across all locales, in one response.

**Payload shape:**
```
nodes: [{ path, locale, title, icon, tags: string[], folder }]   // folder = path's first segment
edges: [{ source: path, target: path, type: 'relation' | 'link', label? }]
```
`relation` edges come from `pages.relations` (`{ pos, label, caption, icon, target }` — `target` is
already a page path); `label` carries through. `link` edges come from the new `links` column,
unlabeled.

**Permission filtering.** Per-page `mayOnPage(req, 'read:pages', page)` check before a page becomes a
node — this is a page-rule permission, so it's checked in the handler, not `config.permissions`,
per the page-permission conventions (comment the route "No route-level permissions:" accordingly). An
edge is dropped if either endpoint isn't in the resulting visible node set.

**Tasks:**
1. Add `links` jsonb column to `pages` in `db/schema.ts`; run `npm run db-generate`, commit the
   migration.
2. Add `extractInternalLinks($, pagePath)` to `backend/models/rendering.ts`'s save pipeline; store
   resolved internal target paths into `links`.
3. Implement `GET /_api/sites/:siteId/graph`: gather the site's pages (all locales) with their
   `relations` + `links`, permission-filter per page via `mayOnPage`, assemble the nodes/edges
   response.
4. Route schema + Swagger docs (summary, tags, response schema); register any new shared `$ref` in
   `api/schemas/`.
5. Backend test: pure-unit test of the node/edge assembly + permission-filter logic against a fixture
   page list with mixed permissions — extract that logic into a plain function so it needs no `WIKI`
   global or database.

## 873 — Frontend: force-directed graph component

**New dependencies** (`frontend/package.json`): `d3-force`, `d3-quadtree`, `d3-zoom`, `d3-drag`,
`d3-selection`. Note `frontend/package.json` currently has no `d3` dependency at all — `d3` was never
carried into the 3.x conversion; the dead `AdminPagesVisualize.vue` file is not a starting point.

**Rendering.** Canvas, not per-node SVG DOM (per the spike's scale decision) — a `<canvas>` filling
the view, driven by a `d3-force` simulation (`forceLink`, `forceManyBody`, `forceCollide`,
`forceCenter`). Redrawn each simulation tick: edges first, then cluster sector hulls (874 layers this
in), then node dots, then labels once zoomed in enough to read them.

**Pan/zoom.** `d3-zoom` attached to the canvas element; its transform is applied to the canvas context
before each draw.

**Hit-testing.** Canvas has no per-node DOM to click, so build a `d3-quadtree` from current node
positions each tick and use `quadtree.find(x, y, radius)` to resolve a click or hover to a node.
Click navigates (router push) to that page's path; hover shows a small tooltip with the node's title.

**Placement in the codebase:** a new routed page, `frontend/src/pages/Graph.vue`, rendered inside
`MainLayout` (reader-facing shell — see 876).

**Tasks:**
1. Add the five `d3-*` packages to `frontend/package.json`.
2. `frontend/src/pages/Graph.vue`: full-viewport canvas, fetches `sites/{siteId}/graph` on mount.
3. Simulation setup (`forceLink`/`forceManyBody`/`forceCollide`/`forceCenter`) and the tick → redraw
   loop.
4. Canvas draw function: edges → sector hulls (accepts a "clusters" input so 874 can layer on without
   restructuring the draw call) → node dots → labels.
5. `d3-zoom` pan/zoom wiring.
6. `d3-quadtree` hit-testing: click-to-navigate, hover tooltip.
7. Component test(s): mount with fixture node/edge data, assert the simulation initializes and the
   canvas element exists without throwing. Note: asserting actual pixel output is out of practical
   reach for a unit test — this is a real testing-strategy limitation, not an oversight.

## 874 — Frontend: clustering & color coding

**Grouping dimension:** folder or tag (site dropped — see architecture note above). A selector lets
the viewer switch between them.

**Color assignment:** categorical palette per group, chosen per the `dataviz` skill's palette
guidance at implementation time rather than picked in this spec.

**Visual clustering force.** Link/charge/collision forces alone won't produce visually coherent
clusters — nodes need an additional pull toward their group. Add a low-strength `forceX`/`forceY` per
node, targeting a running centroid for that node's group, blended into 873's simulation.

**Sectors (Obsidian-style, confirmed — not just node-color).** For each visible group with ≥3 nodes,
compute a translucent convex hull (`d3.polygonHull`, padded outward so it visually contains the node
dots rather than passing through their centers) and draw it behind the nodes/edges layer. Groups of
1–2 nodes (no hull possible) get a small padded circle/ellipse instead.

**Recompute triggers:** hulls and centroids recompute whenever the visible node set changes (a filter
from 875) or the grouping dimension changes.

**Tasks:**
1. Grouping-dimension selector (folder | tag).
2. Categorical color assignment per group, per the `dataviz` skill.
3. Per-group centroid force layered into 873's simulation.
4. Convex-hull sector computation with the ≥3-node / 1–2-node fallback.
5. Recompute wiring on visible-set change and grouping-dimension change.
6. Legend: group → color mapping.

## 875 — Frontend: drill-down filter controls

**Filters:** tag (multi-select chips), folder depth, locale (dropdown, shown only if
`siteStore.locales.showMenu` — mirrors the existing locale-selector gating in `HeaderNav.vue`/
`MainLayout.vue`). "Site" dropped — see architecture note.

**Options source:** each filter's available values are derived from the already-loaded node set
client-side — no separate endpoint.

**Behavior:** the visible node set is the AND of all active filters; an edge is hidden if either
endpoint isn't visible. Filter changes feed both 873 (removed nodes exit the simulation so the
remainder re-settles, rather than just being drawn hidden) and 874 (hulls/colors recompute against the
new visible set).

**Tasks:**
1. Filter panel UI: tag chips, folder-depth control, conditional locale dropdown.
2. Derive filter options from the loaded node set.
3. Compute visible node/edge subset as the AND of active filters.
4. Wire filter changes into 873's simulation (add/remove nodes) and 874's recompute.
5. "Clear filters" control.

## 876 — Placement & entry point

Icon button in `HeaderNav.vue`, same row and pattern as New Page / File Manager / Inbox (`w-btn` +
icon + `to="/_graph"` + `w-tooltip`), gated the same way as the existing "Browse" button (reachable by
anyone who can browse the wiki — not an admin-only control, per the reader-facing decision).

Route `/_graph` (underscore-prefixed, matching the existing utility-route convention alongside
`/_inbox` — this namespace can't collide with a real wiki page path), lazy-imported in
`frontend/src/router/routes.js`, rendered inside `MainLayout`.

**Tasks:**
1. Add `/_graph` to `routes.js`, lazy-imported, `MainLayout`.
2. Icon button in `HeaderNav.vue` following the New Page/File Manager/Inbox pattern, gated like
   "Browse".
3. Pick a literal Iconify reference for the icon and run `npm run icons` (build-time inlining
   convention).
4. i18n label/tooltip string in `backend/locales/en.json`.

## Sequencing

871 (spike, done) → 876 and 872 can start in parallel (independent) → 873 depends on 872's payload
shape → 874 layers onto 873's simulation/draw loop → 875 depends on both 873 (simulation add/remove)
and 874 (recompute hooks).

## Out of scope

- Local/embedded graph mode (see Scope above) — future epic if wanted.
- Glossary-generated edges (OpenProject #870) — explicitly deferred as a follow-on from 870 once this
  epic's edge-extraction pipeline (872) exists for it to hook into; #870 is set `blockedBy` #848 in
  OpenProject already.
- A site filter/switcher inside the graph view (see architecture note) — consistent with the rest of
  the app having no site-switcher UI.
