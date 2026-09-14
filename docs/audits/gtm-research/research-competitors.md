# Cardinal.js competitive landscape (research date 2026-09-13)

Scope: the 2026 state of self-hosted wikis, SaaS incumbents and docs-as-code tools, plus signals about market timing. Written for go-to-market planning.

**Method and how reliable each kind of data is**
- **GitHub stars, license SPDX, latest release, release count (last 12 months), repo creation date:** pulled live via `gh api` on 2026-09-13. Reliable.
- **12-month star growth:** from the OSSInsight public API (`api.ossinsight.io/v1/repos/<repo>/stargazers/history`).
  - OSSInsight's running totals are 15–25% below GitHub's (e.g. Docmost 16.5k vs 21.7k), so compare growth between projects, not as absolute counts.
  - GitHub's own stargazer-timestamp endpoint returned 404 for every page, so it couldn't be used to cross-check.
- **Pricing and features:** official pricing pages were fetched where possible. Where I only had a third-party SEO/aggregator page, it's marked **[3rd-party]**. Anything I couldn't confirm is marked **[UNVERIFIED]**.
- **Cut short:** the session's web-search limit (200 calls) ran out partway through. Items I couldn't research because of that are listed in the last section.

---

## 1. Summary tables

### 1a. Self-hosted team wikis (direct competitors)

| Product | License | Stars (2026-09-13) | 12-mo star growth* | Latest release | Releases, last 12 mo | Business model |
|---|---|---|---|---|---|---|
| Wiki.js (requarks) | AGPL-3.0 | 28,918 | +546 (~2%) | v2.5.314 (2026-05-01) | 12 | Donations/sponsors; no paid tier |
| Docmost | AGPL-3.0 core + commercial EE | 21,669 | +1,119 (~7%) | v0.96.0 (2026-09-08) | 22 | Business $6/seat/mo (annual, min 10 seats); Enterprise custom |
| BookStack | MIT | 19,038 (GitHub mirror; dev moved to Codeberg in 2026) | +488 (~3%) | v26.05.4 (2026-08-24) | 29 | Donations/sponsors; no paid tier |
| Outline | **BSL 1.1** (becomes Apache-2.0 on 2030-09-09 for v1.10.1) | 40,529 | +1,181 (~3.5%) | v1.10.1 (2026-09-09) | 19 | Cloud $10 / $79 / $249 per month flat tiers; Enterprise self-hosted by quote |
| XWiki | LGPL-2.1 | 1,309 (the star count understates XWiki's real adoption) | +36 | 17.10.13 LTS (2026-09-09); 18.7.0 (Aug 2026) | monthly | XWiki SAS support subscriptions, paid extensions (Confluence Migrator Pro from €2,000), XWiki Cloud |
| DokuWiki | GPL-2.0 | 4,717 | +87 | 2026-07-14 "Mort" (hotfix c, 2026-09-02) | ~3 | Community |
| MediaWiki | GPL-2.0 | 5,168 (mirror) | n/a | 1.46 (2026-06-30); 1.45 (Dec 2025) | 6-monthly; every 4th release is LTS | Wikimedia Foundation plus a consultancy ecosystem (e.g. Professional Wiki) |
| AFFiNE | MIT (frontend) + separate backend license (`packages/backend/server/LICENSE`) | 72,520 | +4,626 (~8.6%) | v0.27.4 (2026-08-18) | 72 | Cloud Pro/Team; self-hosted free up to 10 seats, then $10/seat/mo annual [3rd-party] |
| AppFlowy | AGPL-3.0 | 76,604 | +2,272 (~3.4%) | 0.14.2 (2026-09-10) | 32 | Cloud Pro $10–12.5/user; AI MAX $8; local-AI "Vault" $6; multi-user self-hosting needs a license [3rd-party: free self-hosting = 1 seat] |
| Otter Wiki | MIT | 1,532 | n/a | v2.24.1 (2026-09-08) | 33 | Hobby/community |
| Nextcloud Collectives | AGPL-3.0 | 193 | n/a | v4.6.1 (2026-09-01) | frequent | Nextcloud GmbH enterprise subscription |
| Huly | EPL-2.0 | 27,661 | n/a | v0.7.426 (2026-07-05) | many | Cloud priced by storage/traffic ($0 / $19.99 / $99.99 / $399.99 per month, unlimited users); self-hosting free [3rd-party] |
| Plane (Pages/Wiki) | AGPL-3.0 (Community); commercial editions | 59,335 | +4,215 (~11%) | v1.4.2 (2026-08-23) | 15 | Cloud Free (12 users, no wiki) / Pro $6–8 / Business $13–15 per user; self-hosted Commercial edition |
| TriliumNext | AGPL-3.0 | 37,821 | +1,669 (~5%) | v0.105.0 (2026-08-19) | 20 | Community (personal notes, not a team wiki) |
| SilverBullet | MIT | 6,042 | +475 (~12%) | 2.10.0 (2026-07-28) | many | Community (personal) |
| Gollum | MIT | 14,328 | n/a | v6.1.0 (2024-12-23); last push 2025-11 | ~0 | Effectively dormant |
| TiddlyWiki | BSD-3 style (GitHub reports NOASSERTION) | 8,647 | n/a | v5.4.1 (2026-07-10) | few | Community (personal) |
| **La Suite Docs** (FR/DE/NL governments) | MIT (editor is BlockNote: MPL-2.0, with GPL-3.0/commercial "XL" packages) | 16,814 | +1,108 (~8.5%) | v5.6.1 (2026-09-04) | 31 | Government-funded (DINUM + ZenDiS) |
| **tela** (new, May 2026) | AGPL-3.0 | 62 | new | v0.8.0 (2026-07-05) | 1 | Cloud Free / $6 Personal / $8 per seat Team; Enterprise: SSO, audit |
| PandaWiki (Chaitin, China) | AGPL-3.0 | 10,237 | +1,386 (~37%) | v3.87.1 (2026-09-08) | very frequent | AI-first knowledge base; Chinese-market focus |
| LeafWiki (new, 2025) | MIT | 1,128 | small base | v0.13.0 (2026-09-08) | frequent | Hobby (single Go binary + SQLite) |

\* OSSInsight growth from 2025-09-01 to 2026-09-01. Percentages use GitHub's current total as the denominator, so treat them as approximate.

### 1b. SaaS incumbents

| Product | 2026 pricing (per user/month unless noted) | AI / MCP | Notes |
|---|---|---|---|
| Confluence Cloud | Standard ~$5.42–6.70; Premium ~$10.44–13.20 [3rd-party]. **+7% for Standard/Premium under 5k seats, +10% at 5k+ seats, +8% Enterprise from 2026-10-13** | Rovo (search, chat, agents) bundled but metered by credits (~25/70/150 credits per user per month for Std/Prem/Ent) [3rd-party]. **Official Rovo MCP server is generally available** | Also raised prices Oct 2025; Data Center rose ~15% on 2026-02-17 [3rd-party] |
| Confluence Data Center | End-of-sale to new customers **2026-03-30**; last date to expand existing licenses **2028-03-30**; **end of life / read-only 2029-03-28** | – | Server end of support was 2024-02-15. Current DC LTS is 10.2 (support to 2027-12-02) |
| Notion | Plus $10 monthly (~$8 annual); Business $20 monthly (~$16 annual) per the official page fetch. **Conflict:** several 3rd-party sources say Business is $20 annual / $24 monthly after a ~20% 2026 rise. [UNVERIFIED which is current] | Full AI only on Business (the standalone AI add-on ended May 2025); Enterprise adds zero data retention. **Official hosted MCP server** | No self-hosting |
| GitBook | Premium $65/site/mo + $12/user; Ultimate $249/site/mo + $12/user; free = 1 user | Every published site gets an auto-generated MCP server; an authoring MCP too; AI-traffic analytics (Feb 2026) | Small historical funding (~$1M seed) [3rd-party] |
| Slab | Free (≤10 users); Startup $6.67; Business $12.50 (annual); Enterprise min 100 users | AI Autofix / Predict / Ask on paid tiers | No acquisition notice on its pricing page |
| Nuclino | Starter $6–8; Business $10–12.50 [3rd-party] | – | – |
| Guru | ~$25/seat, 10-seat minimum [3rd-party] | AI-first positioning | Every reader needs a paid seat |
| Document360 | Quote-only since the free tier ended Nov 2024; roughly $199–499+/mo [3rd-party] | AI tiers | – |
| Tettra | $4–12 per user, 4 tiers [3rd-party] | – | – |
| Coda → **Superhuman Docs** | – [UNVERIFIED] | "Docs AI" rebuilt | Grammarly renamed itself Superhuman (Oct 2025); **Coda was renamed Superhuman Docs on 2026-07-08** |
| Microsoft Loop / SharePoint | Bundled with M365 / Copilot licences | Copilot Pages stored in OneDrive from mid-Aug 2026; SharePoint repositioned as Copilot's content backbone | Loop's Planner component retired Jan–Feb 2026 |
| Google Sites | [UNVERIFIED — not researched; search budget ran out] | – | – |

### 1c. Docs-as-code

| Product | License | Stars | Latest release | Status / business model |
|---|---|---|---|---|
| Docusaurus | MIT | 66,240 | v3.10.2 (2026-07-10) | 3.10 (Apr 2026) is the last 3.x release; the v4 milestone was ~48% done as of Jun 2026 |
| Material for MkDocs | MIT | 27,426 | 9.7.7 (2026-07-17) | **Maintenance mode since early 2026**; critical fixes promised through ~Nov 2026. Successor is **Zensical** (MIT, 5,696 stars, v0.0.62 released 2026-09-13) |
| Starlight (Astro) | MIT | 9,232 | @astrojs/starlight 0.42.0 (2026-09-02) | Still pre-1.0 |
| Mintlify | Proprietary SaaS | – | – | Starter free (5 editors, MCP server included); Pro $450/mo; Enterprise custom. **$45M Series B at a $500M valuation (Apr 2026, a16z + Salesforce Ventures)**; $67M raised in total |

---

## 2. Per-competitor notes

### Wiki.js (upstream)
- **2.x is in maintenance only.**
  - v2.5.314 (2026-05-01) was mostly a Node 24 / Docker base-image update; the last commit on `main` (2026-09-02) was a README link fix.
  - js.wiki still advertises "Stable 2.5.312".
- **3.0 is stalled.**
  - The `vega` branch's last commit was **2025-11-16**; the one before that was July 2025.
  - The only public pre-release is the 3.0.0-alpha image; the Developer Preview came out Oct 2022 and no beta has followed.
  - NGPixel's stated goal is "feature parity with v2" (issue #6844), with no ETA.
  - Sources: https://github.com/requarks/wiki/discussions/7011 , https://github.com/requarks/wiki/discussions/4652 , https://docs.requarks.io/releases , https://js.wiki/
- **Audience:** homelab and small/medium IT teams wanting Git-backed Markdown, broad authentication options and a Node stack.
- **AI/MCP:** community MCP servers only, all built on the 2.x GraphQL API:
  - https://github.com/heAdz0r/wikijs-mcp-server
  - https://github.com/talosdeus/wiki-js-mcp
- **Strategic note:** about 29k stars' worth of installed users sit on a codebase whose next major version has been stalled for years. They are Cardinal's most natural migration audience, and Cardinal ships a 2.5.x importer. **I found no competitor that publishes a Wiki.js importer.** Docmost only writes SEO pieces aimed at Wiki.js users (https://docmost.com/blog/wikijs-alternatives/).

### Docmost — the closest large open-source competitor
- **Code:** AGPL-3.0 core, TypeScript (NestJS + React), Postgres + Redis. Commercial edition for paying tiers.
- **Pricing:** Community free; **Business $6/seat/mo annual, minimum 10 seats**; Enterprise custom. https://docmost.com/pricing
- **Paid-only features (Business/Enterprise):**
  - SSO (SAML, OIDC, LDAP)
  - MFA/2FA
  - AI search and assistant, including MCP
  - Page-level permissions
  - Confluence importer
  - Search inside PDF/DOCX attachments
  - API keys
- **Enterprise-only on top of that:** SCIM, audit logs + SIEM, page verification/review workflow, read confirmation ("coming soon").
- **AI:** Ask AI in the editor and AI Answers in search; works with OpenAI, Gemini or local Ollama. MCP requires an enterprise license. https://docmost.com/docs/user-guide/mcp
- **Importers:** Notion, Markdown and HTML in the free edition; Confluence on paid tiers only.
- **Community pushback on the paywall:**
  - "2-Step Verification behind a paywall? That's not acceptable for an open-source project" https://github.com/docmost/docmost/discussions/1889
  - Business-model thread https://github.com/docmost/docmost/discussions/958
- **Customer logos shown:** Vilnius City, Bechtle, Australian Government, Red Cross, ÉTS Québec.
- **Funding:** none found in Crunchbase or PitchBook [3rd-party summary]; appears bootstrapped.
- **Growth:** very fast in 2024 through Apr 2025 (OSSInsight shows +6k stars between Jan and Apr 2025), then flattening to roughly +50–150 stars per month in 2026. Still pre-1.0 (v0.96).
- **Audience:** SMB to mid-market IT teams replacing Confluence. Widely described as the "default" self-hosted Confluence alternative in 2026 roundups (e.g. https://contabo.com/blog/best-self-hosted-wiki-tools/).
- **Positioning to watch:** Docmost blogs directly on the Confluence Data Center end of life (https://docmost.com/blog/atlassian-confluence-data-center-eol/).
- **Relevance to Cardinal:** Docmost charges for SSO, 2FA, page permissions, AI/MCP and the Confluence importer. **Cardinal gives away every one of those except a Confluence importer** (Cardinal has none). Docmost has no multi-site, approvals, classification levels, glossary or knowledge graph that I found.

### BookStack
- **Code:** MIT, PHP/Laravel + MySQL.
- **Hosting:** development moved from GitHub to Codeberg with v26.05 (May 2026), so GitHub stars will increasingly understate it. https://www.bookstackapp.com/blog/bookstack-release-v26-05/
- **Cadence:** frequent feature and security releases (29 in 12 months).
- **Maintainer:** one person (Dan Brown), funded by sponsors.
- **AI stance:** the maintainer publicly stepped back from building an LLM query system — "too much variability … blows out the scope of maintenance".
- **MCP:** community servers only, e.g. https://github.com/pnocera/bookstack-mcp-server (59 tools).
- **Importers:** none native beyond Markdown/HTML page import; community tools for Confluence.
- **Weaknesses:** rigid shelves → books → chapters → pages hierarchy.
- **Audience:** homelab, schools, SMB IT. Loved on r/selfhosted.
- **Why it matters:** a solo-maintainer project succeeding for 10+ years is the best available proof that Cardinal's solo-maintainer model can work, if the scope is disciplined.

### Outline
- **License:** BSL 1.1, **not open source**. The Additional Use Grant forbids offering a commercial "Document Service" to third parties. Each version converts to Apache-2.0 four years after release (v1.10.1 → 2030-09-09).
- **Cloud pricing:** Starter $10/mo (1–10 members), Team $79/mo (11–100; adds AI answers, SSO, groups, API), Business $249/mo (101–200; adds audit log). https://www.getoutline.com/pricing
- **Enterprise self-hosted:** separate `outline-enterprise` image needing a license key; price not published [UNVERIFIED].
- **AI/MCP:** **built-in official MCP server in every workspace** (https://www.getoutline.com/changelog/mcp) plus AI Answers.
- **Importers:** Confluence (.doc export), Notion (via a planned CLI; the discussion suggests it's incomplete), and since 2026-08-05 MHTML, EML, PDF and TextPack (https://www.getoutline.com/changelog/confluence-import).
- **Weaknesses:**
  - No built-in email/password login; an external OAuth/OIDC provider is required (https://github.com/outline/outline/issues/1881).
  - Needs S3/MinIO for storage.
  - BSL rules out managed-service providers.
- **Company:** General Outline, Inc.
- **Audience:** polished Notion-like experience for tech-savvy teams.

### XWiki — Europe's public-sector incumbent
- **Code:** LGPL-2.1, Java.
- **Releases:** 17.10.x is the LTS line (17.10.13 on 2026-09-09); 18.x adds features (18.7.0 in Aug 2026); 18.0 requires Java 21.
- **Business model:** XWiki SAS sells support subscriptions, Pro extensions and XWiki Cloud. Confluence Migrator Pro starts at €2,000 and needs a Business/Enterprise subscription (https://store.xwiki.com/xwiki/bin/view/Extension/ConfluenceMigratorPro/). Per-user prices of ~€1.74–2.94 come from Capterra [3rd-party/UNVERIFIED].
- **Confluence replacement:** OpenProject and XWiki formally partnered on 2025-07-02 as an open-source Jira + Confluence stack (https://www.openproject.org/blog/open-source-jira-confluence-alternative/).
- **openDesk:** XWiki is openDesk's "Knowledge" component (openDesk 1.18.2 security update, 2026-09-11) — https://www.opendesk.eu/en/product
- **AI/MCP:** official contrib MCP server extension (beta v0.9: Solr search plus read/edit/create) and an AI-LLM RAG application. https://www.xwiki.org/xwiki/bin/view/documentation/extensions/user/llm/mcp-server/
- **Multi-wiki:** XWiki supports sub-wikis / wiki farms, so it overlaps Cardinal's multi-site pitch.
- **Weaknesses:** heavy Java stack, dated UX, steep learning curve.
- **Audience:** enterprise and public sector, especially in DACH and France.

### DokuWiki / MediaWiki
- **DokuWiki:** flat files, PHP, "Mort" release 2026-07-14; stable and low-growth.
- **MediaWiki:** 1.46 (2026-06-30).
  - Professional Wiki maintains a MediaWiki MCP server that gained Semantic MediaWiki support (Sep 2026): https://github.com/ProfessionalWiki/mediawiki-mcp-server
  - Wikimedia has an official REST MCP server for Wikipedia content (May 2026).
- **Both:** large legacy installed bases. They are sources to migrate *from*, not growth competitors.

### AFFiNE
- **What it is:** a Notion + Miro hybrid (docs, whiteboards, databases).
- **License:** MIT frontend with a separately licensed backend.
- **Momentum:** 72 releases in 12 months; ~+4.6k stars in 12 months (the largest absolute gain in this set).
- **Self-hosting:** free up to 10 seats per workspace, then Team at $10/seat/mo annual [3rd-party: https://instapods.com/apps/affine/vs/notion/ ; official https://docs.affine.pro/self-host-affine/features/team-license returned HTTP 402 to my fetch].
- **AI/MCP:** official MCP endpoint (https://affine.pro/mcp); Notion importer (HTML/Markdown).
- **Funding:** ~$18M across seed rounds (Redpoint, Sinovation); a Series A was mentioned [3rd-party].
- **Audience:** Notion refugees; individuals and small teams. Not an enterprise wiki (limited permissions and governance).

### AppFlowy
- AGPL-3.0, Flutter + Rust, local-first, Notion-style databases.
- Self-hosted multi-user use is licensed; third-party sources say the free tier is 1 seat [UNVERIFIED on the official docs page].
- Strong Notion importer (pages + databases) [3rd-party].
- No official MCP server found.
- ~$6.4M seed funding (2023) [from memory, not re-verified — UNVERIFIED].

### Plane (Pages / Wiki)
- AGPL-3.0 project management tool with a wiki bolted on. Wiki and nested pages are paid-only (Pro / Business); the free cloud plan has no wiki and a 12-user cap. https://plane.so/pricing
- **Publishes Confluence (XML/HTML) and Notion (HTML) importers into its Wiki** — https://docs.plane.so/importers/confluence
- Official MCP server.
- Fast growth: ~+4.2k stars in 12 months.
- Audience: Jira replacement first, wiki second.

### Huly
- EPL-2.0 all-in-one (project management, chat, docs, video).
- Cloud is priced by storage/traffic with unlimited users; self-hosting is free.
- Heavy footprint: CockroachDB, Elasticsearch, Redpanda, MinIO; 8–16 GB RAM (https://github.com/hcengineering/huly-selfhost).
- The wiki is not the core product. Last GitHub release was July 2026; issue tracker still active.

### Nextcloud Collectives
- AGPL-3.0 Nextcloud app. 2026 additions: offline cache, database search, per-collective templates.
- Rides Nextcloud's public-sector footprint (Mecklenburg-Vorpommern is moving SharePoint → Nextcloud: https://www.theregister.com/software/2026/07/08/another-german-state-heads-down-the-open-source-sovereignty-road/5268192).
- Community MCP servers only (https://github.com/cbcoutinho/nextcloud-mcp-server, which covers Collectives).
- A lightweight wiki: no page-rule permissions, approvals or classification.

### Otter Wiki / SilverBullet / TriliumNext / TiddlyWiki / Gollum
- **Otter Wiki:** Python/Flask, Git + Markdown, no database, 33 releases/yr. Minimalist.
- **SilverBullet:** v2 is Lua-scriptable personal knowledge management; 2.6 moved from Deno to Node.js.
- **TriliumNext:** personal hierarchical notes; community MCP.
- **TiddlyWiki:** single-file personal wiki.
- **Gollum:** effectively dormant since Dec 2024.
- **For Cardinal:** none of these competes for team or enterprise buyers; they matter only for mindshare on r/selfhosted.

### La Suite Docs (French/German/Dutch governments) — strategically important
- **What it is:** Django + Next.js + Yjs + BlockNote + HocusPocus. Jointly developed by DINUM (France) and ZenDiS (Germany), with Dutch involvement.
- **Traction:** 16.8k stars; 31 releases in 12 months; v5.6.1 (2026-09-04).
- **Features:** DOCX/Markdown import (since v4.5.0), sub-documents, comments, presenter mode.
- **MCP:** community only (https://github.com/JonasDoebertin/lasuite-docs-mcp).
- **openDesk:** was offered as a beta inside openDesk (openDesk blog, June 2025). openDesk's product page still lists **XWiki as "Knowledge"** and a separate Notes app, so Docs sits beside XWiki rather than replacing it (as of 2026-09).
- **Sources:** https://github.com/suitenumerique/docs , https://www.heise.de/en/news/La-Suite-Docs-4-5-0-Free-collaboration-platform-with-simple-DOCX-import-11159984.html , https://www.opendesk.eu/en/blog/open-source-migration-public-sector
- **Why it matters:**
  - It is the European-sovereignty "Notion/Docs" answer, and it takes up European public-sector attention.
  - It is a document editor, **not** a governed wiki: no page-rule permissions, approvals or classification levels found.
  - It is MIT-licensed and government-funded, so it can't be beaten on price. Compete on governance and wiki depth instead, or integrate with it.

### tela — the newest and closest *architectural* match
- **Launched:** repo created 2026-05-18; 62 stars; v0.8.0.
- **Stack:** Go + PostgreSQL + React/Milkdown, **live Yjs multiplayer, pgvector semantic + full-text search, built-in MCP server (39 tools, scoped to each user's permissions)**, WebDAV two-way Markdown sync.
- **Unique feature:** "Atlas" auto-generates cited wiki pages from Git repos and Jira.
- **License / pricing:** AGPL-3.0 Community; Enterprise adds SSO/SCIM/audit. Cloud Free, $6 Personal, $8/seat Team.
- **Marketing:** comparison pages targeting Wiki.js, MediaWiki, AppFlowy and Nuclino (https://telawiki.com/compare/wikijs/).
- **Gaps (as far as I found):** permissions are simple per-space roles (Owner/Editor/Viewer); no multi-site, approvals, classification or Confluence/Notion/Wiki.js importers mentioned.
- Sources: https://github.com/zcag/tela , https://telawiki.com/
- **Takeaway:** tela shows that "AI-native wiki with MCP + semantic search" is being built independently. That pitch alone won't set Cardinal apart for long; governance and multi-site depth will.

### AI-native "LLM wiki" wave (2026)
- GitHub repos created since 2025 that match "wiki", by stars: TencentDB-Agent-Memory (26.6k), Tencent WeKnora (22.8k), nashsu/llm_wiki (19.3k), deepwiki-open (18k), PandaWiki (10.2k), and many "Karpathy LLM-wiki" projects (Apr 2026).
- **Takeaway:** the attention is shifting toward agent memory and AI-compiled knowledge bases rather than human-edited wikis. A built-in MCP server plus pgvector puts Cardinal on the right side of this shift, but it needs to be marketed as "the governed source of truth your agents read and write", not as another AI wiki.

---

## 3. Market and timing signals

### 3a. Atlassian Data Center end of life — the main time-sensitive opportunity
- **Announced** 2025-09-09 ("Ascend"). Official sources: https://www.atlassian.com/blog/announcements/atlassian-ascend and https://www.atlassian.com/licensing/data-center-end-of-life
- **Timeline:**
  - **2026-03-30:** Data Center no longer sold to new customers (already passed).
  - **2028-03-30:** last chance for existing customers to buy or expand.
  - **2029-03-28:** all Data Center licenses and apps expire; instances become **read-only**.
- **Costs rising at the same time:**
  - Data Center price rise 2026-02-17 (~15%; up to 18–40% for legacy "Advantage" pricing) [3rd-party: https://clonepartner.com/blog/atlassian-data-center-end-of-sale-2026-pricing].
  - Cloud list prices up **7–10% from 2026-10-13** (https://www.adaptavist.com/blog/atlassian-price-updates-effective-october-2026).
- **Scale:** Atlassian says 300k+ customers, 99% with some cloud footprint; cloud revenue +30% year over year [3rd-party].
- **Planning window:** migration guides say enterprise migrations take 18–24 months, so organisations that must stay on-premises (regulated, air-gapped, public sector, defence) have to **pick a target by mid-2027**. **Cardinal needs a credible release plus a Confluence importer before then.**
- **Competitors already targeting this group:**
  - XWiki (Confluence Migrator Pro plus the OpenProject partnership)
  - Docmost (Confluence importer, but paid tiers only; blogs about the end of life)
  - Plane (Confluence importer)
  - Outline (Confluence .doc import)
  - Notion (official Confluence importer)

### 3b. EU digital sovereignty
- **openDesk** (ZenDiS / German Interior Ministry): 1.0 launched Oct 2024; now at 1.18.2 (Sep 2026).
  - Adopters: the International Criminal Court moved off Microsoft to openDesk (2025); BWI (German armed forces IT) signed a 7-year framework agreement in Q2 2025.
  - Its wiki slot is filled by **XWiki**. https://www.opendesk.eu/en/product
- **Schleswig-Holstein:** ~80% of 30,000 state workplaces switched to Linux/open source by end of 2025; >€15M/yr in license savings [3rd-party: https://tuta.com/blog/countries-ditching-microsoft-choosing-linux-digital-sovereignty]. Uses openDesk for backup/emergency workstations rather than as its primary suite.
- **Mecklenburg-Vorpommern (Jul 2026):** ~5,000 staff on Nextcloud/OpenProject now, planning for >50,000; cooperating with Schleswig-Holstein (Register, above).
- **France:** La Suite numérique (Docs, Grist used by 15 ministries, Fichiers, Messagerie).
- **Netherlands:** MijnBureau. The FR/DE/NL stacks are converging on shared components [3rd-party blog].
- **Denmark:** Ministry of Digital Affairs moving from Microsoft to LibreOffice.
- **Takeaways for Cardinal:**
  - Public-sector buyers procure through **integrators and suites** (openDesk, La Suite, MijnBureau) with established vendors (XWiki SAS, OpenProject GmbH, Nextcloud GmbH).
  - A solo, unreleased AGPL project won't win a framework contract directly. The realistic routes are:
    - partnering with a European integrator or hosting company (e.g. Univention, B1 Systems, a Hetzner/IONOS app partner);
    - shipping Keycloak/Nubus-friendly SSO and openDesk-style packaging (Helm, Univention app) — **note Cardinal deleted its Helm chart**;
    - pitching features XWiki handles poorly: modern UX, real-time Yjs editing, classification levels and approvals, which fit public-sector records handling.
- **Not verified (search budget ran out):** the EU Cloud Sovereignty Framework, the Deutschland-Stack, and any 2026 EU procurement preference for open source.

### 3c. Market size (analyst estimates vary widely)
- Knowledge-management software 2026: **USD 15.9–32.6B**, CAGR **13.6–18.5%** depending on the firm (Fortune Business Insights, Straits, Mordor, Grand View, MRFR). Treat as directional only.

---

## 4. Importer matrix (what each competitor publishes)

| Product | Confluence | Notion | MediaWiki | Wiki.js | Notes |
|---|---|---|---|---|---|
| **Cardinal.js** | **No** | No | No | **Yes (2.5.x importer)** | — |
| Docmost | Yes (**paid tiers only**) | Yes (free) | No | No | Also Markdown/HTML |
| Outline | Yes (.doc export) | Partial / CLI planned | No | No | Plus MHTML/EML/PDF/TextPack (Aug 2026) |
| XWiki | Yes (free community migrator + Pro from €2k) | [UNVERIFIED] | Yes (MediaWiki import extension — UNVERIFIED this cycle) | No | — |
| BookStack | Community tools only | No | No | No | Markdown/HTML |
| Plane | Yes (XML/HTML) | Yes (HTML) | No | No | Into Plane Wiki |
| AFFiNE | No | Yes (HTML/Markdown) | No | No | — |
| AppFlowy | No | Yes (strongest: pages + databases) [3rd-party] | No | No | — |
| La Suite Docs | No | No | No | No | DOCX/Markdown |
| Notion (SaaS) | Yes (official) | — | No | No | — |
| Confluence Cloud | — | Yes (official) | No | No | — |
| tela | No | No | No | No | Pulls from Git/Jira via Atlas |

**Key finding:** nobody ships a Wiki.js importer. The Wiki.js 2.x base (29k stars, 3.0 stalled) is **uncontested**. Confluence importers are table stakes for the Data Center end-of-life group, and Cardinal lacks one.

---

## 5. MCP server matrix

| Product | Official / built-in MCP | Community MCP |
|---|---|---|
| **Cardinal.js** | **Yes, in-process, free** | — |
| Confluence (Cloud) | **Yes — Atlassian Rovo MCP server, GA** (https://www.atlassian.com/blog/announcements/atlassian-rovo-mcp-ga) | aashari/mcp-server-atlassian-confluence (also covers Data Center) |
| Notion | **Yes, hosted** (https://github.com/makenotion/notion-mcp-server) | many |
| GitBook | **Yes** — auto-generated per published site, plus an authoring MCP | — |
| Mintlify | **Yes** — included on every plan, including free | — |
| Outline | **Yes, built into every workspace** | mmmeff, Vortiago |
| Docmost | **Yes, paid tiers only** | MrMartiniMo, others |
| AFFiNE | **Yes (official endpoint)** | DAWNCR0W |
| Plane | **Yes (official)** | — |
| XWiki | **Yes (contrib extension, beta 0.9)** | vitos73, others |
| tela | **Yes, built-in (39 tools)** | — |
| MediaWiki | Wikimedia REST MCP (Wikipedia only) | ProfessionalWiki (with Semantic MediaWiki support) |
| Wiki.js | No | heAdz0r, talosdeus (GraphQL, 2.x) |
| BookStack | No | pnocera (59 tools), oculairmedia, others |
| Nextcloud Collectives | No (Nextcloud has a Context Agent for its Assistant) | cbcoutinho/nextcloud-mcp-server, bambutz |
| La Suite Docs | No | JonasDoebertin/lasuite-docs-mcp |
| TriliumNext | No | pwelty/mcp-trilium |
| AppFlowy | None found | None found |

**Key finding:** by September 2026, a built-in MCP server is **table stakes** among funded or commercial players (Atlassian, Notion, GitBook, Mintlify, Outline, AFFiNE, Plane, tela). It is only a differentiator against *free, open-source, self-hosted* options. Among those, Cardinal's pitch holds up: Docmost charges for MCP, Outline isn't open source, and Wiki.js, BookStack, Nextcloud and La Suite Docs rely on community servers.

---

## 6. How Cardinal's claimed differentiators compare

| Cardinal differentiator | Who else has it (self-hosted, free) | Assessment |
|---|---|---|
| Hostname-routed multi-site | XWiki (sub-wikis/farms), MediaWiki (farms), Wiki.js 3.0 alpha only | **Strong**; rare in modern tools |
| Real-time Yjs collaboration | Docmost, Outline, AFFiNE, AppFlowy, La Suite Docs, tela | Table stakes |
| pgvector semantic search | tela; Docmost AI search (paid); Outline AI answers (paid cloud / BSL) | Moderate; converging |
| Built-in MCP (free) | tela (AGPL); Outline (BSL); AFFiNE | Moderate |
| Page-rule permissions + delegated per-site admin | XWiki (fine-grained rights); Docmost page permissions (paid) | **Strong** |
| Approval workflows | Docmost page verification (Enterprise only); XWiki (extensions) | **Strong** |
| Classification levels | None found among open-source wikis | **Strong**; public-sector / defence angle |
| Glossary, knowledge graph | None found as built-ins | Nice-to-have |
| 7 storage backends incl. Git sync | Wiki.js 2.x (Git); Otter Wiki / Gollum (Git only) | **Strong** for docs-as-code-adjacent teams |
| Free SSO (OIDC/SAML/LDAP) + passkeys/2FA | BookStack (SAML/OIDC/LDAP free); Wiki.js 2.x; Docmost charges; Outline requires external SSO | **Strong vs Docmost** |
| Prometheus metrics | Few | Ops-friendly |
| RTL / i18n | BookStack, XWiki, MediaWiki good | Parity |
| Lit web-component blocks | None comparable | Unique but niche |
| **Gaps** | No release; solo maintainer; no hosted offering; no databases; **no Confluence or Notion importer**; Helm chart deleted | Must close before mid-2027 for the Data Center end-of-life window |

---

## 7. Could not verify / not researched (search budget exhausted)
- Google Sites 2026 changes; Nuclino/Tettra/Guru official pricing pages (third-party figures used above); Slab corporate status beyond its pricing page.
- Notion's current Business price (the official page and third-party sources disagree; see 1b).
- AppFlowy's self-hosted seat terms on the official docs (third-party says the free tier is 1 seat); AppFlowy funding.
- AFFiNE's official self-hosted team license page (returned HTTP 402 to my fetch).
- Outline's Enterprise self-hosted price.
- Docmost EE code license terms (the docs say only "commercially licensed").
- XWiki per-user pricing (Capterra only); whether XWiki has a Notion importer; whether its MediaWiki importer is current.
- EU-level procurement policy (Cloud Sovereignty Framework, Deutschland-Stack) and any 2026 openDesk move from XWiki to Docs (the product page as of 2026-09-11 still lists XWiki).
- Any 2026 statement from NGPixel on Wiki.js 3.0 (the conclusion that 3.0 is stalled rests on branch activity plus the 2024 discussion).
- Exact star growth for Huly, Otter Wiki and Zensical (not in OSSInsight); OSSInsight absolute counts run below GitHub's.

## 8. Source URLs (main)
- Atlassian end of life: https://www.atlassian.com/blog/announcements/atlassian-ascend · https://www.atlassian.com/licensing/data-center-end-of-life · https://endoflife.date/confluence · https://www.theregister.com/2025/09/09/atlassian_will_go_cloudonly_customers/
- Atlassian pricing: https://www.adaptavist.com/blog/atlassian-price-updates-effective-october-2026 · https://www.usecarly.com/blog/confluence-pricing/ · https://clonepartner.com/blog/atlassian-data-center-end-of-sale-2026-pricing
- Rovo MCP: https://www.atlassian.com/blog/announcements/atlassian-rovo-mcp-ga
- Wiki.js: https://github.com/requarks/wiki/discussions/7011 · https://docs.requarks.io/releases · https://js.wiki/
- Docmost: https://docmost.com/pricing · https://docmost.com/docs/editions · https://docmost.com/docs/user-guide/mcp · https://github.com/docmost/docmost/discussions/1889 · https://github.com/docmost/docmost/discussions/958
- Outline: https://www.getoutline.com/pricing · https://www.getoutline.com/changelog/mcp · https://www.getoutline.com/changelog/confluence-import · https://github.com/outline/outline/issues/1881 · LICENSE via `gh api`
- BookStack: https://www.bookstackapp.com/blog/bookstack-release-v26-05/ · https://github.com/pnocera/bookstack-mcp-server
- XWiki / openDesk: https://www.opendesk.eu/en/product · https://www.opendesk.eu/en/blog/open-source-migration-public-sector · https://xwiki.com/en/Blog/XWiki-joins-OpenDesk/ · https://www.openproject.org/blog/open-source-jira-confluence-alternative/ · https://store.xwiki.com/xwiki/bin/view/Extension/ConfluenceMigratorPro/ · https://www.xwiki.org/xwiki/bin/view/documentation/extensions/user/llm/mcp-server/ · https://www.xwiki.org/xwiki/bin/view/Download/
- La Suite Docs: https://github.com/suitenumerique/docs · https://www.heise.de/en/news/La-Suite-Docs-4-5-0-Free-collaboration-platform-with-simple-DOCX-import-11159984.html · https://gigazine.net/gsc_news/en/20260209-lasuite-french-open-source-project/
- Sovereignty: https://www.theregister.com/software/2026/07/08/another-german-state-heads-down-the-open-source-sovereignty-road/5268192 · https://www.openproject.org/blog/digital-sovereignty-government-germany-opendesk/ · https://cybernews.com/tech/icc-replacing-microsoft-workplace-software-opendesk/ · https://interoperable-europe.ec.europa.eu/collection/open-source-observatory-osor/news/schleswig-holsteins-open-source-strategy-year
- tela: https://github.com/zcag/tela · https://telawiki.com/ · https://telawiki.com/compare/wikijs/
- AFFiNE / AppFlowy / Plane / Huly: https://affine.pro/mcp · https://instapods.com/apps/affine/vs/notion/ · https://appflowy.com/pricing · https://plane.so/pricing · https://docs.plane.so/importers/confluence · https://docs.plane.so/importers/notion · https://github.com/hcengineering/huly-selfhost · https://www.therundown.ai/tools/huly
- Notion: https://www.notion.com/pricing · https://github.com/makenotion/notion-mcp-server · https://www.getpricepulse.com/blog/why-notion-raised-prices-2026-full-story.html
- GitBook: https://www.gitbook.com/pricing · https://gitbook.com/docs/ai-for-your-readers/mcp-servers-for-published-docs
- Mintlify: https://www.mintlify.com/pricing · https://www.mintlify.com/blog/series-b
- Slab / others: https://slab.com/pricing/ · https://costbench.com/software/knowledge-management/nuclino/ · https://www.docsie.io/vs/document360-vs-guru/
- Superhuman Docs: https://blog.superhuman.com/introducing-superhuman-docs/ · https://help.superhuman.com/hc/en-us/articles/46210093285773-What-s-changing-Coda-becomes-Superhuman-Docs
- Microsoft: https://techcommunity.microsoft.com/blog/spblog/whats-new-in-copilot-in-sharepoint-august-2026/4535421 · https://handsontek.net/whats-new-for-copilot-april-2026/
- Docs-as-code: https://github.com/facebook/docusaurus/issues/11719 · https://github.com/renovatebot/renovate/discussions/39232 · https://docsio.co/blog/mkdocs-material
- MediaWiki MCP: https://github.com/ProfessionalWiki/mediawiki-mcp-server · Nextcloud MCP: https://github.com/cbcoutinho/nextcloud-mcp-server
- Market size: https://www.fortunebusinessinsights.com/knowledge-management-software-market-110376 · https://www.mordorintelligence.com/industry-reports/knowledge-management-software-market
- Star history: https://api.ossinsight.io/v1/repos/{owner}/{repo}/stargazers/history/?per=month
