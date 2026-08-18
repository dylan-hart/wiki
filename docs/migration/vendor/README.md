# Vendored 2.x migration sources

Unmodified copies of `server/db/migrations/<version>.js` from
[requarks/wiki](https://github.com/requarks/wiki) (`main` branch), fetched 2026-08-17, used as the
ground truth for `../2.5x-source-schema.md` and cross-checked against it by
`../verify-schema-doc.test.mjs`. Same AGPL-3.0 license as this repository.

Files:

- `2.0.0.js` — baseline schema (the initial `CREATE TABLE` set)
- `2.1.85.js`, `2.2.3.js`, `2.2.17.js`, `2.3.10.js`, `2.3.23.js`, `2.4.13.js`, `2.4.14.js`,
  `2.4.36.js`, `2.4.61.js` — spot-checked incremental migrations (column additions/renames only;
  2.5.x migrations were already confirmed data-only in a prior pass and are not vendored here)

Source URLs follow the pattern
`https://raw.githubusercontent.com/requarks/wiki/main/server/db/migrations/<file>`.
