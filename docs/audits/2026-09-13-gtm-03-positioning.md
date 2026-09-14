# GTM 03 — Positioning, Segments & Messaging

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md).

Positioning is the decision about **which shortlist you want to be on and why you win there**.
Messaging is how you say it. Both are *judgment* built on the verified facts in docs 01–02.

---

## 1. Positioning statement (internal, not copy)

> **For** teams and organisations that run their own wiki and need real control over who sees and
> changes what — **Cardinal is** the self-hosted, open-source wiki **that** ships the governance features
> others charge for (SSO, 2FA, page-level permissions, approvals, classification levels, delegated
> multi-site administration) free, lets AI agents work inside those same permissions, and brings your
> existing Wiki.js content with it. **Unlike** Docmost, nothing is held behind a seat tier; **unlike**
> Wiki.js 3, you can move your 2.x wiki onto it today and get support for it; **unlike** Confluence, it
> runs on your servers indefinitely.

**Category you claim:** *the governed wiki* — not "Notion alternative", not "AI wiki", not "modern
Wiki.js". Governance is the durable differentiator (doc 01 §6.3); AI and collab are converging;
"modern Wiki.js" makes you a derivative.

---

## 2. Segments (ideal customer profiles), prioritised

| # | Segment | Trigger event | What they need to hear | Proof they need | Where they are | Money? |
|---|---|---|---|---|---|---|
| **S1** | **Stranded Wiki.js 2.x admins** (IT generalists, homelabbers, SMB IT) | 2.x dependency/security worry; wanting paste-images/approvals; learning MySQL/SQLite won't be supported | "Bring your wiki. One command, a dry-run report, done in an afternoon." | Dry-run screenshot, migration video, a case study, the all-DB support matrix | r/selfhosted, r/sysadmin, r/homelab, Wiki.js GitHub Discussions (not for promo), search "wiki.js migrate" | Migration services, support |
| **S2** | **Docmost-considerers** (SMB→mid-market IT replacing Confluence cheaply) | Hit the Docmost paywall for SSO/2FA/page perms | "Every feature, no seat tiers." | Factual feature/price table | Confluence-alternative roundups, r/selfhosted | Support |
| **S3** | **Multi-site operators** (MSPs, universities, agencies, internal platform teams) | Running N wiki instances; delegating admin to departments/clients | "One install, many wikis, each with its own admins and rules." | Delegated `site:*` permissions demo | Sysadmin/MSP communities, higher-ed IT lists | Support, contract work |
| **S4** | **Regulated & governed orgs** (defence suppliers, healthcare, legal, public bodies) | Audit finding; need for classification/approval/audit log; data residency | "Classification levels, approval gates and an audit log — on your servers." | Security review report, classification demo, AGPL/on-prem story | Compliance/security circles, EU sovereignty events | Support, LTS, custom |
| **S5** | **Confluence DC on-prem refugees** | DC read-only 2029-03-28; price rises | "Stay on-prem. Keep permissions. Import your spaces." | Confluence importer (**doesn't exist yet**) | r/Confluence, Atlassian community, sysadmin | Migration services (large tickets) |
| **S6** | **Agent-builder teams** | Want an MCP-accessible knowledge base that respects access control | "The governed source of truth your agents read and write." | MCP demo under page rules + approvals | AI engineering circles, MCP registries | Contract work |
| **S7** | **Homelab / self-host enthusiasts** | Curiosity, r/selfhosted posts | "Pretty, fast, free, one compose file." | Screenshots, compose file, ARM support | r/selfhosted, YouTube | Mindshare only — but they bring it to work |

**Sequence:** S1 + S2 at launch (content + tooling exist), S7 as amplifier, S3 once delegation docs are
strong, S4 after the security review is published, S6 opportunistically, S5 only when the Confluence
importer exists (target beta 2027-06-30).

---

## 3. Message pillars

| Pillar | Headline (draft) | Supporting facts (only verified ones) | Never claim |
|---|---|---|---|
| **1. Bring your wiki** | "Move from Wiki.js 2.x in an afternoon." | Postgres-direct importer with dry-run + verify; bundle path for other DBs (once complete) | "Lossless" until 2FA/tokens/timestamps are handled; "any database" until the bundle connector is complete |
| **2. Governed by default** | "Know who can see and change every page." | Page rules (ALLOW/DENY/FORCEALLOW), per-site delegated admin, approvals, classification levels, audit log | "Compliant with X" (no certifications exist) |
| **3. Nothing held hostage** | "Every feature. No seat tiers. AGPL." | SSO (OIDC/SAML/LDAP), 2FA/passkeys, page permissions, MCP, API keys, all free | "Free forever" as a promise about the future business model — say "AGPL-3.0" instead |
| **4. Agents under your rules** | "AI agents see only what the user can see." | In-process MCP server, 38 tool files, semantic search, permission-scoped | "First AI wiki", "smartest search" |
| **5. Built in the open** | "Built with AI, verified in public." | Pinned-SHA CI with provenance, test suites across 4 workspaces, external security review (once done), AI_POLICY | "Every line human-reviewed" (not true) |

---

## 4. Naming, identity and version

- **Name decision (D1):** the legal doc recommends "Cardinal" user-facing, not "Cardinal.js" as a package
  name. Known collisions: DISTRHO/Cardinal (a known OSS synth), `cardinal` on npm, generic tech marks.
  Run a knockout search (classes 9 and 42) *before* the domain, logo or any launch asset. If it's not
  clean, the runners-up from the 2026-09-01 naming session were Azimuth, Landmark, Apogee, Pillar,
  Cornerstone — each needs the same search.
- **Spoken name:** "Cardinal" in prose; "Cardinal wiki" when context is thin (search-friendliness).
  Domain `cardinal.wiki` (reported available 2026-09-01, not yet registered).
- **Version (D2):** your own line. Recommended `v0.9.x` previews → `v1.0.0` launch. Reasons: upstream's
  `3.0.0-beta.*` tags share names with anything you'd tag in the `3.0.0` line; "3.0" invites "is this
  Wiki.js 3?"; Docmost shows a pre-1.0 line with cadence is trusted. Alternative: CalVer (`v26.10`) like
  BookStack.
- **Repo:** product-named org + repo; description and homepage are part of your SEO snippet — the current
  ones advertise Wiki.js.
- **Visual identity:** hand-made or commissioned, not generic AI-landing-page aesthetics (Show HN
  commenters now actively score "AI design slop"). The Cobalt UI work is an asset — use real screenshots.

---

## 5. Messaging by surface

| Surface | Lead with | Length | Author |
|---|---|---|---|
| README (top 20 lines) | What it is, one screenshot, compose quickstart, "Migrating from Wiki.js 2.x?" link, maturity statement | Short | You |
| Landing page hero | "The governed wiki." + 3 pillars + migration CTA | Short | You (hand-written) |
| Show HN title | `Show HN: Cardinal – a self-hosted wiki with free SSO, approvals and a Wiki.js importer` (≤80 chars, no hype words) | — | You, no AI edits |
| Show HN first comment | Who you are, why it exists, how it's built (AI disclosure in plain words), what's rough, what feedback you want | ~250 words | You, no AI edits |
| r/selfhosted post | Screenshots, compose file, migration angle, AI disclosure per current flair rules | Medium | You |
| Compare pages | Factual tables with dates and sources, including rows you lose | Long | You + agents for data gathering; you for final prose |
| Docs | Task-oriented | Long | Agents can draft; you review |
| Conference CFPs | A problem story (migrating a stranded ecosystem; governed wikis for agents) | Medium | You |

**Why "you" keeps appearing:** HN guidelines ban AI-generated or AI-edited posts *and comments*;
awesome-selfhosted bans LLM-written contributions; selfh.st ignores LLM-written submissions. The
strategy documents you're reading are AI-written — use them as notes, never as copy. This is the single
easiest way to torch the launch.

---

## 6. The AI-built question — the narrative

People will ask. Decide the answer now, and give it before anyone asks.

**Recommended stance: radical transparency plus verifiable rigour.**

Draft substance (rewrite in your own voice):

- Cardinal is maintained by one person who directs AI coding agents (Claude) to do most of the
  implementation. Commits carry a co-author trailer; nothing is hidden. (If history is squashed at the
  GitLab move, the squash commit carries the disclosure for everything before it, and the README says
  so. Never let the reset look like the AI trailers were scrubbed; see doc 10 §2.)
- AI speed is only useful with guard-rails, so every change goes through: typecheck, lint with
  warnings-as-errors, unit and DB-backed test suites in four workspaces, an e2e browser suite, and CI run
  inside a pinned container. GitHub Actions are pinned to commit SHAs and images carry build provenance.
- An independent security review of the auth, permissions, uploads, custom blocks and MCP surfaces was
  done before launch; findings and fixes are published. *(Only say this once it's true.)*
- The maintainer is accountable for every release. Security reports go to [channel]; response targets
  are [N business days].
- Contributions: AI assistance is welcome if disclosed and the contributor understands and stands behind
  the change (model on Ghostty's `AI_POLICY.md`).

**What not to say:** "every line reviewed by a human" (untrue); "AI-native"; defensiveness about
NGPixel's vibe-coding comment. If quoted at you: "That's a fair concern — here's the verification we do
and the security review; judge the code."

---

## 7. Proof inventory (build these; claims without them are noise)

| Proof | Status | Needed for |
|---|---|---|
| 3-min migration video (real 2.x → Cardinal) | Not started | Pillar 1, S1 |
| Dry-run report screenshot | Tooling exists | Pillar 1 |
| Migration test-corpus results page | Not started | Pillar 1, trust |
| Feature/price comparison vs Docmost (dated, sourced) | Data in `gtm-research/` | Pillar 3, S2 |
| Delegated multi-site demo (two sites, different admins) | Feature exists | S3 |
| Classification + approval walkthrough | Feature exists | S4 |
| MCP demo: agent edits land in approval queue, can't read restricted page | Feature exists; verify behaviour | Pillar 4, S6 |
| Security review report | Not started | Pillar 5, S4, launch gate |
| Public CI badge that is actually green | CI has chronic red history | Pillar 5 |
| Case studies from design partners | Not started | Everything |

---

## 8. Words and phrases

**Use:** governed, self-hosted, AGPL-3.0, bring your wiki, page rules, approvals, classification, on your
servers, no seat tiers, migrate, dry run, verify.

**Avoid:** revolutionary, next-generation (upstream's own tagline — "Next Generation Open Source Wiki" is
still in the README), AI-powered, enterprise-grade (until proven), "Wiki.js killer", "the real Wiki.js 3",
"dead", "abandoned", "free forever", "military-grade", "compliant".

**Tagline candidates** (test with 5 real sysadmins, pick one):
1. The governed wiki.
2. Your wiki, your servers, your rules.
3. Every feature. No seat tiers.
4. The wiki that brings your wiki.
