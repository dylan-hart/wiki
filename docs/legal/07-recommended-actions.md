# Recommended actions

Ordered by how directly each closes an obligation. "Owner" is the file to touch. None of these
require contact with upstream; the AGPL does not ask for it.

## A. Close the AGPL §5(a) gap — do first

1. **`README.md`**: replace the Wiki.js logo block with the Cardinal mark and add, above the fold:
   > Cardinal is a modified version of [Wiki.js](https://github.com/requarks/wiki) 3.x by
   > Nicolas Giard / Requarks.io and contributors, forked on 2026-08-14 from commit `d0c5a8bfa`
   > and modified continuously since. Both are licensed under the GNU Affero General Public
   > License v3.0 — see [LICENSE](LICENSE). Cardinal is not affiliated with or endorsed by Requarks.
2. **`NOTICE`** (new, repo root, plain text, ~10 lines): the same statement, plus
   "Copyright (C) 2016-2026 Nicolas Giard / Requarks.io and Wiki.js contributors. Modifications
   Copyright (C) 2026 Dylan Hart. Licensed under AGPL-3.0-only." Copy it into the Docker image
   next to `LICENSE` (`dev/build/Dockerfile`, one more `COPY`).
3. **README license badge**: link `./LICENSE`, not `requarks/wiki/blob/master/LICENSE`.

## B. Make the source offer exact (§6, §13)

4. **Expose the build revision.** `build.yml` and `release.yml` already stamp `REL_VERSION`; also
   write `GITHUB_SHA` (e.g. into `backend/package.json` as `gitHead`, or a `BUILD_REVISION` env the
   Dockerfile bakes in) and surface it in `api/system/info.ts` → `AdminSystem.vue`.
5. **Footer link target**: point `FooterNav.vue`'s `PROJECT_URL` at
   `https://github.com/dylan-hart/wiki/tree/<revision>` when a revision is known, falling back to
   the repository root. Same for `AdminLayout.vue`.
6. **OCI labels**: add `org.opencontainers.image.source=https://github.com/dylan-hart/wiki`,
   `.revision=${GITHUB_SHA}`, `.licenses=AGPL-3.0-only`, `.title=Cardinal` to both workflows'
   `docker/build-push-action` steps (or adopt `docker/metadata-action`, which emits them), and
   change `LABEL maintainer` in `dev/build/Dockerfile`.
7. **Confirm the GHCR package's visibility** (anonymous pull answered `NAME_UNKNOWN` on
   2026-09-06). A private image conveyed only to yourself creates no §6 obligation; a public one
   should carry the labels above.

## C. Manifest hygiene

8. Add `"license": "AGPL-3.0-only"` to `frontend/package.json` and `e2e/package.json`; consider
   moving `backend/` and `blocks/` from the deprecated `AGPL-3.0` identifier to `AGPL-3.0-only` in
   the same commit (semantically identical, just unambiguous). Do **not** use `-or-later`.
9. Repoint `backend/package.json`'s `homepage`, `bugs.url`, `repository.url` and `funding` at the
   fork (or delete `funding`).

## D. Third-party notices

10. Add `OFL.txt` to `frontend/public/_assets/fonts/{barlow,barlow-condensed,inter,montserrat,opensans,rubik,tajawal}/` and the correct notice (`LICENSE.txt` Apache-2.0 or `OFL.txt`) to `roboto/` and `roboto-mono/` after checking which build is bundled. Note the added three are the fork's own responsibility; the rest are inherited but cost the same to fix.
11. Add an attribution line for Twemoji ("Emoji graphics © Twitter/Twemoji contributors, CC-BY 4.0") somewhere a reader can find it. Cheapest: a "Credits" section in `README.md` and in the admin dashboard's contribute card (`admin.dashboard.contributeSubtitle` already exists and currently talks about Wiki.js).
12. Optional: generate `THIRD-PARTY-NOTICES.md` for `frontend/` and `blocks/` at build time, since
    the minified bundles strip the MIT/BSD notices that `node_modules` would otherwise carry.
13. Record provenance for `frontend/public/_assets/bg/login.jpg` and the non-unDraw illustrations,
    or replace them with assets whose license is known.

## E. Branding residue (see [06](06-branding-and-trademark.md) for the full table)

14. `.github/FUNDING.yml` — delete or repoint. `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue
    templates, `auto_assign.yml` — rewrite for the fork's own contacts.
15. GitHub repo settings — description and homepage.
16. `check-version.ts` — point at `dylan-hart/wiki` releases (or disable until there is a release).
17. `base.yml` `docsBase` — decide: keep upstream docs (they are still mostly accurate for shared
    features), or blank it until the fork has docs.
18. `openapi.ts` title, `index.ts` banner, `hooks.ts` test payload, `AdminSystem.vue` header,
    `storageDeliveryGraph.js` node + drop `logo-wikijs*.svg`.
19. The 17 `en.json` strings, together with the locale-sync decision in [06](06-branding-and-trademark.md).

## F. Things deliberately *not* recommended

- Do not rewrite git history to remove upstream authorship. It is the fork's best attribution.
- Do not add a CLA or change license for the fork's own contributions. It would complicate a
  codebase that must remain AGPL-3.0 regardless.
- Do not hotlink anything from `static.requarks.io` (the README logo and the analytics/auth module
  `logo:` URLs in `backend/modules/*/definition.yml` do). Those are functional, not legal, issues —
  an outage upstream blanks the admin module lists — but the fix is the same: vendor the SVGs.
- Do not seek permission from Requarks to fork. None is needed; the AGPL is the permission.
