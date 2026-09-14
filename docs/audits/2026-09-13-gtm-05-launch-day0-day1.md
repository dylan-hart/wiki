# GTM 05 — Launch: Channels, Day 0, Day 1, the First 90 Days, Guerrilla Marketing

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md). Channel rules:
[`gtm-research/research-launch-attacks.md`](gtm-research/research-launch-attacks.md). Rules marked
*verify* were not readable first-hand (Reddit blocks fetching) or are changing this month — re-read
them the week you launch.

---

## 1. Principles for a solo launch

1. **One first impression per venue.** You cannot re-launch on HN or r/selfhosted. Stage venues; don't
   fire everything at once.
2. **You are the product on launch day.** Fast, humble, specific, human answers beat any feature.
3. **Every word in a community venue is yours.** No AI-drafted or AI-edited posts or replies (HN rule;
   community norm everywhere else). Use doc 05 §3's notes, type your own sentences.
4. **Never ask for upvotes or stars.** Voting-ring and fake-star detection exist and get publicly called
   out (StarScout: ~6M suspected fake stars).
5. **Concede fast, fix fast, ship a point release within 72 hours.** Responsiveness is the story you
   want told about launch week.
6. **Capacity before audience.** A flood of issues you can't answer becomes the story instead.

---

## 2. Channel plan

### 2.1 Tier 1 — launch venues (staged)

| Venue | Rules that bite (current) | Format | When |
|---|---|---|---|
| **Hacker News — Show HN** | Must be try-able (demo or one-command start); no AI-generated/edited text in post *or comments*; low-history accounts see a restricted Show HN (`/showlim`, thresholds unpublished); no vote solicitation; no hype or caps in title | Title + URL (repo or landing) + your first comment | Day 0, ~08:30 ET Tue–Thu (sources disagree on timing; content matters more) |
| **r/selfhosted** | *Verify week-of:* AI-built project handling ("Vibe Code Friday" thread reported; AI-tagging methodology being reworked early Sept 2026); self-promo norms; flairs | Screenshot-led post; compose file; migration angle; explicit AI disclosure | Day 1 or 2 (not same hour as HN) |
| **Your own channels** | — | Launch blog post, Bluesky, Mastodon (fosstodon), LinkedIn | Day 0 after HN is live |

### 2.2 Tier 2 — first two weeks

| Venue | Notes |
|---|---|
| **r/sysadmin, r/homelab** | Verify each sub's self-promo rules; lead with the problem ("stranded on Wiki.js 2.x MySQL?") not the product |
| **r/wikijs** | Upstream's community. **Do not post** unless its moderators explicitly OK it. Better: don't |
| **r/Confluence, r/opensource** | r/opensource reportedly treats AI-generated content as ban-worthy — verify; skip until you have a non-launch story |
| **Lobsters** | Invite-only; new users can't use `show` for 70 days; self-promo < 25% of activity; content "without meaningful human authorship" is spam. Only if you already have an account in good standing |
| **selfh.st newsletter/directory** | Curator ignores LLM-written submissions; write it yourself |
| **Changelog News** | Public submission form |
| **AlternativeTo** | List as alternative to Wiki.js, Confluence, Docmost, BookStack, Notion (factual) |
| **Product Hunt** | Low relevance for self-hosters; optional, week 2+ |

### 2.3 Tier 3 — slow-burn distribution (launch → +6 months)

| Channel | Requirement (found) | Target |
|---|---|---|
| **awesome-selfhosted** | First release >4 months old, tagged releases, active; **LLM-generated contributions → ban**; PR `software/<name>.yml` by hand | Eligible ~2027-01-30 if first tag 2026-09-30 |
| **Unraid Community Apps** | Public repo, valid XML template, OSI license, `ca_profile.xml` | Launch week |
| **TrueNAS apps** | Community train; prefer GHCR; **non-root** `run_as_context` | +1 month |
| **YunoHost** | Free software; CI integration level | +2 months (or community packager) |
| **Umbrel** | Fully browser-configurable after install | +2 months |
| **Dokploy templates** | PR with compose + template.toml + meta | Launch week |
| **Coolify** | **≥1,000 GitHub stars**, pinned versions (only the GitHub mirror's stars could count; unverified) | When eligible |
| **Proxmox community-scripts** | New scripts go to ProxmoxVED | +1 month |
| **Railway template** | Kickback 15% (25% with support) | Launch week — also revenue (doc 08) |
| **PikaPods / Elestio / Cloudron** | Email/forum; PikaPods questions fork authorship and won't list apps competing with your own paid hosting | +1 month |
| **DigitalOcean Marketplace** | 1-Click (upstream has the official Wiki.js one) | +3 months |
| **Artifact Hub** | Needs the Helm chart | Phase 3 |

### 2.4 Creators, newsletters, podcasts, events

- **YouTube self-hosting creators** (Techno Tim, DB Tech, Jim's Garage, Christian Lempa, Lawrence
  Systems, Wolfgang's Channel, Hardware Haven, VirtualizationHowto; noted.lol, Marius Hosting blogs).
  Contact norms unverified — send a short personal note *after* v1.0.1 ships, with the press kit and an
  offer of a call, never payment for coverage. DB Tech publicly vets self-hosted app security post-Huntarr:
  lead with your security review.
- **Podcasts:** FLOSS Weekly (active, Hackaday), Self-Hosted (Jupiter Broadcasting; verify active),
  Changelog. Pitch a story, not a product: "migrating a stranded 146M-pull ecosystem" or "building a
  wiki with AI agents and publishing the security review."
- **Events:** FOSDEM 2027 (30–31 Jan, Brussels; devroom CfP 4 Oct–7 Dec 2026; talk CfPs from ~late
  Oct). SCALE, All Things Open, Open Source Summit, EU public-sector/OSOR events — dates unverified.
  Local sysadmin/DevOps meetups: a 20-minute migration demo converts better than any post.

### 2.5 SEO & content engine (starts pre-launch, compounds)

Keyword clusters (by segment):

| Cluster | Example queries | Asset |
|---|---|---|
| Wiki.js migration | "wiki.js 3 upgrade from 2", "wiki.js mysql to postgres", "wiki.js sqlite migration", "wiki.js export" | Migration hub + per-engine guides |
| Wiki.js alternatives | "wiki.js alternative", "wiki.js vs bookstack", "wiki.js vs docmost" | Honest compare pages |
| Docmost | "docmost sso free", "docmost 2fa", "docmost alternative" | Compare page (factual table) |
| Confluence DC | "confluence data center end of life", "self-hosted confluence alternative 2027", "confluence on-prem replacement" | DC countdown + planning checklist (importer page when ready) |
| Governance | "wiki page level permissions self-hosted", "wiki approval workflow", "document classification wiki" | Feature pages with demos |
| Multi-site | "multi-tenant wiki self-hosted", "wiki farm modern" | Delegation guide |
| Agents | "self-hosted wiki mcp server", "mcp knowledge base permissions" | MCP guide, listing in MCP registries |

Comparison-page legal rules (US nominative fair use): use competitor names as words only (no logos/trade
dress), only as much as needed, nothing implying endorsement, everything truthful and dated. EU
comparative-advertising rules differ in detail — keep to verifiable facts.

**Editorial calendar, first 12 weeks after launch** (one substantive piece every 1–2 weeks):
1. Launch post: why Cardinal exists, how it's built (AI disclosure), what's rough.
2. "Migrating Wiki.js 2.x on MySQL/SQLite: the complete guide" (useful even to people who don't pick Cardinal).
3. Launch retrospective with real numbers (week 1).
4. Security review: what was found, what was fixed.
5. "Page rules explained: ALLOW, DENY, FORCEALLOW."
6. "Confluence Data Center goes read-only in 2029 — an on-prem planning checklist."
7. "Agents that obey your wiki's permissions" (MCP + approvals demo).
8. Design-partner case study #1.
9. "Running many wikis on one install: delegated site admin."
10. Quarterly roadmap + what shipped.
11. Case study #2.
12. "What we learned migrating N Wiki.js installs" (aggregate, anonymised).

---

## 3. Questions you will be asked — prepare notes, answer live in your own words

**Lineage & upstream**
1. Why fork instead of contributing upstream? *(Upstream issues closed to outsiders; different scope — governance/agents; NGPixel said forking is fine. Calm, once.)*
2. Isn't Wiki.js 3 in beta now? *(Yes — congratulate it; explain what Cardinal adds and the migration path.)*
3. Will you merge upstream changes? *(Selective, security first, with attribution.)*
4. Can I go back to Wiki.js later? *(Honest answer: no tool exists today.)*
5. Did NGPixel approve? *(Not needed under AGPL; you let them know before launch.)*

**AI**
6. Is this vibe-coded? 7. Who reviews the code? 8. How do you know it's secure? 9. Do you accept AI PRs? 10. What did the security review find?

**Product**
11. How is this different from Docmost / BookStack / Outline? 12. Why Postgres-only? 13. Why Node 26? 14. Resource usage / RAM? 15. ARM / Raspberry Pi? 16. Mobile app / PWA? *(No; be direct.)* 17. Notion-style databases? *(No; not planned for now.)* 18. Confluence import? *(Planned; date only if real.)* 19. What doesn't migrate from 2.x? 20. Backups and upgrades between versions? 21. SCIM? 22. Offline / air-gapped installs? *(`docs/offline-deployment.md`.)* 23. Is the MCP server safe to expose?

**Sustainability**
24. What happens if you get bored? 25. How do you make money? 26. Will features go paid later? *(AGPL, no closed edition — and legally you can't do an in-process one.)* 27. Is there a company? 28. How many maintainers? 29. Why should I trust a one-month-old project? *(Don't argue — invite them to watch the release cadence.)*
30. Why "Cardinal"?

---

## 4. Day 0 — launch-day runbook

### T-14 days
- Freeze: no merges except launch fixes. Release candidate tagged.
- Load/abuse test the demo (C7). Confirm the sandbox reset job.
- Dry-run the install on a fresh VPS and ARM again from the public README only.
- Confirm HN account history; read HN guidelines and Show HN rules again.
- Re-read r/selfhosted rules and AI-tagging method (changing Sept 2026).
- Check upstream's release page — avoid the week of a major upstream release.

### T-2 days
- Courtesy note to NGPixel (D13/D5): factual, short, asks nothing.
- Tag `v1.0.0`; publish images; verify signatures/provenance; verify GHCR package is public.
- Status page or simple uptime monitor for demo + docs + update endpoint.
- Prepare: saved replies for duplicates; issue labels; "known issues" pinned discussion.

### T-1 day
- Sleep. Clear your calendar for launch day and the morning after. Tell your household.
- Take the day off work if you can (use PTO; never launch on employer time or equipment).
- Draft (yourself) the Show HN first comment; read it aloud; cut 30%.

### Day 0 (all times ET, illustrative)

| Time | Action |
|---|---|
| 07:30 | Health check: demo, docs, images pull, compose quickstart from README on a clean box |
| 08:30 | Submit Show HN. Post your first comment immediately |
| 08:30–12:30 | **Stay in the thread.** Reply to every substantive comment within ~15 minutes. Thank critics. Concede valid points plainly ("You're right; filed #123"). Never argue about AI, NGPixel or forks more than once per thread |
| 09:00 | Publish launch blog post; Bluesky/Mastodon/LinkedIn (link to the post, not the HN thread — linking HN invites vote-ring flags) |
| Hourly | Watch: demo load/abuse, error logs, GitHub issues/discussions, security inbox |
| 12:30 | Triage: label every new issue; pin "Launch week known issues"; fix anything install-blocking |
| 14:00–18:00 | Second pass on HN; answer GitHub Discussions |
| Evening | Hotfix branch if needed; write down the top 10 pain points; stop by 22:00 |

**If it doesn't hit the front page:** that is the median outcome (~37% of Show HN posts get exactly one
point). Don't repost the same day; don't ask anyone to upvote. Carry on with Day 1 venues; HN allows a
later Show HN only for substantial changes.

**If it hits the front page:** traffic arrives in hours. Put the demo in read-only mode at the first sign
of abuse. Keep answering. Don't ship risky changes under load.

### Kill switches ready before launch
- Demo: read-only toggle, registration off, upload off, rate limits.
- Docs site: static cache in front.
- Update endpoint: can return 200 with no body if overloaded.
- Your attention: a written "I'm stepping away until HH:MM" note if you need to.

---

## 5. Day 1 → Day 7

| Day | Focus |
|---|---|
| **1** | r/selfhosted post (verified rules/flair). Ship `v1.0.1` with launch-day fixes within 72h. Reply to every GitHub issue with a label and a next step |
| **2** | Tier 2 venues (one per day max). Invite promising commenters with real 2.x installs into the design-partner program |
| **3** | Unraid CA, Dokploy, Railway template submissions. selfh.st and Changelog submissions (hand-written) |
| **4** | Close the loop publicly: "What we fixed from your feedback" discussion post |
| **5** | Creator outreach (personal notes + press kit) — only now that v1.0.1 is out |
| **6** | Rest. Seriously |
| **7** | Launch retrospective post with real numbers (stars, instances via update-check, migrations, issues opened/closed, median first response). Honest about what went wrong |

**Launch-week metrics to record:** HN points/comments; referrers; stars (from organic sources only);
Docker pulls; update-check instance count; demo sessions; issues opened/closed; median time-to-first
response; migrations attempted/succeeded; design-partner signups; sponsor/support inquiries.

---

## 6. Days 8–90: from spike to engine

- **Cadence:** a tagged release every 2 weeks, changelog written for humans. A short "What's new in
  Cardinal" post monthly.
- **Content:** the 12-week calendar (§2.5).
- **Distribution:** Tier 3 catalogs one by one.
- **Partners:** Stellar Hosted / Hostwiki / Elestio / PikaPods conversations; a Keycloak or Authentik
  integration guide co-promoted with that community.
- **Case studies:** publish two design-partner migrations.
- **Services:** open the migration-services page and support subscriptions (doc 08) once three unsolicited
  "can we pay you" requests arrive — they will.
- **Second wave:** FOSDEM talk (if January launch), awesome-selfhosted PR (~2027-01-30+), Confluence DC
  planning content ahead of the importer.

**90-day planning targets** (judgment — targets, not predictions): 1–3k stars; 200+ active instances by
update-check; 20+ completed 2.x migrations; 2+ public case studies; median first response < 2 business
days; 1–3 paying support or migration customers; 3–5 regular outside contributors.

---

## 7. Guerrilla marketing — high-leverage, ethical

| Tactic | How | Why it works | Line not to cross |
|---|---|---|---|
| **The open 2.x exporter** | Standalone CLI that exports any 2.x DB to an open bundle (doc 02 §4.4) | Helps everyone leaving 2.x; ranks for migration searches; Cardinal is the native destination | Don't make it a trojan horse — it must work for other destinations too |
| **"Migration Monday" live streams** | Migrate a volunteer's real 2.x wiki live, warts and all | Proof, content, community, and bug reports all at once | Only with explicit consent; scrub data |
| **Dry-run report as a shareable artifact** | Make the dry-run output a clean, shareable page ("here's what would move") | People post it in their team chat → word of mouth inside organisations | No auto-upload; opt-in sharing only |
| **Confluence DC countdown page** | A genuinely useful, vendor-neutral on-prem planning checklist with the dates | Owns a time-bound search wave well before the importer exists | Don't claim an importer until it ships |
| **"Every feature, no seat tiers" table** | A single dated table vs Docmost's editions page | Crisp, shareable, factual | No brigading Docmost's paywall discussions |
| **Dogfood multi-site publicly** | docs.cardinal.wiki, demo.cardinal.wiki, community wiki — one install | The docs site *is* the demo | — |
| **Community wiki on Cardinal** | Users write recipes (SSO, backups, reverse proxies) on a public Cardinal site with approvals | Shows approvals/governance in action; UGC SEO | Moderate it; approvals on |
| **MCP registry listings** | List the MCP server in public MCP directories with a "governed knowledge base" description | Agent builders discover Cardinal through their tooling | — |
| **Integration co-marketing** | Guides with Keycloak, Authentik, Plane, Nextcloud, Traefik/Caddy communities | Borrowed audiences with aligned values | Ask before tagging them |
| **"Badge" for migrated wikis** | Optional footer badge "Migrated from Wiki.js with Cardinal" (off by default) | Organic backlinks from real sites | Never on by default |
| **Answer the stranded threads** | When someone publicly asks "how do I migrate Wiki.js 2 MySQL to 3?", answer the question fully, disclose affiliation, link the guide | Helpful, findable, honest | Never in bulk; never templated; not in upstream venues as promotion |
| **Translators first** | Invite the 2.x translator community (Localazy) to Cardinal's locales early | Translators are evangelists in their language communities | Credit them properly |
| **Talks > posts** | Local meetup / FOSDEM / sysadmin conference demos | High-trust, high-conversion | — |
| **Stickers & swag** | Only after 1k stars; send to contributors | Contributor retention, not acquisition | — |

**Never:** sockpuppets; paid or exchanged stars; fake reviews; astroturfed "has anyone tried Cardinal?"
posts; mass cold email; scanning or contacting operators of public Wiki.js instances you found by
crawling; AI-written community posts; ads that bid on "Wiki.js" with copy implying affiliation.
