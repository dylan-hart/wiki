# Comment changes for OpenProject #3518 (Search.vue filter rows)

Recommended only; none of these were applied to the code.

## `frontend/src/pages/Search.vue`

- Template comment above `.layout-search-sd` ("Shown in both modes: Path/Tags/Locale/Editor/Publish
  State ..."): the fixed controls are now filter rows. Reword to "Filter rows are shown in both modes:
  every row type is part of the semantic route's contract too. Sort By is the one control hidden in
  Semantic mode ..." and keep the rest.
- Route watcher comment ("... (e.g. `syncTags`'s own `router.replace` round trip) ..."): `syncTags` no
  longer exists. Drop the parenthetical.
- `performSemanticSearch` JSDoc: "so the tag filter reads the sidebar's own `state.selectedTags`" is
  stale. It now reads: tag filters are the `#tag` tokens in the query plus any Tag rows, sent as
  repeated `tags` pairs.
- Guard comment in `performSearch` ("Asking the server with nothing to go on ..."): add that exclude
  rows alone do not count, since they narrow rather than select (see
  `docs/decisions/2026-09-20-search-filter-rows-request-shape.md`).
- Removed with its code, nothing to restore: the `onMounted` note about listing tags needing a session
  (the tag dropdown and its `siteStore.fetchTags()` call are gone; Tag is a text input).

## Suggested additions (only where a real why is worth keeping)

- `frontend/src/helpers/searchFilters.js`, above `filtersToSearchParams`: "Returns `[name, value]`
  pairs, not an object: `ky` joins an array value with commas, which the enum-validated `publishState`
  and `editor` lists reject."
- `Search.vue`, above `restoringFilters`: "Set while the saved rows are assigned so the signature watcher
  does not queue a second search; `loadSavedFilters` runs the first one itself."
