# Third-party code and assets

Inventory taken 2026-09-06 from each workspace's `package-lock.json` and installed `node_modules`
(production dependencies only — `devDependencies` are never conveyed). The `e2e/` workspace is
test tooling and ships nothing.

## npm dependency licenses

| Workspace | Prod packages | Breakdown |
| --- | --- | --- |
| `backend/` | 575 | 419 MIT · 66 Apache-2.0 · 28 ISC · 17 BSD-2-Clause · 16 BSD-3-Clause · 10 LGPL-3.0-or-later · 9 BlueOak-1.0.0 · 4 mixed Apache/LGPL(/MIT) · 2 0BSD · Python-2.0, PSF-2.0, MIT-0, Unlicense (1 each) |
| `frontend/` | 353 | 294 MIT · 24 MPL-2.0 · 17 ISC · 5 BSD-3-Clause · 4 BSD-2-Clause · 4 Apache-2.0 · 2 "MIT AND CC-BY-4.0" · 1 "MPL-2.0 OR Apache-2.0" · Python-2.0, 0BSD (1 each) |
| `blocks/` | 358 | 232 MIT · 57 Apache-2.0 · 34 ISC · 16 BSD-3-Clause · 7 BlueOak-1.0.0 · 2 BSD-2-Clause · 2 Unlicense · CC0-1.0, "MPL-2.0 OR Apache-2.0", "MIT AND Zlib", "MIT AND BSD-3-Clause", "MIT OR CC0-1.0", 0BSD, Python-2.0 (1 each) · 1 UNKNOWN |

**Nothing incompatible with AGPL-3.0 was found.** The non-trivial ones:

| Package(s) | License | Compatibility note |
| --- | --- | --- |
| `@img/sharp-libvips-*` (10 platform builds), `@img/sharp-wasm32`, `@img/sharp-win32-*` | LGPL-3.0-or-later (libvips), some AND Apache-2.0/MIT | LGPL-3 is compatible with (A)GPL-3; sharp links libvips as a prebuilt shared library. No source obligation beyond libvips' own, which sharp's package satisfies. Inherited from upstream. |
| `lightningcss` + 12 platform builds (two copies: direct and under `vite/`) | MPL-2.0 | File-level copyleft, explicitly GPL-compatible (MPL §3.3). Used at build time by Vite/Tailwind; ships nothing to the browser. Inherited. |
| `dompurify` (frontend and blocks) | MPL-2.0 OR Apache-2.0 | Choose Apache-2.0; compatible. Inherited. |
| `@twemoji/api`, `twemoji-assets` | MIT (code) AND **CC-BY-4.0** (graphics) | Compatible, but **CC-BY requires attribution** to Twitter/the Twemoji authors wherever the graphics are displayed or redistributed. Neither upstream nor the fork attributes them anywhere in the UI or docs (`docs/variances.md` mentions Twemoji only for a version pin). Inherited gap. |
| `khroma` (blocks, via mermaid) | No `license` field → reported UNKNOWN | Its shipped `license` file is MIT (Fabio Spampinato, Andrew Maney). Not a problem; noting so the next audit does not re-flag it. |
| BlueOak-1.0.0, Python-2.0, PSF-2.0, Unlicense, 0BSD, CC0, Zlib, MIT-0 | permissive | Compatible. |

Dependencies **added by the fork** since the fork point (checked by diffing `dependencies` in each
`package.json` against `d0c5a8bfa`) are all MIT/Apache-2.0/ISC/BSD: the AWS, Azure and Google
Cloud SDKs, Elasticsearch and Algolia clients, `@modelcontextprotocol/sdk`, `zod`, `nodemailer`,
`ldapts`, `@node-saml/node-saml`, `simple-git`, `ssh2-sftp-client`, `tar`, `undici`, `markdown-it`,
`highlight.js`, `@js-temporal/polyfill`, the `@tiptap/*` editor suite, `katex`, `asciidoctor`,
`turndown`, `d3-*`, `@zxcvbn-ts/*`, `swagger-ui`, and others. None introduced a new license class.

Upstream ships no third-party notice file, and the fork does not either. Most of the licenses above
(MIT, BSD, Apache, ISC) require the notice to accompany *the distributed software*; the standard
industry position is that the `node_modules` tree inside the Docker image — each package carrying
its own `LICENSE` — satisfies that for the backend, while the **minified frontend bundle strips
them**. A generated `THIRD-PARTY-NOTICES` for `frontend/` and `blocks/` (e.g. from
`rollup-plugin-license` or a script over `package-lock.json`) would be the conservative fix.
Inherited; low risk; listed in [07](07-recommended-actions.md) as optional.

## Fonts (`frontend/public/_assets/fonts/`)

Eight families, self-hosted as `.woff2` with a hand-written `<family>.css`. **No license file
accompanies any of them.** The `.woff2` container is Brotli-compressed, so whether the OFL notice
survives in the embedded `name` table could not be confirmed with a strings probe; treat it as
unverified.

| Family | Origin | License (as published by the foundry) | Note |
| --- | --- | --- | --- |
| Montserrat, Open Sans, Rubik, Tajawal | inherited (upstream) | SIL OFL 1.1 | |
| Roboto, Roboto Mono | inherited (upstream) | Apache-2.0 for the builds Google shipped until 2023; OFL 1.1 for Roboto v3+ | Which build is bundled is not recorded. Either license is fine; both want their notice shipped. |
| **Barlow, Barlow Condensed** | **fork** (`cdd3bfd9c`, 2026-09-05, Cardinal re-skin) | SIL OFL 1.1 (Jeremy Tribby) | Cardinal's display and body face. |
| **Inter** | **fork** (`145b1c782`, 2026-08-18) | SIL OFL 1.1 (Rasmus Andersson) | |

OFL §2 permits bundling with software "provided that each copy contains the above copyright notice
and this license", either as stand-alone text files or in the font metadata. Adding `OFL.txt`
(and `LICENSE.txt` for the Apache Roboto builds if that is what they are) to each directory is the
unambiguous way to comply and takes minutes. OFL's Reserved Font Name clause is not triggered: the
fonts are not modified or renamed.

## Images and emoji

| Asset | Origin | License / status |
| --- | --- | --- |
| `frontend/public/_assets/illustrations/undraw_*.svg` | inherited | unDraw license: free for commercial/personal use, no attribution required; may not be redistributed as a standalone collection. Fine as embedded UI art. |
| `frontend/public/_assets/illustrations/fileman-*.svg` and the other non-unDraw SVGs | inherited (added by NGPixel `fe38f4c7e`) | No provenance recorded. Presumed Requarks' own work → AGPL with the rest. Unverified. |
| `frontend/public/_assets/bg/login.jpg` | inherited (`fe38f4c7e`) | No provenance recorded. Unverified. If it is a stock photo, its license (Unsplash etc.) is what governs; worth asking or replacing. |
| `frontend/public/_assets/logo-wikijs.svg`, `logo-wikijs-full.svg` | inherited | Upstream's brand mark. Still shipped and still referenced by `helpers/storageDeliveryGraph.js`. Trademark question, not a copyright one — see [06](06-branding-and-trademark.md). |
| `frontend/public/_assets/logo-cardinal.svg` | fork (`8559fbcbe`) | Fork's own mark, three paths, no external source. |
| Twemoji SVGs (copied into the build by the `twemoji-assets` Vite plugin) | inherited | CC-BY-4.0 graphics: attribution required and absent (above). |
| Iconify icon sets | fetched at runtime from `/_icons`, stored in the `icons` table | Each set carries its own license (mostly MIT/Apache/OFL/CC-BY); `models/icons.ts` stores it and `AdminIcons.vue` displays it. Some sets (e.g. CC-BY ones) require attribution when their glyphs are shown; this is a per-site operator choice, not a fork-level one. |
| `ui-redesign/*.dc.html` (untracked, design mockups) | fork | Not shipped. Not reviewed. |

## Vendored source code

`docs/migration/vendor/` — unmodified 2.x files from `requarks/wiki` `main`, fetched 2026-08-17,
attributed in its `README.md` with source URLs, date and license. **Compliant.** They are
documentation fixtures cross-checked by `backend/test/migration-*-doc.test.ts`, not runtime code.

`.devcontainer/wait-for.sh` — Eficode Oy, MIT, notice retained in the file. Compliant.

`backend/locales/*.json` (other than `en.json`) — from `requarks/wiki-locales`, AGPL-3.0.
Compliant; the naming consequence is in [06](06-branding-and-trademark.md).
