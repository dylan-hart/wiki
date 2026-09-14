# Monetizing Cardinal.js: a research brief

Researched 2026-09-13 using live web search and fetch. **This is not legal or tax advice.** Section 2 describes the legal landscape so the questions you take to a lawyer are sharper. It does not replace the lawyer.

Labels used below:
- **[verified]**: read on a primary source during this session.
- **[secondary]**: from a third-party write-up or estimate aggregator (GetLatka, review sites, press).
- **[unverified]**: could not confirm, or sources disagree.
- **[judgment]**: my own synthesis, not a sourced fact.

---

## 0. The situation, and why it changes the answers

- **The license and the history.** Cardinal.js is AGPL-3.0 (repo `LICENSE`). It is a hard fork of Wiki.js 3.x (`scarlett` branch), taken 2026-08-16.
- **Who wrote the code.** A local `git shortlog` shows 3,015 commits:
  - NGPixel / Nicolas Giard: 1,191 + 589 = about 1,780
  - Dylan Hart: 565 + 58 = 623 (all after the fork)
  - Other contributors: the rest
  - Commit counts are *not* a measure of copyright ownership. They do show that most of the copyrightable expression still belongs to Requarks/Giard and upstream contributors.
- **No contributor agreement.** Upstream never used a CLA or DCO. `.github/CONTRIBUTING.md` has no such clause (checked locally), so no one has ever granted relicensing rights.
- **The funding file still pays upstream.** `.github/FUNDING.yml` points at NGPixel, `patreon: requarks` and `open_collective: wikijs`. A comment in the file says so, and `docs/legal/README.md` tracks it. Any funding button on the repo today pays upstream, not you.
- **What upstream earns.** NGPixel's GitHub Sponsors page shows 19 current and 122 past sponsors, against a $6,000/month goal that is "~4%" met. The Wiki.js Open Collective shows about $4,015/yr estimated budget and $20.9k raised in total. requarks/wiki has 28.9k stars. **[verified]** ([GitHub Sponsors NGPixel](https://github.com/sponsors/NGPixel), [Open Collective wikijs](https://opencollective.com/wikijs))
  - **[judgment]** Lesson: even a 29k-star wiki raised only a few hundred dollars a month from donations. Donations alone will not fund Cardinal.js.
- **Your constraints.** You are one person with a day job, the product is pre-release with no installed base, and the likely buyers are organizations: internal wikis, the public sector, digital-sovereignty buyers. Those facts favor models that sell *time, service, or convenience* over models that sell *license rights*. You don't hold most of the license rights.

---

## 1. Monetization models, with real examples

### 1.1 Donations and sponsorship platforms

| Platform | Fees | Notes |
|---|---|---|
| GitHub Sponsors | 0% on personal-account sponsorships; up to 6% on organization-account sponsorships **[verified]** | [GitHub Docs](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/about-github-sponsors-for-open-source-contributors). Very skewed: an early study found only 31% of developers who enabled Sponsors got anything, and 39.3% of those got $1 ([CHI 2022 study](https://yuyue.github.io/res/paper/sponsor-chi2022.pdf)). A 2026 observatory counts 40,549 users who sponsor others against 7,343 who receive, about 5.5:1 ([arXiv 2604.03846](https://arxiv.org/html/2604.03846)). |
| Open Collective (Open Source Collective host) | 10% host fee **[verified]** | [OSC docs](https://docs.oscollective.org/campaigns-and-partnerships/github-sponsors). Useful for transparency and for companies that must pay an invoice instead of making a "donation". |
| Liberapay | 0% platform fee; only processor fees (about 3% Stripe, 5% PayPal); $100/week cap per donor **[secondary]** | [Liberapay FAQ](https://liberapay.com/about/faq) |
| Polar.sh | Starter plan 5% + 50¢ from May 27, 2026; paid plans $20–$400/mo get lower rates; older accounts keep 4% + 40¢ **[secondary]** | [Dodo Payments review](https://dodopayments.com/blogs/polar-sh-review), [Polar plans blog](https://polar.sh/blog/introducing-polar-plans). Polar is a merchant of record (MoR) and can also sell license keys and subscriptions. |

**Reference points for what donations and sponsorships earn:**
- **BookStack (Dan Brown, solo, full-time since Oct 2021).** 19.0k stars. The "11 Years of BookStack" post (14 July 2026) gives 12-month monthly averages **[verified]**:
  - Support services: £3,715.68/mo (up 47%)
  - GitHub Sponsors: £1,996.24/mo (up 20%)
  - Ko-fi: £214.92/mo (down 22%)
  - Total about £5.9k/mo. Donations and sponsors are "a consistent foundation"; support is "volatile but increasingly valuable". ([blog](https://www.bookstackapp.com/blog/11-years-of-bookstack/))
- **Coolify (Andras Bacsai, solo).** February 2025 figures: $15.7k gross/mo, of which about $10.5k was cloud and $5.2k donations; $2.8k expenses. **[secondary, founder's own tweet]** ([X post](https://x.com/heyandras/status/1901894087604916396)). 61.7k stars. Other write-ups put GitHub Sponsors at about $4.5k/mo **[unverified]** ([bex.co](https://bex.co/blog/2026/08/16/coolify-bootstrapped-vs-vc-repricing-treadmill)).
- **Caleb Porzio (Livewire/Alpine).** Went from $0 to $100k/yr on GitHub Sponsors in months, later passing $1M total. Driven by sponsorware and sponsor-only screencasts, not plain donations **[verified, his blog]** ([100k post](https://calebporzio.com/i-just-hit-dollar-100000yr-on-github-sponsors-heres-how-i-did-it), [$1M post](https://calebporzio.com/i-just-cracked-1-million-on-github-sponsors-heres-my-playbook), [sponsorware](https://calebporzio.com/sponsorware)).
- **Plausible, early days.** Six $5 donations in six months, while its cloud product earned $8,500+ MRR in the same period. They concluded "donations are not a viable monetization method" **[verified]** ([blog](https://plausible.io/blog/open-source-saas)).
- **core-js.** Billions of downloads. Donation income fell from about $2,500/mo to about $400/mo, as reported in 2023 **[secondary]** ([The Stack](https://www.thestack.technology/core-js-maintainer-denis-pusharev-license-broke-angry/), [The Register](https://www.theregister.com/2023/02/15/corejs_russia_open_source/)).

### 1.2 Sponsorware
You release a feature, add-on, or content to sponsors first, then open it at a sponsor-count or time threshold. Porzio's "Sushi" package was sponsor-only until he reached 75 sponsors **[verified]**.
- **[judgment]** It can fit Cardinal.js only for code *you* wrote that ships as a separate package, or for non-code extras: video courses, deployment playbooks, a Confluence-migration guide.
- **[judgment]** Holding back AGPL code *in the main repo* doesn't work. Anyone who receives the build can pass the source on freely (see §2).

### 1.3 Paid support contracts and SLAs
- **BookStack** **[verified]** ([support page](https://www.bookstackapp.com/support/)):
  - Community: free
  - Professional: **£450/yr**. Email and help-desk support, install and update help, high-priority bug triage.
  - Enterprise: **£4,500/yr**. Adds top priority, API and extension help, roadmap discussion with the maintainer, and up to 10 hours/yr of video calls.
  - Not priced per instance or per user.
  - The rationale ([announcement](https://www.bookstackapp.com/blog/bookstack-support-services/)): companies feared abandonment when no revenue was visible, and support invoices get through accounting more easily than donations.
- **Nextcloud** (a *fork* of ownCloud): Enterprise subscriptions sell support, longer maintenance windows and "someone to call", and deliberately **no features**. Published tiers are about €68.94 / €104.99 / €204.75 per user per year, with a 100-user minimum **[secondary]** ([Nextcloud pricing](https://nextcloud.com/pricing/), [Opsily summary](https://opsily.com/hosting/nextcloud/nextcloud-enterprise-pricing)).
  - **[judgment]** This is the most useful precedent for your case. A fork company built a large support business on AGPL code it did not originally write, without relicensing anything.
- **XWiki SAS** (the closest wiki-company analogue): core LGPL; tiered subscriptions (support, long-term-support releases, "Pro Apps", cloud hosting) priced by support level, not user count; consulting billed by the day **[secondary]** ([XWiki pricing](https://xwiki.com/en/pricing/)). XWiki is the wiki component of Germany's openDesk ([openDesk](https://www.opendesk.eu/en/about), [XWiki blog](https://xwiki.com/en/Blog/XWiki-CryptPad-knowledge-management-for-openDesk/)).
- **curl / wolfSSL**: Daniel Stenberg sells commercial support and contract development through wolfSSL, plus paid long-term-support builds called "Rock-solid curl" **[verified]** ([curl support](https://curl.se/support.html), [wolfSSL announcement](https://www.wolfssl.com/wolfssl-inc-announces-rock-solid-curl-long-term-supported-curl-releases/)).

### 1.4 Managed hosting (SaaS on the AGPL code)
- **Plausible**: switched MIT → AGPL in October 2020 so large companies couldn't host clones without contributing back. $1M ARR in June 2022, bootstrapped. Estimated ~$3.5M ARR in 2025 with a team of 10 and 19k+ subscribers **[2025 figures secondary]** ([Plausible blog](https://plausible.io/blog/open-source-saas), [OperatorBook](https://www.operatorbook.dev/stories/plausible-analytics-revenue-1m-arr-against-google)).
- **Ghost(Pro)**: a non-profit foundation. Reported crossing $10M ARR in March 2026 and about $10.8M by mid-2026 on its public about-page dashboard **[secondary]** ([Startup Founder Stories](https://startupfounderstories.com/stories/john-onolan-ghost-10m-arr), [GetLatka](https://getlatka.com/companies/ghost)).
- **Cal.com**: VC-backed ($25M raised). Revenue estimates disagree ($1.1M, $1.9M, $5.1M ARR) **[unverified, aggregators disagree]** ([GetLatka](https://getlatka.com/companies/calcom)). Not a solo-maintainer model.
- **Docmost** (the most direct competitor: AGPL wiki, 21.7k stars):
  - Self-hosted Community edition is free.
  - Business is **$6/seat/mo billed annually, 10-seat minimum** (SSO, AI, granular permissions, Confluence import, email support).
  - Enterprise is custom (SCIM, audit logs, SIEM).
  - Cloud also exists **[verified]** ([pricing](https://docmost.com/pricing), [editions](https://docmost.com/docs/editions)).
- **Outline** (40.5k stars): BSL 1.1, which is source-available, *not* open source. The license forbids reselling or hosting it as a service. Revenue comes from the cloud plus paid enterprise features (SAML, audit log, Confluence importer). No public revenue figures **[secondary]** ([license restrictions](https://docs.getoutline.com/s/hosting/doc/license-restrictions-f9aq6uEL3H)).
  - Not available to you. You cannot move an AGPL fork to BSL without every copyright holder's consent.
- **Coolify Cloud**: about $10.5k/mo in February 2025, solo (above).
- **[judgment]** Hosting has the highest revenue ceiling, but running on-call infrastructure, backups, incident response, and GDPR/DPA paperwork is a poor match for a day job. Consider it only after traction, and consider partnering with an existing host first (§1.9).

### 1.5 Open core
- **Docmost** keeps Enterprise Edition code in `apps/server/src/ee/`, `apps/client/src/ee/` and `packages/ee/` under a proprietary Docmost Enterprise license. Production use requires a subscription for the correct number of seats **[verified]** ([packages/ee/LICENSE](https://github.com/docmost/docmost/blob/main/packages/ee/LICENSE), [EE license](https://docmost.com/enterprise-edition-license)).
  - Docmost can do this because it wrote the codebase *and* makes contributors sign a CLA through CLA Assistant **[verified]** ([issue #1157](https://github.com/docmost/docmost/issues/1157)).
- **Sidekiq** (Mike Perham, solo): OSS core plus Sidekiq Pro and Enterprise add-ons. Reported "closer to $10M than $1M" in annual revenue as of April 2023 **[secondary, podcasts/interviews]** ([saas.group](https://saas.group/podcasts/saas-unbound-interview-mike-perham-sidekiq/), [Indie Hackers](https://www.indiehackers.com/podcast/016-mike-perham-of-sidekiq)).
  - Sidekiq's core is LGPL and Perham owns the copyright. That combination is what makes closed add-ons workable.
- **GitLab**: open core, but it owns the copyright and uses a CLA/DCO. Not comparable.
- **VoidZero** (Evan You): tried a mixed-license "Vite+", said it "didn't feel right", MIT-licensed it, and was later acquired by Cloudflare **[secondary]** ([SoftwareSeni](https://www.softwareseni.com/what-cloudflare-acquired-when-it-bought-voidzero-and-why-the-deal-happened/)).
  - **[judgment]** Even owning the copyright, open core can hurt your standing with the community.
- **For a fork, see §2**: an in-process closed "enterprise edition" is legally risky to impossible.

### 1.6 Dual licensing
This requires owning, or having a license grant for, all the code. It is not available to Cardinal.js (§2.3).

### 1.7 Bounties
- **Algora**: charges organizations 9% on bounties; visible 2026 bounties run $50–$2,500; payouts via Stripe Connect. Popular bounties draw 8–158 competing PRs within hours **[secondary]** ([Algora](https://algora.io/bounties), [DEV money map](https://dev.to/zeroknowledge0x/the-open-source-money-map-every-way-developers-are-actually-making-money-in-2026-with-real-45ba)).
- **[judgment]** Bounties are mainly a way to *pay contributors*. As income for a maintainer they are small and lumpy, and the flood of AI-generated PR spam (§6) raises review cost.

### 1.8 Contract feature development, consulting, migration services
- **Rates.** US senior freelance developers average roughly $100–$130/hr; niche experts charge $150–$200+/hr; general consultants $150–$300/hr **[secondary, rate aggregators]** ([contractrates.fyi](https://www.contractrates.fyi/Senior-Software-Engineer/hourly-rates), [invoicebloom](https://invoicebloom.io/blog/how-much-to-charge-as-consultant)).
  - **[judgment]** As "the maintainer of X", $150–$250/hr is defensible for US and EU companies. Price fixed-scope work by the project, not the hour.
- **Caddy / Matt Holt** publishes his whole sponsorship-plus-services ladder, run through Dyanim LLC **[verified]** ([caddyserver.com/sponsor](https://caddyserver.com/sponsor)):

  | Tier | Price | Includes |
  |---|---|---|
  | Indie | $25/mo | Expert resource access |
  | Indie Pro | $50/mo | Adds occasional email support |
  | Startup | $99/mo | Adds onboarding call |
  | Startup Pro | $249/mo | Priority triage, 10% off services |
  | Business | $999/mo | Private dev chat, 20% off services |
  | Business+ | $2,999/mo | Dedicated support, custom patches, 35% off services |
  | Enterprise | $5,900/mo | 2-business-day guaranteed response |
  | Enterprise+ | $11,900/mo | 1-business-day response, roadmap influence, services included |

  The top tiers are deliberately scarce ("only 1 remaining").
- **Filippo Valsorda / Geomys** (retainer model): eight named clients (Latacora, Tailscale, Teleport, Ava Labs, SandboxAQ and others) pay monthly retainers for maintenance of a *portfolio* plus Slack Connect access to the maintainers. He frames it as enterprise sales against the "north of a million dollars per year" cost of hiring three senior engineers. Amounts are not disclosed **[verified]** ([Geomys post](https://words.filippo.io/geomys/)).
- **A natural product in this repo [judgment]:** `backend/migration/` is a Wiki.js 2.5.x → 3.0 importer. Wiki.js 2.x has a large installed base and its 3.0 has been "coming" for years. A fixed-price **"migrate your Wiki.js 2.x (or Confluence) wiki to Cardinal.js"** service is the most concrete paid offer available right now.

**How to structure a statement of work (SOW) [judgment, standard practice]:**
- Master services agreement (MSA) plus a short SOW for each engagement.
- Fixed scope with acceptance criteria.
- Milestone billing, e.g. 50% up front and 50% on acceptance.
- Upstreaming clause: "work product is contributed to Cardinal.js under AGPL-3.0; client receives no exclusive rights". This protects the project and avoids an employer-style IP assignment.
- Liability cap equal to fees paid; no consequential damages.
- Change-order process; stated support period for the delivered work.
- Customer-specific integration code that is never released can stay private to that customer. Under AGPL §13 the customer is the one who must offer source to its own network users, and only if it modified the program.

**Pricing a support subscription for a self-hosted product [judgment]:**
- Anchors: BookStack at £450 and £4,500 per year; Docmost Business at $720/yr minimum (10 seats × $6 × 12); Nextcloud at €69–€205 per user per year with a 100-user minimum.
- Suggested Cardinal.js ladder:
  - **Community**: free
  - **Standard**: about $500–$900 per instance per year (email support, 2 business-day response, upgrade help)
  - **Business**: about $3,000–$6,000 per year (1 business-day response, up to 3 instances, SSO and auth-provider help, a few hours of calls)
  - **Sovereign/Public-sector**: $10k+ per year, custom (named contact, security advisories under embargo, LTS branch, invoice/PO/tender paperwork)
- Price per instance or per organization, not per user. It is easier to verify, and it matches BookStack and XWiki.
- Keep response-time promises to what you can meet with a day job. Commit to business days, never 24/7.

### 1.9 Marketplace and one-click hosting programs

| Platform | Pays upstream? | Terms found | Confidence |
|---|---|---|---|
| **Railway** | Yes, cash | Template Kickback: 15% of the usage cost of deployments from your template, plus 10% (25% total) for supporting users via the Template Queue. Only public marketplace templates qualify. Payout as Railway credits or cash via Stripe Connect ($100–$10,000 withdrawals; not available in Brazil, China or Russia). Open Source & Technology Partner program for **open source or open-core** projects: the same 15%/25% on verified templates, and technology partners also earn commission on *other people's* templates that use their technology. A limited-time $1M promotion paid 50%. | **[verified]** [kickback docs](https://docs.railway.com/templates/kickbacks), [partner docs](https://docs.railway.com/templates/partners), [$1M blog](https://blog.railway.com/p/1M-open-source-kickbacks) |
| **PikaPods** | Yes | Homepage says "20% revenue share with project authors where possible". Apps with a green heart share revenue. You have to email them; there are no public terms. Other sources quote 10–15%. PikaPods says many projects can't take part because "the authorship is unclear (forked many times)" or they can't issue invoices. **[judgment]** For Cardinal.js, a fork of an app PikaPods may already list, you should expect that authorship question and be ready to show you are the active maintainer. | **[verified 20% on homepage; 10–15% figure unverified]** [pikapods.com](https://www.pikapods.com/), [Vikunja thread](https://community.vikunja.io/t/consider-pikapods-revenue-sharing/4629), [noted.lol](https://noted.lol/pikapods-instant-open-source-app-hosting/) |
| **Elestio** | Yes | Its own blog says "10% of all revenue is distributed to the open-source projects whose software we manage". Other coverage says partners get 20%. How to join isn't published. | **[unverified: 10% vs 20% conflict]** [Elestio blog](https://blog.elest.io/why-open-source/) |
| **Cloudron** | Discretionary | "Sponsors development of apps we use every day… as revenue allows"; invites projects to reach out. No formal share. App packaging takes at least a week plus maintenance, and apps need browser tests. | **[secondary]** [cloudron.io/opensource](https://www.cloudron.io/opensource.html), [forum](https://forum.cloudron.io/topic/9659/process-of-getting-into-the-appstore) |
| **DigitalOcean Marketplace** | No share on 1-Click apps found | Listing gives exposure; money only through your own SaaS add-on | **[secondary]** [DO docs](https://docs.digitalocean.com/products/marketplace/) |
| **Akamai/Linode Marketplace** | No | Users pay for compute plus any bring-your-own license | **[secondary]** [marketplace-apps repo](https://github.com/akamai-compute-marketplace/marketplace-apps) |
| Hetzner apps, Coolify one-click, Umbrel, CasaOS, TrueNAS apps, Unraid CA, YunoHost | None found | Distribution and visibility only; YunoHost is a non-profit | **[unverified: no revenue-share program found]** |

**[judgment]** The only programs that pay *today* without negotiation are Railway (and possibly PikaPods and Elestio after emailing them). Getting listed everywhere else is still worthwhile. Every self-hoster install becomes a potential support customer.

### 1.10 Certified and long-term-support (LTS) builds
- **HeroDevs "Never-Ending Support"** sells security patches for end-of-life OSS under a 14-day CVE SLA, shares revenue with original authors, and partners with the OpenJS Foundation for Node.js **[secondary]** ([HeroDevs](https://www.herodevs.com/support), [OpenJS](https://openjsf.org/blog/the-openjs-foundation-is-excited-to-share-that-nod)).
- **Rock-solid curl** (wolfSSL) is the solo-maintainer-adjacent version of the same idea.
- **[judgment]** For Cardinal.js, a paid LTS branch (security backports for 18–24 months) fits naturally inside a public-sector support tier. It only has value once there are releases people must stay on.

---

## 2. Legal constraints for an AGPL fork you don't fully own

> Talk to a lawyer who works on open-source licensing before selling anything license-shaped: Software Freedom Conservancy, a firm like Kate Downing's, or an EU counterpart such as ifrOSS in Germany. What follows is the landscape.

### 2.1 What you *can* do freely
- **Charge for anything that isn't a license to the code**: support, SLAs, hosting, consulting, training, migration, LTS maintenance, certification, and your time. AGPL §10: "you may not impose a license fee, royalty, or other charge for exercise of rights granted under this License." That rule bars charging for the *rights*. It does not bar charging for services or for a copy you distribute **[verified]** ([AGPL text via OSI](https://opensource.org/license/agpl-v3)).
- **Run it as a hosted service.** AGPL §13: "If you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network … an opportunity to receive the Corresponding Source of your version … at no charge" **[verified]**.
  - Practical compliance: a "Source code" link in the footer or About dialog pointing at the exact commit or tag deployed, *including any hosting-specific patches*.
  - Configuration and secrets are not source.
  - Separate programs that talk to it only over the network (billing, provisioning, monitoring) are not the "Program" and can stay closed **[judgment, widely held reading; see 2.2]**.
- **License your own *new, separable* works however you like**, as long as they are genuinely separate from the AGPL program (2.2).
- **Sell a copy.** Selling binaries or Docker images is allowed, but the buyer can redistribute them for free. That makes sales a convenience charge at most.

### 2.2 Can you sell a proprietary add-on or closed "enterprise edition"?
- **In-process modules.** Cardinal.js loads modules from `backend/modules/*` by dynamic `import()` into the same Node process, sharing the `WIKI` global and model objects.
  - The FSF's GPL FAQ (couldn't be fetched this session because gnu.org rate-limited every attempt; paraphrased from its long-standing text, **verify**: [GPL FAQ #GPLPlugins](https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins)) says that when a main program dynamically links plug-ins that call each other's functions and share data structures, they form a single combined program, which must be treated as an extension of both. Separate programs communicating at arm's length, via pipes, sockets or command-line arguments, are normally separate works.
  - **[judgment]** A closed module that imports Cardinal's models, runs inside its process and depends on its internal API is very likely a derivative or combined work. Its source would have to go under AGPL to anyone who receives it, and under §13 also to network users of the modified deployment. This is the "Docmost `ee/`" pattern.
- **Why Docmost can and you can't.** Docmost wrote essentially all of its code *and* collects a CLA from every contributor. As the copyright holder it can issue the same code under two licenses: AGPL for the community, and a commercial EE license that waives AGPL obligations for paying customers. Your fork contains mostly Requarks/Giard code licensed to you *only* under AGPL.
  - You cannot waive AGPL obligations on their code for a customer.
  - Any EE you build on top of it inherits their AGPL grant, not yours.
  - **[judgment]** A closed in-process EE carries real infringement risk against the upstream copyright holders. NGPixel is active, and Requarks holds the Wiki.js trademark.
- **Grey-zone options, all to check with a lawyer:**
  1. **A separate-process service** (e.g. a proprietary "compliance/audit export" daemon or an AI indexing sidecar) that talks to Cardinal only over a documented REST API. Stronger position, but the product becomes more complex and less integrated.
  2. **Proprietary content that isn't code**: templates, themes-as-assets, documentation, courses.
  3. **A "blocks" or client-side widget distributed separately.** Weak: blocks are delivered to browsers as JS and rely on the app. Assume AGPL applies.
  - **"License key" gating of AGPL code** is technically allowed, but anyone may strip it out and redistribute the result. It is a nudge, not protection. Compare Immich's honor-system product keys: $25 per user or $100 per server, lifetime, unlocking nothing **[verified]** ([Immich blog](https://immich.app/blog/immich-product-keys), [buy.immich.app](https://buy.immich.app/)).

### 2.3 Can you dual-license?
- **No, not the codebase.** Relicensing requires permission from every copyright holder whose expression remains. The FSF FAQ's long-standing answer (same fetch limitation, verify): someone who distributed under the GPL cannot later grant exclusive use, because the public already holds GPL rights that can't be withdrawn. AGPL §7 lets *you* remove additional permissions from your copies, but only copyright holders can add new ones.
- **The only route to dual licensing** would be one of:
  - a license grant from Requarks/Giard and every other upstream contributor (impractical), or
  - a clean-room rewrite of the upstream parts (enormous, and against the spirit of the fork).
- **[judgment]** Treat dual licensing as off the table.

### 2.4 CLA vs DCO for *new* contributions
- **DCO** (Developer Certificate of Origin, a `Signed-off-by` line): certifies the contributor had the right to submit the code. It grants no relicensing rights. Low friction, and the norm in Linux-style projects. OpenStack replaced its CLA with a DCO in May 2025 ([OpenStack TC resolution](https://governance.openstack.org/tc/resolutions/20250520-replace-the-cla-with-dco-for-all-contributions.html)).
- **CLA** (Contributor License Agreement; broad copyright license or assignment to you): enables future relicensing and commercial licensing of *contributors'* code. It creates friction and is often read as a sign of a future license change. MongoDB used CLA rights to move to SSPL in 2018/2019 ([opensource.com](https://opensource.com/article/18/3/cla-vs-dco-whats-difference), [consortiuminfo](https://consortiuminfo.org/open-source/all-about-clas-and-dcos/)).
- **The Gitea precedent.** Gitea's maintainers moved its trademark and domains to a for-profit company without asking the community (Oct 2022). Codeberg forked it as **Forgejo** (Dec 2022), which later went AGPL/GPL and sits under a non-profit e.V. ([LWN](https://lwn.net/Articles/963095/), [Christian Tietze](https://christiantietze.de/posts/2022/11/gitea-ltd-takes-over-open-source-community-pushes-back/)).
  - **[judgment]** For a fork-of-a-fork, that is a vivid warning. Commercial moves perceived as enclosing the commons get forked away.
- **[judgment]** A CLA wouldn't help you much, because it only covers code written from now on, and upstream's code stays AGPL-only regardless. Adopt a **DCO**, state that the project stays AGPL, and make money from services. If you ever want the *option* of licensing your own future modules commercially, an inbound=outbound DCO plus keeping those modules in a separate repository you alone write is cleaner than a CLA.

### 2.5 Trademark
- **Why it matters.** Under AGPL anyone can host Cardinal.js. The *name* is what you can control, and it is the real commercial moat for hosting and support ("Official Cardinal.js Cloud", "Certified Cardinal.js support").
  - Examples: Plausible and Ghost rely on their brands; Forgejo placed its trademark with a non-profit to prevent capture.
- **US registration.** Since Jan 18, 2025 the USPTO base application costs **$350 per class**, with surcharges of $100 for incomplete information, $200 for free-form descriptions not in the ID Manual, and $200 per extra 1,000 characters **[verified via law-firm summaries]** ([Vorys](https://www.vorys.com/publication-new-uspto-trademark-fees-for-2025-what-you-need-to-know), [USPTO](https://www.uspto.gov/trademarks/additional-fees-trademark-applications)). Likely classes are 9 (downloadable software) and 42 (SaaS and hosting), so budget about $700+ plus attorney fees.
- **Clearance first.** "Cardinal" is a common word with existing tech marks (e.g. Cardinal Intellectual Property, the historical Cardinal Technologies) ([search](https://en.wikipedia.org/wiki/Cardinal_Technologies)). No specific wiki-software conflict was found **[unverified; this is not a clearance search]**. Get a knockout search in classes 9 and 42 before investing in the brand. "Cardinal.js" as a compound helps.
- **EU.** EUIPO filing is €850 for one class online (**[unverified this session]**, known published fee).
- **Avoid** using "Wiki.js" in product or marketing names except for factual compatibility statements ("migrates from Wiki.js 2.x"). Requarks owns that brand.
- **Publish a trademark policy**, e.g. modeled on Mozilla's or Forgejo's: forks must rename, and hosts may say "runs Cardinal.js" but not "Official".

---

## 3. Public money and foundation funding (status as of Sept 2026)

| Fund | Status and amount | Eligibility | Fit for Cardinal.js |
|---|---|---|---|
| **NLnet / NGI Zero** | NGI Zero Commons Fund's **13th and final call closed June 1, 2026**. NLnet paused open calls in June 2026 to take stock and transition to the **Open Internet Stack**: **Restack**, **CodeSupply** and **ELFA**, launching "after the summer". The NLnet site banner shows the **next deadline as November 3, 2026**. Under the Commons Fund, first proposals were up to €50k, max €150k per proposal, €500k lifetime; Restack is described as €5k–€50k grants through 2030, scalable. Only NGI Taler and NGI Fediversity stayed open during the pause. **[verified]** | Grants go to "individuals, companies, NGOs or other legal entities"; a "European dimension" is required; all outputs must be under a recognized open-source license. | **Best public-money fit**: sovereignty, commons, and an interoperable alternative to Confluence. A US-based individual needs a credible European angle (EU users, EU public-sector pilots, standards and interoperability work, EU co-applicant) **[judgment; whether US individuals qualify is unverified]**. Propose concrete, milestone-based work, e.g. accessibility audit, federation, the Confluence importer, security hardening. [stocktaking post](https://nlnet.nl/news/2026/20260612-NGIZero-stocktaking.html), [guide](https://nlnet.nl/commonsfund/guideforapplicants/), [April 2026 awards](https://nlnet.nl/news/2026/20260409-announce-commons-fund.html) |
| **Sovereign Tech Agency (Germany): Fund** | Investments from €50k with no fixed cap; **not looking for user-facing applications**; doesn't fund prototypes. **[secondary]** | Critical, foundational, non-user-facing technology | **Poor fit** (end-user app) **[judgment]**. [STF](https://www.sovereign.tech/programs/fund) |
| **Sovereign Tech Fellowship** | 2026 applications closed April 6, 2026; 14 fellows. Employment €64k–€82k/yr, 2-year contracts, Germany work authorization required. **Freelance 3–12 months, 6–32 h/week, worldwide**, hourly rate negotiated. **[secondary; sovereign.tech returned 403 to fetch]** | Maintainers of *critical* OSS; community managers; technical writers | **Poor fit now** (criticality bar) [judgment]. [2026 call](https://www.sovereign.tech/news/2026-fellowship-applications-open), [2026 fellows](https://www.sovereign.tech/news/meet-the-2026-sovereign-tech-fellows) |
| **Prototype Fund (Germany)** | Up to €47,500 over 6 months plus a second stage up to €31,667; next round applications Oct 1 – Nov 30, 2026 **[secondary]** | **Residents of Germany** (individuals or teams up to 4) | Only if you or a co-applicant live in Germany. [prototypefund.de](https://www.prototypefund.de/en/funding) |
| **FLOSS/fund (Zerodha)** | $1M/yr. 2025: $325k first tranche (9 projects; Krita got $50k) plus $675k second. Another $1M planned for 2026. Grants in $10k steps, then multiples of $25k, max **$100k/yr** per project **[verified]** | Individuals may apply. Needs a `funding.json` manifest. Targets **"existing, widely used, and impactful projects"**; new or low-usage projects excluded. Reviewed quarterly. | **Not yet.** Publish `funding.json` now at no cost, apply once there's measurable adoption. [FAQ](https://floss.fund/faq/), [first tranche](https://floss.fund/blog/update-2025-may/), [2025 report](https://zerodha.com/open-source/2025-report/) |
| **Open Technology Fund: FOSS Sustainability Fund** | $10k–$900k contracts (most $50k–$200k); round deadline May 7, 2026 **[secondary]** | Software released ≥3 years; ≥4 updates/yr; substantial active users; mission of internet freedom and anti-censorship | **Poor fit** (mission and maturity) [judgment]. [OTF](https://www.opentech.fund/funds/free-and-open-source-software-sustainability-fund/) |
| **Mozilla** | MOSS on **indefinite hiatus** since the 2020 restructuring; Mozilla Technology Fund themes are AI/environment and change yearly **[secondary]** | — | Poor fit. [mozilla.org/moss](https://www.mozilla.org/en-US/moss/) |
| **GitHub Secure Open Source Fund** | $10k per project ($6k/$2k/$2k tranches) plus Azure credits; 3-week security program (15 h) with check-ins at 6 and 12 months; rolling applications **[secondary]** | Projects with meaningful dependents or usage | **Plausible later**. Security hardening of a wiki with auth, SSO and uploads is a legitimate pitch. [GitHub SOSF](https://github.com/open-source/github-secure-open-source-fund) |
| **Alpha-Omega / OpenSSF** | $12.5M new money in March 2026 (Anthropic, AWS, GitHub, Google, Microsoft, OpenAI…); 70+ grants, $20M+ historically, mostly ecosystems and registries **[secondary]** | Critical infrastructure | Poor fit. [LF press release](https://www.linuxfoundation.org/press/linux-foundation-announces-12.5-million-in-grant-funding-from-leading-organizations-to-advance-open-source-security) |
| **thanks.dev** | Donors' money flows across their dependency tree up to 3 levels deep, weighted by usage; maintainers register to claim **[secondary]** | Packages that appear in dependency manifests | Poor fit: an app is not a dependency. [thanks.dev](https://thanks.dev/) |
| **Open Source Pledge / FOSS Funders** | Companies pledge ≥$2,000 per full-time developer per year. 25+ firms gave $2.58M by March 2025; Sentry reports $4.5M paid by Pledge members in 2025 **[secondary]** | Money goes to what member companies *depend on* | Indirect: target Pledge members who self-host a wiki. [opensourcepledge.com](https://opensourcepledge.com/about/), [Sentry blog](https://blog.sentry.io/another-year-another-750-000-to-open-source-maintainers) |
| **Google Summer of Code** | 185 organizations in 2026; organization gets **$500 per contributor** (plus Mentor Summit travel); contributors get stipends **[secondary]** | Organization must be accepted; requires mentoring capacity | Gets you free contributor labor, not income; mentoring costs time. [GSoC blog](https://opensource.googleblog.com/2026/02/introducing-the-185-organizations-for-gsoc-2026.html), [org payments](https://developers.google.com/open-source/gsoc/help/org-payments) |
| **EU / public-sector procurement** | Horizon Europe WP 2026–27 adopted (€14B overall); NGI continues via the Open Internet Stack. Germany's **openDesk** (ZenDiS) already chose **XWiki** as its wiki; France's **La Suite numérique** built its own **Docs** with Germany and the Netherlands, used by 500k+ agents monthly. **[secondary]** | Tenders, not grants | **[judgment]** Real demand, but those slots are taken by EU vendors. Your realistic entry is subcontracting to or partnering with an EU integrator, or offering a Confluence→Cardinal migration path, not winning a tender as a US individual. [openDesk](https://www.opendesk.eu/en/about), [La Suite](https://github.com/suitenumerique), [OSOR funding list](https://interoperable-europe.ec.europa.eu/collection/open-source-observatory-osor/funding-opportunities-open-source-software-projects-public-sector) |

---

## 4. Enterprise sponsorship and contract work

- **How solo maintainers actually land corporate money** (patterns from the case studies):
  1. **Publish a price list.** Caddy's ladder runs $25 → $11,900/mo, and the top tiers bundle guaranteed response times and roadmap influence **[verified]**. Companies can't buy "donate"; they can buy "Business+ support".
  2. **Sell a portfolio or retainer, not a feature.** Geomys sells ongoing maintenance and expert access against the cost of hiring engineers **[verified]**.
  3. **Look like a going concern.** BookStack added support plans specifically because companies feared abandonment **[verified]**.
  4. **Work inside a company that sells support.** Stenberg at wolfSSL **[verified]**.
  5. **Recognition helps**, e.g. Stenberg's 2025 European Open Source Achievement Award and IVA Gold Medal **[secondary]**, but only after decades of work.
- **Tidelift**: acquired by **Sonar** (announced Dec 2024), which promised "no immediate planned changes" for maintainers ("lifters"). Pays based on subscriber usage and package importance. **[secondary]** The program's 2026 status couldn't be confirmed **[unverified]**. It targets *packages* inside customers' software bills of materials (SBOMs), so it's a poor fit for an application. ([Sonar press](https://www.sonarsource.com/company/press-releases/sonar-to-acquire-tidelift/), [lifter payments](https://support.tidelift.com/hc/en-us/articles/4406294816916-How-we-pay-lifters))
- **Evan You**: Vue was long funded by Patreon and sponsors; he later raised a $4.6M seed for VoidZero (Accel), which Cloudflare acquired in 2026 along with a $1M Vite ecosystem fund **[secondary]**. The VC route doesn't apply to a side project.
- **Rates, SOW structure and support pricing**: see §1.8.
- **Where to find buyers [judgment]:**
  - Wiki.js 2.x admins stranded without a 3.0.
  - Confluence Data Center refugees: Atlassian ended Server and is pushing cloud, a well-known motivation for self-hosting. **[secondary/common knowledge; Atlassian's DC end-of-life dates not verified this session]**
  - EU sovereignty-minded SMEs and municipalities.
  - Companies on the Open Source Pledge list.
  - Hosting providers that want a sponsored integration.

---

## 5. Side-business practicalities (US default, with an EU note)

1. **Check your employment agreement first.**
   - California Labor Code §2870 (verbatim, [FindLaw](https://codes.findlaw.com/ca/labor-code/lab-sect-2870/)): an assignment clause "shall not apply to an invention that the employee developed entirely on his or her own time without using the employer's equipment, supplies, facilities, or trade secret information except for those inventions that either: (1) Relate … to the employer's business, or actual or demonstrably anticipated research or development of the employer; or (2) Result from any work performed by the employee for the employer." **[verified]**
   - Similar statutes exist in **Washington, Delaware, Illinois, Kansas, Minnesota, New Jersey, North Carolina, Utah, and New York** (NY, signed Sept 15, 2023). Most other states decide it by contract and common law **[secondary]** ([WSGR on NY](https://www.wsgr.com/en/insights/new-york-redefines-the-permissible-scope-of-invention-assignment-provisions.html), [OpenAgreements](https://openagreements.org/practice-guides/invention-assignment/us)).
   - **Action:**
     - Read your proprietary information and invention assignment agreement (PIIA), its moonlighting and conflict-of-interest policy, and any open-source contribution policy.
     - If your employer sells wiki, knowledge-management or collaboration software, the "relates to employer's business" exception can swallow the carve-out. Get **written** approval.
     - Never use employer laptops, accounts, AI subscriptions, or work hours.
2. **Entity.**
   - A single-member LLC gives liability separation; it is a disregarded entity for federal tax.
   - **California charges an $800/yr minimum franchise tax** plus a gross-receipts LLC fee **[secondary]** ([McCauley Law](https://mlotax.com/resources/state-business-taxes/california-franchise-tax)).
   - Common advice: a sole proprietorship is fine while you're just testing. Form the LLC before signing your first support or consulting contract or taking hosting customers, which is when liability becomes real **[secondary]**.
   - Forming in Wyoming or Delaware doesn't avoid your home state's fees if you operate from there **[judgment/common knowledge]**.
   - Keep a separate bank account, and sign contracts in the LLC's name.
3. **Taxes (US).** Self-employment tax applies to net profit; make quarterly estimated payments; donations and sponsorships are ordinary income, not gifts, when tied to your business. **[judgment/common knowledge; get a CPA]** Consider an S-corp election only once profit is well into five figures.
4. **Payments and merchant of record (MoR).**
   - **Paddle**: 5% + 50¢, handles global sales tax and VAT **[secondary]** ([Dodo](https://dodopayments.com/blogs/paddle-fees-explained)).
   - **Polar**: 5% + 50¢ on Starter, lower on paid plans **[secondary]**.
   - **Lemon Squeezy**: acquired by Stripe and folding into **Stripe Managed Payments** (public preview Feb 2026; +3.5% on top of Stripe fees, roughly 6.4% + 30¢ domestic) **[secondary]** ([Lemon Squeezy 2026 update](https://www.lemonsqueezy.com/blog/2026-update)).
   - Plain **Stripe** is cheapest, but then you handle US state sales tax on SaaS and EU VAT yourself.
   - **[judgment]** Use an MoR for self-serve subscriptions and hosting. Use Stripe invoices or bank transfer for B2B support contracts; business buyers self-account VAT under reverse charge.
5. **EU note.**
   - A non-EU seller owes VAT on **B2C** digital services **from the first euro** (no threshold), filed through the non-Union OSS scheme in one member state. B2B uses reverse charge with a validated VAT ID **[secondary]** ([Taxually](https://support.taxually.com/support/solutions/articles/80001155457-digital-services-vat-in-the-eu-non-union-oss)). An MoR removes this burden.
   - **If you live in the EU**, national rules apply: small-business VAT schemes, and Germany's Gewerbe registration and Nebentätigkeit approval from your employer.
   - EU public-sector buyers expect a GDPR data processing agreement (DPA) for any hosting, and increasingly Cyber Resilience Act (CRA) readiness. The CRA's obligations for commercial OSS "manufacturers" and "stewards" phase in from 2026–2027 **[judgment; CRA timelines not verified this session]**.
6. **Insurance.** Tech errors & omissions (E&O) insurance for software developers averages roughly $74–$111/mo (about $900–$1,330/yr), usually with $1M/$1M limits. Premiums range from about $400 to $7,000/yr **[secondary]** ([Insureon](https://www.insureon.com/technology-business-insurance/software-developers/cost), [TechInsurance](https://www.techinsurance.com/errors-omissions-insurance/cost)). Buy it before offering SLAs or hosting; add cyber liability if you host customer data.
7. **Contracts.**
   - Support terms: scope, exclusions, business-day response targets (not resolution guarantees), liability cap at 12 months of fees, no consequential damages, customer responsible for backups on self-hosted installs.
   - Hosting: terms of service plus a DPA, and an acceptable-use policy (AUP), because wikis host user content (DMCA agent registration in the US).
   - Consulting: MSA plus SOWs as in §1.8.
   - Standard templates (Common Paper, Bonterms) are reasonable starting points **[judgment]**.

---

## 6. Popularity thresholds, burnout, sustainability

### 6.1 When each model starts paying [judgment, calibrated against the data above]
Stars are a weak proxy. They correlate only moderately with real usage, and roughly 6M suspected fake stars exist across GitHub ([ICSE 2026 paper](https://cmustrudel.github.io/papers/icse2026fakestars.pdf)). Track **active instances** instead, e.g. through opt-in telemetry or a Docker pull count.

| Model | Rough viability signal | Evidence |
|---|---|---|
| Marketplace kickbacks (Railway, PikaPods) | From the first deployments, but only pocket money until hundreds of paid instances | Railway's promo shows $199k of user spend produced $66.5k of creator payouts at the 25% rate |
| Donations and GitHub Sponsors | Negligible below about 10k stars; about £2k/mo at BookStack's 19k stars after 11 years; Wiki.js at 29k stars reaches only ~4% of a $6k/mo goal | BookStack, NGPixel, Plausible's six $5 donations |
| Paid support | First contracts once organizations run it in production, often a few hundred active installs; BookStack's support is about £3.7k/mo | BookStack |
| Consulting / migration | Can start at **near-zero stars** if you target a stranded installed base (Wiki.js 2.x users) | [judgment] |
| Hosting (SaaS) | Break-even needs dozens of paying workspaces; meaningful at hundreds to thousands (Coolify: 3.4k+ cloud customers, about $10–30k MRR) | Coolify, Plausible |
| Grants (NLnet) | No popularity threshold, only a credible plan and a European dimension | NLnet |
| FLOSS/fund, OTF, GitHub SOSF | Need demonstrated adoption; OTF needs ≥3 years of releases | Stated criteria |

### 6.2 Burnout and sustainability lessons
- **Babel (2018–2021).** Henry Zhu went full-time funded through Open Collective at $11k/mo, with others at $2k/mo. Sponsors dropped away in 2020, pay fell to $6k/mo, and a public dispute over "fundraising vs coding" followed ([Babel funding update](https://babeljs.io/blog/2021/05/10/funding-update), [The Register](https://www.theregister.com/2021/05/12/babel_money_woes/)).
  - Lessons: fundraising is real work; sponsor money is cyclical; don't quit the day job on sponsorships alone.
- **core-js.** Enormous usage and collapsing donations; sanctions made payment rails fragile ([The Stack](https://www.thestack.technology/core-js-maintainer-denis-pusharev-license-broke-angry/)).
  - Lesson: popularity doesn't equal income. Diversify payment rails and income types.
- **faker.js / colors.js (Jan 2022).** Unpaid maintainer Marak Squires sabotaged both packages in protest ("Pay Me or Fork This"); GitHub reportedly suspended his account ([Snyk](https://snyk.io/blog/open-source-npm-packages-colors-faker/), [BleepingComputer](https://www.bleepingcomputer.com/news/security/dev-corrupts-npm-libs-colors-and-faker-breaking-thousands-of-apps/)).
  - Lesson: resentment destroys trust faster than it gets you paid. Set boundaries and prices *early*, before bitterness sets in.
- **xz-utils backdoor (CVE-2024-3094).** A 2.6-year social-engineering campaign exploited a burned-out solo maintainer. Sock-puppet accounts pressured him to add a co-maintainer, "Jia Tan", who then got commit and release rights ([Securelist](https://securelist.com/xz-backdoor-story-part-2-social-engineering/112476/), [OpenSSF-adjacent case study](https://sscsecurity.dev/book1/chapter-07/ch-7.5/)).
  - Lessons for a solo maintainer who will eventually want help:
    - Grant commit and release rights slowly.
    - Require signed commits and reproducible release builds.
    - Treat "you're too slow, add X as maintainer" pressure from brand-new accounts as a red flag.
    - Paid support creates an obligation to customers. Don't let it become pressure to hand off the keys.
- **Tidelift survey (2024).** 60% of maintainers are unpaid; about 60% have quit or considered quitting; paid maintainers are 55% more likely to follow critical security practices ([Tidelift/BusinessWire](https://www.businesswire.com/news/home/20240917030299/en/Tidelift-Study-Reveals-Paid-Open-Source-Maintainers-Do-Significantly-More-Critical-Security-and-Maintenance-Work-Than-Unpaid-Maintainers)).
- **AI-generated PR and report floods (2025–2026).** curl is "drowning in AI-assisted security reports" ([Victorino Group](https://victorinollc.com/thinking/curl-pressure-ai-report-flood)), and Algora bounties draw dozens of PRs within hours. **[judgment]** Budget triage time, and consider requiring an issue discussion before a PR.
- **[judgment] Rules for a day-job maintainer:**
  - Sell business-day response times only.
  - Cap consulting hours per month.
  - Keep the free community channel explicitly best-effort.
  - Publish a maintenance policy (supported versions, security contact).
  - Keep 3–6 months of any business commitments covered by cash before promising SLAs.

---

## 7. Ranked recommendation for this situation [judgment]

1. **Do now, zero or low cost.**
   - Replace the upstream-pointing `FUNDING.yml` with your own GitHub Sponsors and Liberapay.
   - Publish a `funding.json` for FLOSS/fund.
   - Apply for Railway's open-source partner program (15–25%) and email PikaPods and Elestio about their revenue shares.
   - Adopt a DCO.
   - Run a trademark knockout search on "Cardinal.js" in classes 9/42.
   - Read your employment agreement.
2. **First real income: fixed-price migration and consulting.** Offer "Wiki.js 2.x → Cardinal.js" and "Confluence → Cardinal.js" migrations plus custom auth and integration work at $150–$250/hr equivalent, as upstreamed-AGPL SOWs. It needs no installed base, it sells the importer you already built, and it carries no licensing risk.
3. **Paid support subscriptions (BookStack / Nextcloud style)** once organizations run it in production: about $500–$900/instance/yr Standard, $3–6k Business, $10k+ Sovereign with an LTS branch. Legally clean for a fork; the time commitment stays within day-job limits if response targets are in business days.
4. **Grant: NLnet's Open Internet Stack (Restack) call, Nov 3, 2026.** Pitch a €30–50k milestone plan (security hardening, accessibility, interoperability or import work). You need a genuine European dimension. GitHub SOSF ($10k) and FLOSS/fund come later, once adoption can be shown.
5. **Managed hosting later**, only if support demand proves the market. Start by partnering with Elestio or PikaPods rather than running your own on-call infrastructure; a branded "official cloud" needs an LLC, E&O and cyber insurance, a DPA, and the §13 source link.
6. **Avoid:** a closed in-process "enterprise edition", dual licensing, or BSL/relicensing (you don't hold upstream copyright), and CLA-driven relicensing plans (the Gitea/Forgejo precedent). Sponsorware only for separate, self-authored add-ons or content.
