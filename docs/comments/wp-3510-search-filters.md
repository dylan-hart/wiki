# Recommended comment changes: WP 3510 (list-valued include/exclude search filters)

Code comments were not touched by the change itself. Apply these separately.

## Add

- `backend/models/search.ts`, above `SearchFilters`: the contract in one place. An empty or absent
  list is no constraint. Include lists: `path` any-of by prefix, `locales`/`editor`/`publishState`
  any-of, `tags` all-of. Exclude lists: a page is dropped when it matches ANY entry (a path prefix,
  one of the locales/editors/states, or carries any of the tags). Every engine implements exclusion
  natively so paging and totals stay exact; post-query filtering is rejected.
- `backend/modules/search/shared.ts`, above `buildSqlFilterConditions`: aliased `pages p`, shared by
  the `db` engine and semantic search so both hops of semantic search apply the identical filter.
  Two comments that lived at the old inline call sites belong here now: `escapeLikePattern` keeps
  the value literal while the trailing `%` makes it a prefix match, and `sql.param` is used because
  drizzle expands a bare array into a list of placeholders rather than one array value.
- `backend/modules/search/elasticsearch/search.ts` and `algolia/search.ts`: the tags loop lost its
  comment. Restore "ANDed clauses rather than an OR group: every named tag must be present"
  (Algolia's also cited `db/search.ts`'s `p.tags @>` containment).
- `backend/modules/search/elasticsearch/search.ts`, at `mustNot`: exclusions are `must_not`
  clauses beside the `filter` array, and are omitted entirely when empty.
- `backend/modules/search/azure-search/search.ts`, near `buildFilter`: include `tags` is any-of
  there while every other engine is all-of (pre-existing); the exclusion `not tags/any(...)` is
  "carries any of" and so agrees across engines.

## Correct

- `backend/models/semanticSearch.ts`, `queryChunks`: "Filter semantics mirror
  `modules/search/db/search.ts`'s, and every value is bound as a parameter" should now say the
  conditions come from `shared.ts#buildSqlFilterConditions`, the same builder the `db` engine uses.
- `backend/models/semanticSearch.ts`, `AnnSearchScope`: the per-field comments ("Prefix match, as in
  keyword search", "A page must carry every one of these") were dropped with the fields; they move
  to `SearchFilters`.
- `backend/modules/search/db/search.ts`, `suggestTitle`: still accurate ("`path`/`locales`/`tags`
  are deliberately not repeated"), and applies equally to the new `exclude*` lists.
