# Semantic/vector search with multi-hop question support

Design for Epic #3050. Brainstormed 2026-09-13 per the Epic's own instruction to run a full
`superpowers:brainstorming` pass before any Feature/Task breakdown.

## Idea, resolved

Add semantic (embedding-similarity) search alongside the existing full-text search engines, with a
"multi-hop" retrieval mode that chains a second embedding query off the first hop's best result to
surface pages related by meaning rather than literal keyword overlap — e.g. a query about "database
connection pooling" surfacing a page about "Postgres tuning" that never mentions "pooling" itself,
because the pooling page's best-matching passage is itself close, in embedding space, to a passage in
the tuning page.

This is **not** a RAG/question-answering feature. The output is always a ranked list of pages/passages,
never a generated prose answer. There is no LLM call anywhere in this design.

## Scope decisions

These were each resolved as an explicit choice during brainstorming, not left as open questions:

1. **"Multi-hop" = chained vector retrieval**, not graph traversal over the existing
   `relation`/`link` edges `api/graph.ts` already assembles. The knowledge graph and this feature are
   unrelated; a future epic could combine them, but this one doesn't.
2. **Ranked results only** — no LLM synthesis step, no generated answer, no citations-in-prose. A
   result is a page + matched passage + score, same shape as today's full-text search result.
3. **Embeddings are generated locally**, no external API, no per-page cost, works fully offline —
   consistent with this app's existing offline-capable posture (icons already support an `offline`
   config flag).
4. **Independent of the pluggable search-engine system** (`modules/search/`: algolia,
   aws-cloudsearch, azure-search, elasticsearch, db). Semantic search is always backed directly by
   Postgres/pgvector, available regardless of which engine handles full-text search. It is not a
   capability of the `db` `SearchModule` and does not touch `ExternalSearchModule`.
5. **Chunked (passage-level) embeddings**, not one vector per page — needed both for precise
   result excerpts and to give the multi-hop chain a passage, not a whole page, to hop from.
6. **A separate mode/toggle in the UI**, not blended into today's keyword results. Keyword search's
   behavior and performance are completely unaffected.
7. **Automatic, fixed hop count** (2 hops) — no per-result "find related" action, no adaptive
   hop-count heuristic.
8. **Graceful degradation when pgvector is unavailable** — semantic search hides itself rather than
   failing boot or breaking migrations. See "Schema & pgvector availability" below for how that
   interacts with the migration system.
9. **Local model runtime: `@xenova/transformers`** (pure JS/WASM, ONNX inference, no Python, no
   native compile step), running `Xenova/all-MiniLM-L6-v2` (384-dim sentence embeddings, ~90MB,
   CPU-friendly, a standard and widely-used choice in this ecosystem).

## Data model

### `pageEmbeddingChunks`

Deliberately **not** declared in `db/schema.ts` / managed by `drizzle-kit generate` — see "Schema &
pgvector availability" below for why. Conceptually:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid, PK | |
| `pageId` | uuid, FK → `pages.id` `ON DELETE CASCADE` | Deleting a page deletes its chunks |
| `chunkIndex` | integer | Position within the page, for stable re-generation |
| `chunkText` | text | The passage itself, for building the result excerpt |
| `embedding` | `vector(384)` | pgvector column, matches the model's output dimension |
| `updatedAt` | timestamptz | |

No `siteId` or `locale` column: both are already implied by `pageId` (a page row is already
site-scoped and locale-specific — a translation is a separate page row with its own id). Anything
needing site/locale/path/tags/classification for permission filtering joins through `pages`,
matching `modules/search/shared.ts`'s `VisibilityRef` shape exactly rather than duplicating those
columns.

Index: `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` — cosine distance, matching how a
sentence-embedding model's similarity is normally compared.

### Chunking

Page content is rendered to plain text through the existing render pipeline (not re-parsed from raw
markdown), then split into ~250-word passages with a ~50-word overlap. The embedding call itself
truncates to the model's own max token count (256 tokens for MiniLM) if a chunk still runs long after
word-splitting — chunking targets a reasonable passage size, the model's tokenizer is the real safety
net.

### Freshness

A page save enqueues an async job (`tasks/workers/embed-page.ts`, CPU-bound like the existing
worker-thread jobs) that:

1. Deletes every existing `pageEmbeddingChunks` row for that `pageId`.
2. Re-renders, re-chunks, re-embeds, and inserts fresh rows.

No partial-update bookkeeping — full delete-and-replace per page, same correctness model the search
engines' own re-index-on-change already uses. The job no-ops immediately (and cheaply) if semantic
search is unavailable (see below), rather than queuing work that can never complete.

## Schema & pgvector availability

`pgvector` is a Postgres extension (`CREATE EXTENSION vector`) that not every host permits a
non-superuser role to install. Graceful degradation (scope decision 8) means the ABSENCE of pgvector
must never fail a migration or block boot — which is incompatible with putting
`pageEmbeddingChunks` through the normal `db/schema.ts` → `drizzle-kit generate` → migration-must-
succeed pipeline every other table uses.

**Resolution:** this table and its extension are managed imperatively at boot, not through Drizzle's
migration system:

- After the normal Drizzle migrations run, `core/db.ts` attempts, in a try/catch:
  `CREATE EXTENSION IF NOT EXISTS vector`, then `CREATE TABLE IF NOT EXISTS ...` and
  `CREATE INDEX IF NOT EXISTS ...` for `pageEmbeddingChunks`, as raw SQL.
- Success or failure is recorded once as a boot-time capability flag (e.g.
  `WIKI.capabilities.semanticSearch: boolean`), read by every other part of this feature
  (`models/semanticSearch.ts`, the embed-page worker, the API route, and a site-info field the
  frontend reads to decide whether to show the toggle at all) rather than each of them independently
  probing for the extension.
- `models/semanticSearch.ts` queries this table via Drizzle's raw `sql` template rather than the
  schema-DSL query builder, since the table isn't part of the generated schema.

This is a deliberate exception to the "all schema changes go through `db/schema.ts`" rule in
CLAUDE.md, justified by the extension's genuine optionality, and should be recorded as such in
`docs/variances.md` when implemented.

## Multi-hop retrieval algorithm

Given a query string, an actor, a `siteId`, and pagination (`limit`, `offset`):

1. **Embed the query** once, using the same local model → query vector `Q`.
2. **Hop 1**: ANN search — `ORDER BY embedding <=> Q LIMIT 50` (a `SEMANTIC_SCAN_CAP` constant,
   analogous to `shared.ts`'s `SCAN_CAP`/`OVERFETCH_HARD_CAP`), joined to `pages` for
   `path`/`locale`/`tags`/`classification`, scoped to `siteId` and (unless cross-locale search is
   explicitly requested — out of scope for v1; always same-locale as the query) the caller's locale.
3. **Filter visible**: reuse `modules/search/shared.ts#filterVisible` unchanged, against the same
   `VisibilityRef` shape, so semantic search is never a way around page permissions — exactly the
   same guarantee full-text search already gives.
4. **Pick hop-2 seeds**: the top 3 distinct pages (by each page's single best/lowest-distance chunk)
   from the hop-1 visible results.
5. **Hop 2**: for each seed page's best chunk, run the same ANN search using THAT CHUNK's own
   embedding vector as the query (not the original text) — this is the actual "semantic hop": moving
   from "what matches the literal query" to "what matches the meaning of the best thing the literal
   query already found." Overfetch + `filterVisible` exactly as in hop 1.
6. **Merge & rank**: pool hop-1 and hop-2 visible results, dedupe to one row per page (each page's own
   best chunk across whichever hop(s) it appeared in). A hop-2-only page's distance gets a fixed
   penalty added (`+0.1`, tunable) before sorting, so a genuine direct (hop-1) match always outranks
   an equally-distant hop-2-only one — reflecting that it really is one step further removed. Sort by
   the (possibly penalized) distance ascending.
7. **Paginate & shape**: apply `offset`/`limit` to the merged, ranked, deduped list;
   `totalHits`/`totalHitsApproximate` computed the same way `shared.ts#toSearchPagesResult` already
   does (from the visible set alone, `totalHitsApproximate` true whenever permission filtering
   actually dropped a row the ANN search had counted). Each result carries which hop it was found at
   (`1` or `2`) so the UI can show "related via" for a hop-2 result.

No result synthesis, no LLM call, anywhere in this pipeline.

## API

New route, alongside the existing full-text one in `api/pages/read.ts`:

```
GET /_api/sites/:siteId/pages/search/semantic?query=...&locale=...&limit=...&offset=...
```

Same permission/schema conventions as `pages/search` (`No route-level permissions:` comment, since
page-scoped visibility is enforced per-row via `filterVisible`, not by the global `preHandler`).
Response schema mirrors `SearchPagesResult`/`SearchResult`, extended with a `hop: 1 | 2` field per
result.

Availability is exposed as a boolean on the existing `GET /_api/sites/:siteId/current` (or
equivalent site-info) response — e.g. `features.semanticSearch` — read directly off
`WIKI.capabilities.semanticSearch` AND a site-level admin toggle (see below); both must be true.

## Admin settings

A new boolean site setting, `search.semanticEnabled`, alongside the existing search engine config in
`AdminSearch.vue` (which CLAUDE.md already documents as an embedded-setting-save-affordance example —
this fits the same pattern, a setting embedded in a page whose primary content is something else).
Defaults to `true` whenever `WIKI.capabilities.semanticSearch` is true at first boot, `false`
(and disabled/hidden in the UI) when the capability itself is false, with a message explaining why
(pgvector not available on this database).

A manual "Rebuild embeddings index" admin action, matching the existing per-engine `rebuild()`
capability search engines already have, for recovering from a model change or corrupted data —
re-runs the embed-page job for every page in the site.

## Frontend UI

`Search.vue`'s full results page gets a two-way mode toggle — "Keyword" (today's behavior, default)
and "Semantic" — hidden entirely when `siteStore.features.semanticSearch` is false. Switching modes
re-queries against the new endpoint instead of `pages/search`. `HeaderSearch.vue`'s live preview
panel is unaffected — it stays keyword-only, since it's meant to stay fast and lightweight, and
semantic search's local-model inference latency doesn't fit debounced-as-you-type search well.

A semantic result row uses the same row shape as a keyword result (path, title, matched excerpt), plus
a small "related" indicator for a hop-2 result — the one piece of UI surface unique to the multi-hop
mechanic.

## Testing

- Pure unit coverage for chunking (`helpers/textChunking.ts`) and the merge/rank/dedupe/penalty logic
  in `models/semanticSearch.ts` (the hop-1/hop-2 combination is pure once given canned distance
  values — no need for a real model or a real database to test the ranking math itself).
- DB-backed tests (`hasTestDatabase()`-gated, per the existing backend testing convention) for the
  actual pgvector round trip, `filterVisible` integration, and the availability capability flag,
  skipped cleanly wherever the test database doesn't have pgvector installed.
- The local model itself is not mocked in unit tests — `helpers/embeddings.ts`'s `embedText` is the
  seam that gets stubbed, matching how Sharp-dependent code is tested today.

## Out of scope (this epic)

- Any LLM-generated answer, citation, or summary.
- Cross-locale semantic search (a query in one locale surfacing another locale's pages).
- Per-engine native vector search (Elasticsearch/Azure AI Search's own vector capabilities) — pgvector
  only, regardless of the configured full-text engine.
- Graph traversal over `relation`/`link` edges as part of "multi-hop" — that's the existing knowledge
  graph feature and stays separate.
- A manual, per-result "find related" action, or an adaptive/heuristic hop count.
