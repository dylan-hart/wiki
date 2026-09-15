# GTM 11 — Pitfalls Audit: A Young OSS Project Taking On Its Own Upstream

**Date:** 2026-09-13 · **Branch:** `scarlett` @ `df032646a` · Part of the
[war room set](2026-09-13-gtm-00-war-room.md).

**What this audits.** The common ways new open-source projects fail, and the specific ways a hard fork
competing with its upstream fails. Each is checked against *this* repository today, not just listed.
Every "Evidence" cell was gathered from the repo on 2026-09-13 unless marked *judgment*.

**Exposure ratings**
- **EXPOSED**: the pitfall is live in the repo or plan right now.
- **PARTIAL**: some mitigation exists, gaps remain.
- **WATCH**: not live yet; becomes live at launch or with growth.
- **HANDLED**: adequately covered; keep doing it.

---

## Scorecard — the 12 that matter most

| # | Pitfall | Exposure | Why it's on top |
|---|---|---|---|
| 1 | **Shared-code security gap** — upstream's advisories publicly reveal Cardinal's holes (A1) | EXPOSED | No monitoring; the auth/permission core is inherited |
| 2 | **Reverse disclosure** — publishing a flaw in inherited code exposes upstream's users (A2) | EXPOSED | The fastest route to villain status |
| 3 | **Shared default admin password on first boot** (B4) | PARTIAL | Forced change and `ADMIN_PASS` exist, but an unset `ADMIN_PASS` still seeds the same known password on every install, so whoever logs in first owns the instance |
| 4 | **Privacy-hostile defaults for a "governed" wiki** (B5) | EXPOSED | Diagram source sent to kroki.io / plantuml.com by default |
| 5 | **Breaking-change policy that can't survive real users** (B6) | EXPOSED | Current project policy mandates no compat shims and squashed migrations |
| 6 | **Scope too large for one maintainer** (B1) | EXPOSED | ~217k non-test LOC, 16 auth modules, 26 blocks, 167 production dependencies |
| 7 | **Identity bleed** — Cardinal users routed to upstream (A3) | EXPOSED | In-app docs go to `beta.js.wiki`; update check polls `requarks/wiki` daily |
| 8 | **More AI output than a human can review** (C1) | EXPOSED | 731 commits in 4 weeks; landings of 100+ work packages at once |
| 9 | **Employer IP and data-location risk** (D1, D5) | EXPOSED | Coworkers use it |
| 10 | **Overclaiming** — i18n, SSO, "production-ready" (B2, B19) | EXPOSED | 55 locales, each ~38% translated; SSO presets unverified against live identity providers |
| 11 | **The fork treadmill** — divergence tax (A4) | WATCH | 2,170 files changed since the fork point |
| 12 | **Launch-and-vanish** (B12) | WATCH | A cadence has never been demonstrated publicly |

---

## Part A — Pitfalls of an adversarial fork

### A1 · Upstream's security advisories reveal Cardinal's vulnerabilities — EXPOSED
- **The pitfall.** Upstream publishes a GitHub Security Advisory for a flaw in code you both share. From that moment, the advisory is a public exploit guide for every Cardinal instance, until you port the fix.
- **Evidence.**
  - Most of Cardinal's code still comes from upstream's 3.x branch: the auth, permissions, assets and rendering foundations.
  - Upstream's advisory history is the vulnerability classes that live in that kind of code: critical privilege escalation via group validation (2026-04-28), disabled-user lockout bypass, stored XSS via template injection, path-based write-check bypass, SVG/MIME XSS, path traversal.
  - Nothing in the repo or process watches `requarks/wiki` advisories or releases.
- **Mitigation.**
  - Watch upstream's security advisories and releases, with notifications turned on.
  - Adopt a written rule: *upstream security fixes to shared surface are assessed within 2 business days and ported within 7, or mitigated with a published workaround.*
  - Keep a merge base with upstream (doc 10, history option B) so ports are cheap.
  - Add one line to SECURITY.md: "Cardinal monitors upstream Wiki.js advisories for shared code."

### A2 · Disclosing a flaw in inherited code exposes upstream's users — EXPOSED
- **The pitfall.** You find and fix a vulnerability in code Cardinal inherited, then publish your advisory. Every Wiki.js 2.x or 3.x installation carrying the same flaw now has a public exploit and no patch.
  - Out of every way to turn upstream's community against you, this is the most defensible for *them* to be angry about.
- **Evidence.** None of the reporting setup exists yet (`.github/SECURITY.md` still sends reporters to `security@requarks.io`), so there is no policy either way.
- **Mitigation.**
  - Put this in SECURITY.md: *"If a vulnerability also affects upstream Wiki.js, we notify Requarks privately and coordinate disclosure before publishing."*
  - Actually do it: email upstream's security contact, offer the patch, agree on an embargo of about 90 days, and credit both sides.
  - This is also the single best goodwill move available to you with NGPixel. It costs nothing and it's simply correct.

### A3 · Identity bleed: Cardinal users end up at upstream's door — EXPOSED
- **The pitfall.** When users can't tell the products apart, Cardinal bug reports and support questions land in upstream's Discussions, Discord and inbox. That burdens NGPixel, draws public complaints about "that fork", and makes Cardinal look like a parasite.
- **Evidence.**
  - `backend/base.yml:225`: `docsBase: 'https://beta.js.wiki/docs'`. In-app help sends Cardinal users to upstream's 3.x docs, which describe a different product.
  - `backend/models/jobs.ts:27`: `checkVersion` runs daily (`0 0 * * *`), and `check-version.ts` polls `api.github.com/repos/requarks/wiki/releases/latest`. Every admin dashboard reports upstream's release as "the latest version".
  - GitHub repo description and homepage still read "Wiki.js | A modern and powerful wiki app" / `js.wiki`.
  - `.github/CONTRIBUTING.md` is upstream's (with a disclaimer at the top).
  - `config.yml` shape is shared with upstream 3.x, so upstream's docs look applicable.
- **Mitigation.** Doc 04 A5/A6, plus:
  - blank `docsBase` until Cardinal has its own docs;
  - a Cardinal-owned update endpoint;
  - a "Cardinal" label in the admin header and error pages;
  - an FAQ entry "Is this Wiki.js?";
  - never tell users to "see the Wiki.js docs".

### A4 · The fork treadmill — WATCH
- **The pitfall.** Two failure modes:
  - Chasing every upstream change forever, which drains all capacity.
  - Ignoring upstream until the shared surface falls visibly behind: "Wiki.js 3 fixed that months ago."
- **Evidence.**
  - `git diff --shortstat d0c5a8bfa HEAD`: **2,170 files changed, +515,931 / −43,772 lines** (includes tests and generated files).
  - Upstream added 57 commits in the same four weeks.
  - Divergence only grows. Every month, ports cost more.
- **Mitigation.** A written port policy:
  - security fixes, always;
  - bug fixes in shared code, when cheap;
  - features, never by default, and only by explicit decision.
  - Time-box it at 1h/week (doc 04 C13). Record reviewed upstream ranges so you never re-read them.

### A5 · Letting upstream set your roadmap — WATCH
- **The pitfall.** Building whatever upstream ships so the comparison matrix stays green. You become a slower, less trusted copy.
- **Mitigation.** The positioning in doc 03 is the filter: migration, governance, agents, support. "Upstream has it" is not a reason to build something; "our segments need it" is.

### A6 · Grievance marketing — PARTIAL
- **The pitfall.** Framing the project as a rescue ("upstream is slow / dead / hostile"). Forks that won (Valkey, Forgejo) had an upstream that *broke trust*. Yours hasn't: NGPixel publicly said forking is fine, and 3.0 is in beta.
- **Evidence.** The plan already forbids it (doc 02 §2). The risk is personal: the private "ponytail" read of NGPixel (recorded in project memory) leaking into public tone.
- **Mitigation.** Doc 02's standard: publish nothing about Wiki.js that NGPixel couldn't call accurate.

### A7 · Poaching translators and ecosystem contributors — EXPOSED (on claims)
- **The pitfall.** Pulling translators, block authors or packagers away from upstream reads as hostile. Advertising inherited locales as your own is overclaiming.
- **Evidence.** 55 non-English locale files, **every one at ~38% coverage** of 3,604 `en.json` keys, so most of the UI falls back to English. Claiming "55 languages" or leading on the RTL work would be false advertising.
- **Mitigation.**
  - Claim only complete locales.
  - Open your own translation project and invite people openly without recruiting from upstream's channels.
  - Credit the inherited translations to upstream's translators.

### A8 · License and attribution slips — PARTIAL
- **Evidence.**
  - `.github/FUNDING.yml` still pays NGPixel, Requarks and wikijs.
  - `.github/SECURITY.md` points at `security@requarks.io`.
  - There is no `NOTICE` file.
  - `docs/legal/07` lists roughly 19 open items.
  - The planned history reset can erase the fork's strongest attribution (doc 10, F3).
- **Mitigation.** Doc 04 A5/A6 before anything public. Choose history option B.

### A9 · Name confusion and trademark — EXPOSED
- **Evidence.**
  - No clearance search has been done.
  - DISTRHO/Cardinal is an established OSS project with the same name.
  - `gitlab.com/cardinal` is taken.
  - `cardinal` on npm is taken.
- **Mitigation.** Doc 04 A2 before building any branded asset.

### A10 · Assuming the installed base wants to leave — WATCH
- **The pitfall.** Most Wiki.js 2.x installations are fine and will stay put. Treating 146M pulls as "your market" leads to spammy outreach and disappointment.
- **Mitigation.** Target people who hit a trigger: a stranded database engine, a security worry, wanting a 3.x feature, needing support. Measure completed migrations, not reach.

### A11 · Inheriting 2.x's support burden — WATCH
- **The pitfall.** Becoming the de facto way off Wiki.js 2.x means inheriting the quirks of five database engines, twelve years of plugins and odd installations (MSSQL unicode, MySQL auth errors, git-storage zombie processes). That becomes free, unbounded support for software you didn't write.
- **Mitigation.**
  - A published support matrix (engine × 2.x version × supported/partial/no).
  - The dry-run report as the triage tool: "attach your report or we can't help."
  - A paid tier for complex migrations (doc 08 §3.1).

---

## Part B — Pitfalls of any new, unproven project

### B1 · Scope larger than one person can maintain — EXPOSED
- **Evidence.** A single maintainer is responsible for:

  | Surface | Count |
  |---|---|
  | Auth modules | 16 |
  | Storage | 7 |
  | Search engines | 5 |
  | Comment providers | 4 |
  | Analytics | 3 |
  | Lit blocks | 26 |
  | MCP tool files | 20 |
  | API route files | 92 |
  | Frontend pages | 51 |
  | Frontend components | 179 |
  | Non-test source | **~217k lines** |
  | Production dependencies | **153** (backend 67, frontend 73, blocks 13), plus 52 dev |

  Every module is a public promise, a bug surface, a dependency-upgrade treadmill and a documentation page. Most self-hosted projects that die, die of maintenance surface rather than competition.
- **Mitigation.**
  - Publish module support tiers before launch:
    - **Core**: maintained and tested live.
    - **Supported**: tested against mocks, community verification wanted.
    - **Experimental**.
    - **Deprecated**.
  - Show the tier in the admin UI.
  - Retire modules nobody uses once update-check data exists.
  - Each new module needs a named user who will test it.

### B2 · Options that don't actually work — EXPOSED
- **Evidence.**
  - The CAS module can never log anyone in (CAS 1.0 only, no provisioning or login capability), as
    of this audit's 2026-09-13 snapshot. *Update 2026-09-14: CAS 1.0 support was removed and CAS
    3.0 — which does provision and log in accounts — became the only option (#3187/#3207); this
    item no longer applies.*
  - Roughly ten SSO integrations were verified only against mocks.
  - History of the same pattern: a ratings feature and about 1,400 lines of a data-template admin panel shipped as dead UI before audits removed them.
- **Why it's fatal early.** The first evaluator who picks a broken option from a dropdown stops trusting every other claim.
- **Mitigation.** Doc 04 B5 and C9: remove or label. Hold the rule "if nobody has seen it work, it isn't in the UI."

### B3 · Install friction kills trials — PARTIAL
- **Evidence.**
  - Node 26 only. Node 26 enters LTS around October 2026; until then some ops teams will balk.
  - PostgreSQL 16+, plus pgvector for semantic search.
  - No production compose file; the only compose files are `.devcontainer/` and search-test.
  - A known trap: no session cookie at all on plain HTTP unless `cookieSecure` is changed (project memory).
- **Mitigation.**
  - Doc 04 C2: one compose file.
  - A first-run mode that works on `http://localhost`.
  - Time a cold install as a release gate.

### B4 · A shared default admin password on first boot — PARTIAL
- **Already in place** (`backend/models/users.ts:1517-1523`):
  - `ADMIN_EMAIL` / `ADMIN_PASS` environment variables seed the admin account on first boot.
  - When `ADMIN_PASS` is unset, the seeded account has `mustChangePassword: true`, so first login forces a new password.
- **Remaining gap.** With `ADMIN_PASS` unset, every install seeds the *same* publicly documented password (`12345678`, in `README.md` lines 78, 189 and 199). The forced change protects the operator only if the operator logs in first.
  - On an internet-reachable instance, anyone who reaches the login page before the operator can use the default, complete the forced change themselves, and own the instance. Scanners look for known defaults.
  - This is a well-known weakness class (CWE-1392, use of default credentials), so a reviewer will note it. The forced change and the env var make it a medium finding, not a critical one.
- **Mitigation** (small change, keeps the current flow):
  - When `ADMIN_PASS` is unset, generate a random password and print it once to the startup logs, instead of seeding `12345678` (Jenkins and GitLab self-managed work this way). Keep the forced change.
  - Put `ADMIN_EMAIL`/`ADMIN_PASS` in the production compose file and the install docs, so most people never see a default at all.
  - Stop printing the literal password in user-facing docs. The dev container and e2e suite already set it explicitly and can keep doing so.
  - Keep registration off by default.

### B5 · Privacy-hostile defaults in a "governed" product — EXPOSED
- **Evidence.**
  - `blocks/block-kroki/component.js:5` (`https://kroki.io`) and `blocks/block-plantuml/component.js:5` (`https://www.plantuml.com/plantuml`): diagram *source text* from wiki pages goes to public third-party servers by default. That is page content leaving the instance.
  - `backend/base.yml:66`: icon resolution falls back to `https://api.iconify.design`.
  - Daily version check to GitHub.
  - Map blocks load OpenStreetMap tiles.
  - The CSP allows `connect-src 'self' https:` specifically to support this.
- **Why it matters.** Your positioning is governance, sovereignty and "on your servers" (doc 03). A reviewer who greps for egress finds classified pages' diagrams going to kroki.io. Self-hosters also treat surprise phone-home as a betrayal.
- **Mitigation.**
  - Default diagram servers to *disabled*, or to a bundled or same-host renderer, with an explicit admin opt-in naming the third party.
  - Publish a "Network egress" page listing every outbound call, its purpose and its off switch.
  - Advertise the existing `offline` mode (`docs/offline-deployment.md`).
  - Tighten the CSP once the defaults change.

### B6 · A breaking-change policy that can't survive real users — EXPOSED
- **Evidence.** CLAUDE.md, verbatim in spirit:
  - "Nothing here has to stay compatible with an existing installation … do not write migration shims, legacy-value fallbacks, deprecated aliases."
  - Migration history "is periodically squashed back to a single fresh-install schema init … anyone holding an existing … database … has to drop and recreate it."
  - That's correct for a pre-release branch. The day a coworker, design partner or stranger runs a tagged release, it becomes **data loss by policy**.
  - The agents follow CLAUDE.md, so the policy will be executed faithfully unless you change it.
- **Mitigation.** On the commit that cuts the first public tag:
  - rewrite those dev-doc sections to "every tagged release upgrades in place from the previous one";
  - DB migrations are append-only;
  - config and API changes get a deprecation window;
  - add an upgrade-from-previous-release e2e test as a release gate.
  - This is the most important internal policy change launch forces (doc 07 §4 notes it). Your coworkers' instance may already be exposed.

### B7 · Documentation written for agents, not users — EXPOSED
- **Evidence.**
  - CLAUDE.md is 16,673 words and `docs/variances.md` 21,405 words, against **zero user-facing install/admin docs** and no docs site.
  - Earlier audits in this same folder got basic facts wrong in both directions: "no migration CLI" (false) and "private repo" (false). Machine-written documentation drifts confidently.
- **Mitigation.**
  - User docs, each page verified by actually doing it on a fresh install.
  - A short human `CONTRIBUTING.md`, with CLAUDE.md framed as agent configuration.
  - Date and source any factual claim in marketing.

### B8 · Community infrastructure bigger than the community — WATCH
- **The pitfall.** A Discord with 4 people in it, an empty forum, a roadmap board with 300 items. An empty room signals a dead project.
- **Mitigation.** One public support channel (doc 10 §4: GitLab issues) until volume demands more.

### B9 · Saying yes — WATCH
- **The pitfall.** Accepting every feature request into an ever-growing backlog, which becomes an implicit promise and a maintenance tax. With agents, "yes" is cheap to *build* and expensive to *own*.
- **Mitigation.** "Not planned, with a reason" as a normal, kind response (doc 07 §5).

### B10 · Neglecting first-time contributors — WATCH
- **The pitfall.** A first merge request waits three weeks and the contributor never returns. Specific to this repo: overnight automated work-cycle landings can **conflict with or duplicate** an open outside MR, which reads as the maintainer's robots overwriting their work.
- **Mitigation.**
  - A published 2-business-day first-response target.
  - Work-cycle runs check for open outside MRs touching the same files and skip or coordinate.
  - Credit contributors in release notes.

### B11 · Chasing vanity metrics — WATCH
- **The pitfall.** Optimizing for stars and upvotes; star-exchange temptations; mistaking HN traffic for adoption.
- **Mitigation.** Doc 07 §8: active instances, completed migrations, time to first response.

### B12 · Launch-and-vanish — WATCH
- **The pitfall.** A big launch, a two-week burst, then six weeks of silence while real life happens. The "is it dead?" threads start, which is exactly what upstream suffered for years.
- **Evidence.** A public release cadence has never been demonstrated. Internal velocity is invisible and bursty (overnight work cycles).
- **Mitigation.**
  - Small, regular releases, even if tiny.
  - Announce breaks in advance ("maintenance mode until …").
  - Given the premise that adoption is optional, a *slower, steady* public cadence beats bursts.

### B13 · Perceived rug-pull when money appears — WATCH
- **Evidence from the field.**
  - Docmost's 2FA-paywall backlash (#1889).
  - Plane's paid-only wiki.
  - Gitea's move to a for-profit company, which produced Forgejo.
- **Your specific traps.**
  - The GitLab for Open Source program forbids selling services (doc 10, F8).
  - Anything that looks like gating AGPL features.
- **Mitigation.** Doc 08 §8. State the money policy publicly *before* any money exists: "no closed edition, ever; paid services only."

### B14 · Unstated governance — WATCH
- **The pitfall.** Nobody knows who decides, how to become a maintainer, or what happens if you vanish, so serious contributors and organisations hold back.
- **Mitigation.** A short `GOVERNANCE.md`: benevolent dictator for now, with a stated path to more maintainers and a continuity plan (doc 07 §6).

### B15 · Supply-chain and account compromise — PARTIAL
- **Evidence.**
  - Handled: CI Actions are pinned to commit SHAs, with build-provenance attestation.
  - Gaps:
    - 153 production dependencies;
    - no secret scanner on this machine (`gitleaks` and `trufflehog` absent);
    - account 2FA posture unknown;
    - a CI rebuild pending on GitLab (doc 10).
- **Mitigation.** Doc 04 B7 and doc 09 P7. Add a secret scan to CI and run it before the history reset.

### B16 · Depending on a single platform — WATCH
- **The pitfall.** An account suspension, a false-positive abuse flag (high-volume automated activity is a plausible trigger, *judgment*), or a platform policy change takes the project offline.
- **Mitigation.**
  - The GitHub push mirror from doc 10.
  - Periodic offline `git bundle` backups.
  - Images in two registries.
  - The domain and DNS held outside either code host.

### B17 · Public demo abuse — WATCH
Doc 04 C7 and doc 09 P8.

### B18 · Hosting users' content without legal plumbing — WATCH (only if you ever host)
Terms of service, DPA, DMCA agent, acceptable-use policy (doc 08 §7).

### B19 · Overclaiming maturity — EXPOSED
- **Evidence.**
  - The README's red "VERY BUGGY… NON-SECURE" banner is currently *accurate*.
  - Removing it without doing the work behind doc 04's launch gates would be the overclaim.
  - Also: locale coverage (A7), SSO verification (B2), "production-ready" relative to upstream's "beta".
- **Mitigation.** A per-feature maturity table; replace the banner only when the gates are green.

### B20 · Mistaking the test suite for correctness — PARTIAL
- **Evidence.**
  - Test code is **~236k lines, more than the ~217k lines of source it tests**.
  - An earlier internal audit found ~2,900 frontend and ~4,600 backend lines of assertions "that cannot fail on a product defect".
  - Project memory records layout bugs green in jsdom and broken in real Chromium, and features closed and broken the same day.
- **Mitigation.**
  - Never market test counts.
  - Advertise what users feel: an e2e browser suite, cold-install gates, the migration corpus, the external security review.
  - Keep doing "verify in the real app" (doc 07 §3).

---

## Part C — Pitfalls specific to an AI-built project

### C1 · More output than a human can review — EXPOSED
- **Evidence.**
  - 731 commits between 2026-08-16 and 2026-09-13, 497 with a Claude co-author trailer.
  - Work-cycle landings of dozens to 126 work packages in one merge request (project memory).
  - 356 same-file feat→fix pairs within 48 hours (`ngpixel-field-notes.md`).
- **Why it's the top AI risk.** Incidents come from security-relevant changes nobody fully read.
- **Mitigation.**
  - A mandatory human review checklist for auth, permissions, uploads, custom blocks, MCP tools, outbound fetchers and the importer (doc 07 §7).
  - Smaller landable units on the public main branch.
  - Slow the agents down on sensitive surface; speed isn't scarce, trust is.

### C2 · Process theatre — plausible-but-unverified completion — EXPOSED
- **Evidence (`ngpixel-field-notes.md`).**
  - Feature #3093 passed every lifecycle gate to Closed on the same day it produced two bug reports.
  - At least eight "CI red on scarlett" tickets.
  - Duplicate bug filings for the same root cause.
  - A formatter check that printed a finding and exited 0.
- **Why it matters publicly.** Once the tracker or history is visible, this is the "it's all rubber stamps" story.
- **Mitigation.**
  - A green main branch as a hard rule (doc 04 B8).
  - Treat "closed" as "a human saw it work" for anything user-visible.
  - Dedupe before opening the planning surface (doc 07 §6).

### C3 · Mishandling disclosure — PARTIAL
- **Evidence.** Commit trailers disclose today. The planned history reset could erase them (doc 10).
- **Mitigation.** Doc 03 §6, doc 09 P21, and history option B.

### C4 · AI text in human venues — WATCH
HN guidelines, awesome-selfhosted, selfh.st and Lobsters all refuse or ban AI-written submissions or comments. The temptation peaks on launch day, when you're tired and fifty comments are waiting. The rule is doc 05 §1.3: **every word in a community venue is yours.**

### C5 · The "AI look" — WATCH
Show HN commenters now score landing pages for "AI design slop". Generic hero sections, gradient cards, emoji bullets and uniform prose get dismissed. Mitigation: real screenshots, hand-written copy, a distinct visual identity (doc 03 §4).

### C6 · Knowledge that lives only in agent context — EXPOSED
- **Evidence.**
  - The *why* behind decisions lives in a 16.7k-word CLAUDE.md, a 21.4k-word `variances.md`, `docs/decisions/` and a private OpenProject tracker with ~1,550 work packages.
  - A human contributor can't navigate that; it's a bus factor that includes your agent setup.
- **Mitigation.**
  - A human-sized architecture overview (2–3 pages).
  - Decision records for the handful of load-bearing choices.
  - Contributor docs that don't require reading CLAUDE.md.

### C7 · Copyrightability of AI-generated modifications — WATCH
`docs/legal/03` notes the degree of human authorship needed to protect AI-assisted code is unsettled. Practical effect: your enforceable rights over your modifications may be thinner than over hand-written code. That makes the **trademark** (doc 04 A2) relatively more important as your protectable asset. *Legal-advice territory.*

### C8 · Other people's AI contribution floods — WATCH
Doc 09 P15: require reproduction steps or a proof of concept, discuss before opening an MR, publish `AI_POLICY.md`.

---

## Part D — Personal pitfalls for a solo maintainer

### D1 · Employer IP ownership — EXPOSED
Coworkers use Cardinal. Work done "for the employer's benefit" or "related to the employer's business" is exactly what IP-assignment clauses (and California §2870's exceptions) reach. Resolve it in writing before any public launch (doc 04 A1).

### D5 · Where coworkers' data lives — EXPOSED (check)
- **The pitfall.** If colleagues' work content sits on an instance you run on personal hardware, that may breach your employer's data-handling or acceptable-use policy. It also makes you the on-call admin, backup operator and incident responder for their data.
- **Evidence.** Project memory records that you run the wiki on a separate home machine for your own use. *Where the coworker instance runs isn't recorded; verify, don't assume.*
- **Mitigation.**
  - Host the coworker instance on employer-approved infrastructure, ideally operated by the employer.
  - Or get explicit approval, and add backups plus a restore test.

### D2 · Burnout from the launch spike — WATCH
Doc 07 §9. Your premise ("it doesn't matter if it takes off") is the best protection you have; don't let launch-week adrenaline overwrite it.

### D3 · Tying your identity to the project — HANDLED (keep it that way)
Hostile threads hurt less when the project isn't your livelihood or self-worth. Keep income optional (doc 08 framing).

### D4 · Your coworkers' needs versus the public's — WATCH
- **The pitfall.** Your first users are coworkers. Their needs are real, but outsiders may want different things. Either you build only for them, or you let public requests pull the product away from them.
- **Mitigation.** Coworkers stay the success floor (war room premise). Public requests go through the positioning filter.

### D6 · Unpaid enterprise support — WATCH
- **The pitfall.** Organisations, possibly including your own employer's peers, treat you as free on-call support.
- **Mitigation.** Doc 08 §3 and doc 09 P17. Say the boundary once, kindly.

---

## Part E — Tripwires: early-warning signals and what to do

| Signal | What it means | Action |
|---|---|---|
| Upstream publishes a security advisory | A1 is now live | Assess within 2 business days; port or mitigate within 7 |
| A Cardinal issue appears in upstream's venues (or vice versa) | A3 identity bleed | Fix the misleading surface; politely redirect; thank upstream if they redirected |
| First outside MR waits > 2 business days | B10 | Drop other work and respond |
| Main branch red > 24h | C2/B12 | Stop merging until green |
| Open issues grow > 20% month over month with flat closes | B9 or capacity | Declare scope; close "not planned"; recruit a triager |
| Same bug reported 3× across channels | Docs/UX gap | Fix the product or docs, not the replies |
| A module has had no reported users for 6 months (per update-check data) | B1 | Move it to Deprecated |
| You're dreading notifications | D2 | Maintenance-mode announcement; time off |
| "Is Cardinal dead?" appears | B12 | Ship something small and say what's next |
| A migration corrupts data | A11 / doc 09 P9 | Incident protocol |
| Someone asks "where did the Claude commits go?" | C3 / P21 | Link the disclosure; never deny |
| A coworker's workflow depends on an unreleased branch | B6 | Tag a release; switch on the upgrade-compat policy |

---

## Part F — Things that feel like pitfalls but aren't

- **Low star counts early.** BookStack took years; Docmost is still pre-1.0 after two.
- **Not being 1.0.** Cadence builds trust, not version numbers.
- **Upstream not endorsing you.** AGPL is the permission. Endorsement was never on offer, and seeking it invites a public "no".
- **Competitors having more features.** Docmost won with fewer.
- **Saying no a lot.** That's maintenance, not rudeness.
- **Not supporting MySQL/SQLite as a *target*.** Postgres-only is a defensible, documented decision (`docs/migration/decision-source-scope.md`). Supporting them as migration *sources* is what matters.
- **Having no Discord.** Searchable async support scales better for one person.
- **Being openly AI-built.** Hiding it is the pitfall. Doing it rigorously and in the open is a story people can respect.

---

## Part G — New actions this audit adds (not already in doc 04)

| # | Action | Addresses | Effort |
|---|---|---|---|
| N1 | Watch upstream security advisories and releases; add the port rule to SECURITY.md | A1 | S |
| N2 | Coordinated-disclosure-with-upstream clause in SECURITY.md, and follow it | A2 | S |
| N3 | When `ADMIN_PASS` is unset, seed a random password printed once to the logs (keep the forced change); put `ADMIN_PASS` in the compose file and docs | B4 | S |
| N4 | Egress defaults: diagram renderers off or same-host by default; publish a "Network egress" page; tighten the CSP | B5 | M |
| N5 | Blank `docsBase` (currently `beta.js.wiki/docs`) until Cardinal docs exist | A3 | S |
| N6 | Flip the project's compat and squashed-migration policy on the first public tag; add an upgrade-from-previous e2e gate | B6 | M |
| N7 | Module support tiers, shown in the admin UI | B1, B2 | M |
| N8 | Claim only complete locales; open a Cardinal translation project | A7, B19 | S |
| N9 | Human-sized architecture overview + short CONTRIBUTING | B7, C6 | M |
| N10 | Work-cycle guard: skip or coordinate when an outside MR touches the same files | B10 | M |
| N11 | Secret scan in CI and before the history reset | B15 | S |
| N12 | Confirm where the coworker instance and its data live; move or approve | D5 | S |
| N13 | `GOVERNANCE.md` + continuity note | B14 | S |
