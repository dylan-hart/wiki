# Recommended comment changes: WP 3558 (creator/author search filter)

Code comments were not touched by the change itself. Apply these separately.

## Add

- `backend/models/search.ts`, on `SearchFilters`: `creatorId` is the page's first creator and
  `authorId` its last editor (the `pages.creatorId` / `pages.authorId` columns), both any-of lists
  of user ids, with `exclude*` counterparts. Deliberately not called `editor`, which is the editor
  type filter. Both columns are NOT NULL, so exclusion needs no NULL handling.
- `backend/modules/search/elasticsearch/search.ts`, in `ensureIndex`: `putMapping` on an existing
  index is what gives an index created before `creatorId`/`authorId` existed `keyword` mappings; left
  to dynamic mapping they would become analyzed `text` and a `term` on a hyphenated UUID would match
  nothing. Documents written before the change lack the fields until a rebuild, so a creator/author
  include filter finds nothing on them until then.
- `backend/modules/search/azure-search/search.ts` and `algolia/search.ts`: same rebuild caveat;
  `createOrUpdateIndex` / `setSettings` add the field and facet at the next `init()`.
