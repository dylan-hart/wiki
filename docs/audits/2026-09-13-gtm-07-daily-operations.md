# GTM 07 — Daily Operations & Community: Running a Popular OSS Project on a Day-Job Budget

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md).

You've never run a popular OSS project. This is the operating manual: what actually happens when people
show up, how to structure your time, how to grow a community without it eating you.

---

## 1. What changes when a project gets popular

| Before | After |
|---|---|
| You decide what to build | Users decide what's urgent; you decide what's *important* |
| Bugs are found by your tests | Bugs are found in environments you've never seen (NAS boxes, ARM, air-gapped, weird reverse proxies, old Postgres) |
| Silence is fine | Silence reads as abandonment within ~2 weeks |
| Every issue is interesting | 60–80% of issues are support questions, duplicates, or config problems |
| Security is a checklist | Security reports arrive, some real, many AI-generated junk; embargoes and CVEs become your job |
| Your roadmap is private | People plan their organisations around what you say |
| Criticism is hypothetical | Some people will be rude, entitled, or hostile, publicly, with your name in it |

The single most important operational skill is **saying no kindly and quickly**.

---

## 2. Time budget profiles

Pick one (D12). Plan to it. Revisit monthly.

| Activity | 8 h/week ("steady") | 15 h/week ("growing") | 25 h/week ("sprint", not sustainable alongside a job) |
|---|---|---|---|
| Triage (issues, discussions, security inbox) | 2.5 | 4 | 5 |
| Reviewing agent work / PRs / releases | 2 | 4 | 7 |
| Community (answers, contributor mentoring) | 1.5 | 2.5 | 4 |
| Content / marketing | 1 | 2 | 3 |
| Services / customers | 0 | 1.5 | 4 |
| Admin (money, legal, partners) | 1 | 1 | 2 |

**At 8 h/week:** release monthly, no paid SLAs, GitHub Discussions only, one content piece a month,
say "not planned" a lot. **At 15:** biweekly releases, services open with limited slots, occasional
streams. **25+** is a launch-month profile only — schedule a deliberate step-down after it.

Agents multiply implementation, not **judgment, trust, relationships or your public voice**. Those
don't scale, and they're what popularity demands most.

---

## 3. The operating rhythm

### Daily (30–45 min, same time each day)
1. **Security inbox first** (private vulnerability reports, security@). Acknowledge real ones within 1
   business day.
2. **CI/trunk status** — red trunk is fixed before anything else.
3. **New issues:** label (`bug`, `support`, `feature`, `docs`, `migration`, `security`, `duplicate`,
   `needs-repro`, `good first issue`), answer or convert support issues to Discussions, close duplicates
   with a link. Don't solve everything — *route* everything.
4. **One thoughtful community reply** (a discussion, a contributor PR, a thank-you).
5. Glance at mentions (Bluesky/Mastodon/Reddit search for the name) — respond only where useful.

### Weekly (2–3 h, fixed day)
- Release (or release-candidate) with human-written notes.
- Review merged agent work at the level of **behaviour**: spot-check real usage in the running app, not
  just green CI (your memory notes: jsdom can't catch layout bugs; verify UI in real Chromium).
- Upstream-tracking hour: read upstream `scarlett` commits; port security fixes; update the vs-3.x matrix.
- Metrics snapshot (§8).
- Backlog grooming: close stale "needs-repro" after 14 days with a kind template.
- Plan next week's content item (if any).

### Monthly
- Roadmap update (Now/Next/Later) + "What shipped" post.
- Dependency currency review (your standard: latest LTS, pinned).
- Security review of new surface shipped that month (auth, uploads, MCP tools, fetchers).
- Sponsor/customer update email.
- Burnout check (§9) — honestly.

### Quarterly
- Strategy review against this doc set: segments, gates, pricing, time budget.
- Retire or re-scope features nobody uses (update-check + feature flags data).
- Grant/funding applications window.
- Contributor recognition (release notes shout-outs, maintainer promotions).

---

## 4. Release engineering as a public trust signal

- **Cadence:** biweekly minor/patch while growing; the calendar matters more than the content.
- **Versioning:** your own line (D2); SemVer with an explicit policy on what "breaking" means for
  configs, APIs and DB migrations.
- **Changelog:** git-cliff is already wired into `release.yml`; add a human summary on top (3 bullets:
  what's new, what's fixed, anything you must do).
- **Upgrade notes:** every release that runs DB migrations says so, with backup reminder.
- **Security releases:** separate advisory, patched versions listed, severity, credit to reporter.
- **Supported versions table:** latest minor only at first; add an LTS line only when a paying customer
  needs it (doc 08).
- **Squashed migrations (CLAUDE.md policy) must end at v1.0.** Once real installations exist,
  "drop and recreate your database" is no longer acceptable. Make the policy change explicit in
  `docs/versioning.md` and CLAUDE.md on the day you tag the first public release people will run.
  This is the single most important engineering-policy change launch forces.
- **"No compatibility shims" (CLAUDE.md) also ends for released artefacts:** config keys, API payloads
  and stored settings need deprecation windows once users exist.

---

## 5. Issue, discussion & support hygiene

- **Issue forms:** Bug (version, install method, DB, reverse proxy, logs, steps), Feature request (problem
  first, not solution), Migration problem (dry-run report attached). Blank issues disabled.
- **Support goes to Discussions.** Issues are for confirmed defects and accepted work.
- **Saved replies:** needs repro; duplicate; support-not-bug; not planned (with reason); security → private
  reporting; thanks + good first issue; "please don't paste secrets".
- **Published expectations** (README + CONTRIBUTING): community support is best-effort; triage target
  (e.g. 5 business days); security acknowledgement target (e.g. 2 business days); paid support exists.
- **"Not planned" is a gift.** Close feature requests that don't fit the positioning (doc 03) with a
  one-sentence reason and a pointer to extensibility (blocks, API, MCP). A backlog of 800 open wishes is
  a tax and a false promise.
- **AI-generated junk:** require reproduction steps or a PoC for bug and security reports; close
  unverifiable LLM-style reports with a template; don't argue.

---

## 6. Community architecture

### Channels
- **At launch:** GitHub Discussions (searchable, indexable, async — ideal for a solo maintainer).
  **On GitLab** (doc 10), which has no Discussions equivalent, use issues with a `support` label and a
  support template, kept public. Wherever this doc set says "Discussions", read "the public support
  channel".
- **Later (with a second moderator):** Matrix (fits the sovereignty audience) or Discord (fits homelab).
  Real-time chat is a time sink for one person and hides answers from search.
- **Announcements:** release RSS, GitHub releases, a low-frequency newsletter, Bluesky + Mastodon.

### Governance, stated honestly
- **Now:** "Cardinal is maintained by Dylan Hart (BDFL). Decisions are made in public discussions; the
  maintainer has final say." That's normal and fine — say it.
- **Path:** named in `GOVERNANCE.md` — criteria for committer (sustained quality contributions over ≥6
  months), for maintainer (committer + review/triage track record), and a stated intent to form a small
  maintainer group when there are ≥3 maintainers.
- **Continuity plan** (addresses the bus-factor attack): repo, domain, registry and package credentials
  held by an org with a second trusted owner or a sealed recovery process; a short "if the maintainer is
  unavailable for 90 days" note.
- **Neutral home later:** if it becomes significant, consider a foundation/umbrella (e.g. Codeberg e.V.-style
  non-profit models) for trademark and infrastructure — Forgejo shows the credibility value.

### Contributor ladder
Reporter → contributor (first merged PR) → regular (5+ PRs) → triager (label rights) → committer →
maintainer. Publicly recognise each step. Label `good first issue` generously *and keep them real*.

### Contribution policies
- DCO sign-off; AGPL-3.0-only inbound=outbound.
- `AI_POLICY.md`: disclose tool and extent; contributor must understand and stand behind the change; no
  AI-generated media; maintainer's own AI-directed workflow disclosed (doc 03 §6).
- Discuss-before-PR for anything non-trivial (reduces drive-by and AI PR floods).
- CODE_OF_CONDUCT (Contributor Covenant) with *your* enforcement contact and a real process.

### Opening the planning surface
Your internal OpenProject project has ~1,550 work packages, duplicate bug filings, and chronic
red-CI tickets (`ngpixel-field-notes.md`). Don't open it raw. Options:
1. **Recommended:** a curated public roadmap (GitHub Projects) mirrored from Epics/Features only; keep
   the internal tracker private as your "agent work queue"; stop referencing internal WP numbers in
   public commits/PR titles.
2. A public OpenProject view scoped to Epics/Features after a dedupe/cleanup pass.

Whichever you pick, GitHub issues from outsiders must be **first-class**: an accepted outside issue gets
a public status, not a silent import into a private tracker.

---

## 7. Working with agents in public

- Agent-authored PRs should look like good human PRs: small, described, linked to a public issue,
  tested. The overnight "Cycle: 40 things" mega-PR pattern is invisible to contributors and hard to
  audit; for public trunk, prefer smaller landable units or at least a human-written summary.
- Keep the Co-Authored-By trailers (disclosure).
- Before merging anything that touches auth, permissions, uploads, MCP tools, custom blocks, fetchers or
  migrations: a human-level review checklist, every time, no exceptions. This is where a Huntarr-class
  incident would come from.
- Outside contributors will read CLAUDE.md. At 16k+ words it reads as bureaucracy to outsiders; ship a
  short human `CONTRIBUTING.md` and treat CLAUDE.md as agent configuration.

---

## 8. Metrics dashboard

| Metric | Source | Why |
|---|---|---|
| Active instances (7-day unique) | Update-check endpoint (disclosed, opt-out) | The real adoption number |
| New instances/week; version distribution | Same | Upgrade health, release uptake |
| Migrations started / verified | Opt-in counter, support | War aim #1 |
| Docker pulls (GHCR + Docker Hub) | Registries | Trend only |
| Stars (organic) | GitHub | Social proof, grant criteria |
| Median time to first response (issues, discussions) | GitHub API script | Your responsiveness promise |
| Open issues by label; % support mislabeled as bugs | GitHub | Triage load |
| Security reports: received / valid / median fix time | Private | Trust |
| Outside contributors (monthly active) | GitHub | Bus-factor mitigation |
| Docs top pages + zero-result searches | Docs analytics (privacy-respecting) | Where users get stuck |
| Revenue: services, support, sponsors, kickbacks | Books | Sustainability |
| Your hours | Your calendar | Burnout |

Privacy stance for update-check: send only instance UUID (random), version, and coarse feature flags
(e.g. "migrated: yes"); no hostnames, no IPs stored beyond rate-limiting, published retention, one
config key to disable. State it on the security page. Self-hosters will read the code.

---

## 9. Burnout and boundaries

- **Signals:** dreading notifications; replying curtly; working on the project during work hours; skipping
  sleep for launch-adjacent tasks; resentment toward users.
- **Rules:** notification-free evenings/weekends except security; a published "maintainer availability"
  note; vacations announced in advance; no SLAs that require nights/weekends; paid work capped per month.
- **Entitlement handling:** one polite boundary-setting reply ("This is a volunteer project; here's what I
  can do; here's the paid option"), then lock or close if it escalates. Enforce the CoC early and
  visibly — tolerating one abusive thread teaches everyone that it's allowed.
- **Harassment:** don't engage; document; block; report to platform; if threatening, local authorities.
- **Lessons from others:** Babel (sponsor money is cyclical — don't quit the day job on it); faker.js
  (resentment destroys trust faster than it gets you paid — set prices and boundaries early); xz (an
  exhausted solo maintainer is a supply-chain target — grant commit rights slowly, be suspicious of
  pressure to add maintainers).

---

## 10. When to hire help, and what help

In order of leverage: (1) a **community moderator/triager** (volunteer from the community, recognised
publicly); (2) a **technical writer** for docs (contract, grant-fundable); (3) **packaging maintainers**
per catalog (volunteers); (4) a **security reviewer** on retainer for releases touching sensitive
surface; (5) a **second code maintainer** — last, and slowly, because commit access is the xz vector.
