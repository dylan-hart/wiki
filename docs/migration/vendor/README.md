# Vendored 2.x migration sources

Unmodified copies of `server/db/migrations/<version>.js` from
[requarks/wiki](https://github.com/requarks/wiki) (`main` branch), fetched 2026-08-17, used as the
ground truth for `../2.5x-source-schema.md` and cross-checked against it by
`../../../backend/test/migration-schema-doc.test.ts`. Same AGPL-3.0 license as this repository.

Files:

- `2.0.0.js` — baseline schema (the initial `CREATE TABLE` set)
- `2.1.85.js`, `2.2.3.js`, `2.2.17.js`, `2.3.10.js`, `2.3.23.js`, `2.4.13.js`, `2.4.14.js`,
  `2.4.36.js`, `2.4.61.js` — spot-checked incremental migrations (column additions/renames only)
- `2.5.1.js`, `2.5.12.js` — **correction, added during Task 707**: the claim (recorded in a prior
  pass of this doc) that every 2.5.x migration is data-only turned out to be wrong. `2.5.1.js` adds
  `authentication.order` / `.strategyKey` / `.displayName`; `2.5.12.js` adds
  `groups.redirectOnLogin`. Both are real `alterTable` schema changes, discovered because Task 707's
  export-bundle resolver code selects `authentication.strategyKey` / `.displayName` — columns that
  did not exist anywhere in the `2.0.0.js`–`2.4.61.js` set this doc was originally built from. See
  the "Erratum" note in `../2.5x-source-schema.md`. The other four 2.5.x migrations touching these
  two tables (`2.5.108.js` conditionally patches a pre-existing `authentication.isEnabled` default
  for beta installs, `2.5.118.js` and `2.5.128.js` are pure data fixes, `2.5.122.js` adds an
  unrelated new `userAvatars` table) were read but are not vendored, being out of this doc's table
  scope or genuinely data-only.

Source URLs follow the pattern
`https://raw.githubusercontent.com/requarks/wiki/main/server/db/migrations/<file>`.

## `2x-definitions/`

Vendored for Task 709 (the column-level 2.x → 3.0 mapping doc,
[`../2.5x-to-3.0-mapping.md`](../2.5x-to-3.0-mapping.md)): the 2.x `definition.yml` for the three
spot-checked modules, plus the 2.x GraphQL schema fragment that pins down the `pageRules` shape.
Fetched 2026-08-17 from `requarks/wiki` `main`:

- `authentication-local-definition.yml` ← `server/modules/authentication/local/definition.yml`
- `storage-git-definition.yml` ← `server/modules/storage/git/definition.yml`
- `storage-s3-definition.yml` ← `server/modules/storage/s3/definition.yml`
- `group.graphql` ← `server/graph/schemas/group.graphql` (source of the `PageRule` type used to
  confirm the `deny: Boolean!` vs. 3.0 `mode: ALLOW|DENY|FORCEALLOW` mismatch)

Cross-checked against the mapping doc by `../../../backend/test/migration-mapping-doc.test.ts`. Not
`.js`, so none of these are picked up by `../../../backend/test/migration-schema-doc.test.ts`'s scan
either way, but they get their own subdirectory for the same organizational reason `export-bundle/`
does.

## `export-bundle/`

A separate, non-migration set of vendored files — `server/graph/resolvers/system.js`,
`server/core/system.js`, `server/models/authentication.js` — used as the ground truth for
`../2.5x-export-bundle-format.md` and cross-checked against it by
`../../../backend/test/migration-export-bundle-doc.test.ts`. Kept in its own subdirectory (not
scanned by `../../../backend/test/migration-schema-doc.test.ts`, which only reads `.js` files
directly under `vendor/`) because
these are resolver/service implementation files, not `db/migrations/*.js` schema definitions, and
mixing them in would make `loadVendoredSchema()`'s generic `createTable`/`alterTable` scan pick up
unrelated matches. Fetched 2026-08-17 from
`https://raw.githubusercontent.com/requarks/wiki/main/server/graph/resolvers/system.js`,
`https://raw.githubusercontent.com/requarks/wiki/main/server/core/system.js`, and
`https://raw.githubusercontent.com/requarks/wiki/main/server/models/authentication.js` respectively.
