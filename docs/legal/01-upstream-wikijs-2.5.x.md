# Upstream Wiki.js 2.5.x

The 2.x line is upstream's current stable release and lives on `requarks/wiki`'s **default branch,
`main`**. Latest tag at review time: **`v2.5.314`**.

## License

| Fact | Value | How verified |
| --- | --- | --- |
| License file | `LICENSE`, the verbatim GNU AGPL v3 text, 661 lines | GitHub contents API, `ref=main` and `ref=v2.5.314` |
| Checksum | MD5 `3e00ca6129dc8358315015204ab9fe15` | Same file on `main`, `scarlett`, `vega`, `v2.5.314`, and both branches of this fork |
| First appeared | Initial commit `5bec7ff5c`, 2016-08-16, Nicolas Giard | `git log -- LICENSE` in this repository, which carries the full upstream history: exactly one commit ever touched it |
| `package.json` | `"name": "wiki"`, `"version": "2.0.0"`, `"author": "Nicolas Giard"`, `"license": "AGPL-3.0"` | Root `package.json` on `main` |
| GitHub license detection | `AGPL-3.0` | `gh api repos/requarks/wiki` |
| Public statement | js.wiki footer: "Released under the AGPL-v3 License" and "Copyright © 2017-2026 Requarks.io" | Fetched 2026-09-06 |

Two things the license file does **not** do, and they matter for how to read the grant:

- The "How to Apply These Terms" appendix is left as the FSF template. No copyright line, no
  program name, no "or (at your option) any later version" election was ever filled in. The only
  version statement anywhere is the SPDX-style `AGPL-3.0` string in `package.json`, an identifier
  SPDX has since deprecated because it does not say "only" or "or later". With no later-version
  election anywhere, the defensible reading is **AGPL-3.0-only**, and a downstream should not
  assume it may move the combined work to a later version.
- There are no per-file copyright headers and no `NOTICE` file. Copyright is asserted only on the
  website ("Requarks.io"), never in the repository.

## Who holds the copyright

Requarks.io is Nicolas Giard's vehicle (`NGPixel` on GitHub; five author identities in the history
all resolve to him). He is the overwhelming author, but not the only one:

| Count | Source |
| --- | --- |
| ~235 | Contributors listed by the GitHub API for `requarks/wiki` (`per_page=1` pagination, `anon=true`) |
| 174 | Distinct author emails in the history this fork carries |
| 23 | Upstream commits carrying a `Co-authored-by: Nicolas Giard` trailer on top of another author |

There is **no Contributor License Agreement and no Developer Certificate of Origin**.
`.github/CONTRIBUTING.md` (fetched from `main`) talks about pull-request etiquette, the feedback
board and OpenCollective; it says nothing about licensing. `PULL_REQUEST_TEMPLATE.md` is empty.
Under the usual inbound-equals-outbound reading, every outside contributor licensed their patch
under the AGPL-3.0 and kept their copyright. Consequences:

- Requarks cannot relicense 2.x (or 3.x) without every contributor's consent, and neither can
  anyone downstream. The AGPL is, for practical purposes, permanent on this codebase.
- The website's "Copyright © Requarks.io" is a claim over Requarks' own share, not a statement
  that Requarks owns the whole. That is normal and not a problem, but it means an accurate
  copyright notice for the fork has to say "Requarks.io / Nicolas Giard **and contributors**".

## Trademark

There is no trademark policy, `TRADEMARK` file, or trademark clause anywhere in the repository,
the contributing guide or the website. A web search for a Wiki.js trademark policy found nothing.
Registration status at USPTO/CIPO/EUIPO was **not** checked. Treat "Wiki.js", the "Wiki.js" logo
and "Requarks" as upstream's unregistered brand identifiers: the AGPL grants no right to use them
(it is a copyright license; §7(e) only lets a licensor *decline* to grant trademark rights, and
upstream added no §7 terms at all). See [06-branding-and-trademark.md](06-branding-and-trademark.md).

## Other repository-level policies on `main`

- `SECURITY.md`: supported versions 2.x only; report via GitHub security advisories.
- `.github/CODE_OF_CONDUCT.md`: Contributor Covenant, contact `abuse@requarks.io`.
- `.github/FUNDING.yml`: GitHub Sponsors `NGPixel`, Patreon `requarks`, OpenCollective `wikijs`.
- The 2.x README says anyone becoming a sponsor gets their name shown "in the Contribute page of
  all Wiki.js installations". That is a promise about upstream's builds; a fork with its own admin
  dashboard is under no obligation to carry the sponsor wall, and this fork's dashboard does not.

## How the fork relates to 2.5.x

- The fork's own `main` branch **is** upstream `main` (last merged 2026-08-20 as
  `d1d78e46e Merge branch 'requarks:main' into main`), plus three small fork-authored 2.x commits
  from before the 3.x work started (`folderByPath` GraphQL resolver and two follow-ups). Nothing on
  it is distributed by the fork; it exists as the trunk `scarlett` was cut from and as a
  reference for the 2.5.x → 3.0 migration importer.
- `docs/migration/vendor/` holds **unmodified copies of 2.x source files** (twelve
  `server/db/migrations/*.js`, four module definitions, one GraphQL schema fragment, three
  resolver/service files, and the `2x-settings` set), fetched 2026-08-17 from `main`. Its `README.md`
  names the source, the fetch date and the license ("Same AGPL-3.0 license as this repository").
  That is the right way to vendor AGPL code: the license is preserved by the repository `LICENSE`,
  and attribution is explicit.
- `backend/migration/` reads a 2.5.x *database*, not 2.5.x code. Data is not licensed by the AGPL,
  so nothing about the importer changes the analysis.
