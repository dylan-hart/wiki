# GTM 01 — The Battlefield: Opponents, Distance, Weak Points

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md). Sources:
[`gtm-research/research-competitors.md`](gtm-research/research-competitors.md),
[`gtm-research/research-wikijs.md`](gtm-research/research-wikijs.md). Star counts are GitHub's, pulled
2026-09-13. Growth figures are OSSInsight (relative, not absolute).

The wiki field is vast. What matters is **distance from Cardinal's core value** — who a real buyer
would put on the same shortlist — and **which fights are winnable now**.

---

## 1. The map: concentric rings

```
                      ┌──────────────────────────────────────────────┐
  Ring 4: Incumbents  │ Confluence · Notion · SharePoint/Loop · GitBook│  (you win only on self-host,
  (SaaS)              │ Slab · Guru · Document360 · Superhuman Docs    │   price, sovereignty)
                      │   ┌──────────────────────────────────────────┐ │
  Ring 3: Adjacent    │   │ AFFiNE · AppFlowy · Plane · Huly         │ │  (overlap on "team docs";
  self-hosted         │   │ La Suite Docs · Nextcloud Collectives    │ │   not governed wikis)
                      │   │ DokuWiki · MediaWiki · Otter · LeafWiki  │ │
                      │   │   ┌──────────────────────────────────────┐│ │
  Ring 2: Same        │   │   │ BookStack · Outline · XWiki · tela   ││ │  (same shortlist, different
  shortlist           │   │   │   ┌──────────────────────────────┐  ││ │   shape)
                      │   │   │   │ Ring 1: Wiki.js (2.x & 3.x)  │  ││ │  (same code lineage, same
                      │   │   │   │         Docmost              │  ││ │   buyer, same pitch)
                      │   │   │   └──────────────────────────────┘  ││ │
                      └───┴───┴──────────────────────────────────────┴┴─┘
```

| Opponent | Ring | Threat to Cardinal | Winnable now? | Primary line of attack |
|---|---|---|---|---|
| **Wiki.js 2.x** (installed base) | 1 | Not a threat — a **prize** | **Yes** | Migration path nobody else offers |
| **Wiki.js 3.x** (upstream beta) | 1 | **Highest** — same code, same buyer, 29k★ brand, shipping fast | Contested | Migration, production readiness, support, governance, agents |
| **Docmost** | 1 | **High** — owns "self-hosted Confluence alternative" mindshare | Yes, on price-of-features | "Everything Docmost charges for, free" |
| **tela** | 2 | Medium, rising — same AI pitch, marketing vs Wiki.js | Yes | Governance depth, multi-site, importers |
| **BookStack** | 2 | Medium — beloved, simple, solo-maintained | Partially | Collab, SSO depth, multi-site; don't fight on simplicity |
| **Outline** | 2 | Medium — polish + MCP, but BSL and needs external SSO | Yes for self-hosters | "Actually open source", local login, no S3 requirement |
| **XWiki** | 2 | Medium in EU public sector, low elsewhere | Not directly | Modern UX + real-time + classification; partner, don't tender |
| **Confluence DC** | 4 | Not a threat — a **2027–2029 prize** | Later (needs importer) | On-prem continuity before read-only 2029-03-28 |
| **La Suite Docs** | 3 | Low direct, high for EU attention | No (government-funded, MIT) | Coexist/integrate; sell governance it doesn't have |
| **Notion / Confluence Cloud / GitBook** | 4 | Low — different buyer | Only on sovereignty/price | Don't chase; capture defectors |

---

## 2. Ring 1 opponent profiles

### 2.1 Wiki.js — two different opponents under one name

**Wiki.js 2.x — the installed base (treat as territory, not enemy)**

- 28,918★, **116M Docker Hub pulls + 30.5M GHCR**, packaged on DigitalOcean (official 1-Click),
  Cloudron, YunoHost, TrueNAS, Unraid (linuxserver.io), Elestio, PikaPods, Stellar Hosted, Hostwiki.
- Maintenance-only: `v2.5.314` (2026-05-01); last NGPixel commit on `main` 2026-05-01.
- Runs on EOL/deprecated dependencies: Apollo Server 2, Vue 2.6, webpack 4, knex 0.21, `request`,
  aws-sdk v2, deprecated `passport-saml` (SAML bypass report #7756 still referencing the vulnerable lib
  in 2026-01). Critical privilege-escalation CVE-2026-44224 patched April 2026. A Swiss company
  (swissmakers/wikijs-ng) forked 2.x purely to pay down that debt.
- Supports five databases; the docs themselves say four of them (MySQL, MariaDB, MSSQL, SQLite) **will
  not be supported in the next major version**, with an export tool promised in 2022 that never shipped.
- **Weak points:** no path forward (upstream "Coming soon"), stranded non-Postgres databases, most-wanted
  features (paste images 81 votes, approvals 54, collapsible nav 38) are "Added in V3" — unreachable
  without a migration; ~33% of help threads answered; issues closed to the public.
- **Strength to respect:** it works, people like it, and it's the name they searched for.

**Wiki.js 3.x — upstream beta (the real rival)**

- Public betas since 2026-09-02; README still *"DO NOT USE IN PRODUCTION"*, *"no upgrade path"*, *"no
  support"*. GA ETA: none ("stay in beta until all v2 features have been implemented").
- Has: multi-site, approvals/suggest edits, live collab, dynamic blocks, file manager, HA, webhooks,
  passkeys, audit log, Prometheus, 8 auth modules (incl. Entra/LDAP/SAML group mapping), 7 storage,
  analytics and 9 comment providers, Helm chart.
- Lacks: 2.x upgrade, MCP, semantic search, external search engines (deprecated), classification,
  glossary, knowledge graph, delegated site admin, WYSIWYG/AsciiDoc editors, page templates.
- **One maintainer** (1,875 contributions vs #2 at 14), day job, explicitly not seeking to go full-time,
  thin funding (19 sponsors ≈ 4% of a $6k/mo goal; OC ≈ $4.8k/yr).
- **Verified pace and milestone state (2026-09-13):** 129 commits since 2026-07-25 (~7.3 weeks,
  ~18/week), 100% solo, no co-authors, 50% feat / 24% fix / 14% refactor. Six real tagged GitHub
  Releases in that window (`3.0.0-alpha.530` → `beta.561`), roughly one every 1–4 days, each with a
  genuine changelog — this is a real release habit, not just fast commits. His own "3.0" milestone:
  10/13 closed; open items are Mail (not started), Navigation Sidebar, and WYSIWYG Editor (2/6
  subtasks done). A "3.1" milestone is already scoped in parallel (4/5 closed) — he's planning past
  3.0 already. Preceded by 16 months of near-dormancy (~15 commits total) — the pace is real today,
  not guaranteed to hold.
- **Cardinal's own pace against this, verified 2026-09-13 (doc 00 §1 has the full breakdown):**
  Cardinal's 6-day launch push (2026-08-16 → 08-21) reached upstream's entire 3.0 feature list —
  multi-site, approvals, collab. Every week since (~28–40 commits/week, above his ~18/week) has built
  what upstream isn't attempting at all: MCP, semantic search, classification, glossary, delegated
  site admin — none on his "3.0"/"3.1" milestones. §6.3's differentiator table is current, not
  aspirational.
- **Weak points:** bus factor; no support/hosting offer; no migration; closed issue tracker; blog silent
  since 2023; opinionated scope ("I'm quite opiniated when it comes to how a feature should work").
- **Strengths to respect:** the brand and the 29k-star repo; real, accelerating velocity since July
  2026; the community's affection; the moral position of "original author"; the ability to legally
  absorb any Cardinal feature under AGPL.
- **Full campaign:** [doc 02](2026-09-13-gtm-02-campaign-wikijs.md).

### 2.2 Docmost — the incumbent of your category

- 21,669★, AGPL core + proprietary `ee` (CLA-backed, so they can dual-license — you can't), v0.96.0,
  22 releases in 12 months, NestJS/React, Postgres + Redis, Cloud + self-hosted.
- **Paywall (Business $6/seat/mo, 10-seat min):** SSO (SAML/OIDC/LDAP), MFA/2FA, page-level permissions,
  AI search/assistant **including MCP**, Confluence importer, attachment search, API keys.
  Enterprise adds SCIM, audit log + SIEM, page verification.
- Public pushback on the 2FA paywall (discussion #1889 — "not acceptable for an open-source project").
- Growth peaked early 2025, now ~+50–150★/month. Customer logos: Vilnius City, Bechtle, Australian
  Government, Red Cross.
- Already writes the SEO you want: "Wiki.js alternatives", "Confluence DC end of life".
- **Weak points:** the paywall itself; no multi-site; no approvals/classification/glossary; no Wiki.js
  importer; Redis dependency; pre-1.0 after two years.
- **Strengths:** execution, cadence, community, a hosted cloud, a Notion-style "Bases"/Kanban primitive
  Cardinal lacks, first-party embeds, a founder who markets.
- **Line of attack:** *pricing shape*. Every item on Docmost's Business list except the Confluence
  importer is free in Cardinal. Say that with a factual table, not adjectives. Never brigade their
  discussions.

---

## 3. Ring 2 opponent profiles

### tela — the doppelgänger to watch
- Created 2026-05-18, 62★, Go + Postgres + React, **Yjs + pgvector + built-in MCP (39 tools) + WebDAV
  Markdown sync**; "Atlas" auto-generates cited pages from Git/Jira. AGPL Community, paid SSO/SCIM/audit,
  cloud $6–8/seat. **Publishes a "tela vs Wiki.js" comparison page.**
- **Implication:** your AI story (semantic search + MCP) is being built independently by others. Lead
  with governance + migration; keep AI as "agents that obey your permissions."
- **Weak points:** simple per-space roles, no multi-site/approvals/classification, no importers.

### BookStack — the one to learn from, not attack
- 19,038★ (dev moved to Codeberg May 2026), MIT, PHP/MySQL, 29 releases/yr, **solo maintainer funded at
  ~£5.9k/month** (support £3.7k + sponsors £2.0k). Maintainer publicly declined to build LLM features.
- Beloved on r/selfhosted; rigid shelves→books→chapters hierarchy; no real-time collab.
- **Line:** don't attack. Position alongside: "BookStack if you want simple; Cardinal if you need
  real-time editing, page-rule permissions, multi-site, approvals." Attacking BookStack costs goodwill
  in the exact community you need.

### Outline — polished, but not open source
- 40,529★, **BSL 1.1** (no competing hosting), cloud $10/$79/$249 flat tiers, built-in MCP in every
  workspace, Confluence import, AI answers.
- Self-hosters' recurring complaint: **no local email/password login** — an external OAuth/OIDC provider
  is required — and S3/MinIO is required.
- **Line:** "open source, local accounts, no object store required" — factual, verifiable.

### XWiki — Europe's public-sector incumbent
- LGPL, Java, monthly releases + LTS, XWiki SAS sells support/Pro apps/cloud; **the "Knowledge"
  component of Germany's openDesk**; Confluence Migrator Pro from €2,000; OpenProject + XWiki partnership
  (2025-07) as open-source Jira + Confluence; beta MCP extension; sub-wikis cover multi-site.
- **Weak points:** heavy stack, dated UX, steep learning curve.
- **Line:** don't try to displace it in tenders. In Phase 4, pitch *modern real-time editing +
  classification levels + approvals* to integrators; XWiki's slot is taken, but the UX complaint is real.

---

## 4. Ring 3 — adjacent, don't chase

| Product | What it is | Why it's not your fight | What to borrow |
|---|---|---|---|
| **AFFiNE** (72.5k★) | Notion + Miro, fastest absolute growth | Individuals/small teams, weak governance | Whiteboard/database envy is real; don't chase it pre-launch |
| **AppFlowy** (76.6k★) | Local-first Notion clone | Paid multi-user self-host | Notion importer bar |
| **Plane** (59.3k★) | Jira replacement with paid wiki | Wiki is secondary and paid | **Integration target** — Plane + Cardinal is an open Jira+Confluence pair |
| **La Suite Docs** (16.8k★) | FR/DE/NL government doc editor | Government-funded, MIT, not a wiki | Coexist; governance is your gap-filler |
| **Nextcloud Collectives** | Nextcloud app | Lightweight | Nextcloud users are a Cardinal integration audience |
| **Huly** | All-in-one, 8–16GB RAM footprint | Not a wiki | — |
| **DokuWiki / MediaWiki** | Legacy giants | Migration *sources*, not competitors | MediaWiki/DokuWiki importers are cheap SEO + real value |
| **Otter Wiki, LeafWiki, SilverBullet, Trilium, TiddlyWiki** | Minimalist/personal | Different buyer | LeafWiki is already being cited as where Wiki.js users went ("too much effort to manage assets, sidebar tree, links") — that's an onboarding lesson |
| **PandaWiki / LLM-wiki wave** | AI-compiled knowledge bases | Agent memory, not human wikis | Frame Cardinal as "the governed source of truth agents read and write" |

---

## 5. Ring 4 — SaaS incumbents

| Product | Pressure point you can use | Caveat |
|---|---|---|
| **Confluence** | DC end-of-sale 2026-03-30; expansion cutoff 2028-03-30; **read-only 2029-03-28**; DC +~15% (Feb 2026); Cloud +7–10% from **2026-10-13** | Needs a Confluence importer; XWiki, Docmost (paid), Plane, Outline, Notion already have one |
| **Notion** | Full AI only on Business; no self-host | Different buyer; editor polish bar is very high |
| **GitBook** | Per-site pricing; docs-first | Great MCP story; not an internal wiki |
| **SharePoint / Loop** | Bundled with M365; Copilot content backbone | Sovereignty-driven exits only |
| **Slab / Nuclino / Guru / Tettra / Document360** | Per-seat cost | Small buyers rarely self-host |
| **Superhuman Docs (ex-Coda)** | Rebrand churn | Different product category |

---

## 6. Capability matrices

### 6.1 Importers — the most strategic table in this document

| Product | Wiki.js | Confluence | Notion | MediaWiki | Markdown/HTML |
|---|---|---|---|---|---|
| **Cardinal** | **Yes** (Postgres full; bundle partial) | **No** | No | No | Page import |
| Wiki.js 3.x upstream | **"Coming soon"** | No | No | No | — |
| Docmost | No | Paid only | Free | No | Free |
| Outline | No | Yes | Partial | No | Yes |
| XWiki | No | Free + Pro €2k | ? | Extension | Yes |
| Plane | No | Yes | Yes | No | — |
| BookStack | No | Community tools | No | No | Yes |
| tela / La Suite Docs / AFFiNE | No | No | AFFiNE yes | No | Some |

**Finding:** the Wiki.js 2.x base is *uncontested*. Confluence import is table stakes for Ring-4
defectors and Cardinal's largest capability gap.

### 6.2 MCP / agents
Built-in MCP is table stakes among funded products (Atlassian Rovo, Notion, GitBook, Mintlify, Outline,
AFFiNE, Plane, tela; Docmost paid-only; XWiki beta). It is a differentiator **only among free,
open-source, self-hosted** options — where Cardinal is the only one that is free, first-party, and
permission-scoped. Market it as governance ("agents see what the user can see, edits go through
approvals"), not as novelty.

### 6.3 Differentiator durability

| Cardinal capability | vs upstream 3.x | vs Docmost (free) | vs field | Durable? |
|---|---|---|---|---|
| 2.x importer | **Unique** | Unique | Unique | Until upstream ships one — make it *the best* one |
| Classification levels | Unique | Unique | None found in OSS wikis | **High** — public sector/defence/regulated |
| Delegated per-site admin + page rules | Unique (site delegation) | Page perms paid | XWiki fine-grained | High |
| Free SSO/2FA/passkeys | Upstream has fewer modules (8 vs 17) | **Paid** | BookStack free | Medium-high |
| MCP (free, permission-scoped) | Unique | Paid | tela/Outline | Medium, converging |
| Semantic search (pgvector, 2-hop) | Unique | Paid AI search | tela | Medium, converging |
| WYSIWYG + AsciiDoc + Markdown editors | Upstream lacked WYSIWYG/AsciiDoc as of this audit's 2026-09-13 snapshot. *Update 2026-09-14: upstream shipped a visual editor; still lacks AsciiDoc.* | Docmost is WYSIWYG-native | — | Medium — narrower now that upstream has WYSIWYG too |
| External search engines (ES/Algolia/etc.) | Upstream dropped | No | — | Medium (enterprise ES users) |
| 7 storage backends incl. git sync | Upstream has 7 | 3 | Otter/Gollum git | Medium |
| Multi-site | **Upstream has it** | No | XWiki/MediaWiki farms | Medium — not unique vs upstream |
| Approvals | **Upstream has it** | Enterprise | XWiki ext. | Medium — not unique vs upstream |
| Real-time Yjs collab | Upstream has it | Yes | Common | **None** — table stakes |
| Glossary, knowledge graph | Unique | No | None built-in | Low-medium (nice to have) |
| Lit custom blocks | Upstream has dynamic blocks | No | — | Low (and a security liability to manage) |

### 6.4 Gaps that cost evaluations
No release · no Confluence/Notion importer · no hosted offer · no Notion-style database/Kanban · no
Helm chart (upstream has one) · no production compose file · no docs site · no demo · CAS module that
cannot log anyone in · SSO presets unverified against live IdPs · unsandboxed custom blocks undisclosed
to evaluators · no SCIM · no PWA/mobile.

---

## 7. Where to fight, where to flank, where to ignore

- **Fight head-on:** Wiki.js 2.x migration (own it completely); Docmost on pricing shape.
- **Flank:** upstream 3.x on production readiness, support, public responsiveness, governance and agents
  — never on "our code is better."
- **Prepare the ground for 2027:** Confluence DC (importer + on-prem story); EU sovereignty via partners
  (Helm, Keycloak-friendly SSO, classification).
- **Ally or integrate:** Plane (open Jira+Confluence pair), Nextcloud, Keycloak/Authentik communities,
  hosting partners that already list Wiki.js.
- **Ignore for now:** Notion-class editors, whiteboards/databases, AI-compiled wikis, docs-as-code.
- **Never attack:** BookStack, NGPixel personally, La Suite (government goodwill).
