# GTM 02 — The Campaign Against Wiki.js

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md). Evidence:
[`gtm-research/research-wikijs.md`](gtm-research/research-wikijs.md) (every figure and quote there has a
URL).

You asked for a war with no prisoners. Here is the version that wins.

---

## 1. Know the enemy's centre of gravity

Clausewitz's useful idea: attack the thing the opponent's strength actually rests on. Wiki.js's
strength is **not its code** (you have the same code, and upstream can take yours). It rests on:

1. **The name people search for** and the 29k-star repo that ranks.
2. **A massive installed base with inertia** (146M+ container pulls, packaged everywhere).
3. **Goodwill toward a sympathetic solo maintainer** who gave the world a free wiki for years.
4. **The promise of 3.0** — now credible again, because betas are shipping.

Its **critical vulnerabilities** — the things that, if exploited, move users:

| Vulnerability | Evidence | Exploitable how |
|---|---|---|
| **No 2.x → 3.x path** | 3.x docs: "Coming soon"; no importer in upstream tree; 2022 export-tool promise unshipped | You already have one. Make it the best in existence |
| **Stranded non-Postgres DBs** | 2.x docs: MySQL/MariaDB/MSSQL/SQLite "will NOT be supported in the next major version"; #7741 "Was migration from sqlite to postgres abandoned?" | Finish the bundle connector; publish the guide |
| **Wanted features locked behind 3.x** | Paste images (81), approvals (54), collapsible nav (38) "Added in V3" | "Get the 3.x features today, with your content" |
| **Aging 2.x dependencies** | Apollo 2, Vue 2.6, webpack 4, deprecated `passport-saml`, #7756 SAML bypass thread | Factual, neutral security-currency comparison — *not* FUD |
| **No support, no hosting, no SLA** | Requarks sells nothing; README "no support provided" | A throat to choke, for money |
| **Closed issue tracker, backlog** | Non-maintainer issues "deleted without warning"; 138 open PRs; ~33% help answered; "wrote @NGPixel several times a mail, but get no response" | Public tracker, published response targets |
| **Bus factor of one** | 1,875 vs 14 contributions; "Yes I'm the only one working on it" | Don't say it — *show* a contributor ladder and continuity plan. (You are also bus-factor one; see §5) |
| **"Beta, not for production"** | Every 3.x release body | Cardinal must genuinely be production-ready at launch, or this is not a weapon |
| **Dropped 2.x modules in 3.x** | 21 → 8 auth, 11 → 7 storage, 9 → 0 external search, 13 → 0 logging, no WYSIWYG/AsciiDoc | "Keep your LDAP/Keycloak/Okta/Elasticsearch setup" (only where true and verified) |
| **GraphQL removal** | Every 2.x API script breaks on 3.x (upstream *and* Cardinal) | A 2.x-API compatibility shim is an optional, unique offer (§4.4) |

## 2. What would make attacking Wiki.js backfire

| Landmine | Why it explodes | Rule |
|---|---|---|
| "Wiki.js 3 is dead / never shipping" | False since August; the first HN comment will link the beta releases | **Never say it.** Not even implied |
| Criticising NGPixel personally ("slow", "unresponsive", the "ponytail" read) | The community is warm toward them; they have day-job and burnout sympathy; you become the villain | Critique **capabilities and gaps**, never the person, never pace-as-character |
| "Fork of Wiki.js" as your identity | Invites "why not contribute upstream?" and "he told you to fork, and 3.0 is in beta" | Lead with what Cardinal *is*; mention lineage factually in the About/FAQ |
| Vibe-coding exposure | NGPixel, Feb 2026: *"vibe coding software is a recipe for disaster … a buggy, insecure, unmaintainable mess."* Your commit log carries 497 Claude co-author trailers | Disclose first; lead with verification gates and an external security review (doc 09 P2) |
| Implying endorsement or using their brand | Trademark/passing-off risk; community reads it as squatting | Word "Wiki.js" only for factual compatibility. Never the logo, never "Wiki.js 3", "Community Edition", "Wiki.js Plus" |
| Poaching in their house | r/wikijs, GitHub Discussions, their Discord are upstream's venues | No promotion there. Answer genuine help questions as a person, disclose affiliation, and only link Cardinal when someone explicitly asks for a migration path |
| Claiming features upstream now has | Multi-site, approvals, collab, audit log, metrics are all in upstream beta | Maintain a dated, factual "Cardinal vs Wiki.js 3.x beta" matrix; update it every upstream release |
| Security FUD about 2.x | 2.x supports Node 22/24 and patches criticals; overstating reads as dishonest | Cite advisories verbatim, recommend 2.5.314 first, link to the upstream advisory |

**The standard to hold yourself to:** anything you publish about Wiki.js should be something NGPixel
could read and say "that's accurate," even if they wouldn't enjoy it.

**Provenance check, closed out (2026-09-13):** worth having settled in your own head before it ever
comes up publicly. There is no credible evidence NGPixel is drawing on Cardinal's work, original or
reworked, and no basis for the reverse claim either. The one thing that looked like it at first —
near-identical text between the two `CLAUDE.md` files — resolves cleanly by date: his was added in
commit `ee7a15fb` (2026-07-25), three weeks before Cardinal's own divergence began (2026-08-16), so
Cardinal's is the derivative. A search of his 129 recent commits for anything distinctive to
Cardinal's build (MCP, semantic search, "Cobalt," staged glossary editing, delegated per-site admin)
turned up one loose match — a fully inert `AdminMcp.vue` placeholder, no backend, dated 2026-08-29 —
which reads as him reserving space for an industry-standard protocol, not evidence of copying. If
this ever surfaces as an accusation in either direction, the honest answer is "convergent design from
a shared ancestor, verifiable by commit date" — not a claim either side should have to walk back.

---

## 3. War aims, in order

1. **Own the 2.x → modern migration.** Be the answer to "how do I get off Wiki.js 2.x" — for
   *every* 2.x database — before upstream ships its own tool.
2. **Be the production-ready 3.x-generation wiki** while upstream is "beta, not for production" —
   which means Cardinal must earn "production-ready" honestly (doc 04 gates).
3. **Own the adjacent space upstream won't go:** governance (classification, delegation, approvals
   depth), agents (MCP + semantic search under page rules), enterprise search engines, editor breadth.
4. **Out-support and out-listen:** public issues, fast answers, paid support, visible roadmap.
5. **Convert upstream's distribution:** every channel that lists Wiki.js should also list Cardinal
   (DigitalOcean, Cloudron, YunoHost, TrueNAS, Unraid, Elestio, PikaPods, Stellar Hosted, Hostwiki).

---

## 4. The campaign plan

### 4.1 Phase A — "Bring your wiki" (now → launch)

**Objective:** a 2.x admin on any database can go from dry-run to cutover in an afternoon, with a
report that tells them exactly what moved and what didn't.

- Finish `ExportBundleSourceConnector` (users, groups, settings, assets, comments).
- Close the silent losses or make them loud: preserve asset/comment timestamps; carry comment threading;
  for 2FA and API tokens (which cannot be carried safely), generate a per-user re-enrolment notice and an
  admin checklist rather than silently dropping them.
- A **public migration test corpus**: 2.x databases of varying size on each engine, run in CI, with
  published results. Only publish numbers you measured.
- A `migrate --dry-run` report good enough to screenshot: page counts, auth modules mapped/unmapped,
  storage targets mapped, what the admin must do by hand.
- **Design partners:** 5–10 real 2.x installs migrated free, white-glove, in exchange for feedback and
  (optional) a public case study. Doc 06 has the recruitment plan.

### 4.2 Phase B — "The honest comparison" (launch)

- `cardinal.wiki/compare/wikijs-2` — for 2.x users: what you gain, what changes (GraphQL → REST, Node
  26/Postgres 16+ requirement), what doesn't carry over, how long a migration takes.
- `cardinal.wiki/compare/wikijs-3` — a dated matrix against the latest upstream beta, re-verified each
  upstream release. Include rows where upstream wins (Helm chart, audit-log maturity, whatever is true).
  Rows you lose on are what make readers trust the rows you win on.
- `cardinal.wiki/migrate/wikijs` — the migration hub; the page every help-thread answer points to.
- FAQ entry, verbatim-grade: *"Is Cardinal Wiki.js 3?"* — No. Cardinal began as a fork of Wiki.js's
  3.x branch in August 2026 and is developed independently. Wiki.js 3 is developed by its original author
  and is currently in beta. Both are AGPL-3.0. Cardinal is not affiliated with or endorsed by Requarks.

### 4.3 Phase C — "Upstream's distribution, our listing" (launch → +6 months)

- Submit Cardinal to every catalog that carries Wiki.js (doc 05 §4 lists requirements).
- Approach the two third-party Wiki.js hosts (Stellar Hosted, Hostwiki) and Elestio/PikaPods as
  **partners**: they have customers who will ask for 3.x-generation features and a migration.
- A standalone **Wiki.js 2.x export tool** (§4.4) listed on its own — useful to anyone leaving 2.x,
  including people going to BookStack or Docmost. Counter-intuitive, and it's the point: goodwill, search
  traffic, and Cardinal as the native, zero-conversion destination.

### 4.4 Special weapons (optional, choose deliberately)

| Weapon | What | Why it works | Cost / risk |
|---|---|---|---|
| **Open 2.x export format + CLI** | Dumps any 2.x DB (all five engines) to a documented Markdown+JSON bundle; Cardinal imports it natively; anyone else can too | Solves the problem upstream promised in 2022, for everyone; makes Cardinal the reference implementation | Must be written cleanly by you (or licensed AGPL like the rest) — check provenance before choosing a permissive license; maintenance of 4 DB drivers *outside* the core repo (keeps `docs/migration/decision-source-scope.md` intact) |
| **2.x GraphQL compatibility shim** | Separate sidecar/proxy translating the most-used 2.x GraphQL operations (`pages.single/create/update`, `search`) onto Cardinal REST | Every 2.x automation script keeps working; neither upstream nor anyone else offers this | A real maintenance surface; keep it out of core (CLAUDE.md: GraphQL removed) — ideal as a **paid migration add-on / contract item** |
| **Wiki.js 3.x beta importer** | Import from an upstream 3.x beta database | Shared schema ancestry makes it cheap; captures beta testers who hit "no upgrade path" | Small audience; schemas diverge daily; only do it if it's genuinely cheap |
| **Upstream-tracking cadence** | Weekly review of upstream `scarlett`; port security fixes and good small features with attribution | Keeps Cardinal ≥ upstream on the shared surface; "we credit upstream" earns trust | Divergence grows; set a time box (1h/week) |
| **Offer the importer upstream** | Publicly tell NGPixel they're welcome to merge Cardinal's importer | Moral high ground; "Cardinal's importer now powers Wiki.js" is a win either way | Surrenders the wedge — only after the governance/support moats are real (Phase 4+) |

**Not weapons (do not do):** scanning public Wiki.js instances for vulnerabilities; cold-emailing
Wiki.js users en masse; buying ads on "Wiki.js" as a keyword with copy implying affiliation; creating
accounts to seed "is Wiki.js dead?" threads; star campaigns; publishing NGPixel's quotes out of context.

### 4.5 Phase D — Adjacent superiority (continuous)

Build where upstream is not going: classification + approvals as a records-management story; delegated
per-site admin for MSPs/universities; agents under page rules; external search engines for enterprises
already running Elasticsearch; WYSIWYG for non-technical editors; importers for Confluence, MediaWiki,
DokuWiki, BookStack, Notion.

---

## 5. The mirror: Cardinal's own vulnerabilities, as upstream's advocates will see them

| Their attack | Truth today | Preparation |
|---|---|---|
| "One guy and an AI, vs the original author" | True. You're bus-factor one too | Public continuity plan (keys escrow, successor note, org-owned repo), contributor ladder, a second maintainer by Phase 3 |
| "Vibe-coded; NGPixel warned you" | 497 of 731 fork commits carry a Claude trailer | AI_POLICY, external security review, published gates, advisories handled impeccably (doc 09 P2) |
| "They took NGPixel's work and rebranded it" | AGPL-compliant in substance but branding residue remains (FUNDING→Requarks, SECURITY→requarks.io, repo description says Wiki.js) | Finish `docs/legal/07-recommended-actions.md` before anything public |
| "Parasitic fork — why not contribute upstream?" | Upstream issues are closed to outsiders; NGPixel said forking is fine | One calm FAQ answer; never argue it in threads |
| "Your importer drops 2FA and timestamps" | True today | Fix or make loud (§4.1) before launch |
| "Cardinal will die when he gets bored" | Unknown | Cadence evidence, sustainability model (doc 08), public roadmap |

---

## 6. Scenarios and branch plans

| Scenario | Signals | Likelihood (judgment) | Response |
|---|---|---|---|
| **S1. Upstream stays in beta through mid-2027** | "No ETA"; parity checklist incomplete | **Re-rated 2026-09-13: Low.** This was the assumed base case before the release-cadence check (doc 00 §1: 6 real tagged prereleases in 2 weeks, 10/13 of his own "3.0" milestone closed). Plan as if it does *not* hold — this scenario now requires the pace to break, which it has done before (16 months dormant pre-July), but isn't the case to build the launch date around | If it happens anyway, nothing changes — Cardinal still launches 2026-11-10 regardless |
| **S2. Upstream ships 3.0 GA without a 2.x importer** | GA release; upgrade page still "Coming soon" | **Re-rated: Medium-High, plausibly within ~2–4 months of 2026-09-13** if the current pace holds. His own milestone shows no importer work item at all — this is the more likely near-term scenario, not S3 | Migration becomes *more* valuable (more people want 3.x-generation now). Update compare page same day; congratulate upstream publicly and sincerely |
| **S3. Upstream ships a 2.x importer** | Commits under an importer/migration path | Medium-low near-term (no visible work started as of 2026-09-13); rising over 12 months | Wedge narrows. Pivot headline to governance + agents + support + non-Postgres coverage; make yours measurably better (fidelity report, all 5 DBs, GraphQL shim) |
| **S4. Upstream merges Cardinal features (MCP, semantic search, classification)** | AGPL cherry-picks with attribution | Low-medium | Treat as validation. Publicly thank them. Moats were never the code (war room §2) |
| **S5. NGPixel publicly criticises Cardinal** | Discussion post, Bluesky, HN comment | Medium around launch | Doc 09 P3: acknowledge, agree where right, correct facts once, no pile-on, never reply twice |
| **S6. Trademark objection from Requarks** | Email/C&D | Low (no published policy; you've renamed) | Doc 09 P3: comply fast on anything reasonable (wording, logo remnants); counsel for anything else |
| **S7. Upstream gains maintainers / funding** | New committers, sponsor surge | Low | Competition gets stronger; lean harder on services and governance |
| **S8. Upstream goes quiet again** | Commit rate falls back to 2025 levels | Medium over 12–24 months | Still never say "dead"; let the release dates speak |

---

## 7. Metrics that tell you whether you're winning this war

- Completed 2.x migrations (self-reported + support) — the only number that really matters.
- Dry-run reports generated (opt-in "share anonymised report" counter, or support requests).
- Share of Cardinal instances whose first content came from a 2.x import (update-check ping, disclosed).
- Search rank for: "wiki.js migrate", "wiki.js 3 upgrade", "wiki.js mysql postgres", "wiki.js alternative".
- Catalog parity: number of channels listing Wiki.js that also list Cardinal.
- Inbound from upstream venues (people arriving via links others posted — not links you posted).
