# Handoff: Knowledge Graph edge-mode pivot (OpenProject #997)

**Start a fresh session for this** — the `superpowers` plugin (`obra/superpowers`) was installed
mid-session last night and needs a session restart to load. Use `superpowers:writing-plans` →
`superpowers:subagent-driven-development` for the implementation (this repo's global CLAUDE.md
standing preference — always choose Subagent-Driven without asking).

Repo: `dylan-hart/wiki`, worktree `/Users/dylangles/git/dylan.hart/wiki-merge-review-2`, branch
`integration/merge-review-2` (pushed, HEAD `f0f4d524`). Pull first.

## Where OpenProject Epic #848 stands

All 5 original features (872–876, WPs #880–906) are implemented, tested (unit + two rounds of
real-browser Playwright verification), and closed in OpenProject, on this branch, pushed — but
**not yet merged to `scarlett`** and Features are at status "Tested" (not "Closed"/released) —
that was a deliberate stop short of full release pending your review. Epic #848 itself sits at
"Specified" — its `get_workflow_state` can't cleanly progress further because its direct children
(872–876) are Feature-type work packages, not Task-type; that's pre-existing structural debt in
how #848 was originally created, not something introduced by this work.

Two small bugs were found and fixed live this morning while Dylan was testing, both already
committed and pushed (`da99900a`, `f0f4d524`) — a repeat of the same "falsy-zero" bug class found
during Feature 875 (`filters.folderDepth === 0` / `node.x === 0` wrongly treated as "unset").

## The pivot: edges shouldn't depend on authored links

Dylan tested the shipped graph and found it showed no edges — correctly diagnosed as: the original
design (Feature 872) sources edges only from explicit page relations (`pages.relations`, the
"Related Pages" dialog) and in-content markdown links (`pages.links`, extracted at save time).
Neither gets reliably authored across a whole real wiki, so a lightly-linked wiki's graph is
correctly, but uselessly, almost empty.

Decision (Dylan's, after a design discussion — see the conversation on OpenProject #997's
description for the full framing): the graph's **edge source becomes a selectable mode**, not a
single hardcoded model:

- **`paths` (default)** — path-hierarchy edges. "Root fans out to everything": every page connects
  to its immediate parent folder segment, chained up to a synthetic root, so even a wiki with zero
  authored links renders a fully connected graph for free.
- **`tags`** — tag-hub edges. One synthetic hub node per distinct tag; every page connects to the
  hub for **each** tag it carries (not just the first, unlike Feature 874's clustering, which picks
  one tag per node for its color bucket — this is a different, additive concern).
- **`glossary`** (auto-linked term definitions) — explicitly **deferred**, not built now. It's the
  natural third mode once OpenProject #870 (Glossary epic, already `blockedBy` #848) ships and
  starts generating real term→page links; #870's forward-reference note in #848's own description
  already anticipated this. Do not build a placeholder/disabled UI slot for it — just leave it out
  and add the mode when #870's data actually exists.

**The existing Feature 872 endpoint and its `relation`/`link` edges are not being deleted.** They
stay exactly as shipped (`backend/api/graph.ts`, `pages.relations`/`pages.links`) — just not wired
into the graph's default rendering for now. `paths` and `tags` are **entirely client-side**: every
field either needs (`node.path`, `node.folder`, `node.tags`) is already in the existing endpoint's
response, so **no backend changes, no new OpenProject work under #872, no migration** — this is
scoped to `frontend/src/pages/Graph.vue` and `frontend/src/pages/graphFilters.js` only.

## OpenProject tracking already created

**Feature #997** ("Edge source modes: paths & tags (glossary deferred to #870)"), parented under
Epic #848, status "New" — read its full description for the complete framing (it's the same content
as this handoff's pivot section above, kept in sync).

Child Tasks, all status "New", no work started:

| WP | Task |
|---|---|
| #998 | Path-hierarchy synthetic nodes + edges |
| #999 | Tag-hub synthetic nodes + edges |
| #1000 | `edgeMode` selector wired into `Graph.vue`'s simulation/draw pipeline |
| #1001 | Synthetic nodes: non-navigable, visually distinct, excluded from clustering |
| #1002 | Unit tests for path/tag synthetic edge builders |
| #1003 | Design spec amendment (`docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md`) |

No implementation plan doc exists yet for this Feature — that's the new session's first job, via
`superpowers:writing-plans`.

## Design notes worth carrying into the plan (from working through this before being told to stop)

These are **not committed anywhere** — pure design reasoning to save the next session some
rediscovery, not a spec to follow verbatim:

- **`buildPathHierarchyEdges(nodes)`** (→ `graphFilters.js`): for each node, climb its path segment
  by segment up to `''` (root), calling `ensureFolderNode(path)` at each level — reuse a REAL page's
  node if one exists at that exact path (so an index-style page at `docs` doesn't get a duplicate
  dot next to a synthetic `docs` folder marker), otherwise synthesize `{ path, title, synthetic:
  true }`. De-dup edges via a `Set` keyed on `"parent child"` so climbing from many sibling pages
  under the same folder doesn't produce duplicate edges — cheap to always climb every node fully to
  root rather than trying to short-circuit on "already wired," given the spike's confirmed scale
  (low hundreds to low thousands of pages).
- **`buildTagHubEdges(nodes)`**: one synthetic hub per distinct tag (`path: '__tag__' + tag`), an
  edge from each hub to every page carrying that tag. Simpler than paths — no chaining, no root.
- **Multi-locale path collision, pre-existing, not new**: if a site has multiple locales and a page
  path like `docs/intro` exists in both `en` and `fr`, both the existing `computeVisibleSubset`
  (`visiblePaths = new Set(...)`) and `forceLink().id((d) => d.path)` already assume `path` is
  globally unique across the whole visible node set — a latent limitation from Feature 873, not
  something this pivot introduces. Worth flagging to Dylan rather than silently working around;
  out of scope to fix as part of #997.
- **Synthetic nodes need to be inert everywhere they'd otherwise cause errors or nonsense**: no
  `router.push` on click (`onCanvasClick` must check `node.synthetic` first), excluded from
  `legendEntries`/`groupCentroids`/`computeClusters` (Feature 874's grouping code reads
  `node.folder`/`node.tags`, which synthetic nodes don't meaningfully have), and the clustering
  force's `.strength()` needs to become a per-node function returning `0` for synthetic nodes
  (currently a flat `0.05`) rather than fighting to keep them out of `centroids.get(...)` cleanly.
  `drawNodes`/`drawLabels` can keep iterating the full node list unchanged (synthetic nodes still
  render — smaller radius, a fixed neutral gray, was the plan — and still show a hover tooltip via
  the same `node.title` the template already reads, since synthetic nodes carry a `title`).
- **Re-settling on every mode/filter change is expected, not a bug**: synthetic nodes are freshly
  constructed objects every time `buildPathHierarchyEdges`/`buildTagHubEdges` runs, so they lose
  `x`/`y` on every `activeFilters` change too (not just an `edgeMode` switch) — consistent with this
  codebase's own already-accepted precedent (Feature 875's code comment: "a node re-added after
  being filtered back in loses whatever x/y/velocity it had before removal... re-settling is the
  explicitly wanted behavior, not a bug to work around"). Don't over-engineer synthetic-node
  identity/position caching across calls unless Dylan asks for it after seeing it in the browser.
- **UI**: a second `w-btn-toggle` next to Feature 874's existing `groupBy` toggle, clearly
  distinguished (e.g. a small "Group by" / "Connect by" caption above each), matching the existing
  file's plain-literal-label convention (the current `groupBy` toggle uses bare `'Folder'`/`'Tag'`
  strings, not `t()` — no i18n exists for these controls yet, follow that precedent rather than
  introducing i18n for only the new control).

## What the new session should actually do

1. Read `docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md` (original spec) and
   OpenProject Feature #997 + Tasks #998–1003 in full.
2. `superpowers:writing-plans` a plan for #997, mapped onto #998–1003 the same way last night's
   plan mapped onto #880–906 (see `docs/superpowers/plans/2026-08-20-knowledge-graph-view.md` for
   the format/fidelity to match).
3. `superpowers:subagent-driven-development` to implement it — real TDD where the logic is
   deterministic (#998, #999, #1002), verify in a real browser before calling #1000/#1001 done
   (Dylan is actively testing this feature, unlike last night's fully-unattended run).
4. Update `docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md` with the amendment
   (#1003) as part of the same pass, not a follow-up.
5. Close #998–1003 and advance #997 the same way the previous session closed out 872–876 (see this
   worktree's git log for the pattern: unit tests pass → close Task → all Tasks closed → Feature
   workflow state advances to "review" → verify → advance to "Tested", stopping short of "Closed"
   until this also gets merged to `scarlett`).
