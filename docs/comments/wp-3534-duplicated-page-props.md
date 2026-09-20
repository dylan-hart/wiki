# Recommended comments for OpenProject #3534

Code comments were not written directly; these are the suggested additions.

## `frontend/src/helpers/duplicatedPageProps.js`

Above `DUPLICATED_PAGE_PROPS`:

```js
// Password is absent because the API never returns it, alias because it is unique per site, and the
// script/style fields because they need write:scripts/write:styles. See
// docs/decisions/2026-09-20-duplicate-copied-page-properties.md.
```

Above the `publishState !== 'scheduled'` block in `duplicatedPageProps`:

```js
// The API refuses a schedule on a draft or published page.
```

## `frontend/src/stores/page.js`

On `pageCreate`'s `carriedProps` block:

```js
// Spread last so a duplicated draft or hidden page is not overwritten by the create defaults. An
// empty icon is dropped so the default icon stands in.
```

## `frontend/src/components/PageHistoryOverlay.vue`

Above `duplicatedPageProps({ ...full.meta, ...full.meta?.config })` in `branchFrom`:

```js
// A version's meta holds the display flags and tocDepth under `config`, unlike the page API.
```

Note: the previous comment on the draft/scheduled downgrade there was removed with the code it
described; it no longer applies.
