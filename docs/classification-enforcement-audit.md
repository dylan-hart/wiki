# Cross-surface classification enforcement audit

Feature [#1082](../../../work_packages/1082) "Cross-surface enforcement audit" walked every content
path that resolves or lists page content outside the direct page-view route, and checked whether it
independently enforces the same page rules — in particular the `CLASSIFICATION` match kind #1079/#1080
introduced, which is supposed to override every path/tag rule unconditionally. Per #1082's own
description, **the deliverable is this findings report, not fixes** — each gap found here is filed as
its own Bug under #1082 rather than patched inline, the same pattern the Aug 2026 comprehensive review
pass (#913–#989) used.

## Why this matters

`helpers/pageRules.ts`'s `CLASSIFICATION` match kind fails **closed** for its own purpose: a
`RulePageRef` with `classification: null` never matches a `CLASSIFICATION` rule, so an unknown
classification never benefits from a `CLASSIFICATION`-scoped ALLOW. But that same design is fail
**open** with respect to the epic's actual invariant ("classification always takes precedence... a
classification-based DENY overrides a path/tag ALLOW"): if a code path can't supply a page's real
classification and passes `null` instead, a `CLASSIFICATION` DENY rule on that page simply never
applies there — the page falls back to whatever plain path/tag rules say, which may well be ALLOW.
Every gap below is exactly this shape: a surface with a genuine (or effectively `null`) classification
gap, not a surface that got the polarity backwards.

## Surfaces audited

| Surface | Verdict | Notes |
| --- | --- | --- |
| Direct page view (`GET .../pages/:pageIdOrHash`) | Correct | The baseline every other surface is compared against — `mayOnPage()` with the real page row. |
| Postgres full-text search (`modules/search/db/search.ts`) | Correct | Selects `pages.classification` per row and passes the real value into `checkAccess()` before a hit is returned. Both `query()` and `suggestTitle()`. |
| Algolia / AWS CloudSearch / Azure Search / Elasticsearch (`modules/search/{algolia,aws-cloudsearch,azure-search,elasticsearch}/search.ts`) | **Gap** — [#1125](../../../work_packages/1125) | None of the four providers' index carries a classification field; each post-filters with a hardcoded `classification: null`, so a `CLASSIFICATION` DENY never applies to a hit from these engines. |
| Knowledge graph / page relations & backlinks (`api/graph.ts`, `models/pages.ts#listAllForGraph`) | **Gap** — [#1126](../../../work_packages/1126) | `GraphPageRow` and its `SELECT` simply omit `pages.classification`, even though the column sits on the same table six other fields are already pulled from. Not a "can't get the data there" limitation like search — just an omission. |
| Glossary term resolver (`models/glossary.ts#getCachedTerms`, #870) | **Gap** — [#1127](../../../work_packages/1127) | No permission check of any kind, not just no classification check — the resolved term→page link is cached instance-wide and served identically to every reader regardless of what they may read. The most severe finding of the four; predates #1079/#1080 entirely. |
| Transclusion (`block-include` → `GET .../pages/include`) | Correct | Fetches the real page row via `getPage()` and checks `mayOnPage('read:pages', ...)` against it — an include can never show more than a direct view of the same page would. |
| Sitemap (`GET /sitemap.xml`, `models/pages.ts#listPagesForSitemap`) | Correct | Selects `pages.classification` and filters through `rulesAllow()` against the guests group's real rules before a URL is listed. |
| RSS | N/A | No RSS/Atom feed route exists anywhere in `backend/controllers` or `backend/api` — `robots.txt` and `sitemap.xml` are the only two routes `controllers/seo.ts` registers. Nothing to audit. |
| MCP `get_page` / `update_page` / `create_page` (`mcp/tools/{getPage,updatePage,createPage}.ts`) | Correct | `getPage()`/`updatePage()`'s target both carry the real page row; `createPage()` deliberately checks against `classification: null` for a page that doesn't exist yet (the documented, correct treatment of a create check, same as the HTTP route). |
| MCP `search_pages` (`mcp/tools/searchPages.ts`) | Correct, but inherits the search gap above | Delegates straight to `WIKI.models.search.query()` — correct against the Postgres engine, subject to the same external-provider gap ([#1125](../../../work_packages/1125)) when a site is configured to use one. |
| MCP `list_navigation` (`mcp/tools/listNavigation.ts`) | **Gap** — [#1128](../../../work_packages/1128) | Shares the `tree`-table root cause below; already self-flagged inline during #1079/#1080's own implementation. |
| File manager tree browsing, folder listing, `block-index` listing (`api/tree.ts`, 3 call sites) | **Gap** — [#1128](../../../work_packages/1128) | The `tree` table carries no `classification` column at all; all three call sites (plus MCP `list_navigation` above) pass a hardcoded `classification: null`. Already self-flagged inline during #1079/#1080's own implementation — this ticket makes it one tracked, actionable gap instead of four scattered comments. |
| REST `GET /sites/:siteId/pages` (list pages) | N/A | Not implemented — the route always answers `[]` (its own schema description says so). Nothing to leak. |
| Comments (`models/comments.ts`) | Correct | Every admin-facing page-ref query (`pageRefsForSite`, `getWithPage`) already selects `pages.classification` alongside `path`/`locale`/`tags`. |
| Assets (`api/assets.ts`, `controllers/files.ts`) | Correct | Threaded through the same `RulePageRef` construction sites as the rest of #1079/#1080's rollout; spot-checked, not found lacking. |
| Auto-generated navigation (`GET .../navigation/:navId` on an `auto`/`mixed` menu, `models/navigation.ts#generateFromTree`) | Correct (fixed by [#2155](../../../work_packages/2155)) | Unlike the `tree`-table gap above, `generateFromTree()` already left-joins `pages` for `icon`; it now also selects `pages.tags`/`pages.classification` and runs `checkAccess()` per candidate with the real values, so a `CLASSIFICATION` DENY reaches this surface same as a direct page view. |

## Known gaps from this pass

Four gaps survived this audit and are their own Bugs under #1082 rather than resolved here — see each
bug for the full analysis instead of duplicating it in this table:

- **External search providers** — Algolia, AWS CloudSearch, Azure Search, Elasticsearch post-filter
  search hits with a hardcoded `classification: null` because none of their indexes carry the field.
  See [#1125](../../../work_packages/1125).
- **Knowledge graph** — `listAllForGraph()` omits `pages.classification` from its own `SELECT` despite
  the column being available on the same table. See [#1126](../../../work_packages/1126).
- **Glossary term resolver** — no permission check of any kind, the most severe finding; predates
  #1079/#1080. See [#1127](../../../work_packages/1127).
- **Tree-based listings** — the `tree` table has no `classification` column, so file manager browsing,
  folder listing, `block-index` listings, and MCP `list_navigation` all pass a hardcoded
  `classification: null`. See [#1128](../../../work_packages/1128).

## Extending this audit

A later feature that adds a new way to resolve, list, or excerpt page content outside the direct
page-view route should add a row here (or a follow-up audit) before shipping, checking specifically
whether the surface's permission check receives the page's real `classification` rather than a
hardcoded or defaulted `null` — that default is the shape every gap above takes.
