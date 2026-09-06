# Legal and licensing review — Wiki.js 2.5.x, Wiki.js 3.0, and the Cardinal fork

Review date: **2026-09-06**. Reviewed against upstream `requarks/wiki` as fetched that day
(`main` at its 2.5.x head, `scarlett` at `7cf47610d`, `vega` at `05fe49577`, tag `v2.5.314`) and this
repository (`dylan-hart/wiki`, branch `scarlett` at `8559fbcbe`, branch `main` at `d1d78e46e`).

This is a code-and-repository review, not legal advice. Every claim below was checked against the
files, git history, GitHub API or public web page it cites; where something could not be verified
it is marked as such. Take it to a lawyer before relying on it for anything with money attached.

## Bottom line

**Cardinal is on the same license as the code it forked, and the copyleft obligations that matter
are met.** Specifically:

- Upstream Wiki.js — 1.x, 2.5.x and every 3.x branch — has been under the **GNU Affero General
  Public License, version 3** since the project's first commit in 2016. The `LICENSE` file has never
  been edited. See [01-upstream-wikijs-2.5.x.md](01-upstream-wikijs-2.5.x.md) and
  [02-upstream-wikijs-3.0.md](02-upstream-wikijs-3.0.md).
- The fork ships that **byte-identical** `LICENSE` file, declares `AGPL-3.0` in the same
  `package.json` files upstream does, keeps the full upstream git history (2,284 upstream commits
  under 687 fork commits), publishes its source at `github.com/dylan-hart/wiki`, and links that
  repository from the footer of every rendered page. Those are the AGPL's core requirements for a
  modified version that is run as a network service. See [03-cardinal-fork.md](03-cardinal-fork.md)
  and the clause-by-clause table in [04-agpl-obligations.md](04-agpl-obligations.md).
- Upstream has **no CLA, no DCO, no NOTICE file, no per-file copyright headers and no trademark
  policy**. Contributions are inbound-equals-outbound under the AGPL. Nobody — not Requarks, not
  this fork — can relicense the code. Cardinal must stay AGPL-3.0, and it does.
- Every third-party dependency in the three shipping workspaces is AGPL-compatible (MIT, Apache-2.0,
  ISC, BSD, MPL-2.0, LGPL-3.0, CC-BY-4.0, and a handful of other permissive licenses). Nothing
  proprietary, nothing GPL-2.0-only, nothing source-available-but-restricted. See
  [05-third-party-and-assets.md](05-third-party-and-assets.md).

## What is not clean

None of these is a license breach in the sense of "the fork is distributing code it has no right
to". They are notice, attribution and branding hygiene, ordered by how much they matter:

1. **No modification notice** (AGPL §5(a)). Nothing in the repository states, prominently, that
   this is a modified version of Wiki.js and when it was modified. Git history shows it, but
   the license asks for a notice a reader will actually see. One paragraph in `README.md` plus a
   short `NOTICE` file closes this.
2. **Residual Wiki.js branding and Requarks contact points** in places that would mislead a reader
   or misdirect money and security reports: `README.md` hotlinks the Wiki.js logo from
   `static.requarks.io` and carries sponsorship badges for NGPixel; `.github/FUNDING.yml` names
   NGPixel, Patreon `requarks` and OpenCollective `wikijs`; `.github/SECURITY.md` says to email
   `security@requarks.io`; the Docker image is labelled `maintainer="requarks.io"`; the update
   checker asks `api.github.com/repos/requarks/wiki/releases/latest`. Details and the full string
   inventory are in [06-branding-and-trademark.md](06-branding-and-trademark.md).
3. **Bundled fonts ship without their license texts.** Eight families under
   `frontend/public/_assets/fonts/` (five inherited, three added by the Cardinal re-skin) carry no
   OFL or Apache notice file. Whether the notice survives inside the `.woff2` metadata is
   unverified. Adding the license text per directory is cheap and unambiguous.
4. **Twemoji graphics are CC-BY-4.0 and are not attributed anywhere in the app.** Inherited from
   upstream, which does not attribute them either.
5. **Corresponding Source is offered at repository granularity, not revision granularity.** The
   footer links `github.com/dylan-hart/wiki`; the app reports version `3.0.0-alpha.<run>` and no
   commit. Fine in practice while everything is on one public branch; better to link the exact
   tag or commit.
6. **Two of four workspace `package.json` files have no `license` field** (`frontend/`, `e2e/`).
   Upstream's frontend has none either, so this is inherited, but `"license": "AGPL-3.0"` costs
   nothing.

[07-recommended-actions.md](07-recommended-actions.md) turns the above into a checklist with the
exact files to touch.

## Files in this directory

| File | Covers |
| --- | --- |
| [01-upstream-wikijs-2.5.x.md](01-upstream-wikijs-2.5.x.md) | The 2.x line: license, copyright holders, contribution terms, what the fork takes from it |
| [02-upstream-wikijs-3.0.md](02-upstream-wikijs-3.0.md) | The 3.x line (`scarlett`, and the older `vega`): same questions, plus the fork point |
| [03-cardinal-fork.md](03-cardinal-fork.md) | What this repository is, who wrote what, what it changed, how it is distributed |
| [04-agpl-obligations.md](04-agpl-obligations.md) | AGPL-3.0 clause by clause, with the fork's status against each |
| [05-third-party-and-assets.md](05-third-party-and-assets.md) | npm dependency license inventory, fonts, images, emoji, vendored upstream files |
| [06-branding-and-trademark.md](06-branding-and-trademark.md) | The "Wiki.js" name and logo, the Requarks contact points, and where each still appears |
| [07-recommended-actions.md](07-recommended-actions.md) | The fix list |
