# Cardinal.js vs. Docmost — Head-to-Head Audit

**Date:** 2026-09-13
**Companion to:** `docs/audits/2026-09-13-business-sanity-audit.md`, which identified Docmost as the
single closest competitive analog to Cardinal.js — same AGPL-3.0 license, same "self-hosted
Confluence/Notion alternative" positioning, same rough target buyer. This audit goes deep on that one
comparison specifically, using primary sources (Docmost's own GitHub repo, docs site, and pricing
page — not secondary blog roundups) cross-referenced against the code-verified Cardinal.js inventory
from the first audit.

**One correction to the first audit:** that audit cited Docmost's paid tier at "$3.50/seat" from a
secondary source. Docmost's own pricing page states **$6/seat/mo, 10-seat minimum** ($60/mo/instance
floor). The primary number supersedes the earlier one; nothing else in the first audit's Docmost
mentions was materially wrong.

---

## Headline verdict

**On a line-by-line technical comparison, Cardinal.js's free tier is often the deeper product.**
Docmost gates search sophistication, page-level permissions, full API access, and audit logging
behind a $6/seat paid tier that Cardinal.js gives away for free and, in several cases, implements
more thoroughly. **Docmost's real advantage is not features — it's execution and go-to-market**: a
live hosted cloud option, a working (if partial) migration path from a real competitor's format, a
lighter two-service ops footprint, a couple of structural product primitives Cardinal.js lacks
outright (a Notion-style database/table view, Kanban boards, first-party embed blocks), and — most
importantly — two-plus years of continuous, versioned, changelogged shipping with a real outside
contributor base and 21,000+ GitHub stars, versus Cardinal.js's zero tags and zero public presence.

This sharpens the first audit's framing: the gap between these two projects is not "Cardinal.js
needs to build more" — on raw capability it frequently doesn't — it's "Cardinal.js needs to become
visible and shippable." Docmost is proof that a wiki with a noticeably *thinner* free feature set than
Cardinal.js's can still win the category, purely by showing up, shipping continuously, and being
findable.

---

## License & business model — the more instructive comparison

Both projects are AGPL-3.0. The similarity ends at the license string.

**Docmost's open-core split is architectural, not just a marketing distinction.** Per its own
`README.md`: everything under `apps/server/src/ee`, `apps/client/src/ee`, and `packages/ee` is
"Docmost Enterprise license," not AGPL. Critically, `apps/server/src/ee` is a **git submodule
pointing at `github.com/docmost/ee`, a private repository** — the Enterprise code is not merely
differently licensed, it is genuinely closed-source and unreadable outside their internal team. The
AGPL core and the private EE tree are built and shipped together from one monorepo, with the
boundary enforced by which submodule resolves at build time.

Cardinal.js has no equivalent structure — everything in this repo is AGPL, all the time, because
there is currently no commercial model at all. That's a legitimate choice, but it means Cardinal.js
has no mechanism to fund itself the way Docmost funds ~2+ years of continuous shipping (52
contributors, 37 PRs merged in the last 30 days alone). **If Cardinal.js — or whoever operates it —
ever wants sustained, funded development rather than one maintainer's spare capacity, Docmost's
`ee`-submodule pattern is a concrete, already-proven template to study**: keep the wiki itself fully
AGPL and free, and put a narrow, clearly-scoped set of enterprise-only capabilities (SSO/SAML/LDAP,
SCIM, audit-log/SIEM export, AI chat/writing) behind a private module and a per-seat price. Docmost's
own choice of *which* things to gate — auth, provisioning, and premium AI — is itself worth studying:
they gated exactly the features enterprise procurement will pay for without touching what makes the
free product good enough to attract a community in the first place.

---

## Feature-by-feature comparison

Legend: **C free** = Cardinal.js, free/open at every tier · **D free** = Docmost Community tier ·
**D paid** = Docmost Business ($6/seat, 10-seat min) or Enterprise (custom) only · **Tie** · **Neither**

| Category | Cardinal.js | Docmost | Who's ahead |
|---|---|---|---|
| **License** | AGPL-3.0, 100% open | AGPL-3.0 core + closed-source `ee` submodule for paid features | Tie on openness; Docmost's split is more commercially sustainable |
| **Auth — local/password** | C free | D free | Tie |
| **Auth — SAML/OIDC/LDAP/OAuth2** | **Free**, broad (7+ named providers plus generic OIDC presets) | **Paid-gated entirely** — OSS core has only `jwt.strategy.ts`, no SSO of any kind free | **Cardinal.js**, decisively |
| **SCIM provisioning** | Neither has it | Enterprise-only | Tie on absence from anything affordable; Docmost at least has a path to sell |
| **2FA / passkeys** | Free (TOTP, recovery codes, passkeys) | MFA/TOTP is Business+/Enterprise | **Cardinal.js** |
| **Storage backends** | Free — disk/S3/Azure/GCS/SFTP/git/db (7 drivers) | Free — disk/S3/Azure (3 drivers) | **Cardinal.js** on breadth, but both free at the tier that exists |
| **Search — keyword** | Free (7 engine modules incl. Elasticsearch/Algolia) | Free (Postgres full-text) | **Cardinal.js** on breadth |
| **Search — semantic/AI** | **Free**, real two-hop pgvector ANN, degrades gracefully | **Paid-gated** ("AI Answers"), and no evidence of anything as sophisticated as multi-hop ANN | **Cardinal.js**, decisively — this is Cardinal.js's clearest structural win |
| **Attachment content search (PDF/DOCX)** | Not confirmed as a distinct feature | Business+/Enterprise | Unclear/Docmost has at least named it |
| **Real-time collaboration** | Yjs, live cursors/awareness | Yjs via Hocuspocus, same primitive | **Tie** |
| **Permissions granularity** | **Free at every level** — global / page-rule / site-scoped delegation | Free tier stops at Space/Group (CASL-based); **page-level rules are paid-gated** | **Cardinal.js** |
| **Multi-tenancy** | Hostname-routed multi-site, fully isolated page trees & sessions | Single-workspace Spaces model (closer to Confluence) | **Cardinal.js** — more architecturally ambitious |
| **AI writing assistant / chat** | **None** | Free-tier: none; Business+/Enterprise: AI Chat + "Ask AI" writing assist, supports local LLMs | **Docmost** — this is Docmost's clearest structural win, though it costs $6/seat even self-hosted |
| **MCP / agent protocol** | **Free**, already built — 20+ tools, in-process, documented in this repo | Exists but grouped with paid AI features; no public tool-list/depth comparable to Cardinal.js's | **Cardinal.js** on price and verifiable depth; tie on bare presence |
| **Structured data (database/table views, Kanban)** | **None** | Free-tier "Bases" (Notion-style tables) + Kanban boards | **Docmost** — a product category Cardinal.js doesn't have at all |
| **Diagrams in-editor** | Blocks: kroki, plantuml, drawio (via Lit custom blocks) | Free-tier: Draw.io, Excalidraw, Mermaid | Roughly **tied**, different implementations |
| **Comments & page history** | Free, multiple comment providers, real audit log | Free-tier | Tie |
| **Templates / transclusion** | Not shipped (open Feature 2428) | Not confirmed as a marketed feature either | Tie — neither has decisively shipped this |
| **Embeds (Airtable/Loom/Miro, etc.)** | **None** first-party; only generic webhook/OAuth plumbing | Free-tier, named third-party embeds | **Docmost** |
| **Import/migration tooling** | **None** — not even for its own predecessor, Wiki.js 2.5.x | Free-tier: ZIP, Notion, basic Confluence, PDF/DOCX import; Enterprise adds high-fidelity Confluence import | **Docmost**, and pointedly — it ships free migration from a *competitor's* format while Cardinal.js has none for its own lineage |
| **API/extensibility** | **Free**, full Swagger-documented REST API + API keys, custom Lit block architecture | API keys/admin key management are Business+/Enterprise; no plugin/block system found | **Cardinal.js** |
| **i18n** | Locale-scoped page rules, translation linking, hardened RTL | Free-tier, 10+ languages via Crowdin | Roughly tied — Cardinal.js deeper structurally, Docmost broader in translated-language count |
| **Mobile / PWA / offline** | None | None (responsive web only) | **Tie** — neither has this |
| **Accessibility** | Basic, undocumented as a strength | No stated posture found | **Tie** |
| **Admin: audit log** | Free, backs classification/approvals | Enterprise-only, paired with SIEM export | **Cardinal.js** on the free tier; Docmost's paid tier goes further (SIEM) than anything Cardinal.js has at all |
| **Admin: metrics/ops** | Free (Prometheus, scheduler, maintenance broadcast) | Not prominently featured | **Cardinal.js** |
| **Deployment footprint** | Postgres + broader module surface (search/storage/analytics engines as needed) | **Postgres + Redis only**, single Dockerfile + docker-compose | **Docmost** — meaningfully lighter to stand up |
| **Hosted/cloud offering** | **None** — self-hosted only | **Yes**, a live managed cloud option exists alongside self-hosted | **Docmost** |
| **Stable/tagged releases** | **Zero tags** past inherited `v2.5.x`; README carries a "VERY BUGGY, INCOMPLETE, NON-SECURE" banner | **60 tagged releases since June 2024**, still pre-1.0 at `0.96.0` but shipping continuously and changelogged | **Docmost**, decisively — see nuance below |
| **Public presence / community** | Private repo, zero public signal | 21,668 stars, 1,558 forks, 52 contributors, 37 PRs merged in the last 30 days, pushed as recently as the day before this research | **Docmost**, overwhelmingly |
| **Business model / sustainability** | None | Bootstrapped-appearing (founder Philip Okugbe, UK; no VC funding found), self-funding off Business/Enterprise revenue for 2+ years | **Docmost** |

---

## An important nuance: "no stable release" isn't quite the right framing

The first audit flagged Cardinal.js's lack of a stable, tagged release as a Tier-0 adoption blocker.
Docmost's own history refines that claim rather than overturning it: **Docmost has shipped 60 tagged
releases over more than two years and still hasn't cut a 1.0** — it's sitting at `0.96.0` with real
adoption, real revenue, and 21,000+ stars. The market's actual bar is evidently not "must be
version 1.0" — it's **"must ship regular, dated, changelogged, tagged releases that a user can point
at and trust wasn't silently broken since last week."** Cardinal.js currently clears none of that:
not the tags, not the changelog, not the cadence. The fix implied by Docmost's example is cheaper
than "achieve production perfection before shipping 1.0" — it's "start tagging what already exists,
on a regular cadence, today," independent of whatever internal quality bar a hypothetical 1.0 would
require. This is a materially easier P0 fix than the first audit's framing implied.

---

## What Cardinal.js should study or steal from Docmost, in priority order

1. **Start tagging real releases on a cadence, now.** Per the nuance above, this is decoupled from
   "finish 3.0" — Docmost proves a pre-1.0 project can build real trust through cadence and
   changelog discipline alone.
2. **A structured-data primitive (tables/"Bases" + Kanban).** This is a genuine product category gap,
   not a polish gap — Cardinal.js has nothing here, and it's core to why Docmost (like Notion) reads
   as more than "just a wiki" to evaluators.
3. **Migration tooling — even a partial one, even for a competitor's format first.** Docmost's free
   Notion/Confluence/ZIP import is more mature than Cardinal.js's import story for its *own*
   predecessor. Fixing the 2.5.x migration gap (Tier 0 in the first audit) also directly answers
   this.
4. **First-party embed blocks for a short list of common third-party tools** (Airtable, Loom, Miro-
   equivalent) — low effort relative to the credibility it buys, using the existing Lit block
   architecture Cardinal.js already has and Docmost doesn't.
5. **Consider the `ee`-submodule open-core pattern** as the funding mechanism if Cardinal.js is ever
   meant to be more than a personal fork — gate SSO/SCIM/AI-writing/audit-SIEM behind a private
   module and a seat price, the way Docmost does, rather than either staying entirely unfunded or
   closing the whole project.
6. **Publish, even minimally.** Docmost's visibility comes from ordinary open-source hygiene (public
   repo, regular pushes, responsive issues/PRs) more than from deliberate marketing. Cardinal.js is
   invisible by construction (private repo) — that's a switch to flip, not a campaign to run.

## What Cardinal.js should NOT change chasing Docmost

- **Don't paywall page-level permissions or full API access** — Docmost's free tier is intentionally
  shallower there to create an upgrade incentive; Cardinal.js giving these away free is a genuine
  competitive advantage worth keeping if Cardinal.js ever does adopt a paid tier of its own.
  Reproduce Docmost's *choice of what to gate* (auth, provisioning, premium AI, SIEM) rather than its
  specific menu, which happens to gate things Cardinal.js currently wins on for free.
- **Don't abandon the semantic search investment** — it's more technically sophisticated than
  Docmost's paid "AI Answers" and is currently one of only two areas (with MCP) where Cardinal.js is
  unambiguously ahead on substance. Docmost's AI *writing* assistant is the real gap to close (see
  the first audit's P1 recommendation), not the search side.
- **Don't chase Docmost's lighter two-dependency footprint by ripping out modularity** — Cardinal.js's
  broader storage/search engine surface is a real strength for larger or more idiosyncratic
  deployments; Docmost's simplicity is an advantage for small teams specifically, not a universal
  win.

---

## Revised bottom line

Cardinal.js is not losing to Docmost on engineering. It is losing on the two things engineering alone
cannot fix: **being shippable in a form the market can trust (tags, changelog, a release cadence)**
and **being visible at all (a public repository, ordinary open-source activity)**. Every other gap
identified against Docmost specifically — AI writing assist, structured data views, migration
tooling, embeds, a hosted tier — is real but secondary to those two, because none of them can be
evaluated by anyone until the first two are fixed.
