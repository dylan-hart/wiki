# WP #3570 recommended comment changes

## `backend/modules/search/azure-search/search.ts`, `buildFilter`

The doc comment "`tags` matches any-of, not all-of: a document qualifies if any of its tags is in
the set." is now false: `tags` is all-of by default (one `tags/any(t: t eq ...)` clause per tag) and
any-of only when `tagsMatch` is `any`. Suggested replacement:

```ts
/** `tags` is all-of unless `tagsMatch` is `any`. */
```

## Tests whose titles state the old contract

`backend/modules/search/shared.test.ts` "include lists are any-of, except tags which are all-of"
stays true for the default; no change needed.

## `frontend/src/pages/TagsBrowse.vue`, `toggleTag` JSDoc

"Selected tags are ANDed server-side: toggling one on only ever narrows the results." is only true
in the default `all` match mode; under `tagsMatch=any` a toggle widens. Suggested replacement:

```js
/**
 * Selected tags are ANDed server-side unless `state.tagsMatch` is `any`, where each one widens the
 * results instead.
 *
 * A push, not a replace: ...(rest unchanged)
 */
```

`tagsQuery` writes `tagsMatch` only when it is `any` so the default keeps the URL a bare
`?tags=a,b`; worth a one-line why if a comment is wanted there.
