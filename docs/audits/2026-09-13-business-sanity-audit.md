# Cardinal.js Business Sanity Audit

**Date:** 2026-09-13
**Scope:** branch `scarlett` @ `df032646a`
**Frame:** not "is the code correct" (covered elsewhere — `docs/audit-2026-08-24`, `docs/security-reviews/`,
`docs/testing-audit/`) but "would a business choose Cardinal.js as their wiki, over every paid and
free alternative, in 2026 — and if not, why not." Nothing about current scope, architecture, or
roadmap is treated as sacred; the only fixed goal is "world's best general-purpose wiki."

**Method:** four independent research passes, done in parallel and cross-checked against each other:
a code-verified inventory of what's actually implemented (not what CLAUDE.md or commit messages
*claim*), external market research on ~20 competing products, a cross-reference against this
project's own OpenProject backlog (project `wiki-js-3-0`), and an archaeology pass over
`docs/variances.md`, `docs/decisions/`, and `docs/legal/` to separate deliberate scope decisions from
genuinely open concerns. Findings below are load-bearing on that research; where a specific file or
epic is cited, it was checked directly.

---

## Executive summary

**Cardinal.js's engineering is ahead of its go-to-market readiness, by a wide margin.** The
technical core is genuinely strong — arguably stronger than most of its direct self-hosted
competitors — but almost nothing about the project today would survive an actual buyer's evaluation,
for reasons that have nothing to do with code quality:

- It has never cut a stable release (`package.json` says `3.0.0`, but zero git tags exist past the
  inherited `v2.5.x` line, and the README opens with a red "VERY BUGGY, INCOMPLETE AND NON-SECURE"
  banner).
- It has no path for the existing Wiki.js 2.5.x install base to move onto it.
- Its legal/branding hygiene (Requarks-hosted logo, Requarks funding links, `security@requarks.io`
  in `SECURITY.md`, no NOTICE file) would read as an unlicensed rebrand to any procurement or legal
  review, today.
- It has zero public presence — it's a private single-maintainer repo (`github.com/dylan-hart/wiki`)
  with no announcement, no community, no roadmap anyone outside this repo can see.

Meanwhile, two things it has actually built — **real, two-hop pgvector semantic search** and a
**genuine in-process MCP server with 20+ tools** — are ahead of where most of the market is in 2026,
including well-funded SaaS incumbents. That combination (strong differentiated core, zero go-to-market
readiness) is the headline finding of this audit, and it reframes the "gaps" section below: most of
what's missing is not "can we build this," it's "have we decided to become a product yet."

The single most important competitive fact this audit surfaced: **a very close analog already
exists and is winning traction** — Docmost, a self-hosted, AGPL-3.0-licensed, "Confluence/Notion
alternative" with 20,700+ GitHub stars and active 2026 commits, shipping real-time collaborative
editing, Confluence migration tooling, and a paid SSO/AI tier on top of a free self-hosted core.
Docmost is less architecturally sophisticated than Cardinal.js (no semantic search, no MCP, no
multi-site, shallower permissions) but it has a release, a migration story, a community, and a public
roadmap. Every one of Cardinal.js's structural gaps below is a gap *relative to Docmost specifically*,
not just relative to Confluence.

---

## Where Cardinal.js actually wins today (code-verified)

These are real, not aspirational — each was checked against the implementation, not just CLAUDE.md's
description of it.

| Strength | Evidence | Why it matters competitively |
|---|---|---|
| **Semantic/vector search** | `backend/models/semanticSearch.ts` (455 lines) — real two-hop ANN search (`annSearch` → `runHop2` → `mergeHopResults`), graceful degradation when pgvector isn't installable (`core/pgvectorBootstrap.ts`), full frontend UI (`SearchResultHopBadge.vue`) | No self-hosted OSS wiki in the competitive set ships anything like this. Confluence's search is the single most-cited complaint about the market leader — this is a direct, quantifiable answer to that complaint, for free. |
| **In-process MCP server** | `backend/mcp/` — 20+ real tools (create/update page, search, render diagram, watch/unwatch, asset CRUD, sideload icons/locales) | GitBook is the only managed competitor marketing MCP as a headline 2026 feature (plus MCP-query analytics). Confluence/Notion offer this only via unofficial third-party connectors. Cardinal.js already has a first-class, first-party surface — this is a genuine, defensible differentiator if ever marketed. |
| **Three-kind permissions model** | Global / page-rule / site-scoped delegation (`helpers/pageRules.ts`, `helpers/siteRules.ts`) | Deeper than Confluence's space-permission model; enables per-site admin delegation with no `manage:sites` grant, which is a real enterprise ask most competitors can't answer. |
| **Multi-site platform** | Epic 339 (closed) — hostname-routed sites, isolated page trees, isolated sessions | Rare among general-purpose wikis at any price point; closer to a multi-tenant SaaS capability than a typical OSS project ships. |
| **Real-time collaborative editing** | `core/collab.ts` (Yjs, 1299 lines), live cursors/awareness | Meets — doesn't exceed — the 2026 table-stakes bar (Docmost, Notion, Outline, GitBook all ship this standard). Table stakes, but *present*, unlike BookStack/DokuWiki/MediaWiki. |
| **Content governance suite** | Classification levels + glossary + approvals workflow, all wired end-to-end with a real audit log (`models/auditLog.ts`) | This trio (sensitivity classification, approval gates, glossary-linked terminology) is enterprise-content-governance territory almost no OSS wiki attempts. |
| **i18n/RTL depth** | Locale-scoped page rules, translation linking, hardened RTL support (Feature 413) | Rare depth for an OSS project; most competitors treat i18n as an afterthought. |
| **Zero-seat-fee self-hosted economics** | No per-seat pricing exists because there's no pricing at all | Per the market research, this is structurally the cheapest possible offer *if* the feature/quality bar is met — and for search quality and governance depth specifically, it already is. |

---

## The competitive landscape (2026)

| Product | Segment | Pricing | Standout features | Weaknesses | AI |
|---|---|---|---|---|---|
| **Confluence** | Mid-market → enterprise | $5.42–10.44/user + custom Enterprise | Deep Jira/Atlassian integration, mature permissions | Search widely panned; Oct 2025 price hikes unpopular; heavy UI | Rovo bundled into all paid plans |
| **Notion** | SMB → prosumer → enterprise push | Free / $8 / $15–20/user | All-in-one docs+DB+wiki; beloved editor | AI now gated to $20 Business tier (killed free/Plus AI Aug 2026); perf lag at scale | AI autofill, multi-step Agents (Business only) |
| **GitBook** | Docs-as-code, API teams | Site-based, ~$365/mo/site at scale | Git-native workflow, best-in-class API docs, **first-party MCP + MCP analytics** | No published enterprise SLA; site-based pricing punishes multi-space orgs | Most complete AI layer of any managed platform |
| **Document360** | External/customer KB, enterprise | Quote-only since Nov 2024 (killed free tier) | Deep versioning, multi-language, analytics | No self-serve purchase at all; steep sales cycle | AI writing + search (paid) |
| **Guru** | Internal team KB, "verified answers" | $25/seat, 10-seat min | Verification workflow directly fights knowledge rot | Expensive at minimum | AI-suggested cards, Slack-embedded |
| **Slab** | SMB internal wiki | $6.67/user | Clean editor, transparent pricing | Smaller ecosystem | Paid-tier AI search |
| **Nuclino** | Small teams | $6/user | Visual/spatial canvas | **No SSO/API/SOC2/audit logs at ANY tier** — hard enterprise ceiling | Business-tier only |
| **Tettra** | Dev/support team KB | $4–12/user | **Kai AI answers inside Slack**, no context switch | Narrower outside Slack workflows | Bundled all paid plans |
| **Coda** | Docs-as-apps | $30–36/maker | Doc-as-application, embedded automations | Steep learning curve; per-maker pricing | Comprehensive gen-AI |
| **Outline** | Dev/tech teams | From $10/mo | Fast editor, AI Q&A search, 20+ integrations | Smaller ecosystem than incumbents | AI workspace search |
| **BookStack** | Self-hosted, simple structure | Free (MIT) | Approachable Book→Chapter→Page metaphor, new WYSIWYG | No real-time collab; lighter ceiling | None |
| **DokuWiki / MediaWiki / XWiki** | Self-hosted, technical | Free | Flat-file simplicity (DokuWiki) / Wikipedia-scale proven (MediaWiki) / structured apps (XWiki) | Dated UX, ops-heavy (MediaWiki/XWiki) | None |
| **Obsidian** | Personal knowledge management | Free app + $4–8 add-ons | Best-in-class personal linking, huge plugin ecosystem | **Not a real team tool** — shared vaults don't give smooth real-time editing | Community plugins only |
| **Wiki.js (upstream)** | Self-hosted, "was" go-to modern FOSS wiki | Free | Broad module system | **v3 stalled since 2021 Developer Preview, no beta since**; reviewers explicitly cite "uncertain roadmap" as a reason to pick something else | None |
| **Docmost** ⚠️ closest peer | Self-hosted, direct Confluence/Notion alternative | **Free/AGPL-3.0 core**; paid self-managed SSO/AI/migration at $3.50/seat, 10-seat min | Real-time collab out of the box, built-in draw.io/Mermaid/LaTeX, no OIDC required, 20,700+ stars, active mid-2026 commits | Younger, smaller module ecosystem than a Confluence-class tool; AI/SSO gated even self-hosted | AI + Confluence migration on paid tier |

### Cross-cutting 2026 trends

1. **AI is table stakes, but where it's priced is now a competitive weapon.** Confluence bundles it
   everywhere to attack Notion; Notion just moved the opposite way (AI now Business-only). A wiki
   that ships strong AI (search *and* authoring) for free, self-hosted, has real pricing leverage —
   Cardinal.js currently only has half of that story (search, not authoring).
2. **MCP/agent-protocol support is a genuine buying criterion now**, not a gimmick — GitBook markets
   it as a headline feature. This validates the existing MCP investment as forward-looking, not
   niche — but only if anyone outside this repo knows it exists.
3. **Self-hosted/OSS has moved from "hobbyist" to a first-class enterprise category**, driven by EU
   data-sovereignty regulation (AI Act, NIS2) and SaaS pricing fatigue. AGPL is understood and
   tolerated by regulated buyers (Docmost proves the commercial model works), not disqualifying.
4. **Knowledge rot / low adoption is the #1 named failure mode industry-wide** (84% of developers
   surveyed said they'd rather ask a colleague than search the wiki). The market is racing toward
   active staleness detection and verification workflows (Guru), not just better storage.
5. **Real-time collaborative editing is baseline, not premium** — its absence (BookStack, DokuWiki,
   MediaWiki) now reads as dated. Cardinal.js clears this bar; it just doesn't exceed it anywhere.
6. **Pricing *shape* is itself a differentiator** buyers actively compare (GitBook's per-site,
   Coda's per-maker, Nuclino's zero-tier SSO gap). A self-hosted product with zero seat fees and no
   feature tiering is structurally the cheapest possible offer, if quality holds up.

### What buyers actually weigh, in rough priority order

1. Total cost at their real seat count 2. Search quality 3. Migration friction from their current
tool 4. Data control/sovereignty 5. Real-time collaboration quality 6. AI presence and its price gate
7. Self-hosting/ops burden 8. Ecosystem/integrations 9. Enterprise checkboxes (SSO/SAML/SCIM/SOC2/audit)
10. **Roadmap credibility and visible development velocity** — explicitly cited against upstream
    Wiki.js itself; a stalled or invisible roadmap actively pushes evaluators away even when the
    current feature set is adequate.

Cardinal.js currently loses on #3 (no migration path), is invisible on #10 (no public roadmap at
all, private repo), and is only half-answered on #6 (AI search yes, AI authoring no). It wins clearly
on #1, #2, and #4, and meets the bar on #5 and #7.

---

## Gap analysis — what would stop a business from choosing Cardinal.js

Tiered by how disqualifying each gap actually is, not by effort to fix.

### Tier 0 — Adoption blockers (stop a serious evaluation before feature comparison even starts)

| Gap | Evidence | Why it's Tier 0 |
|---|---|---|
| **No stable release** | `package.json` says `3.0.0`; zero git tags past inherited `v2.5.x` line; `docs/versioning.md` frames 3.0 as arriving with no committed date; README opens with a red "VERY BUGGY, INCOMPLETE AND NON-SECURE" banner | No business points production content at software with no versioned artifact and a self-declared "don't use this" banner. This alone ends most evaluations before anything else is assessed. |
| **No 2.5.x → 3.0 migration path** | `docs/release-checklist.md` item 5: "no migration CLI, no dry-run mode, and no 2.x reader of any kind" | Wiki.js 2.5.x has a real, years-old install base. Cardinal.js currently cannot capture a single one of those installs without a manual, unsupported, high-risk data migration. This is a go-to-market gap, not a technical one — `backend/migration/` exists in spec but the CLI/reader path isn't built. |
| **Legal/branding hygiene reads as an unlicensed rebrand** | README hotlinks the Wiki.js logo from Requarks' CDN; GitHub Sponsors/OpenCollective funding routes to Requarks; `SECURITY.md` sends vulnerability reports to `security@requarks.io`; no `NOTICE` file; no AGPL §5(a) fork-disclosure statement; no font/Twemoji attribution (`docs/legal/06-branding-and-trademark.md`, `07-recommended-actions.md`) | Any legal/procurement review at a company evaluating this would flag it immediately as either sloppy or bad-faith. This is cheap to fix and currently isn't fixed. |
| **Zero public presence** | Private repo (`github.com/dylan-hart/wiki`), no announcement, no community, no public roadmap | You cannot lose a bake-off you were never invited to. Before any gap below matters, someone outside this repo has to know Cardinal.js exists. |
| **SCIM provisioning does not exist** | Zero hits for SCIM anywhere in `backend/` | Automated user lifecycle/deprovisioning is a hard requirement for most enterprise security teams, independent of everything else on offer. |
| **CAS auth is decorative** | `docs/decisions/cas-1.0-account-provisioning-gap.md` — CAS 1.0 only, **cannot provision or log in any account** | Worse than not offering CAS at all: it implies a capability that silently fails. An evaluator who tries it loses trust in every other claim in the docs. |

### Tier 1 — Competitive table stakes missing (the 2026 market has normalized these; their absence is now noticed, not excused)

| Gap | Evidence | Competitive contrast |
|---|---|---|
| **No AI authoring assistant** | AI investment is 100% on the search side (`semanticSearch.ts`); zero in-editor writing/rewrite/summarize assist found anywhere in `frontend/src/components/Editor*` | Every paid competitor in the table above (Confluence Rovo, Notion AI, GitBook AI, Coda, Tettra Kai) now bundles authoring AI. This is the single highest-leverage gap to close, because the LLM infrastructure already exists for search and MCP — extending it to authoring is largely a product decision, not a new subsystem. |
| **No mobile app / PWA / offline reading** | Zero web manifest, zero service worker, anywhere in `frontend/` | Confirmed absent, not merely unpolished — there's nothing to build on. Every competitor above at least offers a usable mobile web experience; several ship native apps. |
| **No native integrations beyond generic webhooks/OAuth login** | `models/hooks.ts` webhooks exist; no Slack/Teams notification bot, no Jira/GitHub issue-linking, no embed blocks for Google Docs/Figma | Tettra and Guru's Slack-native AI answering is explicitly cited as a retention driver in the research. Confluence/Notion's integration marketplaces run to hundreds of entries. Cardinal.js has the plumbing (webhooks, OAuth) but none of the actual first-party connectors. |
| **No internal analytics/usage dashboards** | `boot/analytics.js` only injects outbound tracking snippets (GA/Matomo/GTM) — no in-app "most viewed," "search miss," "stale page" reporting | Directly relevant to the #1 industry-wide failure mode (knowledge rot). Competitors racing toward staleness detection (Guru's verification workflow) have a concrete answer here; Cardinal.js has none. |
| **No plugin/extension marketplace for third parties** | Extensibility is code-level only (custom Lit blocks, REST API) — no admin-installable third-party ecosystem | Blocks a long-tail growth mechanism every successful platform (Notion, Confluence, Obsidian) relies on. |

### Tier 2 — Segment-limiting (cap addressable market rather than block adoption outright)

| Gap | Why it caps the market |
|---|---|
| **No hosted/managed-cloud offering** — 100% self-hosted only | The research is explicit that most buyers still prefer not to run their own infrastructure even in 2026's self-host-friendly climate. This makes the entire "don't want to run infra" segment — arguably the largest single segment, and Confluence/Notion/GitBook Cloud's whole customer base — structurally unaddressable without one. |
| **No SOC2/compliance certification story** | Only the AGPL legal review exists (`docs/legal/`); nothing shaped like an enterprise compliance certification. Disqualifying for regulated-industry procurement regardless of feature quality. |
| **Accessibility posture is basic and undocumented as a strength** | A single 109-line `helpers/accessibility.js`; no dedicated audit trail beyond Epic 1368. Not clearly worse than most competitors, but nothing to point to either — a missed opportunity given how few competitors lead with this. |
| **ARM64 support unverified on real hardware** | Manifest declares `linux/arm64` but no release has ever been tagged or tested on real silicon. Matters for the growing homelab/Raspberry Pi self-host demographic this project's own positioning (self-hosted, zero seat fees) should be courting. |
| **Several auth presets never verified against live providers** | Auth0, Okta, Keycloak, GitLab, Twitch, Discord, Slack OIDC presets are unit-tested against mocks only (`docs/decisions/auth-preset-live-verification-gaps.md`) | A prospective evaluator's first login attempt is a bad place to discover a live-integration bug. |

### Tier 3 — Perception/marketing risk (not functional gaps, but they shape how everything above lands)

- **Roadmap invisibility compounds the "no public presence" problem.** The research explicitly found
  that upstream Wiki.js's *own* stalled, hard-to-see roadmap is cited by 2026 reviewers as a reason
  to pick something else — even though its existing feature set was adequate. Cardinal.js is not
  stalled (this audit's own OpenProject cross-reference shows 46 closed epics, mature and actively
  developed), but nobody outside this repo can see that. The perception risk is identical to
  upstream's even though the underlying reality is the opposite.
- **Unsandboxed custom-block execution is an accepted internal risk, but an external disclosure
  item.** Every custom block's JS runs unsandboxed on every reader's page view — a deliberate,
  documented trade-off (the feature's point requires executable script), not an oversight. A
  competitor's sales team could still weaponize this in a security-focused bake-off if it ever comes
  up. Worth a documented mitigation stance (CSP scoping, an opt-in flag, signed blocks) before it's
  ever raised by someone outside this repo.
- **The README's own severity banner is currently true and currently a liability at the same time.**
  It's honest engineering communication for an internal audience; it is disqualifying marketing copy
  for any external one. These are two different audiences that the current README conflates.

---

## Head-to-head positioning: why someone picks Cardinal.js over X (and why they don't)

**vs. Confluence** — Wins on cost (zero seat fees vs. $5–10/user climbing) and on search quality
(semantic search directly answers Confluence's most-cited weakness). Loses on integration ecosystem
depth, support SLA, and AI-authoring parity (Rovo is bundled into every Confluence paid tier today).

**vs. Notion** — Wins on being wiki-native (real page/space/permission structure) rather than an
all-purpose block tool, and on not upcharging for AI the way Notion just started doing. Loses on
editor polish, integration/template ecosystem breadth, and mobile.

**vs. GitBook** — Wins for general-purpose (non-developer-docs) use cases and for permission/
governance depth GitBook doesn't attempt. Loses, ironically, on *marketing its own MCP support* —
GitBook is winning press for the exact category of feature Cardinal.js already has built.

**vs. Docmost (the real fight)** — This is the comparison that matters most, because it's the closest
license, positioning, and target buyer. Cardinal.js is more architecturally sophisticated (semantic
search, MCP, multi-site, deeper permissions, content governance) — none of which Docmost has. Docmost
is more *adoptable* — it has a real release, a Confluence migration tool, 20,700+ GitHub stars, and
active public development. If Cardinal.js does not close the release/migration/legal/public-presence
gaps, it will lose this fight on go-to-market readiness alone, regardless of which product's code is
better engineered.

**vs. BookStack / DokuWiki / MediaWiki** — Cardinal.js is far more capable but also far more
operationally heavy (Postgres + Node + a multi-module system vs. BookStack's simplicity or
DokuWiki's flat-file zero-database model). Teams that "just want a wiki" will pick the simpler tool
every time; this is a fine trade-off to accept rather than a gap to close.

**vs. Obsidian** — Not really a competitor (personal knowledge management, not team collaboration),
but frequently compared by evaluators. Cardinal.js wins decisively on real team collaboration;
Obsidian wins on personal-linking UX and its plugin ecosystem's sheer size.

---

## Opportunity roadmap (prioritized)

**P0 — Unblock adoption (nothing else matters until these move)**
1. Cut and tag a real, versioned release; commit to a versioning/support policy (`docs/versioning.md`
   already has the mechanics — this is a decision, not a build).
2. Legal/branding cleanup: host Cardinal.js's own logo, redirect funding/security contacts to this
   project, add a NOTICE file and AGPL §5(a) statement, attribute fonts/Twemoji. Low effort, removes
   a Tier-0 blocker entirely.
3. Build a minimal 2.5.x migration path (even a manual, documented one) — or explicitly decide *not*
   to court the existing Wiki.js install base and message Cardinal.js as a fresh start instead. Either
   is defensible; the current silent gap is not.
4. Add SCIM provisioning; remove or clearly relabel CAS as non-functional rather than leaving it
   decorative.

**P1 — Close 2026 table stakes (highest leverage relative to effort, given existing infrastructure)**
5. AI authoring assistant, built on the same LLM plumbing already powering semantic search and MCP —
   likely the single highest-leverage feature in this entire report, since it closes the market's
   biggest current gap without a new subsystem.
6. PWA/offline reading support — no native app required, meaningful perception win for low-to-medium
   effort.
7. A first-party Slack/Teams integration (notifications + in-chat AI answering) — directly modeled on
   Tettra/Guru's proven retention driver, and Cardinal.js's MCP server is a natural backend for it.
8. Internal analytics/usage dashboard (stale pages, search-miss reporting, most-viewed) — a direct,
   concrete answer to the industry's #1 named failure mode (knowledge rot), and currently the
   `analytics` module does none of this (outbound tracking only).

**P2 — Expand addressable market**
9. Evaluate a hosted/managed-cloud tier or hosting-partner model — the single biggest market-expansion
   lever per the research, since most buyers still prefer not to self-host even in 2026.
10. A SOC2 path (or at minimum a documented compliance posture) for regulated-industry procurement.
11. Verify ARM64 on real hardware; manually verify the untested live auth-provider round trips.
12. A plugin/extension marketplace concept for third-party developers, building on the existing block
    architecture.

**P3 — Perception**
13. Publish a public roadmap and give the project a public presence — directly neutralizes the
    "uncertain roadmap" objection that hurt upstream Wiki.js, especially since this audit's own
    OpenProject data shows the opposite (46 closed epics, active development) is already true.
14. Document a mitigation stance for unsandboxed custom-block execution before a competitor or
    security reviewer surfaces it unprompted.
15. An accessibility audit with a publishable outcome (WCAG conformance statement) — most competitors
    don't lead here either, so a real answer is a differentiator, not just parity.

---

## Appendix

### A. OpenProject backlog cross-reference (project `wiki-js-3-0`, snapshot 2026-09-13)

Backlog is unusually clean — 3 open Epics, 3 open Features, 0 open Tasks, 1 open Bug, 1 open Issue,
against 46 closed Epics. This is a mature platform between work-cycles, not one accumulating debt.

| ID | Type | Title | Note |
|---|---|---|---|
| 329 | Epic | Editing & Authoring Experience | open |
| 333 | Epic | Users, Auth & Permissions | open |
| 2962 | Epic | Cobalt typography audit & fixes | open, UI polish |
| 2420 | Feature | Scoped delegation: group self-service | open |
| 2427 | Feature | Map multiple auth methods to one account | open |
| 2428 | Feature | Templates / transclusion / infoboxes | open |
| 2967 | Bug | Typography sizing | open, housekeeping |
| 3139 | Issue | CI red on a merged workcycle branch | open, housekeeping |

Already closed and **not** net-new opportunities: Search (332), Semantic/vector search (3050),
API/Webhooks (340), Notifications (2422), Multi-Site (339), Deployment/Ops (2423), Extensibility:
Blocks & Modules (338), Localization/Theming (337), Accessibility/i18n/RTL (1368), Content
Classification (1075), Knowledge Graph (1035), plus 11 epics from the 2026-08-24 audit sweep.

Cross-referenced against this audit's Tier 1/2 gaps: **AI authoring assistant, mobile/offline PWA,
hosted/SaaS offering, SOC2/compliance certification, SCIM provisioning, and a third-party
integrations/plugin marketplace have zero corresponding Epic or Feature anywhere in the backlog.**
These are not unshipped — they are untracked. Everything else in this report either already has an
open Epic/Feature or is a legal/process fix with no engineering ticket needed.

### B. Deliberate scope decisions this audit does not re-flag as gaps

Per `docs/variances.md` and `docs/decisions/`: no Box/Dropbox/Drive/OneDrive storage targets (2.5.x
versions were non-functional stubs), no Helm chart/Packer builder (no 3.x release yet to deploy),
page ratings/templates removed (2.5.x versions were half-built), GraphQL fully removed, no SSR, no
`/_api` versioning, several 2.5.x migration-importer omissions (API tokens, Slack/Discord notify
config, comment threading). All are documented, reversible-with-evidence decisions, not oversights.

### C. Sources (competitive research)

eesel AI (Confluence/Notion/GitBook comparisons, Confluence alternatives), Docsie (Document360/Guru/
Slab/Nuclino/Tettra pricing comparisons), G2 (Outline reviews), HeroThemes (wiki software roundup),
WikiMatrix (BookStack/Wiki.js/DokuWiki/MediaWiki/XWiki comparison), Glitter AI and getpricepulse
(Notion pricing history), costbench (Obsidian pricing), Docmost's own blog and third-party reviews
(elest.io, thinkthroo, devopspack, makerstack.co), GitBook's own blog (AI/MCP features), Full Scale /
Pravodha / Phonemos (wiki adoption failure analysis), Plane.so (self-hostable alternatives), DEV
Community (MCP ecosystem state, 2026).
