# Decision Record: GraphQL/Apollo Removal

**Status:** Complete — no GraphQL server, client global, or `.graphql` import remains

## History

An earlier iteration of 3.x used GraphQL/Apollo. The removal is complete:

- There is no GraphQL server left in `backend/`.
- `APOLLO_CLIENT` is not defined as a global, so any call through it would throw.
- `blocks/block-index/` no longer imports a `tree.graphql` — its tree comes from
  `sites/…/tree/pages`, plain REST.
- Every former consumer has been ported to REST, including `components/AuthLoginPanel.vue`'s
  `register()` call, alongside the passkey login and 2FA paths that were REST from the start.
- `AdminPages.vue`, `AdminPagesEdit.vue`, `AdminPagesVisualize.vue` and `AdminTags.vue` — the last
  pages still calling `this.$apollo.mutate`/`this.$apollo.queries.*` — were deleted outright rather
  than ported. Of that family, `frontend/src/pages/` now holds `AdminPagesDeleted.vue` and a
  `AdminPages.vue` rewritten from scratch against REST, sharing nothing with the deleted one.

A grep for `apollo|graphql` in `frontend/src` turns up only comments and test fixtures referring to
the removal in the past tense — no live `$apollo` call site remains.

## Consequence for future work

If a future feature needs a REST endpoint that doesn't exist yet, add it under `backend/api/`
following the schema + permissions conventions in `CLAUDE.md` — `sites/:siteId/images/:kind`, which
replaced the logo and favicon upload mutations in `AdminGeneral.vue`, is a recent example of doing
exactly that.
