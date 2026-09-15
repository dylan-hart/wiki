# What the Internet Would Say About Cardinal.js

*Synthesized as a composite of how the OSS/GitHub/HN/r/selfhosted crowd typically reacts to a hard
fork like this one — not real quotes from real people, and not a survey. Every factual claim below
is checked against this repository's actual files, its git history, and real, cited sources about
Wiki.js's own community history, as of 2026-09-13. Where a claim couldn't be verified, it's flagged
as such rather than asserted.*

---

## Part 1: The five-minute roast (what gets found immediately)

This is the stuff that shows up in the first "well that's awkward" reply on the announcement post,
because it's one `grep` away:

- **The Sponsor button pays the project you left.** `.github/FUNDING.yml` still lists
  `github: [NGPixel]`, `patreon: requarks`, `open_collective: wikijs`. Someone clicks "Sponsor" on
  Cardinal.js and their money goes to Requarks.
- **Security reports go to a stranger's inbox.** `.github/SECURITY.md` still says
  `security@requarks.io`.
- **"Check for Updates" checks the wrong product.** `backend/tasks/simple/check-version.ts` hits
  `api.github.com/repos/requarks/wiki/releases/latest`. Every admin dashboard tells its operator
  the latest version of their software is some Wiki.js 2.5.x release.
- **The README's own hero image and badges point at Requarks' CDN and repo.** The Wiki.js logo,
  hotlinked; the AGPL badge links `requarks/wiki/blob/master/LICENSE` instead of this repo's own.
- **Swagger says "Wiki.js API." The boot log says `=== Wiki.js 3.0.0 ===`.** Small, but it reads as
  "the rename isn't finished," which invites the bigger question of what else isn't.
- **A feature that shipped as a fully-exposed admin toggle and did, provably, nothing.** Page
  ratings: the thumbs had no click handler, the star widget's score was hardcoded to `3` and posted
  to nowhere. It's since been quietly deleted — but it lived, enabled-in-the-UI, for a while. A
  community that goes digging through the git log for "how careful is this fork, really" finds this
  in about ten minutes, right next to ~1,400 lines of a second dead admin panel
  (`PageDataDialog.vue`/`PageDataTemplateDialog.vue`) that was wired to nothing and gated behind a
  flag that was *also* hardcoded off.

None of this is hard to fix — the fork's own `docs/legal/06-branding-and-trademark.md` already has
the checklist, dated a week before this report, unresolved. That reads as "moving faster than the
cleanup," forgivable once.

## Part 2: What real Wiki.js users actually asked for — and Cardinal actually built

This is the part worth taking seriously, and it's not just a design opinion — it's checkable
against Wiki.js's own public history:

- **Multi-site.** Wiki.js's own blog calls "Multiple wikis within a single installation" *"one of
  the most requested features,"* tracked for years on the project's Canny board, and confirms it
  was planned only for the unreleased 3.0 line — it never shipped in 2.x at all. Cardinal built it.
- **A real approval workflow.** [GitHub Issue #6556, "Approval Workflow,"](https://github.com/requarks/wiki/issues/6556)
  describes almost exactly what Cardinal's `models/approvals.ts` now does — path-scoped review
  requirements, a minimum-approver count, a contribution review screen — filed against upstream and
  slated for "3.1 or later," i.e. still vaporware there as of this writing.
- **Real-time collaborative editing.** Wiki.js's own community feedback board and
  [GitHub Discussion #5506](https://github.com/requarks/wiki/discussions/5506) explicitly discuss
  Yjs/ShareDB as the likely implementation path, and call it a "killer feature" that's "hard to
  integrate." Cardinal's `core/collab.ts` is a Yjs-based implementation of exactly that.

Three for three isn't luck. Whoever's steering this fork's feature list was reading the actual
upstream backlog, not guessing at what a wiki "should" have. That's a genuinely different posture
from most hard forks, which tend to either copy the parent 1:1 or chase whatever the forker
personally wanted. This one shipped the three things the *existing* Wiki.js community had been
asking for the longest.

*(Couldn't verify, and shouldn't be asserted: claims that Wiki.js 2.x's admin UI is "slow" or
"clunky." Real, sourced 2.x complaints center on a thinner plugin ecosystem and search breaking
down on complex/filtered queries — narrower gripes than "the UI is bad," and worth being precise
about if this ever gets cited publicly.)*

## Part 3: What would worry a security-conscious adopter

A community with any self-hosting instinct reads past the README before deploying anything
containing the word "collaborative," and here's what they'd find:

- **Custom blocks execute unsandboxed arbitrary JavaScript, for every reader, on every page view.**
  This is documented as a deliberate design choice (`docs/security/custom-block-upload.md`), not an
  oversight — "there is no iframe, no Worker, no shadow-DOM script boundary, no CSP sandboxing." The
  part that should raise an eyebrow: it's gated by `manage:sites` *or* the newer delegated
  `site:blocks` permission, meaning a non-admin an owner delegated partial control to can now decide
  whether arbitrary script runs for every future visitor to that site. That's a real, non-obvious
  privilege-escalation shape, clearly written down, that a security-review thread would zero in on
  immediately.
- **A dead-on-arrival auth module, shipped as a working option.** CAS 1.0 support is wired up but
  structurally can never authenticate anyone — the protocol gives no email attribute, the account
  model requires one, so login always throws. Cosmetically present, functionally a trap for whoever
  picks it from a dropdown. *(As of this audit's 2026-09-13 snapshot. CAS 1.0 support was since
  removed entirely — CAS 3.0, which does report an email attribute and does provision/log in
  accounts, is now the only option; #3187/#3207.)*
- **Roughly ten enterprise SSO integrations — LDAP, SAML, CAS, Auth0, Okta, Microsoft, Keycloak,
  GitLab, Twitch, Discord, Slack — documented by the fork's own team as never having been verified
  against a real identity provider**, only mocks. For a self-hoster, "we tested this against a fake
  server" is exactly the sentence that turns "I'll try Cardinal for my org's internal docs" into
  "I'll wait for someone else to try it first."
- **The migration tool built specifically to attract this fork's most obvious audience — existing
  Wiki.js 2.5.x admins — silently drops security-relevant state on import**: two-factor enrollment,
  API tokens, third-party notification credentials, and comment reply-threading don't survive the
  move; timestamps get rewritten to "now." The exact users Cardinal most needs to win over are the
  ones this tool is honest, in writing, about partially failing.

None of this is disqualifying on its own — every young fork ships gaps. But it's the kind of list
that, surfaced in one security-review blog post, becomes the whole first impression, and right now
nothing in the public-facing docs flags any of it before someone deploys.

## Part 4: The tracker you can see the edges of but not the inside of

Commit messages in this repo casually reference things like "OpenProject Feature #786" or close
against specific work-package IDs — which means a curious outside contributor browsing the public
git log keeps bumping into a work-tracking system they have no access to. That's a minor UX
annoyance on its own, but it's also the only externally-visible seam into a real pattern: this
fork's own internal tracker has accumulated **at least eight separate tickets whose entire content
is "the build is broken on scarlett again"** (filed across roughly three weeks), and at least three
instances of the same underlying bug getting filed two or three times over before anyone
deduplicated it. None of that is visible from outside today — but the moment this project opens its
planning surface to the public, as most successful forks eventually do, that history becomes
readable, and "the CI has been chronically red and re-discovered a dozen times" is not the read a
new contributor wants on day one of poking around.

## Part 5: The identity problem

- **Cardinal.js has, as of this writing, essentially zero organic visibility.** A GitHub-wide search
  for the project surfaces nothing but the repository's own automated pull requests — titles like
  "Cycle: graph layout, path-display casing, glossary acronyms..." — which confirms not just low
  visibility but *zero outside engagement*: nobody has starred it into a list, blogged about it, or
  opened an issue that isn't the maintainer's own tooling talking to itself.
- **"Cardinal" isn't the clean slate it looks like.** [DISTRHO/Cardinal](https://github.com/DISTRHO/Cardinal)
  is an established, moderately well-known open-source virtual modular synthesizer with its own real
  user base under the exact same bare name. There's also a long-standing `cardinal` npm package (a
  JS syntax highlighter) — this fork's own `cardinal-backend` package name sidesteps a direct
  collision there, but "Cardinal.js" as a product name is entering a space that already has an
  unrelated "Cardinal" with mindshare, not an empty one.

## Part 6: What history says about forks that actually stuck

Two comparable hard-forks, for calibration:

- **OpenTofu**, forking from Terraform in 2023: renamed within weeks under legal advice, adopted
  Linux Foundation governance *from day one*, shipped its first independent release (v1.6.0) about
  four months after the fork, and had a public manifesto plus a multi-company coalition behind it
  before the fork was even announced. Never, at any point, a solo effort.
- **Forgejo**, forking from Gitea starting in 2022 over a for-profit takeover of Gitea's own
  domain/trademark: took roughly 14 months to go from "soft fork" to a declared hard fork, but was
  governed by Codeberg e.V. — a non-profit, with elections and a public roadmap — from very early in
  that process.

The common thread isn't "rename fast" (though both did). It's that **neither one was ever a
single-maintainer effort** — both had institutional backing and public governance in place before
or at the moment of permanent divergence. Cardinal.js's model right now — one committer, planning
tracked in a private system, zero outside contributors a month in — has no precedent among the hard
forks that actually survived long enough to matter. That's not a moral judgment; it's the base rate.

## The actual verdict

The parts that would make a skeptic reconsider are real and well-evidenced: this fork read the
actual Wiki.js backlog and built the three things people had been asking for longest, it kept the
AGPL license instead of quietly drifting away from it, and it committed to a distinct name early
instead of squatting on "Wiki.js" indefinitely.

The parts that would make a skeptic walk away are also real and now better-evidenced than before:
zero outside engagement of any kind, a governance model with no precedent among forks that survived,
a handful of concrete security caveats undisclosed anywhere a prospective adopter would see them
before deploying, and a migration tool that quietly fails the exact users it most needs to attract.
Both the "this is the fork that fixed Wiki.js's real gaps" story and the "extremely well-organized
solo experiment that never opened up" story are still equally live. Which one happens has nothing
to do with whether the code is good — that part's already decided, and it's good. It has everything
to do with whether anyone outside this repository ever gets a reason to look, and right now,
provably, nobody has.

---

*Methodology note (out of character): claims are checked against `.github/FUNDING.yml`,
`.github/SECURITY.md`, `backend/tasks/simple/check-version.ts`, `README.md`,
`docs/legal/04-agpl-obligations.md`, `docs/legal/06-branding-and-trademark.md`,
`docs/security/custom-block-upload.md`, `docs/variances.md`, this repository's own git history, and
live web research into Wiki.js's public GitHub issues/discussions and comparable OSS hard-forks
(OpenTofu, Forgejo), all performed 2026-09-13. The "community says" framing is illustrative
synthesis of likely reaction, not a transcript of real posts or real people. Where research came up
empty or thin (e.g. 2.x "slow admin UX" complaints), that is flagged rather than asserted.*
