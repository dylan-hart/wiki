# GTM 06 — Migration & Onboarding

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md). Tooling facts from
`docs/migration/migration-runbook.md`, `docs/migration/decision-source-scope.md`, `backend/migration/`
(read 2026-09-13).

Migration is not a feature here; it is **the acquisition channel**. Onboarding is what stops the
acquired user from leaving.

---

## 1. The funnel

```
 Discover ──► Evaluate ──► Try ──► Dry-run ──► Migrate ──► Succeed (30d) ──► Advocate / Pay
   │            │           │         │           │              │                 │
 search,     compare     compose   report      runbook,      first-week       case study,
 thread,     pages,      up in     shows what  verify,       checklist,       badge, support
 video       demo        <10 min   moves       cutover       health check     subscription
```

| Stage | Conversion killer | Countermeasure | Metric |
|---|---|---|---|
| Discover | They search "Wiki.js 3 upgrade" and find only upstream's "Coming soon" | Migration hub + per-engine guides ranking for those queries | Organic visits to migration hub |
| Evaluate | "Is this Wiki.js 3?", "Is it safe?", "Is it maintained?" | FAQ, security page, release cadence, compare pages | Demo sessions → install clicks |
| Try | Install friction (Node 26, Postgres 16+, pgvector, cookie-secure on HTTP) | One compose file; HTTP-local mode that just works; ARM images | Update-check first pings |
| Dry-run | Fear of breaking production | Read-only source connection, no writes, human-readable report | Dry-runs run (opt-in counter) |
| Migrate | Silent losses, one-shot import, truncate-and-restart on failure | Loud report, verify step, rehearsal on a copy, concierge help | Verified cutovers |
| Succeed | Missing 2.x habits (GraphQL scripts, 2FA gone, links, editors) | First-week checklist, re-enrolment emails, redirects, shim option | 30-day retention (instance still pinging) |
| Advocate | Nobody asks | Case-study invite, optional badge, support offer | Case studies, referrals |

---

## 2. Migration tooling: state and required work

### 2.1 What exists (verified)

- `tasks/migrate.ts` + `tasks/verify-migration.ts`, phases `settings → users → content → assets`, with
  `--dry-run`, a recorder and a report module.
- **Postgres-direct connector**: every entity implemented (users, groups, pages, history, tags, navigation,
  settings/auth/storage, comments, assets).
- **Export-bundle connector** (the only route for MySQL, MariaDB, MSSQL, SQLite): pages, history, tags and
  navigation only; users, groups, settings, comments and assets throw `NotYetImplementedError`.
- One-shot semantics: no idempotent re-run; on failure, truncate the destination and restart.
- Documented losses (`docs/decisions/`, `community-take.md`): 2FA enrolment, API tokens,
  Slack/Discord notification config, comment reply threading; asset and comment timestamps rewritten to
  "now".

### 2.2 Required before launch (gates C3–C5 in doc 04)

| # | Work | Why | Priority |
|---|---|---|---|
| M1 | Complete the bundle connector's five entities | MySQL/SQLite/MSSQL users are the most stranded and least served; without this, the "any 2.x wiki" pitch is false | **P0** |
| M2 | Preserve original timestamps for assets and comments | "History rewritten to today" is an instant trust break | **P0** |
| M3 | Carry comment reply threading | Visible loss on every commented page | P1 |
| M4 | 2FA → re-enrolment flow: flag migrated users who had 2FA, force enrolment on first login, email notice template | Silently demoting 2FA accounts is a security regression reviewers will call out | **P0** |
| M5 | API tokens → admin report listing every 2.x token (name, scopes, last use) and a regeneration guide; GraphQL → REST mapping table for common operations | Every 2.x automation breaks; tell them exactly what to change | P1 |
| M6 | Dry-run report as a clean HTML/Markdown artifact: counts per entity, auth/storage modules mapped/unmapped with reasons, manual steps checklist, estimated duration | This is the "aha" screenshot | **P0** |
| M7 | Resumability: per-phase checkpoints or at least a clean-destination pre-flight check with a clear error | A failed 4-hour import that must restart from zero loses the user | P1 |
| M8 | Link integrity: rewrite internal links, keep old paths as redirects, report broken links | "Moving/renaming pages breaks links" is a top 2.x complaint | P1 |
| M9 | Test corpus: synthetic + volunteer-donated anonymised 2.x DBs for all five engines, small/medium/large, in CI | Evidence for the results page; regression safety | **P0** |
| M10 | Rehearsal mode docs: clone production DB → migrate into staging → verify → cut over | Admins need a no-risk rehearsal story | **P0** (docs) |
| M11 | Performance numbers measured on the corpus (pages/min, asset GB/min) | Planning and credibility; publish only measured numbers | P1 |

### 2.3 Later importers (roadmap, by segment value)

| Importer | Segment | Target | Notes |
|---|---|---|---|
| **Confluence** (space export XML/HTML) | S5 — DC refugees | Beta **2027-06-30** | Table stakes vs XWiki/Docmost/Plane/Outline; permissions + attachments + page tree are the hard parts |
| **Wiki.js 3.x beta** | Beta testers with "no upgrade path" | Only if cheap | Shared schema ancestry |
| **MediaWiki** (XML dump) | Legacy intranets | 2027 | Wikitext → Markdown conversion quality is the work |
| **DokuWiki** | Legacy/homelab | 2027 | Flat files — simple and SEO-friendly |
| **BookStack** (API/export) | Rare switchers | Opportunistic | Don't market aggressively (goodwill) |
| **Notion** (export zip) | Small teams | 2027 | Databases won't map; be explicit |
| **Markdown folder / Git repo** | Docs-as-code teams | Pre-launch if nearly free | Git storage sync may already cover much of this |
| **2.x GraphQL shim** | 2.x automation users | Paid add-on / contract | Keep out of core |

---

## 3. Design-partner program (pre-launch → Phase 3)

**Goal:** 5–10 real Wiki.js 2.x installations migrated, spanning at least Postgres and one of
MySQL/SQLite, before launch; 20 by +90 days.

**Offer:** a free, assisted migration (remote screen-share or async), priority fixes for anything that
blocks them, direct maintainer contact for 90 days, optional public case study, first refusal on paid
support at a founder rate.

**Ask:** a rehearsal on a copy of their data; a 30-minute feedback call; honest bug reports; permission
to use anonymised stats; (optional) name + quote.

**Recruitment (ethical):**
- Your own network, colleagues, local meetups.
- People who publicly asked about migration/stranded DBs (upstream #7741, #7618 etc.) — reply once,
  in a venue that allows it, disclosing who you are. Not in upstream's issue tracker/discussions as promotion.
- r/selfhosted / r/sysadmin "looking for design partners" post (verify sub rules).
- Third-party Wiki.js hosts (Stellar Hosted, Hostwiki) who may have customers asking for 3.x features.

**Intake form fields:** DB engine + version; 2.x version; page count; asset volume; auth modules in use;
storage modules (git sync?); API/GraphQL automations; multi-language?; compliance constraints; timeline.

**Data handling:** they run the importer on their infrastructure. You never take custody of their data
unless a signed agreement covers it (and then an LLC + insurance should exist — doc 08).

---

## 4. The migration hub (content spec)

`/migrate/wikijs`:
1. **Can I migrate?** — a matrix: 2.x version × DB engine × supported/partial/not yet.
2. **What moves / what doesn't** — generated from the same mapping docs the importer uses; no marketing
   gloss.
3. **Rehearse safely** — copy DB, run dry-run, read report, run verify.
4. **Step-by-step** — Postgres-direct; export-bundle per engine (with 2.x's own "Export to disk" screenshots).
5. **After migration** — 2FA re-enrolment, API tokens and REST equivalents, git storage re-link, search
   engine re-index, redirects, SSO callback URLs.
6. **Get help** — community discussion category; paid assisted migration (doc 08).
7. **Stories** — case studies.

Per-engine pages ("Wiki.js 2 on MySQL → Cardinal", "… SQLite", "… MSSQL", "… MariaDB") are the SEO
long tail; each must be a complete, stand-alone guide.

---

## 5. Onboarding: first hour, first day, first month

### 5.1 First hour (fresh install, no migration)
- `docker compose up` → browser → **setup wizard**: admin account (forced strong password), site name,
  hostname, mail (skippable), "Start empty / Load sample content / Migrate from Wiki.js 2.x".
- Sample content that *teaches*: a "Welcome" space demonstrating page rules, approvals, a classified page,
  a glossary term, a diagram block, and the MCP page.
- A dismissible admin checklist: set up backups, configure SSO, enable HTTPS/cookie-secure, create groups,
  review security settings, subscribe to security advisories (release RSS / GitHub watch).

### 5.2 First day (post-migration)
- Post-migration banner for admins linking the generated report and manual-steps checklist.
- Automatic health check page: storage reachable, search indexed, mail sending, pgvector available (and
  what degrades without it), update-check status, backup last-run.
- User-facing: re-enrolment prompts; "what's new vs Wiki.js 2.x" tour for editors (paste images,
  approvals, WYSIWYG).

### 5.3 First month
- Opt-in admin newsletter: release notes, security advisories, one tip per issue.
- Day-30 in-app prompt (dismissible, once): "How is it going? Share feedback / become a case study / see
  support options."

### 5.4 Friction audit (do this literally)
Watch 3 people who have never seen Cardinal install and migrate, without helping. Write down every
hesitation. Fix the top 5. Repeat before launch. (The cookie-secure-on-plain-HTTP trap and the
Node 26/Postgres 16+ requirement are already known hazards.)

---

## 6. Support model for migrators

| Tier | Channel | Promise |
|---|---|---|
| Community | GitHub Discussions "Migration help" category, public | Best effort; maintainer triages within N business days (publish N) |
| Design partners | Direct channel, 90 days | 1 business day |
| Assisted migration (paid) | Scheduled calls + async | Fixed scope, fixed price (doc 08 §3) |
| Support subscription | Private help desk | Business-day response targets |

**Rule:** every private answer that isn't customer-confidential becomes a docs page or a public
discussion within a week. Support compounds into documentation.

---

## 7. Migration incident protocol (summary; full playbook doc 09 P9)

If a migration loses or corrupts someone's data: stop and help first (their source DB is untouched by
design — confirm that immediately); reproduce on a copy; ship a fix + regression test in the corpus;
publish a short advisory if others could be affected; add the case to the dry-run report so it's
detected before import next time.
