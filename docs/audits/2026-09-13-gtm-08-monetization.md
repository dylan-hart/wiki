# GTM 08 — Monetization: Turning Popularity into Side Income

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md). Evidence:
[`gtm-research/research-monetization.md`](gtm-research/research-monetization.md). **Not legal or tax
advice** — this frames the questions for a lawyer and a CPA.

> **Framing:** income is optional. Cardinal exists for its maintainer and coworkers first (war room,
> "Premise"). Read this as a menu of rungs to climb *if* demand shows up unprompted. Rungs 1–3 (below)
> cost almost nothing to leave available; rungs 5–8 only make sense if people keep asking to pay.

---

## 1. The constraint that shapes everything

**You don't own most of the copyright.** A local `git shortlog` shows ~1,780 commits from NGPixel / Nicolas
Giard against ~623 of yours; upstream never used a CLA or DCO. The codebase is licensed to you under
AGPL-3.0 only.

| You **can** | You **cannot** (realistically) |
|---|---|
| Charge for **services**: migrations, support, SLAs, consulting, training, custom development, LTS maintenance | Sell a **closed, in-process "enterprise edition"** — modules loaded into the same Node process sharing `WIKI` and models are very likely a derivative/combined work (the Docmost `ee/` pattern works for Docmost only because Docmost owns its copyright and collects a CLA) |
| **Host it** as a paid service (AGPL §13: link users to the exact deployed source, incl. hosting patches) | **Dual-license** or relicense (BSL, commercial) — requires every copyright holder's consent |
| **Own and license the brand** ("Official Cardinal Cloud", "Certified Cardinal Support") | Prevent anyone else from hosting or supporting Cardinal — AGPL lets them |
| License **separate works you alone wrote** (content, courses, templates; possibly a genuinely separate-process service talking over REST — lawyer question) | Hold back AGPL code from people you've given it to (sponsorware on core code doesn't work) |
| Take **grants, sponsorships, marketplace kickbacks** | Rely on donations — Wiki.js at 29k★ reaches ~4% of a $6k/month goal |

**Therefore:** Cardinal's business is *time, trust, convenience and brand* — the BookStack / Nextcloud /
XWiki SAS model — not licences. Nextcloud, itself a fork of ownCloud, is proof this can be large.

**And the upside of that constraint:** you can say, truthfully and permanently, "there is no enterprise
edition and there never can be an in-process one." Against Docmost's paywall, that is marketing.

---

## 2. Revenue ladder, with the popularity threshold where each rung starts to pay

| Rung | Starts paying at (judgment, anchored in research) | Effort | Fits a day job? | Start |
|---|---|---|---|---|
| **1. Fixed-price migration services** | ~Zero stars — sells to a stranded installed base | Medium, scheduled | Yes (async + evenings) | Pre-launch (design partners → paid after) |
| **2. Marketplace kickbacks** (Railway 15/25%; PikaPods ~20% "where possible"; Elestio 10–20%) | From the first deploys; pocket money until hundreds of paid instances | Low | Yes | Launch week |
| **3. Grants** (NLnet Open Internet Stack/Restack €5–50k; next deadline **2026-11-03**) | No popularity threshold; needs a credible plan + European dimension | Medium, bursty | Yes | Now |
| **4. Contract feature work / consulting** | A few hundred users → inbound asks | High | Capped hours only | +1–3 months |
| **5. Support subscriptions** | A few hundred production installs; organisations running it for real | Ongoing | Yes, with business-day promises only | +3–6 months |
| **6. Sponsorships** (GitHub Sponsors, Liberapay, company tiers) | Meaningful only ~10k★+; companies sponsor what they depend on | Low | Yes | Plumbing now, expectations low |
| **7. Managed hosting** (own or partner) | Dozens of paying workspaces to break even; hundreds to matter | Very high (on-call, backups, DPA, incidents) | **No**, unless via partner | Partner first, 2027+ |
| **8. LTS / sovereign tier** | Public-sector or regulated customers who must stay on a version | High | Only as priced add-on | 2027+ |

---

## 3. Draft price sheet (judgment — calibrate with design partners)

### 3.1 Migration services (fixed scope, fixed price)

| Package | Scope | Price (USD) |
|---|---|---|
| **Assisted** | Wiki.js 2.x on Postgres, ≤ 5k pages, ≤ 20 GB assets; rehearsal review, dry-run report walkthrough, cutover call, 30-day email follow-up | 1,500 |
| **Standard** | Any 2.x DB via bundle, ≤ 20k pages; SSO/auth reconfiguration; storage/git sync re-link; redirects; 60-day follow-up | 4,000 |
| **Complex** | Multi-language, large asset stores, custom auth, GraphQL-shim for automations, multiple 2.x wikis → one Cardinal multi-site (custom work) | from 10,000 |
| **Confluence** (when importer exists) | Space audit, permission mapping, attachments, rehearsal, cutover | from 8,000 |

Rules: 50% on signature, 50% on verified cutover; client runs everything on their infrastructure;
any generic improvement is contributed to Cardinal under AGPL (write that into the SOW).

### 3.2 Support subscriptions (per organisation / instance, annual)

| Tier | Includes | Price |
|---|---|---|
| **Community** | Discussions, docs | Free |
| **Standard** | Private email/help desk, 2-business-day response target, upgrade assistance, priority bug triage, 1 instance | 750/yr |
| **Business** | 1-business-day target, up to 3 instances, SSO/permissions design help, 4 h/yr calls, security advisories 48h early (embargo) | 4,500/yr |
| **Sovereign** | Named contact, LTS branch security backports (18–24 mo), procurement paperwork, custom terms | from 12,000/yr |

Anchors: BookStack £450 / £4,500; Docmost minimum $720/yr (10 seats × $6); Nextcloud €69–205/user/yr
(100-user minimum). Price per organisation/instance, not per user — easy to verify, matches the
self-hosted buyer. **Never promise resolution times, 24/7, or nights/weekends.**

### 3.3 Contract development & consulting

- **Rate:** $175–250/hour equivalent, sold as fixed bids per milestone wherever possible.
- **Capacity:** publish slots ("2 engagements per quarter"). Scarcity is honest and protects your job.
- **Upstreaming clause:** work product contributed to Cardinal under AGPL-3.0-only; client gets no
  exclusive rights; client-specific glue that's never distributed can stay private (their AGPL §13
  obligations apply if they modify and expose it).
- **Good contracts to accept:** SSO/IdP integrations, SCIM, importers, Helm/K8s hardening, specific
  compliance features (audit export/SIEM), accessibility work, performance at scale.
- **Contracts to decline:** anything that forks the roadmap against the positioning, closed features,
  exclusivity, or work requiring you to hold customer data without an entity + insurance.

### 3.4 Sponsorship tiers (Caddy-style ladder, published)

| Tier | Price/mo | Benefit |
|---|---|---|
| Supporter | 5 | Name in SUPPORTERS.md |
| Backer | 25 | + release-notes thanks |
| Company Bronze | 250 | Logo on website sponsor page |
| Company Silver | 1,000 | Logo in README + quarterly roadmap call (influence, not control) |
| Company Gold | 2,500 | + 2 h/month of consulting (limited: 2 slots) |

State plainly: sponsorship never buys roadmap control, feature exclusivity, or security embargo beyond
the published policy.

### 3.5 Things that are *not* for sale
Features in the AGPL product; security fixes; roadmap control; your personal data access to customer
wikis without a contract.

---

## 4. Grants & public money (status as of 2026-09-13)

| Fund | Fit | Action |
|---|---|---|
| **NLnet — Open Internet Stack (Restack)**, €5–50k, next deadline **2026-11-03** | **Best fit** — commons, sovereignty, Confluence alternative, interoperability. Requires a European dimension; whether a US-based individual qualifies is **unverified — ask NLnet directly** | Draft a milestone plan: (1) complete 2.x export/import incl. open bundle format, (2) accessibility audit + WCAG statement, (3) security hardening + external review, (4) Confluence importer. Find an EU co-applicant or EU pilot user |
| **GitHub Secure Open Source Fund** ($10k + program) | Plausible once there's usage | Apply after launch with a security-hardening plan |
| **FLOSS/fund** (Zerodha, $10k–100k) | Needs "widely used" | Publish `funding.json` now; apply after adoption |
| **Prototype Fund** (DE) | Germany residents only | Only via a German co-maintainer |
| **Sovereign Tech Agency** | Doesn't fund user-facing apps | Skip |
| **OTF** | Needs 3+ years of releases, internet-freedom mission | Skip |
| **Mozilla MOSS** | Hiatus | Skip |
| **GSoC** | Contributor labour, not income; costs mentoring time | Year 2 |
| **EU public procurement** (openDesk/XWiki, La Suite Docs) | Slots filled by EU vendors | Partner/subcontract to an EU integrator (Phase 4) |

---

## 5. How sponsorships and contract work actually arrive (and how to catch them)

1. **Make buying possible.** Companies can't "donate"; they can buy "Business support" or "a
   migration." A pricing page with invoice/PO support converts inbound interest that a Sponsor button
   never will.
2. **Look like a going concern.** BookStack added support plans because companies feared abandonment.
   Cadence + a named services page + an entity = "safe to depend on."
3. **Harvest intent signals:** GitHub issues from corporate email domains, discussions mentioning
   "our company", design partners, launch-week "can we pay you?" DMs, feature requests with urgency.
   Reply: "Happy to help in the open; if you need it on a timeline, here's how contract work works."
4. **Target the Open Source Pledge / FOSS Funders member list** for companies that self-host wikis.
5. **Partners sell for you:** hosting partners (kickbacks), IdP communities (integration work), EU
   integrators (subcontracting).
6. **Case studies are the sales team.** Every paid migration should end with a request for one.

---

## 6. Revenue scenarios, year one after launch (judgment)

| Scenario | Assumptions | Rough annual |
|---|---|---|
| **Conservative** | Modest launch; 3 paid Assisted migrations; 2 Standard support; kickbacks; no grant | ~$6–8k |
| **Base** | Solid launch; 6 migrations mixed; 6 support subs incl. 1 Business; 1 small contract; one NLnet grant at €30k spread over milestones | ~$45–65k (incl. grant) |
| **Upside** | Strong HN/r/selfhosted + creator coverage; 15 migrations; 15 support incl. 3 Business + 1 Sovereign; 2 contracts; grant; first company sponsors | ~$110–160k |

Reality check: BookStack — solo, full-time, 11 years, 19k★ — runs ≈ £71k/yr. Plan for Conservative;
build so Base is reachable; treat Upside as a decision point about going part-time on your job, not a
promise.

---

## 7. Business setup checklist

**Before any money changes hands**
1. **Employment agreement** read; written approval if your employer is in adjacent software. Never use
   employer hardware, accounts, AI subscriptions or hours for Cardinal.
2. **CPA consult** (self-employment tax, quarterly estimates, S-corp election only at meaningful profit).
3. Separate bank account.

**Before the first paid contract**
4. **Single-member LLC** in your home state (liability separation; California has an $800/yr minimum tax;
   forming in Delaware/Wyoming doesn't avoid home-state obligations).
5. **Contract templates:** MSA + SOW (Common Paper/Bonterms as starting points), support terms (scope,
   business-day targets, liability cap = 12 months fees, no consequential damages, customer owns backups).
6. **Payments:** Stripe invoices / bank transfer for B2B contracts; a merchant of record (Paddle / Polar,
   ~5% + 50¢) for self-serve subscriptions so global sales tax and EU VAT are handled (non-EU sellers owe
   EU VAT from the first B2C euro).

**Before SLAs or hosting**
7. **Tech E&O insurance** (~$900–1,300/yr, $1M/$1M typical); cyber liability if you host customer data.
8. **Hosting paperwork:** Terms of Service, DPA (GDPR), acceptable-use policy, DMCA agent registration
   (user-generated content), AGPL §13 source link in the footer.

**Brand protection**
9. **Trademark filing** after clearance: US classes 9 + 42 (~$700 + attorney); EUIPO if EU revenue
   emerges. Publish a trademark policy.

---

## 8. What not to do (and why)

| Temptation | Why not |
|---|---|
| Closed in-process EE modules | Likely infringes the upstream copyright holders' AGPL grant; NGPixel is active and would be right to object |
| Relicensing to BSL / "fair code" | Requires every copyright holder; community would fork you (Gitea → Forgejo precedent) |
| CLA "for future flexibility" | Only covers new code; signals a future license rug-pull; costs contributors |
| License-key nags that gate AGPL features | Stripped within a day; trust damage exceeds revenue |
| Selling "priority" on security fixes | Every user deserves the fix; sell *early notification under embargo*, not the fix |
| Quitting the job on sponsorship growth | Babel: sponsor money is cyclical |
| Running your own SaaS in year one | On-call and incident response don't fit a day job; partner first |
| Paying for stars/coverage | Detected, called out, permanent reputation damage |
