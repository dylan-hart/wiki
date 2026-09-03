# Decision Record: Reusing Existing Link-Tracking Data for Move-Time Relink

**Date:** 2026-09-03
**Status:** Decided — informs OpenProject #2452 (Epic #2424)
**Author:** Task #2451

## The question

Epic #2424 ("Move a page → update its links") scoped itself to rewriting internal links in-place
across referencing pages at move time, and specifically asked to check first whether the
page-relation/link tracking data already collected for the knowledge graph (`Graph.vue`,
`api/graph.ts`) is enough to build that on, rather than writing new link-parsing from scratch.
This audit traces that data end to end and answers the question.

## What already exists

- **`pages.links`** (`db/schema.ts`) is a `jsonb` array of internal-link **target page paths**.
  It is written by `models/rendering.ts#extractInternalLinks`, called from `Rendering#postProcess`
  on every page save (`createPage`, `updatePage`, and the async `queueRerender` job), and is
  **fully overwritten each time** — never hand-edited, never merged with a prior value.
- **`extractInternalLinks`** walks the page's **rendered HTML** (`$('a[href]')`, i.e. the `render`
  column's DOM, not the raw `content` source), skips fragment-only (`#...`), protocol-relative
  (`//...`) and any other-scheme (`http:`, `mailto:`, ...) hrefs, resolves what remains against
  the saving page's own folder (`pagePath.split('/').slice(0, -1)`), and stores the resulting
  **absolute page path only** — `url.pathname`, with the query/fragment discarded and the
  original href text (relative vs. absolute) discarded along with it.
- **`models/pages.ts#listBacklinks(siteId, targetPath)`** is already an index lookup over that
  column: a single `pages.links @> [targetPath]` jsonb containment query, used today by
  `GET /sites/:siteId/pages/:pageId/backlinks` (`api/pages/read.ts`) to answer "which pages link
  to this one," permission-filtered per row exactly the way `assembleGraph` filters graph nodes.
- **`api/graph.ts#assembleGraph`** builds the graph's `type: 'link'` edges from the very same
  `pages.links` column (`listAllForGraph`), plus a second, separate edge type from **authored**
  `pages.relations` (target paths a user explicitly picked via `PageRelationDialog.vue`, stored
  verbatim, never derived/overwritten by a render).
- Both `links` and `relations` targets are **bare paths with no locale tag**. `assembleGraph`
  resolves a target against the **source row's own locale** when building its node id
  (`docs/decisions/locale-translation-linking.md`'s same-path-by-convention rule), documented
  inline at `api/graph.ts:131-136` and `:174-177`. `listBacklinks`, by contrast, matches the
  literal path string **across every locale** on the site — it has no locale parameter at all.
  These two existing consumers of the same column already disagree on locale scoping; a relink
  pass reusing this data has to pick one deliberately rather than inherit an unexamined default.
- **`models/pages.ts#movePage` / `moveOnePageInTx` currently do no relinking at all** — confirmed
  by reading both directly: the move only touches `path`, `hash`, `locale`, `classification`,
  `title`, `authorId`, `updatedAt` and the `tree` entry. Neither the moved page's own
  `content`/`render`/`links`/`relations` nor any other page's are touched, matching the Epic's
  own "No relink logic currently found" note.

## Decision

**Reuse `pages.links` + `listBacklinks()` for candidate discovery; do not reuse it for the
rewrite itself, because it cannot be — it is derived, lossy metadata, not an editable index.**

Concretely, for #2452:

1. **Finding which pages reference a moved page is a solved problem already** — call
   `WIKI.models.pages.listBacklinks(siteId, oldPath)` (or a locale-aware variant of it, see Open
   Questions) exactly as the backlinks endpoint does today. No new discovery/parsing logic is
   needed for this half.
2. **Performing the rewrite is not covered by any existing data and needs new work.**
   `pages.links` only ever stored *that* a page links to `oldPath`, never *how* — no offsets, no
   original href text, no indication of relative-vs-absolute style, no anchor fragment. The only
   place that information still lives is the referencing page's raw `content`, in whatever editor
   format it was authored in (`markdown`, `asciidoc`, or `html` for `wysiwyg`/`code` —
   `CONTENT_TYPE_EDITORS` in `models/pages.ts`). A rewrite pass has to independently parse each
   referencing page's raw content, per format, to find and replace the actual href — this is new
   link-parsing, not a reuse of `extractInternalLinks` (which only ever reads `render`, never
   writes it, and was never meant to round-trip back into source text).
3. **The `links` recompute path is already correct and needs no new plumbing**: once a
   referencing page's `content` is rewritten and re-saved through the normal `updatePage` /
   `queueRerender` path, `extractInternalLinks` naturally recomputes that page's `links` entry to
   the new target on its own. #2452 does not need to touch `pages.links` directly for the pages it
   rewrites — only read it (via `listBacklinks`) to know which pages to visit.

## Open questions for #2452 (deliberately not resolved here)

- **Locale scoping of candidates.** Should a relink pass follow `listBacklinks`'s current
  cross-locale match, or `assembleGraph`'s same-locale-as-source convention? Silently picking
  either now, inside an audit WP, would be deciding real behavior under the guise of research —
  #2452 should make this call explicitly (and, if it diverges from `listBacklinks`'s current
  behavior, that method's own callers, e.g. the backlinks endpoint, are worth a second look for
  consistency).
- **Scope: extracted `links` only, or also authored `relations`?** The Epic's acceptance
  criteria says moving a page must update "all in-site referencing links, no dead links left
  behind." `pages.relations` (`PageRelationDialog.vue`) is a second page-path-referencing store
  with the same shape of staleness risk, and it is not content the reader edits directly, so it
  cannot be caught by "rewrite the raw content." If it's in scope, #2452 needs its own rewrite
  step (a plain field update, not content parsing); if it's out of scope, that should be
  explicit rather than silently uncovered.
- **The mover's own outbound relative links.** `extractInternalLinks` resolves a relative href
  against the *saving* page's own folder purely to compute the absolute target path for `links` —
  it does **not** rewrite the href text stored in `render`. A relative href written in a page's
  raw content (e.g. `../images/foo` from `docs/a`) keeps resolving relative to wherever that page
  currently lives; moving the page itself therefore risks breaking its *own* outbound relative
  links, a case distinct from "other pages that reference the moved page" and not obviously
  covered by "all in-site referencing links." Worth an explicit in/out-of-scope call in #2452.

## Consequence

#2452 does not need to build a new backlink-discovery mechanism — `listBacklinks` /
`pages.links` already are that, and stay the single source of truth for "which pages reference
path X." It does need new, editor-format-aware link-rewriting logic operating on raw `content`,
since no existing data structure preserves enough information to perform the rewrite mechanically
from `pages.links` alone.
