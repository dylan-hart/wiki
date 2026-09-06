# The Cardinal fork (`dylan-hart/wiki`)

## Identity

| Fact | Value |
| --- | --- |
| Repository | `github.com/dylan-hart/wiki`, **public**, GitHub-flagged as a fork of `requarks/wiki` |
| GitHub description / homepage | Still upstream's: "Wiki.js \| A modern and powerful wiki app built on Node.js", `https://js.wiki` |
| GitHub license detection | AGPL-3.0 |
| Trunk | `scarlett` (3.x). `main` is upstream's 2.x line plus three early fork commits; not developed |
| Fork point | Upstream `d0c5a8bfa`, 2026-08-14 |
| Fork commits on `scarlett` | 687 (authors `Dylan Hart <dylanhart@fastmail.com>` and `dylan.hart <accounts@dylan-hart.com>`), on top of 2,284 upstream commits |
| Product name | "Cardinal" / "Cardinal.js" in the UI (footer, logo `frontend/public/_assets/logo-cardinal.svg`, admin chrome). Repository, package names and most runtime strings still say "wiki" / "Wiki.js" |
| Release state | No git tags, no GitHub Releases. `build.yml` pushes a `ghcr.io/dylan-hart/wiki:3.0.0-alpha[.N]` image on every `scarlett` push; anonymous registry access answers `NAME_UNKNOWN`, so the package is either private or has never been pushed. **Not verified either way.** |

## Scale of the modification

`git diff --stat d0c5a8bfa HEAD`: **1,959 files changed, 464,293 insertions, 38,256 deletions**
across 2,193 tracked files. This is a heavily modified derivative, not a light patch set: new
subsystems (MCP server, migration CLI, seven storage modules, five search engines, approvals,
classification, glossary, collaborative editing, the e2e workspace, the Cardinal re-skin) sit on
top of upstream's skeleton. For AGPL purposes none of that changes anything — a derivative of
AGPL code is AGPL code however large the additions — but it does mean the fork's own copyright
share of the tree is substantial.

## Who wrote the fork's changes

All 687 fork commits are authored by Dylan Hart. Almost all carry an AI co-author trailer:

| Trailer | Commits |
| --- | --- |
| `Co-Authored-By: Claude Sonnet 5` (two capitalisations) | 920 |
| `Co-Authored-By: Claude Fable 5.1` / `Claude Fable 5` | 148 |
| `Co-Authored-By: Claude Opus 5 (1M context)` (two capitalisations) | 18 |

(Counts exceed 687 because merge and squash commits carry several trailers.)

This matters for one question only: **what copyright the fork can claim over its own additions.**
The AGPL obligations on the *upstream* portion are unaffected by who or what wrote the changes.
But copyright offices have so far declined to register purely machine-generated text, and the
degree of human authorship needed for AI-assisted code to be protectable is unsettled. Practical
reading: the fork's additions are licensed outbound under AGPL-3.0 like everything else (the
`LICENSE` and manifests say so), and a copyright notice naming Dylan Hart for the modifications
is reasonable to assert, but its enforceability is less certain than for hand-written code. This
is a consideration for the fork's own position, not a compliance gap toward upstream.

## What the fork kept intact from upstream

- `LICENSE` — byte-identical (MD5 `3e00ca6129dc8358315015204ab9fe15`), never touched.
- Full git history back to 2016, including every upstream author's name and email. Nothing was
  squashed or rewritten. This is the strongest attribution the fork has.
- `backend/package.json` and `blocks/package.json`: `"license": "AGPL-3.0"`, `"author": "Nicolas Giard"`.
  `frontend/package.json`: `"author": "Nicolas Giard <nick@requarks.io>"`, no license field
  (as upstream). `e2e/package.json` (fork-created): no license, no author.
- `backend/package.json` still points `homepage`, `bugs.url` and `repository.url` at
  `github.com/requarks/wiki` and `funding` at `opencollective.com/wikijs`.
- `.github/CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `FUNDING.yml`, issue templates:
  upstream's, with upstream's contact addresses (see [06](06-branding-and-trademark.md)).
- `dev/build/Dockerfile`: `LABEL maintainer="requarks.io"`; copies `LICENSE` into the image.
- `README.md`: upstream's 3.x README with the Wiki.js logo hotlinked from `static.requarks.io`,
  the AGPLv3 badge linking to `requarks/wiki/blob/master/LICENSE`, and NGPixel/OpenCollective
  sponsorship badges; plus fork-added sections.
- `.devcontainer/wait-for.sh`: Eficode Oy's MIT script, copyright and permission notice retained.

## What the fork changed that touches licensing or attribution

- **Footer**: upstream rendered "Powered by **Wiki.js**" linking `https://js.wiki`. The fork renders
  "powered by Cardinal.js" linking `https://github.com/dylan-hart/wiki`
  (`frontend/src/components/FooterNav.vue`, `PROJECT_URL`), unconditionally on every page, and it
  survives print (`_print.scss`). The comment there says why: "the fork is not Wiki.js and no
  longer links to js.wiki." `AdminLayout.vue` links the same repository. This is the fork's AGPL
  §13 source offer.
- **Footer copyright strings** were reworded: `common.footerCopyright` is now "© {year} {company}"
  (upstream: "…All rights reserved."), `common.footerLicense` "© {year} {company} · {license}"
  (upstream: "Content is available under the {license}, by {company}."). These describe the *site
  operator's* content license, chosen per site in `AdminGeneral.vue` (none / All rights reserved /
  CC0 / six CC variants), and default to empty. They have nothing to do with the software license.
- **Vendored 2.x sources** under `docs/migration/vendor/` with a README naming source, date and
  license (see [01](01-upstream-wikijs-2.5.x.md)).
- **Three font families added** (Barlow, Barlow Condensed, Inter) by the Cardinal re-skin
  (`145b1c782` 2026-08-18, `cdd3bfd9c` 2026-09-05), with no license text alongside. Upstream's five
  families had none either. See [05](05-third-party-and-assets.md).
- **Dependencies added**: 32 backend, 37 frontend, 1 blocks; several removed. All under
  AGPL-compatible licenses. Full inventory in [05](05-third-party-and-assets.md).
- **Locale strings**: 17 `en.json` strings still say "Wiki.js"; the fork has added many new keys
  that do not. The translated locale files (11 "Wiki.js" strings each) are synced from
  `requarks/wiki-locales`.

## How the fork is distributed

Three channels, each with a different AGPL section attached:

1. **Source on GitHub** (public). AGPL §4/§5 — verbatim and modified source. Satisfied except for
   the §5(a) modification notice ([04](04-agpl-obligations.md)).
2. **Docker image** (`build.yml`, `release.yml`) — the image contains the backend's TypeScript
   source unbundled (there is no build step) plus the frontend's minified Vite output in `assets/`
   and the compiled blocks. The minified parts are "object code"; the image also contains
   `LICENSE`. AGPL §6 applies: recipients must be able to get Corresponding Source. The image is
   built from a public commit, but carries no OCI `source`/`revision` label and the app does not
   report a commit. See [04](04-agpl-obligations.md) and [07](07-recommended-actions.md).
3. **Running instances** Dylan operates. AGPL §13 applies: every remote user must be offered the
   Corresponding Source of *the version they are interacting with*. The unconditional footer link
   satisfies the "prominently offer" part; the "of your version" part is only as good as the
   mapping from what is running to a public commit, which today is `3.0.0-alpha.<run number>` → a
   GitHub Actions run → a commit, traceable but not linked.
