# Upstream Wiki.js — competitive intelligence (as of 2026-09-13)

Scope: github.com/requarks/wiki, js.wiki / beta.js.wiki / docs.js.wiki, maintainer Nicolas Giard (NGPixel), Requarks.
Method: GitHub REST + GraphQL (authenticated `gh`), a blobless clone of upstream (`git rev-list` counts are exact
as of the clone, taken 2026-09-13), WebFetch of project pages, limited WebSearch (budget exhausted mid-research —
see "Unverified" at the end). Numbers are quoted as returned; nothing is estimated unless marked.

---

## 0. The headline finding (changes the strategic premise)

**Upstream 3.0 is no longer vapourware. It is shipping public prereleases at a near-daily cadence right now.**

- 2026-08-12 — NGPixel on issue #6844: *"A stable alpha v3 version is now available."* … *"upgrading from a v2 database is
  **NOT** supported (to be added later). This is strictly for testing."* … *"**Do NOT report bugs, missing features or
  buttons that don't work.**"* Listed as done: Approvals/Suggest Edits, Dynamic Blocks, File Manager, High-Availability,
  Icon Sets, Live Multi-User Collaboration, Multi-site, Navigation Editor, Redirects, SPA navigation, Table Editor,
  Theming, Webhooks. Listed as not working: no WYSIWYG, very limited auth, no mail/notifications.
  https://github.com/requarks/wiki/issues/6844
- GitHub releases (https://api.github.com/repos/requarks/wiki/releases): `3.0.0-alpha.530` (2026-08-30), then betas
  `3.0.0-beta.537` (09-02), `.543` (09-06), `.550` (09-07), `.554` (09-08), `.561` (09-12). All marked prerelease,
  body: *"3.x Beta Release - Not for production use"*.
- GHCR already has `3.0.0-beta.562`…`3.0.0-beta.566` published within the last ~24h of 2026-09-13
  (https://github.com/requarks/wiki/pkgs/container/wiki).
- Scarlett README: *"This is a beta version of the upcoming 3.0 release. **DO NOT USE IN PRODUCTION!**"* / *"There's no
  upgrade path to or from this version."* / *"There's no support provided."*
- Since the Cardinal fork point (d0c5a8bfa, 2026-08-14) upstream `scarlett` gained **57 commits, all by NGPixel**
  (git clone). Since then he has shipped (commit subjects, Sep 2–13): Entra/LDAP/SAML auth + group mapping, Discord auth,
  auth debugging, audit log, admin metrics + Prometheus endpoint, draw.io block, user public profiles, folder/asset ops,
  print view, view-version-by-id, passkey settings, sitemap.xml/robots.txt, prerendering for unauthenticated requests,
  theme CSS override + head/body injection, tags page, steps block, purge-empty-folders utility, analytics modules,
  comments modules + built-in "talk" feature. Upstream is closing its own feature-parity gaps fast.
- Scarlett commit volume by month (git): 2026-03: 9, 04: 1, 06: 1, **07: 17, 08: 79, 09 (to 13th): 33**. 2024 total 15,
  2025 total 5 (`vega`, the previous 3.x branch, got 0 commits in 2026). Scarlett was restarted as a new architecture:
  first commits `dc25db11 2026-01-25 refactor: fastify + drizzle exploration`, `fe38f4c7 2026-03-01 refactor: migrate
  from graphql to rest for frontend`, and `ee7a15fb 2026-07-25 refactor: migrate backend to Typescript + other
  modernization` (which also added `CLAUDE.md`).
- Beta site: https://beta.js.wiki — *"Wiki.js 3.0 · Now in beta"*, *"Free forever, AGPL licensed"*, PostgreSQL 16+,
  Docker / Kubernetes (Helm) / bare metal.
- docs.js.wiki/setup/requirements (3.x): *"Node.js 26"* only (*"Earlier versions of Node.js are NOT compatible."*),
  PostgreSQL 18/17/16 with `ltree` + `pg_trgm`. No other DBs.
- docs.js.wiki/setup/upgrade (3.x): "Upgrade from 2.x to 3.x" and non-PostgreSQL upgrades are marked **"Coming soon"**.
- Official 3.0 GA ETA: none. Most recent direct statements: 2026-05-20 (#7996) *"When it's ready. No ETA."*;
  2026-08-12 (#6844, above). The parity checklist says *"The plan is to stay in beta until all v2 features have been
  implemented in v3."*

Implication: "Wiki.js 3.0 will never ship" is no longer a true or safe message. The open, exploitable gap is now the
**2.x → 3.x migration** (especially from MySQL/MariaDB/MSSQL/SQLite), **production readiness/support**, and
**governance/bus factor**, not the absence of a 3.x.

Architecture note: upstream scarlett and Cardinal share the same base (Fastify + Drizzle + PostgreSQL, Vue 3/Vite/Tailwind,
Lit blocks, TypeScript 7, Node 26, REST). Upstream's `CLAUDE.md` opens with the same text Cardinal's does
("Next-generation open source wiki. This is the **3.x development branch** …"). Upstream will keep shipping features
into the same shape of codebase; cherry-picking remains technically plausible but diverges daily.

---

## 1. Current numbers

| Metric | Value | Source |
|---|---|---|
| Stars | 28,918 | https://api.github.com/repos/requarks/wiki |
| Forks | 3,317 | same |
| Watchers (subscribers) | 321 | same |
| `open_issues_count` (issues + PRs) | 182 → **44 open issues + 138 open PRs** | GraphQL |
| Closed issues | 2,435 | GraphQL |
| Discussions total | **3,899**; 983 answered | GraphQL |
| 2.x Help/Questions discussions | 2,019, of which 671 answered (~33%) | GraphQL, all 3,899 paginated |
| 2.x Error/Bug Report discussions | 1,640 | same |
| Discussions created per year | 2019: 46, 2020: 421, **2021: 868**, 2022: 803, 2023: 780, 2024: 519, 2025: 336, 2026 (to Sep 13): 126 | same |
| Contributors | ≥100 (API page 1 full; exact total not retrieved). NGPixel 1,875 contributions; #2 regevbr 14 | https://api.github.com/repos/requarks/wiki/contributors |
| Latest 2.x | **v2.5.314, 2026-05-01** ("update arm docker base to node 24") | releases API |
| 2.x releases 2025–26 | 2.5.306 (2025-02-02), .307 (03-24), .308 (08-13), .309 (2026-01-03), .310 (01-06), .311 (01-08), .312 (02-12), .313 (04-27, security), .314 (05-01) | releases API |
| `main` (2.x) commits | 2024: 29, 2025: 23, 2026: 32. Last: 2026-09-02 README link fix by external contributor; last NGPixel commit 2026-05-01 | git clone |
| `main` authors since 2025-01-01 | NGPixel/Nicolas Giard 36; 17 other people with 1–3 commits each | git clone |
| Docker Hub `requarks/wiki` pulls | **116,183,367** (372 stars) | https://hub.docker.com/v2/repositories/requarks/wiki/ |
| GHCR `ghcr.io/requarks/wiki` downloads | 30.5M | https://github.com/requarks/wiki/pkgs/container/wiki |
| js.wiki homepage claims | "100M+ downloads", "28100+ GitHub stars"; still shows 2.5.312 as current | https://js.wiki/ |
| Discord (invite rcxt9QS2jd) | ~874 members, ~119 online | Discord invite API |
| r/wikijs subscribers | not retrieved (reddit blocked for fetch) | — |
| Comparators (stars, 2026-09-13) | outline/outline 40,529; docmost/docmost 21,669; BookStackApp/BookStack 19,038 | GitHub search API |

Branches: `main` (2.x), `scarlett` (3.x current), `vega` (abandoned 3.x attempt; last commit 2025-11-16), `feat-toc`.

---

## 2. 3.0 timeline history

| Date | Event | Source |
|---|---|---|
| 2021 | 3.0 announced (per community recollection in #7011; announcement post not located) | https://github.com/requarks/wiki/discussions/7011 |
| 2021-11-01 | Discussion #4652 "wiki.js v3 actual release date is?" (17 upvotes, still re-asked in Feb 2026) | https://github.com/requarks/wiki/discussions/4652 |
| 2022-01/02 | Feature previews (GitHub setup, storage delivery paths) | https://beta.js.wiki/blog/ |
| 2022-05-01 | "The Road to the Wiki.js 3.0 Beta": no ETA (*"An update will be posted on this site once it's ready."*); reason for phasing: *"Trying to get all new UX components ready all at once simply proved too large of a scope."*; PostgreSQL-only (11+ at that time); *"You won't be able to upgrade from a 2.x installation yet. This will come later in the beta."*; PostgreSQL users would be auto-migrated; MySQL/MariaDB/MSSQL/SQLite users would get an export utility producing *"a tarball of pages, assets, comments, users, etc."* | https://beta.js.wiki/blog/2022-the-road-to-the-wiki-js-3-beta/ |
| 2022-09-09 | September 2022 update post | blog index |
| 2022-10-30 | Developer Preview: *"A beta will be available in the coming weeks / months"*; *"VERY BUGGY and VERY INCOMPLETE"*, *"NO SECURITY"*, *"You CANNOT UPGRADE to or from it!"* | https://beta.js.wiki/blog/2022-wiki-js-3-developer-preview/ |
| 2023-01 → 2023-10-12 | Five "Feature Preview" posts (file manager, markdown editor, nav/search, blocks, passkeys). **Last blog post: 2023-10-12.** | blog index |
| 2023-11-23 | Issue #6844 "v3 Feature Parity Checklist" opened | #6844 |
| 2024-01-08 | NGPixel: alpha.334 is latest; *"It will transition into beta releases once remaining permission issues are fixed."* | #6844 |
| 2024-02-21 | #7011 "Will wikijs 3.0 see the ligth?"; NGPixel (2024-03-16/22) rebuts "constantly adding features", points to parity list | #7011 |
| 2024-06-14 | NGPixel: *"No this project isn't dead, I just didn't have time to work on it in the past months."* … *"Yes I'm the only one working on it."* … *"I'm quite opiniated when it comes to how a feature should work and look."* … *"**no I don't have an ETA** so don't ask for one."* | #6844 |
| 2024-11-14 | *"Yes it's still maintained. … No ETA on v3. Development is slow but still ongoing."* | https://github.com/requarks/wiki/discussions/7435 |
| 2025-01-24 | *"Sorry, no ETA."* | #4652 |
| 2025-03-21 | *"Yes but development is very slow. It'll be released when it's ready. No ETA."* | https://github.com/requarks/wiki/discussions/7580 |
| 2025-04-23 | *"No but development is slow. I hope to put some time into it soon."* | https://github.com/requarks/wiki/discussions/7609 |
| 2025-06-11 | *"Yes but development is slow. No ETA."* | https://github.com/requarks/wiki/discussions/7669 |
| 2025-08-26 | *"Still under development, just very slow. No ETA."* | https://github.com/requarks/wiki/discussions/7752 |
| 2025-11-16 | Last `vega` commit | git |
| 2026-01-25 | Scarlett rewrite begins (Fastify + Drizzle) | git |
| 2026-02-20 | NGPixel on funding/forking (see §5) | https://github.com/requarks/wiki/discussions/7779 |
| 2026-05-20 | *"When it's ready. No ETA."* | https://github.com/requarks/wiki/discussions/7996 |
| 2026-07-25 | Scarlett backend → TypeScript; CLAUDE.md added | git |
| 2026-08-12 | "Stable alpha" announced on #6844; also points #8045 asker to it | #6844, https://github.com/requarks/wiki/discussions/8045 |
| 2026-08-19 | Confirms AI use (Claude) in 3.x development, links FAQ | https://github.com/requarks/wiki/discussions/8070 |
| 2026-08-30 | First GitHub prerelease 3.0.0-alpha.530 (24 reactions) | releases |
| 2026-09-02 → 09-12 | Five 3.0.0-beta GitHub releases; GHCR at beta.566 by 09-13 | releases, GHCR |

Parity checklist state (#6844, as fetched): Implemented — admin dashboard/general/locale/theme, groups, users, storage,
API access, extensions, mail, security, system info, updates, utilities, flags, assets, authentication, markdown editor
(toolbar, links, images, code, tables, tabsets, draw.io, preview, scroll sync), navigation (breadcrumbs, browse, custom),
pages (create/duplicate/move/delete/history/source/tags/TOC/properties/locale/print/SEO), search, profile; partial —
rendering, search autocomplete. **Not implemented — analytics, comments, WYSIWYG editor, AsciiDoc editor, page
templates, convert page** (analytics + comments commits landed 2026-09-13, after this list was likely last edited).
**Deprecated in v3 — navigation editor (old), pages file manager (old), tags management, SSL (built-in Let's Encrypt),
GraphQL, Raw HTML editor, spellcheck, page author display.** Also 3rd-party search engines listed as deprecated
(NGPixel 2024-01-08). Confirmed in git: upstream scarlett `backend/modules/search/` is empty (Postgres built-in only).

---

## 3. 2.x technical debt affecting operators

### Runtime
- 2.x docs (`requarks/wiki-docs-v2/install/requirements.md`): supported **Node.js 24** and **Node.js 22** *"(since
  v2.5.302)"*; `package.json` engines `"node": ">=20"`. Docker images moved to `node:24-alpine` on 2026-01-03 (`4eb9dabb`)
  and ARM to Node 24 in 2.5.314. So **Node EOL is not currently a strong attack line against 2.x** — upstream kept up.
- 3.x requires Node 26 only.

### Databases (important for a migration offer)
- 2.x supports PostgreSQL 9.5+, MySQL 8.0+ (5.7.8 partial), MariaDB 10.2.7+, MS SQL Server 2012+, SQLite 3.9+
  (`server/core/db.js` still has all five client branches).
- 2.x docs, verbatim: *"**These engines (MySQL, MariaDB, MS SQL Server and SQLite) will NOT be supported in the next major
  version of Wiki.js**. … An export + import tool will be made available at / shortly after release."*
  *"SQLite is **not recommended** for production deployments."*
- 3.x: PostgreSQL 16–18 only; upgrade from 2.x "Coming soon"; no 2.x importer exists anywhere in upstream scarlett's tree
  (git tree grep: only Drizzle migrations `20260809235619_init`, `20260906032152_scarlett`, `20260913073518_comments`).
- Community evidence of stranded users: #7741 (2025-08-13) *"Was migration from sqlite to postgres abandoned? Is a
  users-only migration feasible?"* — no maintainer reply retrieved; #7618 (2025-04-26) "3.0.0-alpha is unable to migrate
  from 2.5.307"; #7106 SQLite connection errors; #7301 MSSQL ETIMEOUT; #7501 MySQL access-denied; #3594 MSSQL unicode.
  The 2022 plan ("automatically migrated" for Postgres, tarball export for others) has not shipped as of 2026-09-13.
- Size of the MySQL/SQLite/MSSQL segment: **not measurable from public data** (no telemetry published).

### Dependencies pinned on `main` (2.x) — `package.json` as of 2026-09-13
Legacy/EOL or long-deprecated: `apollo-server`/`apollo-server-express` 2.25.2 (Apollo Server 2 EOL), `graphql` 15.3.0,
`graphql-tools` 7.0.0, `subscriptions-transport-ws` 0.9.18 (deprecated), `apollo-client` 2.6.10 + `apollo-link-*` 1.x +
`vue-apollo` 3.0.5, `vue` 2.6.14 (Vue 2 EOL 2023-12-31), `vuetify` 2.3.15, `webpack` 4.44.2, `knex` 0.21.7, `objection`
2.2.18, `request` 2.88.2 (deprecated), `aws-sdk` 2.1693.0 (v2, maintenance-mode/EOL), `passport` 0.4.1,
**`passport-saml` 3.2.4 (deprecated package)**, `mongodb` 3.6.5, `markdown-it` 11.0.1, `highlight.js` 10.3.1, `katex`
0.12.0, `chart.js` 2.9.4, `moment`, `core-js` 3.6.5, `eslint` 7.12.0, `bcryptjs-then` 1.0.1. Last `package.json` change on
main: 2026-01-03.
Community-filed dependency-vulnerability threads: #7982 (2026-04-14) bundled Vue 2.6.14 CVE-2024-9506; #7756 (2025-08-21)
SAML auth bypass via deprecated `passport-saml` (GHSA-4mxg-3p6v-xgq3) — follow-up 2026-01-17: *"vulnerable version of
library is still used"*, community PR #7899 opened; #7739 DOMPurify CVE-2024-47875 (2025-08-12); #7615 "Please update the
following deps to close vulnerabilities"; #7267 mysql2; #7733, #7698, #7689 generic vulnerability reports.
Third-party proof the debt is real: **swissmakers/wikijs-ng** (Swissmakers GmbH, "a hardened, actively maintained fork of
Wiki.js 2.x") removed `request`, `aws-sdk` v2, `subscriptions-transport-ws`, legacy XML crypto and moved to Webpack 5,
Vue 2.7/Vuetify 2.7, Apollo Server 5, GraphQL 16, Knex 3, AWS SDK v3, Node 24. https://github.com/swissmakers/wikijs-ng
(3 stars, last push 2026-08-30).

### CVEs / advisories
GitHub advisories on requarks/wiki (https://api.github.com/repos/requarks/wiki/security-advisories):

| GHSA | CVE | Summary | Sev | Published | Fixed |
|---|---|---|---|---|---|
| GHSA-cq3g-mwrg-v2rv | CVE-2026-44224 | Privilege escalation via missing group validation in `users.update` (manage:users → Administrators; impact incl. OS-level command execution per advisory) | Critical | 2026-04-28 | 2.5.313 |
| GHSA-vwww-c5vg-xgfc | CVE-2024-45298 | Disabled user bypasses lockout via password reset | High | 2024-09-18 | 2.5.304 |
| GHSA-xjcj-p2qv-q3rf | CVE-2024-34710 | Stored XSS via client-side template injection | High | 2024-05-19 | 2.5.303 |
| GHSA-3cv9-795v-6j7j | CVE-2022-23654 | Improper write access check via arbitrary page path | Medium | 2022-02-21 | 2.5.276 |
| GHSA-rhpf-929m-7fm2 | CVE-2021-43856 | Stored XSS, non-image uploads inline | Medium | 2021-12-26 | 2.5.264 |
| GHSA-4893-pj5w-3hq9 | CVE-2021-43855 | Stored XSS, SVG fake MIME | Medium | 2021-12-26 | 2.5.264 |
| GHSA-3qv4-gp35-rgh7 | CVE-2021-43842 | Stored XSS, SVG upload | Medium | 2021-12-18 | 2.5.258 |
| GHSA-r363-73gj-6j25 | CVE-2021-43800 | Asset dir traversal (Windows) | High | 2021-12-04 | 2.5.245 |
| GHSA-6xx4-m8gx-826r | CVE-2021-21383 | Stored XSS, mustache in code blocks | Medium | 2021-03-13 | 2.5.190 |
| GHSA-pgjv-84m7-62q7 | CVE-2020-15274 | Stored XSS, search result title | Medium | 2020-10-25 | 2.5.162 |
| GHSA-whpv-5xg2-w527 | CVE-2020-15236 | Asset dir traversal | High | 2020-10-03 | 2.5.151 |
| GHSA-9jgg-4xj2-vjjj | CVE-2020-4052 | Stored XSS, template injection | Medium | 2020-06-14 | 2.4.107 |
| GHSA-vj72-c9vq-qxrv | CVE-2020-11051 | Stored XSS, markdown editor | Medium | 2020-05-01 | 2.3.81 |

Not a GitHub advisory: **CVE-2025-56643** (MITRE, published 2025-11-18, CVSS 3.1 9.1 CRITICAL, CWE-613) — 2.5.307 JWTs
not revoked on logout; only reference is a third-party repo (https://github.com/0xBS0D27/CVE-2025-56643). No vendor
acknowledgement or fix found; treat as third-party-reported (this class of CVE is sometimes disputed — dispute status not
verified). https://cveawg.mitre.org/api/cve/CVE-2025-56643
Discussion #7951 (2026-03-08) "Follow-up on previously reported security issue (GitHub Security Advisory)" suggests at
least one private report sat unanswered for a while (content not retrieved).

### Long-standing unfixed bugs / requests (open or unresolved)
- Issue #1874 "Sync groups and group membership through auth strategies" — open since 2020-05-13 (30 reactions).
- Issue #1201 "Markdown links always server absolute" — open since 2019-11-08.
- Discussion #7412 (2024-10-25) "Moving/Renaming pages break all links to that page"; Canny "Moving a page should update
  links" 34 votes, Planned.
- Git storage zombie processes: #3631 (2020), #7683 (2025-06-20, 15 upvotes), #7893 SSH storage zombies (2026-01-12).
- #6216 "API with group permission does not work" (13 upvotes, 17 comments); #8048 API token "Full Access" can't be
  disabled (2026-07-21); #8087 `pages.update` ignores isPrivate (2026-09-08).
- #7077 / #6440 Max upload size / max files per upload settings don't work.
- #3760 / #6524 restoring a page version erases custom scripts/styles.
- #7243 Mermaid plugin too old; #7316 `sidebar.root` shown in menu; #5327 full site tree; #4891 hide sidebar/TOC.
- #6894 Group mapping with OAuth2/OIDC Entra groups claim; #7232 generic OIDC not requesting `groups` scope; #6384 PKCE.
- Issue tracker closed to the public: pinned #6044 — *"Use the Discussions section instead"*; issues by non-maintainers
  *"will be deleted without warning"*. Community-cited: *"113 PRs waiting to go"* (#7779, 2025-12-17); now 138 open PRs.

---

## 4. Most-requested features / pain points

### GitHub discussions by upvotes (all 3,899 scanned)
26 #5614 Implementing an approval workflow · 17 #4652 v3 release date · 16 #5456 Paste images in editor · 16 #5295 Site
tree broken in 2.5.282 · 15 #7683 git creates processes not closed · 14 #4891 hide sidebar/TOC · 14 #5301 · 14 #5327 full
site tree · 13 #6216 API group permission · 13 #7316 · 13 #5213 Keycloak 18 logout · 12 #4470 login redirect w/ multiple
languages · 12 #4954 3.0 GitLab setup · 12 #7011 will 3.0 see the light · 12 #6384 PKCE · 11 #5461 S3 existing bucket ·
**11 #7779 "pay for v3"** · 11 #5292 hide private pages by tag · 11 #5113 extract-files install error · 11 #7243 Mermaid too
old · 10 #6894 Entra group mapping.
"Is it dead?" threads: #7324 (2024-08), #7435 (2024-11), #7580, #7609, #7669, #7752 (2025), #8045 (2026-07), #7996 (2026-05).

### Issues by reactions
#1874 group sync (30, open), #6844 v3 parity (12, open), #1459 video in view mode (99 comments), #1201 absolute links
(open), #2945 SSL cert expiry mismatch (open), #1525 LDAP bind credentials input type (open).

### Feedback board (requarks.canny.io, sort=top; feedback.js.wiki now ProductBridge)
Ability to paste images into MD editor — 81, Added in V3 · Notifications / Email on select events — 59, Planned · Page
Approval Function — 54, Added in V3 · Collapsible navigation — 38, Added in V3 · Moving a page should update links — 34,
Planned · Favicon — 34, Added in V3 · Templates / Transclusion / Infoboxes — 33, In Progress · Export Pages to PDF — 24,
Planned · Autosave draft — 17, Planned · Better markdown tables — 11, Planned.
From search snippets (not re-verified): "Mobile App/IOS Compatibility" 132 votes; "Tag users in native comments" 87,
Planned; "Automatically generate a sitemap" 17. https://requarks.canny.io/wiki?sort=top , https://feedback.js.wiki/wiki
Note: many top requests are "Added in V3" — i.e. only available to users who move to 3.x, which has no upgrade path yet.

### Recurring complaints & where people went
- Docmost's "Top 5 Wiki.js Alternatives" (2025-07-12): *"WikiJS v3 has been in development since 2021 … no beta has
  been released to date"*; *"2.x is essentially in maintenance mode with no new features"*; UI bugs; *"limited content
  collaboration"*. https://docmost.com/blog/wikijs-alternatives/ (competitor marketing — biased, and now outdated on
  "no beta").
- LeafWiki (Go wiki) blog 2026-06-16, user "Sergio": *"I've been using Wiki.js up until some months ago but it was too
  much effort to manage assets, sidebar tree, links…"* https://leafwiki.com/blog/a-beer-a-go-binary-and-a-wiki/ ; HN
  https://news.ycombinator.com/item?id=48647712 (3 points). #8045 commenter: *"it seems unlikely and now there are other
  options like LeafWiki"*.
- Search snippets: a company moved Wiki.js → BookStack citing limitations and stalled development; Superbase moved Wiki.js →
  BookStack preferring PHP over Node server cost (https://dev.to/superbaseltd/overhauling-our-documentation-1l21 —
  not opened directly).
- Named destinations in the material found: BookStack, Docmost, Outline, LeafWiki. Reddit r/selfhosted threads could not
  be retrieved (reddit blocks fetch; search budget exhausted) — **Reddit sentiment unverified**.
- HN: largest thread is "Wiki.js" 2020-07-21, 381 points / 199 comments (item 23904193), broadly positive. No large
  "Wiki.js is dead" HN thread found.

---

## 5. Community & governance

- **Solo maintainer.** NGPixel = 1,875 contributions vs 14 for #2; all 57 post-fork scarlett commits and effectively all
  3.x commits are his. *"Yes I'm the only one working on it."* (2024-06-14). Profile: Montreal, Canada; *"IETF Senior
  Software Developer and Maintainer of open-source project Wiki.js"*; 706 followers. https://github.com/NGPixel
- **Day job, not seeking to go full-time** (2026-02-20, #7779, verbatim):
  > *"I already have a full time job that I enjoy. I'm not looking for Wiki.js to become it. It's simply not sustainable
  > and not a comfortable way of life to depend on donations. If you donate, it's because you enjoy Wiki.js and it's a
  > way to give thanks."*
  > *"If the development pace is too slow for your liking, this is open source. **Fork the project and add the features
  > you need to it. As long as you follow the AGPL license terms, you don't need my approval.**"*
  > *"No offense to the AI fans here, but it's been shown over and over again that "vibe coding" software is a recipe for
  > disaster and ultimately leads to a buggy, insecure, unmaintainable mess. … If you don't understand what is being
  > generated and can't vouch for every single line of code it produces, you'll eventually hit a wall of epic
  > proportions."*
  Note the GitHub Sponsors page still says his objective is to *"quit my job and work on open source full time"* — stale
  vs the 2026-02 statement.
- **AI stance on his own 3.x**: FAQ — *"Yes. Claude by Anthropic was used as a coding assistant. However, it was always
  used in a very directed manner for specific features."* PRs with AI code accepted only if *"a human must have reviewed
  the entirety of the proposed code and is fully responsible for it."* https://docs.js.wiki/admin/faq
- **Responsiveness complaints**: #7779 — *"wrote @NGPixel several times a mail, but get no response"*; *"does no good if
  the author doesn't even respond to these threads"*; suggestions to "bless some other developers" (no evidence it happened).
  Community member ajmas in the same thread: a fork should *"at the very least … try to get his blessing"* — i.e. some of
  the community values his approval even though he says it's not needed.
- **Channels**: GitHub Discussions (issues locked to maintainers), Discord (~874 members), Bluesky @js.wiki, Telegram
  @wiki_js, r/wikijs, X @requarks. Blog silent 2023-10-12 → present; release notes + #6844 comments are the de-facto
  announcement channel.
- **Funding** (all small):
  - GitHub Sponsors: 19 sponsors, goal $6,000/month, **4%** toward goal (≈$240/mo implied; exact amount not shown).
    https://github.com/sponsors/NGPixel
  - Open Collective: total raised $23,310.24; balance $15,957.78; estimated annual budget $4,789; disbursed $7,352.46;
    240 contributors; recent $25/mo sponsors include JBO Vietnam/Thailand and an Italian online-casino site (SEO-backlink
    sponsors). Top contributor Compliance DS $3,500 since 2020. https://opencollective.com/wikijs
  - Patreon (patreon.com/requarks), PayPal, Ethereum: amounts not retrievable.
  - README Gold sponsor: Trans-Zero; GitHub sponsors include Stellar Hosted, HostWiki, GigabiteLabs, Acceleanation.
  - In-kind (beta.js.wiki/backers): BrowserStack, Cloudflare, Crowdin, Icons8, Porkbun, ProductBridge. 335 backers & sponsors.
- **Prior forks and how they fared**: of 3,317 forks, the most-starred have ≤6 stars. Notable: swissmakers/wikijs-ng
  (hardened 2.x fork by a Swiss company, 3 stars, active Aug 2026). No fork has gained meaningful traction to date.
  Community in #7779 floated a team fork (2026-02) but nothing organised surfaced. Hosted-Wiki.js startups: Miki (Show HN
  2021), Hostwiki (Show HN 2021, still operating).
- **Trademark**: **UNVERIFIED.** USPTO/EUIPO/trademarkia/uspto.report fetches were blocked (403) and search budget ran
  out; no evidence of a registration was found in the searches that did run, but absence of evidence is not evidence of
  absence. No written trademark/brand policy found on js.wiki, requarks.io or the repo. requarks.io discloses no legal
  entity or jurisdiction. Recommend a direct USPTO TESS / CIPO (Canada) / EUIPO eSearch lookup before relying on this.
  Regardless of registration, common-law/unregistered rights and passing-off rules still make using "Wiki.js" in a
  competing product's name or branding risky.

---

## 6. Commercial footprint

- Requarks does **not** sell hosting or support. requarks.io lists only open source projects (Wiki.js, connect-loki,
  express-brute-loki). beta.js.wiki: *"Free forever, AGPL licensed"*, no pricing. 3.x README: *"There's no support
  provided."*
- Official DigitalOcean Marketplace 1-Click (*"made by the developers of Wiki.js"*),
  https://marketplace.digitalocean.com/apps/wiki-js (packer scripts still maintained on main, Feb 2026).
- Third-party managed hosting (a potential partner/target channel): Stellar Hosted (EU, GDPR, 14-day trial, also a GitHub
  sponsor) https://www.stellarhosted.com/wikijs/ ; Hostwiki https://hostwiki.io/ ; Elestio (from $11/mo)
  https://elest.io/open-source/wikijs ; PikaPods lists Wiki.js (also BookStack, Docmost; not Outline).
- Publicly listed enterprise users: none found. Wikipedia has no notable-users section; #6584 "A lot of examples to inspire
  your own wiki.js" is a community showcase (not opened). tom-sherman/atproto-wiki (AT Protocol community wiki) is a
  Wiki.js fork. Large deployments: **unverified**.

---

## 7. Integration ecosystem a 2.x migrator will expect (from `main:server/modules`)

- **Authentication (21)**: auth0, azure, cas, discord, dropbox, facebook, firebase, github, gitlab, google, keycloak, ldap,
  local, microsoft, oauth2, oidc, okta, rocketchat, saml, slack, twitch.
- **Storage (11)**: azure, box, digitalocean, disk, dropbox, gdrive, **git** (two-way sync is a signature feature),
  onedrive, s3, s3generic, sftp.
- **Search (9)**: algolia, aws (CloudSearch), azure, db (basic), elasticsearch (6/7/8 clients bundled), manticore, postgres,
  solr, sphinx.
- **Rendering (29)**: asciidoc, asciinema, blockquotes, code highlighting, diagrams, image prefetch, media players, mermaid,
  security/sanitize, tabsets, twemoji, markdown abbr/emoji/expandtabs/footnotes/imsize/katex/kroki/mathjax/multi-table/
  pivot-table/plantuml/supsub/tasklists, openapi.
- **Editors (7)**: api, asciidoc, ckeditor (WYSIWYG-ish visual editor), code, markdown, redirect, wysiwyg.
- **Analytics (17)**: azureinsights, baidutongji, countly, elasticapm, fathom, fullstory, google, gtm, hotjar, matomo,
  newrelic, plausible, statcounter, umami, umami2, yandex.
- **Comments (4)**: artalk, commento, default (built-in), disqus.
- **Logging (13)**: airbrake, bugsnag, disk, eventlog, loggly, logstash, newrelic, papertrail, raygun, rollbar, sentry,
  syslog.
- APIs: GraphQL API + API keys (heavily used by scripts/integrations; 3.x deprecates GraphQL → REST — a breaking change
  for every 2.x API consumer, upstream and Cardinal alike).
- Built-in Let's Encrypt/SSL (deprecated in v3).

Upstream 3.x module inventory today (`scarlett:backend/modules`): auth — discord, entra, github, google, ldap, local, oidc,
saml (8); storage — azure, db, disk, gcs, git, s3, sftp (7); search — none (Postgres built-in); analytics — 12; comments —
artalk, comentario, discourse, disqus, giscus, hyvortalk, isso, remark42, waline (9); extensions — git, pandoc, puppeteer,
sharp. Dropped vs 2.x: auth0, cas, dropbox/facebook/firebase/gitlab/keycloak/microsoft/oauth2/okta/rocketchat/slack/twitch
as dedicated modules (some may be covered by generic OIDC), storage box/dropbox/gdrive/onedrive/s3generic/digitalocean,
all external search engines, all logging modules, AsciiDoc/CKEditor/WYSIWYG editors.

Packaging / one-click:
- Helm: `main:dev/helm/Chart.yaml` version `3.0.0`, appVersion `'2'` (the 2.x chart is confusingly versioned "3.0.0";
  #7938/#7939 report breakage "after upgrading to the v3 helm chart"); scarlett has its own chart (version 2.2.0) and a
  helm workflow.
- Docker Hub `requarks/wiki` (tags 2, 2.5, latest; amd64/arm64/arm/v7) + GHCR.
- DigitalOcean Marketplace (official), Cloudron (https://www.cloudron.io/store/org.wikijs.cloudronapp.html), YunoHost
  (`2.5.314~ynh1`, https://apps.yunohost.org/app/wikijs), TrueNAS Apps Market (https://apps.truenas.com/catalog/wiki-js/),
  Unraid Community Apps (linuxserver.io image), Elestio, PikaPods, Stellar Hosted, Hostwiki. linuxserver.io maintains a
  `wikijs` image.

---

## Unverified / not retrieved
- Trademark registration status of "Wiki.js"/"Requarks" (registries blocked; see §5).
- Reddit r/selfhosted / r/wikijs thread contents and subscriber count (reddit blocked).
- Patreon patron count/earnings; exact GitHub Sponsors $/month.
- Exact contributor total (>100).
- Enterprise/large deployment names.
- Whether CVE-2025-56643 is disputed or fixed.
- Canny "Mobile app" 132 votes / "Tag users" 87 votes (search snippets only).
- Original 2021 3.0 announcement post date/URL.
