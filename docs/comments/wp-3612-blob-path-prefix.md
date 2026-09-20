# Recommended comment changes: WP 3612 (pathPrefix in blob keys)

## `backend/helpers/blobTarget.ts` — `objectKeyFor` JSDoc

Currently: "The `<siteId>/` prefix is what stops two sites colliding on an identical folder and file
name. Every target computes the key this way, so an asset moved between targets keeps it."

Recommended: keep the first sentence, and add that an optional target `pathPrefix` (normalized by
`normalizePathPrefix`: `.`/`..`/empty segments dropped, so it can never traverse) sits ahead of the
`<siteId>/`. Note the key is `<prefix>/<siteId>/<folder>/<file>` and unchanged when no prefix is set.
Reword "an asset moved between targets keeps it" to say the `<siteId>/` part is what carries over,
since the prefix is per target.

## `backend/modules/storage/s3/storage.ts` — `encodeCopySourceKey` JSDoc

Currently: "...and `keyFor` always prefixes `<siteId>/`, so that is every key this module builds."

The logic does not depend on the key starting with the site id (it only percent-encodes each
segment), so no code change is needed. The reasoning still holds and is now stronger: every key has at
least one `/`, whether or not a `pathPrefix` is set. Recommended: replace "always prefixes
`<siteId>/`" with "always contains a `/` (the `<siteId>/` segment, behind any `pathPrefix`)".

## `backend/modules/storage/blobBase.ts` — `keyFor`

No comment exists. None recommended: the name and the `objectKeyFor` doc carry it.
