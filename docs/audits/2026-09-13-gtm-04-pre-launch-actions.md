# GTM 04 — High-Value Actions Before Launch Day

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md).

Ranked by **value ÷ effort, adjusted for irreversibility** — things that are cheap now and expensive or
impossible to fix after the internet has seen them rank highest.

**Owner key:** **YOU** = only a human can do it (legal, money, identity, relationships, public voice) ·
**AGENT** = an agent can do most of it under your review · **BOTH**.
**Effort:** S ≤ 2h · M ≤ 2 days · L ≤ 2 weeks · XL > 2 weeks.

---

## Tier A — Identity & legal (irreversible if skipped; do first)

> **GitLab move:** A3, A4, A7, B1, B7, B8 and C1 still stand, but their mechanics change with the planned
> history reset and move to GitLab. [Doc 10](2026-09-13-gtm-10-history-reset-and-gitlab.md) §5 gives the
> order of operations. Do the reset and move **before** C1's first tag.

| # | Action | Why it's high value | Effort | Owner | Done when |
|---|---|---|---|---|---|
| A1 | **Read your employment agreement** (IP assignment, moonlighting, conflict of interest, OSS policy). If your employer is anywhere near collaboration/knowledge software, get written approval | Could void your ownership of your modifications or your ability to earn from them. California §2870-style carve-outs don't cover work that "relates to the employer's business" | S | YOU | Written clarity on file |
| A2 | **Trademark knockout search** for the final name in classes 9 & 42 (US + EU; DIY on USPTO/EUIPO, or an attorney knockout ~few hundred USD) | Renaming after launch destroys SEO, links and recognition | S–M | YOU | Name decision D1 made |
| A3 | **Reserve the identity**: domain(s), GitHub org, Docker Hub namespace (even if GHCR is canonical — typosquatting), GHCR package, social handles (Bluesky, Mastodon, X, Reddit, YouTube, LinkedIn page), a project email on the domain | Squatters and typosquatters move after launch, not before | S | YOU | All handles owned, 2FA with hardware keys |
| A4 | **Move the repo** to `gitlab.com/cardinaljs/cardinal` with a reset history (doc 10), plus a read-only GitHub mirror. Until then, fix the GitHub description + homepage (currently "Wiki.js \| A modern and powerful wiki app" / js.wiki) | This is your search snippet and first impression today | M | BOTH | GitLab project live, pipeline green, mirror syncing, old repo retired |
| A5 | **Finish `docs/legal/07-recommended-actions.md`** in full: NOTICE, §5(a) statement, README logo + badge, footer source link with build revision, OCI labels, manifest license fields, font/Twemoji notices, asset provenance | Converts "unlicensed rebrand" read into "careful fork"; AGPL §13 source offer must be exact | M | AGENT | Checklist items A–E all ticked |
| A6 | **Replace every upstream-pointing live surface**: `.github/FUNDING.yml` (pays NGPixel/Requarks/wikijs OC), `.github/SECURITY.md` (`security@requarks.io`), `check-version.ts` (`requarks/wiki` releases), Swagger title, boot banner, Dockerfile maintainer label, CODE_OF_CONDUCT contact, issue templates, `base.yml` `docsBase` | Each is a "five-minute roast" item (`community-take.md`) and two of them misroute money and vulnerability reports | S–M | AGENT | `grep` of the product-name checklist shows only the five sanctioned categories |
| A7 | **Version-line decision (D2)** and delete any upstream `3.0.0-*` tags from local clones you publish from (origin currently has none — keep it that way) | Avoids "is this Wiki.js 3?" forever | S | YOU → AGENT | `docs/versioning.md` updated |
| A8 | **Adopt DCO** for contributions; state AGPL-3.0-only permanence; no CLA | Signals no future relicensing; Gitea→Forgejo lesson | S | AGENT | CONTRIBUTING.md + DCO check |
| A9 | **Trademark policy page** (Forgejo/Mozilla style): forks rename; hosts may say "runs Cardinal", not "official" | The brand is your only commercial moat (doc 08) | S | AGENT drafts, YOU approve | Published |

## Tier B — Trust & security (the post-Huntarr gate)

| # | Action | Why | Effort | Owner | Done when |
|---|---|---|---|---|---|
| B1 | **Enable GitHub private vulnerability reporting** + write a real SECURITY.md (supported versions, business-day response targets, disclosure timeline, CVE via GitHub CNA) + `/.well-known/security.txt` on the demo and website | The Huntarr inverse: the path to report must exist before anyone needs it | S | BOTH | A test report round-trips |
| B2 | **External security review** of: authn (local, 17 SSO modules, passkeys/2FA), authz (page rules, site delegation, API keys, MCP scoping), uploads/assets (SVG/XSS, traversal), custom blocks, SSRF in fetchers (diagrams, icons, live-data), collab websocket auth, the importer | You hold other systems' credentials; an AI-built solo project gets one chance. Upstream's own CVE history is XSS/traversal/priv-esc — test the same classes | L (+cash) | YOU commission; AGENT fixes | Report published with fixes, or a scoped statement of what was reviewed |
| B3 | **Pre-review self-audit pass** with the known upstream CVE classes as test cases (CVE-2026-44224 priv-esc via group validation, SVG/MIME XSS, path traversal, disabled-user password reset) | Cheap; lowers review cost; great release-note material | M | AGENT | Regression tests exist for each class |
| B4 | **Custom-block stance**: off by default, gated to `manage:system` (or clearly warned for `site:blocks` delegation), documented threat model on the security page | `community-take.md` Part 3 — the privilege-escalation shape reviewers will find | M | BOTH | Setting + doc shipped |
| B5 | **Remove or hide the CAS module**; label unverified SSO presets as "community verification wanted"; live-verify the top IdPs you can run in Docker (Keycloak, Authentik, a SAML IdP, LDAP) | A login option that can't log in destroys trust in every other claim | M | AGENT | Verified list published |
| B6 | **Secure defaults**: force admin password change on first run in production; cookie-secure behaviour documented (the plain-HTTP no-cookie gotcha); rate limits on; registration off by default | First-run is where the Show HN crowd pokes | M | AGENT | Fresh install walkthrough clean |
| B7 | **Account & release hygiene**: hardware-key 2FA on GitHub, Docker Hub, registrar, email; branch protection + required checks on trunk; signed tags; image signing (cosign) alongside existing provenance attestation; keep Actions SHA-pinned; least-privilege tokens, no long-lived PATs | 2025–26 supply-chain wave (chalk/debug phish, Shai-Hulud, tj-actions, keyv with valid provenance) | M | YOU (accounts) + AGENT (CI) | Checklist complete |
| B8 | **CI green and staying green**; fix the formatter gate exiting 0 on findings (`ngpixel-field-notes.md` §4) | A public red badge contradicts pillar 5; chronic red-trunk tickets are mineable history | M | AGENT | 30 consecutive green trunk runs |
| B9 | **`AI_POLICY.md` + "How Cardinal is built" page** (doc 03 §6) | Disclosure you volunteer is a strength; disclosure extracted is a scandal | S | YOU write the voice | Published |

## Tier C — The product offer (what people actually try)

| # | Action | Why | Effort | Owner | Done when |
|---|---|---|---|---|---|
| C1 | **Cut the first tagged preview** (`v0.9.0`, target **2026-09-30**) with a generated changelog and a GitHub Release | Starts awesome-selfhosted's 4-month clock (eligible ~2027-01-30); establishes cadence evidence | S | BOTH | Release page exists |
| C2 | **Production `docker-compose.yml`** (Cardinal + Postgres 18 + pgvector, volumes, healthchecks, non-root) and a **timed cold install** on a fresh €5–10 VPS and a Raspberry Pi 5/ARM box | Show HN demands a one-command try; TrueNAS requires non-root; ARM is unverified | M | AGENT + YOU (hardware) | < 10 min to first page, both archs |
| C3 | **Finish the Export-bundle connector** (users, groups, settings, assets, comments) | The only route for MySQL/MariaDB/MSSQL/SQLite 2.x users — the most stranded, most uncontested segment | L | AGENT | A MySQL-sourced full migration passes verify |
| C4 | **Close or surface the importer's silent losses** (timestamps preserved; comment threading; 2FA/API token → re-enrolment notices + admin checklist) | Migration trust is the entire S1 pitch | M–L | AGENT | Dry-run report lists every unmappable item |
| C5 | **Migration test corpus in CI** (all 5 source engines, small/medium/large) + published results | Turns "trust us" into a results page | L | AGENT | Results page live |
| C6 | **Docs site** (ideally hosted *on Cardinal*, multi-site: docs + demo + community wiki on one instance): install, upgrade, backup/restore, migrate from Wiki.js 2.x, SSO recipes, permissions model, MCP guide, security model, FAQ ("Is this Wiki.js 3?") | No docs site = no evaluation; dogfooding multi-site is a demo in itself | L | AGENT drafts, YOU review | Live on the domain |
| C7 | **Public demo**: read-only guest instance + a separate sandbox that resets hourly, registration/mail/uploads off or tightly limited, no SMTP on a domain you care about | Kaneo lesson: 14,520 phishing invites in 3 hours from an open instance | M | AGENT | Demo survives a load + abuse test |
| C8 | **README rewrite**: drop the red "VERY BUGGY… NON-SECURE" banner once C1/B1 land; replace with an honest maturity table (stable / beta / experimental per feature) | Current banner is disqualifying marketing and will be screenshot | S | YOU (voice) | Merged |
| C9 | **Maturity labelling in-app** for experimental features (flags UI) | Prevents "feature that does nothing" discoveries (the ratings history) | M | AGENT | Flags labelled |
| C10 | **Update-check endpoint you own** (disclosed, off switch) → active-instance counting | Without it you can't measure adoption or talk to grant funders with numbers | M | AGENT + YOU (hosting) | Dashboard shows instance count |
| C11 | **Feature freeze (D10)** except migration, security, onboarding, bugs | Every new feature before launch is new attack surface and new docs debt | — | YOU | Declared |
| C12 | **Public roadmap** (curated, ~20 items, Now/Next/Later) and stop referencing private OpenProject IDs in public commit messages/PR titles | Outsiders keep hitting a tracker they can't see (`community-take.md` Part 4) | M | BOTH | Roadmap page live |
| C13 | **Upstream-tracking routine** (1h/week): read upstream `scarlett` commits; port security fixes; update the vs-3.x matrix | Keeps comparisons honest and your shared surface ≥ upstream | S/week | AGENT | Log file of reviewed ranges |
| C14 | Helm chart | Upstream has one; EU/enterprise buyers expect it | M | AGENT | **Phase 3**, not a launch gate |
| C15 | Confluence importer | Mid-2027 DC decision window | XL | AGENT | **Phase 3**, beta by 2027-06-30 |

## Tier D — Go-to-market assets & relationships

| # | Action | Why | Effort | Owner |
|---|---|---|---|---|
| D1 | **Design-partner program**: 5–10 real Wiki.js 2.x orgs migrated free, white-glove, for feedback + optional case study (doc 06 §3) | Real proof, real bugs, first testimonials, first paid-support prospects | L (ongoing) | YOU |
| D2 | **Start building HN history now** — genuine comments on topics you know | Show HN is throttled for low-history accounts (`/showlim`) | S/week | YOU |
| D3 | **Landing page + compare pages** (vs Wiki.js 2.x, vs Wiki.js 3 beta, vs Docmost, vs BookStack, vs Outline, vs Confluence DC) — dated, sourced, rows you lose included | SEO for the searches your segments make; Docmost already owns "wiki.js alternatives" | L | AGENT data, YOU prose |
| D4 | **Three ≤3-minute videos**: 2.x migration; governance (delegation + approvals + classification); agent via MCP under page rules | Videos convert self-hosters; creators reuse them | M | YOU record |
| D5 | **Press kit**: SVG logo, light/dark screenshots, 50/150-word descriptions, maintainer bio, fact sheet with dated numbers | Makes it easy for newsletters/YouTubers to cover you correctly | S | AGENT + YOU |
| D6 | **Community infrastructure**: GitHub Discussions categories (Q&A, Ideas, Show & Tell, Migration help), issue forms with a support-vs-bug split, label taxonomy, saved replies, CODE_OF_CONDUCT with *your* enforcement contact | Launch creates an issue flood; structure prevents burnout | M | AGENT |
| D7 | **Funding plumbing**: own FUNDING.yml, GitHub Sponsors profile, Liberapay, `funding.json` (FLOSS/fund), a "Support & services" page (doc 08) | Buttons currently pay upstream; the services page is your first revenue path | S–M | YOU |
| D8 | **NLnet proposal — deadline 2026-11-03** (Open Internet Stack/Restack, €5–50k, needs a European dimension; US-individual eligibility unverified — ask them) | The only funding with no popularity threshold; also forces a credible milestone plan | M | YOU |
| D9 | **FOSDEM 2027** (30–31 Jan): watch devroom CfPs (devroom proposals 4 Oct–7 Dec; talk CfPs from ~late Oct); submit a talk | Free amplification ~2.5 weeks after a January launch; EU public-sector audience | S | YOU |
| D10 | **Business setup** (doc 08 §7): LLC before the first paid contract; merchant of record for self-serve; contract templates; E&O insurance before SLAs | You'll get "can we pay you?" in launch week | M | YOU |
| D11 | **Pre-write (as private bullet notes, not copy) answers** to the 30 questions you'll get (doc 05 §3) | Speed of good answers is the launch | S | YOU |
| D12 | **Relationship map**: 3rd-party Wiki.js hosts (Stellar Hosted, Hostwiki), Elestio, PikaPods, Railway, linuxserver.io, a Keycloak/Authentik contact, a European integrator for NLnet/openDesk-adjacent work, 5 self-hosting creators | Distribution and partners are cheaper than audience-building | M | YOU |
| D13 | **Courtesy note to NGPixel** (~48h before launch; decision D5) | Removes "hostile fork" framing if they're ever asked | S | YOU |

---

## Launch gates (all must be true to launch)

**2026-09-13 update — the deadline is fixed, the scope is not.** Upstream is now cutting a real
tagged prerelease every 1–4 days and is 10/13 through its own "3.0" milestone (doc 00 §1). There is
no safe fallback past 2026-11-10 (doc 00 §2) — treat that date as fixed, and use the 2026-10-01
checkpoint below to cut scope rather than slip it.

**2026-10-01 checkpoint — descope order if a hard gate is behind schedule:**
1. **B2 (external security review)** → descope to the timeboxed self-audit (B3) against known upstream
   CVE classes, plus a paid review *booked* to run during Phase 1/early Phase 3 rather than gating the
   date — launch with "external review in progress, scope and firm published, self-audit complete"
   stated honestly. A launch with an honestly-scoped review beats a slipped launch; it does not beat a
   silently-skipped one.
2. **C6 (docs site)** → descope to install/migrate/security pages only; SSO recipes, the MCP guide and
   the full FAQ can land in week 1.
3. **C3/C5 (bundle connector / migration corpus)** → descope to Postgres-direct plus one fully-verified
   non-Postgres engine (MySQL — the largest stranded segment); state the remaining engines as "in
   progress," not silently absent.
4. **C7 (demo)** → descope to the read-only guest demo only; the hourly-reset sandbox can follow in
   week 1 if abuse-hardening isn't ready in time.
5. **Never descope:** A1 (employment agreement), B1 (private vulnerability reporting), the AGPL/
   branding-residue items (A5, A6), B9 (AI_POLICY disclosure). These are exactly the credibility gates
   the post-Huntarr climate will not forgive skipping, deadline or not — see doc 09 P1/P2/P16.

**Hard gates**
1. Name cleared (A2), identity reserved (A3), repo moved and described (A4).
2. No upstream-pointing funding, security, update-check or branding surfaces (A5, A6).
3. Private vulnerability reporting live; SECURITY.md accurate (B1).
4. Security review complete with criticals/highs fixed and a published summary (B2).
5. Trunk CI green ≥ 30 consecutive runs (B8).
6. Tagged release with changelog; compose quickstart verified cold on amd64 and arm64 (C1, C2).
7. Postgres-direct migration verified on ≥ 3 real design-partner installs; bundle path verified on ≥ 1 MySQL or SQLite install (C3, D1).
8. Docs site live with install, migrate, backup, security pages (C6).
9. Demo live and abuse-hardened (C7).
10. README maturity statement replaces the red banner (C8); AI_POLICY published (B9).
11. Employment agreement cleared (A1).

**Soft gates (launch without, but know it)**
Compare pages · videos · design-partner case study · NLnet submitted · business entity · update-check
counting · public roadmap.

**Launch window: Tue 2026-11-10 — fixed.** Descope per the checkpoint above rather than sliding the
date; 2027-01-12 is a failure state to avoid, not a plan B (doc 00 §2). Never December. Check
upstream's release page the morning of launch — if they cut a major tagged release that same week,
that's a reason to update the compare page same-day (doc 09 P4), not a reason to move Cardinal's
date.

---

## Cash budget (judgment, USD, pre-launch)

| Item | Low | High | Note |
|---|---|---|---|
| Domains + email | 50 | 150 | /yr |
| VPS for demo + docs + update endpoint | 120 | 400 | /yr |
| Trademark knockout / filing (2 classes US) | 0 (DIY search) | 2,500 | Filing $350/class + attorney |
| External security review | 0 (community/pro bono, scoped) | 15,000 | The one item worth stretching for |
| Hardware security keys | 60 | 120 | Two keys |
| LLC formation | 0 (defer) | 1,000 | CA adds $800/yr minimum tax |
| E&O insurance | 0 (defer until SLAs) | 1,300 | /yr |
| **Total** | **~250** | **~20,000** | A credible middle path is ~$3–6k with a scoped review |
