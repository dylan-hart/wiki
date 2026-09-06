# AGPL-3.0 obligations, clause by clause

The AGPL-3.0 text is `/LICENSE`. Section numbers below are its. "Status" is the fork's position on
2026-09-06. "Met" means the text and the repository agree; "gap" means there is something concrete
to change; "n/a" means the clause does not bind the fork in its current situation.

| § | What it requires of a downstream | Status | Evidence / note |
| --- | --- | --- | --- |
| 0, 1 | Definitions. "Corresponding Source" = everything needed to build and run the object code, including build scripts. | — | The repository is the Corresponding Source: `dev/build/Dockerfile`, `dev/setup.sh`, all four workspaces and lockfiles are in it. |
| 2 | Basic permissions: run, make and propagate unmodified copies. | met | — |
| 3 | No anti-circumvention claims. | met | The fork ships no DRM and asserts none. |
| 4 | Convey verbatim copies: keep license notices, keep the license text, keep §7 notices, no warranty. | met | `LICENSE` intact and byte-identical. No §7 notices existed upstream to preserve. |
| 5(a) | A modified version "must carry prominent notices stating that you modified it, and giving a relevant date." | **gap** | No such notice exists. `README.md` never says the code is modified from Wiki.js. Git history records every change with a date, and `CLAUDE.md`/`docs/` describe the fork's changes in detail, but neither is a *prominent notice* in the sense the clause intends. Fix: a paragraph at the top of `README.md` and a `NOTICE` file — see [07](07-recommended-actions.md). |
| 5(b) | Carry prominent notices that it is released under this License and any §7 terms. | met (weakly) | `LICENSE` file, `backend/`+`blocks/` manifests, and the README badge — but the badge links to **upstream's** `LICENSE` at `requarks/wiki/blob/master/LICENSE`, not the fork's own. Point it at `./LICENSE`. `frontend/` and `e2e/` manifests say nothing. |
| 5(c) | License the entire modified work under this License to anyone who gets a copy. | met | No additional restrictions anywhere. The fork's additions are AGPL by virtue of the repository `LICENSE` and manifests. |
| 5(d) | If the work has interactive interfaces, each must display Appropriate Legal Notices — **but** "if the Program has interactive interfaces that do not display Appropriate Legal Notices, your work need not make them do so." | n/a | Upstream Wiki.js displays no in-app license/copyright/no-warranty notice, so the fork is not obliged to add one. (Adding an About/credits screen would still be good practice and is where the Twemoji and font attributions could live.) |
| 6 | Conveying object code (the Docker image's minified frontend + compiled blocks) requires one of 6(a)–(e): accompany with source, or a written offer, or, for a network server, "access to the Corresponding Source … from a network server at no charge" (6(d)). | met via 6(d), improvable | The image is built from a public commit and the repository is public. Weaknesses: the image has no `org.opencontainers.image.source` / `.revision` label; `LABEL maintainer="requarks.io"` names the wrong party; the app's `WIKI.version` is `3.0.0-alpha.<run>` with no commit hash, so a recipient must map the run number to a commit by hand. |
| 7 | Additional terms. Upstream added none. A downstream may add certain permissive terms to its own contributions, and may add §7(a)–(f) terms only to material it owns. | met | The fork adds none. It should not add any that purport to bind upstream's code. |
| 8 | Termination on breach; reinstatement on cure. | — | Not triggered. The §5(a) gap is curable by adding the notice. |
| 9, 10 | Automatic licensing of downstream recipients; no further restrictions. | met | — |
| 11 | Patents: contributors grant a patent license for their contributions. | met | The fork's contributions carry the same implicit grant. No patent assertions exist either direction. |
| 12 | No surrender of others' freedom. | met | — |
| 13 | **Remote network interaction**: if you modify the Program, "your modified version must prominently offer all users interacting with it remotely through a computer network … an opportunity to receive the Corresponding Source of your version by providing access to the Corresponding Source from a network server at no charge, through some standard or customary means." Also permits linking with GPLv3 works. | met (weakly) | The footer "powered by Cardinal.js" link to `github.com/dylan-hart/wiki` is on every page, cannot be disabled by a site administrator, and survives print. That is "prominent" and "standard means". The weakness is "of your version": the link is to the repository, not to the running revision. While every deployment tracks the head of one public branch this is fine in practice; the clean fix is exposing the commit (or tag) in the admin System page and in the footer link target. |
| 14 | Later versions: only if the Program says "or any later version". | — | Upstream never said so. Treat the license as **AGPL-3.0-only**. The fork may not relicense the combined work under a future AGPL v4. |
| 15–17 | No warranty; limitation of liability. | met | Text intact. The Dockerfile and README make no warranty claims. |

## Two questions people usually ask about the AGPL and forks

**Does renaming the product change anything?** No. The AGPL does not care what the program is
called. Renaming is a trademark question ([06](06-branding-and-trademark.md)), not a copyright one.
The only place a name appears in the license's own requirements is §5(a)'s modification notice,
which is easier to satisfy honestly if the notice says "Cardinal is a modified version of Wiki.js".

**Can the fork ever change license?** Not without the consent of every copyright holder of code
still in the tree: Requarks/Giard and ~235 upstream contributors, none of whom signed a CLA. The
fork's own additions could in theory be dual-licensed by their author, but as a combined work the
program stays AGPL-3.0. Anything built on Cardinal — plugins loaded in-process, custom blocks
bundled into the image, an MCP client is *not* in scope — inherits the same obligation when
conveyed or run as a service.

## What this fork does *not* owe upstream

- No obligation to contribute changes back. The AGPL requires offering source to the fork's own
  users, not to upstream.
- No obligation to keep the Wiki.js name, logo, sponsor wall, or links to js.wiki. The opposite is
  closer to true — see [06](06-branding-and-trademark.md).
- No obligation to carry upstream's `FUNDING.yml`, Code of Conduct, or security contact. Those are
  project governance files, not license terms.
- No obligation to ship a `NOTICE` file with third-party attributions beyond what those third
  parties' own licenses require. (Some do — see [05](05-third-party-and-assets.md).)
