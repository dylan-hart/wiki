# WP 3487: recommended comment changes

`isHashedAssetFilename` now takes a path relative to `assets/_assets` and only accepts a root-level
file whose name ends in `-<8 base64url chars>.<ext>` with at least one uppercase letter, digit or
underscore in the hash. Code comments were not edited; these are the recommendations.

## `backend/helpers/common.ts`

- Delete the `FIXME` on `HASHED_ASSET_PATTERN` (the `logo-cardinal.svg` trap is resolved).
- Replace the `HASHED_ASSET_PATTERN` doc with: "Vite's `[name]-[hash].[ext]` output: an 8-character
  base64url hash."
- On `HASH_MIX_PATTERN`, add: "Rejects hand-authored names whose last segment is an 8-letter
  lowercase word (`logo-cardinal.svg`)."
- On `isHashedAssetFilename`: replace `@param filename Basename only, not a full path` with
  "`relativePath` is relative to `assets/_assets`. Vite writes every hashed file directly under it,
  so anything in a subdirectory (`fonts/`, `icons/`, `illustrations/`, `storage/`, `svg/`) is
  hand-authored and never immutable." Drop the "hand-authored trees" sentence from the summary, now
  covered by the above.

## `backend/helpers/common.test.ts`

- In the `unhashedSamples` comment, drop the sentence "`logo-cardinal.svg` is left out because ...
  see the FIXME on `HASHED_ASSET_PATTERN`" (the case is now tested directly).

## `backend/core/http/server.ts`

- The `setHeaders` comment is still accurate; optionally add "Only root-level files are candidates;
  `fonts/`, `icons/` etc. are never vite output."
