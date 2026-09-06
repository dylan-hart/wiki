# Upstream Wiki.js 3.0

Upstream has two 3.x branches. Both are development branches with no release, no upgrade path from
2.x and, per their own README, "NO support".

| Branch | State on 2026-09-06 | Layout |
| --- | --- | --- |
| `scarlett` | Head `7cf47610d` ("feat: add draw.io block", 2026-09-06). Active. | `backend/` (TypeScript 7, Fastify, Drizzle), `frontend/` (Vue 3 / Vite / Tailwind), `blocks/`, `dev/`, `CLAUDE.md`, `.oxfmtrc.json` |
| `vega` | Head `05fe49577` (2025-11-16). 119 commits behind `scarlett`, 0 ahead. Effectively superseded. | `server/`, `ux/` (the pre-rename names), `blocks/`, `localazy.json` |

This fork is a fork of **`scarlett`**. The fork point is upstream commit **`d0c5a8bfa`**
("feat: add unlock aspect ratio option to block-gallery", NGPixel, 2026-08-14); the first
fork-authored commit is `0b329fb16` on 2026-08-16. Upstream `scarlett` has since moved **34 commits
ahead** of that fork point and 0 behind, so the two lines have diverged and nothing from the fork
has gone back upstream.

## License

Identical to 2.5.x in every respect that matters:

| Fact | `scarlett` | `vega` |
| --- | --- | --- |
| `LICENSE` | Same file, MD5 `3e00ca6129dc8358315015204ab9fe15` | Same |
| Backend manifest | `backend/package.json`: `wiki-backend` 3.0.0, author Nicolas Giard, `"license": "AGPL-3.0"` | `server/package.json`: `wiki-server` 3.0.0, `"license": "AGPL-3.0"` |
| Frontend manifest | `frontend/package.json`: `wiki-ux` 3.0.0, author `Nicolas Giard <nick@requarks.io>`, **no `license` field** | `ux/package.json`: same, no `license` field |
| Blocks manifest | `blocks/package.json`: `blocks` 1.0.0, `"license": "AGPL-3.0"` | Same |
| `CLAUDE.md` first lines | "Next-generation open source wiki. This is the 3.x development branch … AGPL-3.0." | (absent) |
| README | Same AGPLv3 badge as 2.x, linking `requarks/wiki/blob/master/LICENSE` | Same |

So 3.0 is AGPL-3.0, with the same unfilled appendix, no copyright headers, no NOTICE, no CLA, and
the same "only, not or-later" reading as 2.5.x. The missing `license` field on the frontend
manifest is an upstream omission the fork inherited, not a choice either side made.

`.github/` on `scarlett` carries the same policy files as `main` (`CODE_OF_CONDUCT.md`,
`CONTRIBUTING.md`, `FUNDING.yml`, `SECURITY.md`, issue and PR templates, `auto_assign.yml`).

## Copyright holders on the 3.x code specifically

3.x is a rewrite, but a rewrite made in the same repository by the same principal author. Of the
2,284 upstream commits in the fork's history, the 3.x-era ones are almost entirely NGPixel's;
outside contributions to 3.x exist but are a small fraction. This does not change the conclusion:
the 3.x code is Requarks/Giard **and contributors**, AGPL-3.0, no relicensing possible.

## What upstream 3.x ships that has its own license

Everything in [05-third-party-and-assets.md](05-third-party-and-assets.md) tagged "inherited"
was already in `scarlett` at the fork point: five font families, the Twemoji CC-BY-4.0 graphics,
the unDraw illustrations, the login background, the Eficode `wait-for.sh` (MIT, notice retained)
and the npm dependency tree. Upstream itself ships no third-party notice file for any of them.

## Locale strings

3.x locale files come from a separate repository, `requarks/wiki-locales` (**AGPL-3.0**, public,
"Localization files for Wiki.js v3"), pulled at runtime by `backend/tasks/simple/update-locales.ts`
and managed through Localazy (`localazy.json`). The English source strings in
`backend/locales/en.json` are part of this repository. Licensing is the same AGPL; the practical
consequence is different and covered in [06-branding-and-trademark.md](06-branding-and-trademark.md):
the translations name the product "Wiki.js" in every language, and continuing to sync them means
continuing to import that name.
