# Cardinal.js launch research: channel mechanics + attack/crisis case studies

Research date: 2026-09-13. Method: live WebSearch/WebFetch. Reddit (www/old.reddit.com) and several
sites (selfh.st, dbtechreviews.com) refused direct fetches (blocked / HTTP 403), so some items
rely on secondary reporting and are marked. The session's web-search budget ran out before every
item was covered; anything not verified live is tagged **[UNVERIFIED]**. No rule or number here
is invented; where a source's date looks wrong, that is flagged.

Legend: **[V]** verified from primary source · **[S]** secondary source only · **[UNVERIFIED]** not checked live / from background knowledge.

---

## 0. Two facts that reshape the whole launch plan

1. **Upstream is not dead.** Wiki.js 3.0.0-beta.554 was released 2026-09-08 (beta.543 on
   2026-09-06), with active auth work (Entra, LDAP, SAML, Discord). Upstream still says "Not for
   production use" and gives no ETA. [S] https://github.com/requarks/wiki/releases ·
   https://github.com/requarks/wiki/releases/tag/3.0.0-beta.543
   → Framing like "fork of an abandoned/unreleased 3.x" will get fact-checked in the first HN
   comment. NGPixel is real and shipping, so the fork has to justify itself on its own
   differences, not on upstream being stalled.
2. **An AI-built self-hosted app is launching into peak hostility toward AI-built self-hosted
   apps.** Huntarr (Feb 2026) is the incident every commenter will cite (§B1). HN restricted Show
   HN for newer accounts in March 2026 and added "no AI-generated/AI-edited comments" to its
   guidelines. awesome-selfhosted bans rule-breaking LLM-generated contributions. selfh.st's
   curator ignores LLM-written submissions.

---

# PART A — Launch channel mechanics

## A1. Hacker News / Show HN

**Rules [V]** https://news.ycombinator.com/showhn.html
- Show HN is "for something you've made that other people can play with". It must be something
  people can try: no blog posts, sign-up pages, newsletters, lists, landing pages or fundraisers.
- Non-trivial ("avoid quickly-generated one-offs"), your own work, with you around to discuss it.
- "Please make it easy for users to try your thing out, ideally without barriers." A live demo
  or a one-command Docker start matters.
- Version bumps ("Foo 1.3.1 is out") usually don't qualify; major overhauls may.
- Title starts with "Show HN". Posts show on /shownew first and move to /show after a points
  threshold.

**General guidelines [V]** https://news.ycombinator.com/newsguidelines.html
- "Don't post generated text or AI-edited text. HN is for conversation between humans." This
  covers the launch post body and every reply you write in the thread. Answering commenters with
  Claude-drafted text is a real risk here: it gets flagged and the post killed.
- "Please don't use HN primarily for promotion." "Don't solicit upvotes, comments, or
  submissions." (Asking your network for upvotes triggers the voting-ring detector.)
- No uppercase or exclamation marks, don't editorialize, crop gratuitous numbers.
- Coverage of the AI-comment rule: https://cybernews.com/ai-news/hacker-news-bans-ai-generated-and-edited-comments/ ·
  https://news.ycombinator.com/item?id=47340079 [S]

**2026 restrictions on Show HN [S]**
- dang: `/showlim` is "what many accounts without much HN history now see" and is "responsible
  for the downtick" in Show HN submissions. It rolled out around March 2026, after "Ask HN: Please
  restrict new accounts from posting" (Mar 2026, ~515 comments).
  https://news.ycombinator.com/item?id=47866332 ·
  https://keydiscussions.com/2026/03/09/hacker-news-moves-toward-restricting-show-hn-posts-amid-the-ai-slop-wave/
- The exact thresholds behind /showlim (account age, karma) were **not found [UNVERIFIED]**.
  Practical implication: post from an account with real HN history, or build history first.
- Volume data (Arthur Cnops, 2026-02-17): Show HN grew from ~1,200/month (Feb 2023) to ~4,800
  (Jan 2026), ~15.2% of all stories. ~37.2% of Show HNs get exactly 1 point (26.2% for other
  stories). Average front-page stay ~2.9h at US peak; ~3.1 comments per post.
  https://www.arthurcnops.blog/death-of-show-hn/ · HN discussion https://news.ycombinator.com/item?id=47045804
- Someone scored ~1,400 Show HN pages for "AI design patterns". Generic AI-looking landing pages
  are now a recognised negative signal. https://www.adriankrebs.ch/blog/design-slop/

**Timing [S]**: no consensus. Weekday 9am–12pm ET gets the biggest audience. A June 2025 analysis
of 23k posts favoured Sunday 00:00–01:00 PT for less competition. Another analysis found Sunday
06:00 UTC 2.5× more likely to reach the front page than Wednesday 09:00 UTC. Every source agrees
title, topic and early discussion matter more than the hour.
https://syften.com/blog/hacker-news-marketing/ · https://blog.alcazarsec.com/tech/posts/best-time-to-post-on-hacker-news ·
https://chanind.github.io/2019/05/07/best-time-to-submit-to-hacker-news.html

**Case studies**
- **Docmost** (AGPL Confluence/Notion alternative, direct competitor): "Show HN: I am building an
  open-source Confluence and Notion alternative", 2024-06-29, **551 points / 217 comments** [V].
  Themes: accessibility (a screen-reader user offered an audit), Postgres TOAST/WAL concerns for
  collaborative docs, self-host vs SaaS viability, feature gaps (PDF export, diagrams, OIDC/SSO,
  API, Markdown), comparisons to XWiki/Outline/BookStack/MkDocs, Docker onboarding.
  https://news.ycombinator.com/item?id=40832146 · later thread https://news.ycombinator.com/item?id=47826580
- **BookStack** Show HN (2022): https://news.ycombinator.com/item?id=29851834 (not fetched; points [UNVERIFIED])
- **Hoarder (now Karakeep)**: "Hoarder: Self-hostable bookmark-everything app", 2024-12-24, **475
  points / 106 comments**, posted by a third party, not the author [V]. Some commenters wrote it
  off on seeing "AI". The author calmly explained AI was optional and could run locally via
  Ollama. https://news.ycombinator.com/item?id=42485746 · earlier https://news.ycombinator.com/item?id=39830651
- **Linkwarden**: Show HN 2023 https://news.ycombinator.com/item?id=36942308; a 2025 non-Show post
  https://news.ycombinator.com/item?id=43856801 (points [UNVERIFIED]).
- Immich, Plausible and Memos launch threads were **not retrieved** (search budget exhausted)
  [UNVERIFIED]. Pattern visible across the retrieved cases: a clear "X alternative" title,
  AGPL/self-host framing, and the author answering technical critique directly and in their own words.

## A2. Reddit

**r/selfhosted.** Reddit blocked direct fetches of the rules page, so the exact current wording is
**[UNVERIFIED]**. Rule text needs manual verification before posting.
- HowToGeek reports: "The moderators of Reddit's r/selfhosted introduced a recurring 'Vibe Code
  Friday' thread after AI-generated self-hosted projects became common enough to overflow regular
  discussions." [S] https://www.howtogeek.com/vibe-hosting-is-officially-the-new-self-hosting/
  (Whether this restricts AI-built project posts to that thread, and whether it still runs, is [UNVERIFIED].)
- Self-Host Weekly (2026-09-04): an "AI-assisted" tag for projects "has been temporarily dropped as
  too many users are confusing 'AI-assisted' for 'vibe coded'", and "a new methodology for tagging
  projects" is due "in the next week or two". [S via search snippet; page returned 403] https://selfh.st/weekly/2026-09-04/
  It is **ambiguous whether that tag belongs to r/selfhosted or selfh.st's own directory**. The
  newsletter is written by selfh.st's curator, who is not an r/selfhosted mod as far as I could verify.
  The **disclosure/tagging methodology is actively changing in mid-September 2026**. Check it the
  week of launch.
- The same newsletter: LLM-generated text used "to communicate or submit content ... will be
  ignored" (the curator "cannot stomach the LLM-isms"). [S] This is a selfh.st submission rule.
- The Huntarr disclosure itself was posted on r/selfhosted, and the community told users to shut
  it down and rotate keys (§B1). Expect mods and regulars to scrutinise any new AI-built app that
  holds credentials.
- Self-promotion ratio / "New Project Friday" / megathread rules: **[UNVERIFIED]**. None of the
  searches confirmed a "New Project Friday" distinct from "Vibe Code Friday".

**Other subreddits**
- r/opensource: reportedly treats "All AI-generated content [as] low-effort and ban worthy". [S]
- r/rust: requires project submissions to certify no "significant AI-generated content". [S] (not a Cardinal target, but shows the direction)
  Source for both: https://dev.to/madsendev/i-built-something-good-with-ai-now-some-developer-communities-dont-want-to-see-it-20mo
  (the fetch reported a 2024-07-26 date, which conflicts with the 2026 HN changes it describes; treat the date as a parsing error.)
- r/sysadmin, r/homelab, r/devops, r/Confluence, r/wikijs, r/docker: rules **not retrieved [UNVERIFIED]**.
  r/wikijs is upstream's community. Posting a fork announcement there will read as poaching unless
  its mods approve it first.

## A3. Curated lists and directories

**awesome-selfhosted [V]** https://github.com/awesome-selfhosted/awesome-selfhosted-data/blob/master/CONTRIBUTING.md
- "first released more than **4 months** ago", with tagged releases (dev versions alone don't count).
- Must be actively maintained; no activity for 6–12 months → may be removed.
- FOSS license (SPDX).
- **"Machine/LLM-generated contributions, that do not respect project guidelines are not allowed
  and will result in a ban."** Write the PR/YAML by hand.
- Submit via `software/<name>.yml` PR (template in `.github/ISSUE_TEMPLATES/addition.md`) or an issue.
- Excludes cloud-dependent software, libraries/SDKs, and "Dockerization" ports of existing apps.
  A fork should be fine if it is a distinct project, but maintainers may question it while
  upstream is also listed [UNVERIFIED how they treat forks].
- **Implication:** the 4-month clock starts at the first tagged release. Cut a 3.x tag early.

**selfh.st** (newsletter + apps directory). The criteria page returned 403. The search snippets
retrieved describe the *companions* directory ("extend the functionality of a self-hosted project";
"not a core service of the original project"). The main apps directory covers open- and
closed-source self-hosted apps. https://selfh.st/apps/ · https://selfh.st/apps-about/ ·
https://selfh.st/post/introducing-selfhst-apps/ [S]. Main-directory criteria: [UNVERIFIED]. The
curator ignores LLM-written submissions (§A2).

**Lobsters [V]** https://lobste.rs/about
- Invite-only. New users (first 70 days) can't use the `show` tag or submit new domains.
- "Self-promo should be less than a quarter of one's stories and comments."
- Spam includes "content that is created without meaningful human authorship". Banning a spammer
  can also cost their inviter the ability to invite.

**Product Hunt [S]**: still used for OSS dev tools in 2026. PH's own 2026 roundup highlights OSS
successes (OpenClaw, InsForge #1 Product of the Day). One solo OSS launch at #14 of the day got
"ten new GitHub stars". Real results depend on audience-building beforehand. Low relevance for a
self-hosted wiki audience.
https://www.producthunt.com/p/github/best-open-source-products-launched-on-product-hunt-in-2026 ·
https://upword-rahil.medium.com/i-launched-an-open-source-tool-on-product-hunt-with-no-budget-no-team-and-no-audience-4429fe45e395 ·
https://dev.to/fmerian/5-awesome-oss-products-launched-on-product-hunt-in-2026-2p9

**Changelog News [V]**: public submission form (sign-in required) https://changelog.com/news/submit

**AlternativeTo, console.dev, dev.to/Hashnode, LinkedIn, Mastodon/fosstodon, Bluesky**: not
retrieved live [UNVERIFIED]. (console.dev/about returned 404.) Known in general: AlternativeTo lets
anyone add an app and link it as an alternative to Confluence/Wiki.js/Notion. console.dev is an
editorially selected devtools newsletter (current submission process [UNVERIFIED]).

## A4. Creators and podcasts

- **FLOSS Weekly** is active on Hackaday (ep. 881, 2026-09-09) and interviews OSS projects. [V]
  https://hackaday.com/tag/floss-weekly/ · https://hackaday.com/2026/09/09/floss-weekly-episode-881-eating-its-own-tail/
- **Self-Hosted** (Jupiter Broadcasting) has episodes listed into at least March 2026. Whether it
  is still active in September 2026 is [UNVERIFIED]. https://selfhosted.show/ ·
  https://www.jupiterbroadcasting.com/show/self-hosted/
- **DB Tech** published "Before you trust another selfhosted app read this" (2026-04-13) about
  Huntarr. Self-hosting YouTubers are now openly vetting security. https://dbtechreviews.com/2026/04/13/before-you-trust-another-selfhosted-app-read-this/ [S; page 403]
- Techno Tim, Jim's Garage, Christian Lempa, Lawrence Systems, NetworkChuck, Wolfgang's Channel,
  Hardware Haven, VirtualizationHowto, Noted.lol, Marius Hosting, Linux Unplugged, Console DevTools
  podcast: **not researched live [UNVERIFIED]**.

## A5. One-click and app-store distribution

| Channel | Requirement found | Status |
|---|---|---|
| **Coolify** | Repo "must have at least **1,000 GitHub stars**"; pinned image versions (no `latest`); matching docs PR required; SVG logo preferred | [V] https://coolify.io/docs/get-started/contribute/service |
| **Dokploy** | PR to Dokploy/templates with `docker-compose.yml`, `template.toml`, `blueprints/<id>/meta.json`, logo; use `expose` not `ports`; no `container_name`; auto preview deploy per PR; no star threshold stated | [V] https://github.com/Dokploy/templates |
| **TrueNAS** | Community train only; prefer `ghcr.io` images; must define `run_as_context` with **non-root** user (uid/gid 568 suggested); complete app.yaml/README | [V] https://github.com/truenas/apps/blob/master/CONTRIBUTIONS.md |
| **Unraid CA** | Public, active repo with valid XML templates; OSI license on the repo contents; `ca_profile.xml` with non-empty Profile; live scan and duplicate check at submit | [S] https://ca.unraid.net/submit · https://docs.unraid.net/community-applications/ |
| **Umbrel** | "App Store Standard": usable from the browser after install (web UI/setup/login, no SSH/CLI/manual file edits), sensible defaults, predictable updates; contribution guidance lives in AGENTS.md and `.claude/skills/` (Umbrel steers contributors to coding agents) | [V] https://github.com/getumbrel/umbrel-apps |
| **YunoHost** | Free-software upstreams only; integration level 0–8 assigned by CI | [S] https://doc.yunohost.org/dev/packaging/publish/ · https://github.com/YunoHost/apps |
| **PikaPods** | Web app on one HTTPS port; low CPU/bandwidth; no abuse potential; license allows self-hosting; must not compete with the author's own paid hosting; official Docker image; actively developed with security fixes. Request/vote on feedback board | [V] https://docs.pikapods.com/faq/apps · https://feedback.pikapods.com/ |
| **Cloudron** | App requests via forum "App Wishlist"; community apps are unreviewed | [S] https://forum.cloudron.io/category/5/app-requests |
| **Proxmox community-scripts** | New scripts go to **ProxmoxVED**; "PRs with new scripts opened directly against this repo will be closed"; there is a security/review policy. Popularity threshold / AI policy not found | [V] https://github.com/community-scripts/ProxmoxVE · https://github.com/community-scripts/ProxmoxVED |
| CasaOS, Railway/Render templates, DigitalOcean Marketplace, Elestio, Artifact Hub (Helm) | Not researched live | [UNVERIFIED] |
| Docker Hub vs GHCR | TrueNAS prefers GHCR (above). Docker Hub typosquatting is well documented (§B4), so publish under one canonical namespace and reserve the Docker Hub name even if you use GHCR | [V]/[S] |

Note: Cardinal's `dev/build/Dockerfile` exists, but the Helm chart was deleted from this repo.
Artifact Hub is only relevant once a chart exists.

## A6. SEO and comparison pages

- **Nominative fair use [S]**: you may name a competitor to identify or compare it if (1) the
  product isn't readily identifiable without the mark, (2) you use only as much of the mark as
  needed (the word, not the logo or trade dress), and (3) nothing suggests sponsorship or
  endorsement. Comparisons must be truthful. https://en.wikipedia.org/wiki/Nominative_use ·
  https://www.inta.org/fact-sheets/fair-use-of-trademarks-intended-for-a-non-legal-audience/ ·
  https://www.nolo.com/legal-encyclopedia/when-you-need-permission-use-trademarks.html (US law; EU "comparative advertising" rules differ [UNVERIFIED detail])
- **Docmost already owns "Wiki.js alternatives" content**: https://docmost.com/blog/wikijs-alternatives/ and
  https://docmost.com/blog/open-source-confluence-alternatives/ [S]. Also G2, SaaSHub, Slashdot and
  AlternativeTo "Wiki.js alternatives" pages. That is the competitive SERP a Cardinal comparison page enters.
- **Requarks trademark**: no published Wiki.js trademark or logo policy was found (only a
  discussion about using the logo, https://github.com/requarks/wiki/discussions/4018) [S]. No
  policy ≠ no rights. Unregistered/common-law marks still exist [UNVERIFIED registration status].
  Renaming to Cardinal.js is the right defensive move (see the Vaultwarden precedent, §B2). Never
  use the Wiki.js logo, and don't title anything "Wiki.js 3" or "Wiki.js Community Edition".

## A7. Conferences and events

- **FOSDEM 2027** [V]: 30–31 January 2027, ULB Solbosch, Brussels. Call for devrooms open
  **4 Oct – 7 Dec 2026** (dates as given by search snippet; confirm on page). Devroom talk CfPs
  open ~late October. https://fosdem.org/2027/news/call-for-devrooms/ ·
  https://fosdem.org/2027/news/fosdem-2027-dates/
- SCALE 2027, All Things Open, Open Source Summit, EU public-sector events (e.g. OSOR/Open Source
  Observatory events): **not retrieved** (search budget exhausted) [UNVERIFIED].

---

# PART B — Attacks and crisis case studies

## B1. Backlash against AI-generated OSS

**Huntarr (Feb 2026), the defining self-hosted incident**
- A researcher reviewed Huntarr 9.4.2 and reported 7 critical and 6 high findings. One
  unauthenticated API call returned every *arr API key in cleartext. Also: plaintext passwords in
  SQLite, 2FA bypass without credentials, root container, unauthenticated setup reset,
  unauthenticated 2FA enrollment, ZIP slip / path traversal running as root. [S]
  https://gigcitygeek.com/2026/03/08/huntarr-api-security-risk/ · https://learn.g2.com/huntarr-security-vulnerability
- Disclosure: a public GitHub write-up plus a Reddit (r/selfhosted) post that "gained rapid
  traction within hours" (G2 article dated 2026-02-26). [S]
- **Maintainer response, the cautionary part**: posts on r/huntarr were removed, the reviewer was
  banned from that subreddit, threads with the maintainer's security claims were deleted, then
  r/huntarr went private and the repo was deleted or made private. No advisory or patch had been
  published as of the G2 article. [S] DB Tech's verdict: "That's how you respond when the brand
  matters more than the users."
- Community framing: "one person, no review process, no testing pipeline, and no security
  practices", "vibe-coded security theater". Solo maintainer + AI-built + holds other services'
  credentials is exactly Cardinal's profile: auth strategies, S3/Azure/GCS/SFTP/git storage
  credentials, API keys, an MCP server.
- **What would have defused it** (inverse of Huntarr, consistent with the OpenSSF/GitHub guidance
  in §B3): thank the reporter publicly, open a GHSA, ship fixes, publish an advisory and CVE, never
  delete criticism, and document what changed in the review process.

**Hacker News**: the AI-comment ban plus /showlim (§A1). Claude Code's leaked "undercover mode"
(Mar 2026) drew HN criticism that it hides AI authorship in OSS commits. Others argued it mostly
prevents internal codename leaks. Either way, *hiding* AI involvement is now the thing that draws
fire. [S] https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/ ·
https://blog.kilo.ai/p/claude-code-source-leak-a-timeline
→ Cardinal's commits already carry `Co-Authored-By: Claude` trailers. That is verifiable
disclosure. Say so up front rather than letting someone "discover" it.

**curl and AI slop reports [S]**: curl ended its HackerOne bug bounty (submissions accepted until
2026-01-31). The confirmed-vulnerability rate had fallen from >15% to <5%. Stenberg: "our attempt
to remove the incentives for submitting made-up lies". Snippets say curl **returned to HackerOne in
March 2026** [S, single-source, verify].
https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/ ·
https://www.theregister.com/security/2026/01/21/curl-shutters-bug-bounty-program-to-stop-ai-slop/5063039 ·
https://www.bleepingcomputer.com/news/security/curl-ending-bug-bounty-program-after-flood-of-ai-slop-reports/
→ Implication: don't launch with a cash bounty. Expect AI-generated "vulnerability reports" and
require a PoC.

**Disclosure norms that emerged [S/V]**
- Three policy families (2024–2026): outright bans (NetBSD, Gentoo, QEMU, Zig, GIMP), human-in-the-loop
  disclosure (Ghostty and others), and structural closure. https://codenote.net/en/posts/oss-ai-slop-contribution-policy-shift/ ·
  https://www.tomshardware.com/software/linux/linux-distros-ban-tainted-ai-generated-code ·
  https://github.com/melissawm/open-source-ai-contribution-policies ·
  academic surveys https://arxiv.org/html/2609.07542 · https://arxiv.org/html/2605.16706
- **Ghostty AI_POLICY.md [V]**: "All AI usage in any form must be disclosed" (tool plus extent);
  "The human-in-the-loop must fully understand all code"; no AI-generated media; "Bad AI drivers
  will be denounced"; **maintainers exempt**. https://github.com/ghostty-org/ghostty/blob/main/AI_POLICY.md
  → A published AI_POLICY.md is now a recognised trust artefact. Cardinal would effectively be the
  inverse case: an AI-first maintainer who discloses everything and shows the verification
  gates (tests, typecheck, CI-in-container) as proof of review.

## B2. Hostile and hard fork dramas

- **Forgejo vs Gitea [S]**: soft fork Oct 2022 after a for-profit company took over Gitea; hard
  fork Feb 2024 (after 1.21). Moved to GPL (overall project) in Aug 2024 so its code couldn't flow
  back into commercially controlled Gitea. Governed under Codeberg e.V. Received well because of
  the non-profit governance story and a public comparison page.
  https://forgejo.org/2024-02-forking-forward/ · https://forgejo.org/compare-to-gitea/
- **OpenTofu vs HashiCorp [V]**: HashiCorp's C&D (2024-04-03) alleged code taken from BSL Terraform
  (the "removed blocks" feature) and relabelled. OpenTofu published a detailed rebuttal on 2024-04-11
  showing the code came from older MPL-2.0 code, which HashiCorp had itself copied. They also
  published the redacted C&D. OpenTF had renamed to OpenTofu in Sept 2023.
  https://opentofu.org/blog/our-response-to-hashicorps-cease-and-desist/ ·
  https://opentofu.github.io/legal-documents/2024-04-03%20HashiCorp%20C&D/OpenTofu%20C&D%20-%20Redacted.pdf ·
  https://thenewstack.io/opentofu-project-denies-hashicorps-allegations-of-code-theft/
  → Lesson: keep provenance airtight and be able to show it (which upstream commit/branch each
  file came from, under AGPL). Respond with evidence, calmly, after taking time to prepare.
- **Valkey vs Redis [S]**: Redis moved to RSALv2/SSPLv1 (Mar 2024). The Linux Foundation announced
  Valkey within a week, backed by AWS/Google/Oracle/Ericsson/Snap. Redis added AGPLv3 in Redis 8
  (2025-05-01), widely seen as "too little too late". Percona reports 83% of large enterprises
  adopted or were exploring Valkey.
  https://www.percona.com/blog/community-erosion-post-license-change-quantifying-the-power-of-open-source/ ·
  https://www.infoq.com/news/2025/05/redis-agpl-license
  → Forks win when upstream *broke trust* (license change, corporate capture). Cardinal has no such
  grievance: upstream is still AGPL and active. It has to win on technical merit and pace.
  Framing it as grievance would backfire.
- **Vaultwarden (formerly bitwarden_rs) [S]**: renamed April 2021 (v1.21.0) "due to user confusion
  and to avoid any possible trademark/brand issues". Bitwarden's guidelines restrict use of the name.
  https://github.com/dani-garcia/vaultwarden/discussions/1642 · https://vaultwarden.discourse.group/t/note-v1-21-0-release-and-project-rename-to-vaultwarden/862
- General: forks keeping the upstream name with a "-community" suffix have received C&Ds; OSS
  licenses don't grant trademark rights. https://dev.to/alanwest/why-your-open-source-fork-can-get-a-cease-and-desist-and-how-to-fix-it-15k1 ·
  https://lwn.net/Articles/673677/ · https://www.termsfeed.com/blog/open-source-trademark/
- LibreOffice/OpenOffice (2010), io.js/Node (2014–15 reconciliation), Nextcloud/ownCloud (2016),
  MariaDB/MySQL (2009), Mastodon forks (glitch-soc, Hometown; Gab's fork and the AGPL-compliance
  pressure on it): background knowledge only, **not re-verified this session [UNVERIFIED]**.
  Common thread: forks led by original core contributors or neutral foundations were accepted. A
  fork by an outsider with no upstream contributions has to earn legitimacy through
  transparency and shipping.
- **Wiki forks**: no public community fork of Wiki.js 3.x was found in search [S]. Cardinal may be
  the first, so there's no precedent for how upstream or its community will react.

## B3. Security incident handling for small projects

- **GitHub Private Vulnerability Reporting + Repository Security Advisories [V/S]**: researchers
  report via the Security tab. Maintainers get a private draft advisory and temporary private fork
  to fix in. GitHub is a CNA and can assign a CVE (review "usually within 72 hours"; requesting one
  doesn't publish the advisory).
  https://docs.github.com/code-security/security-advisories/repository-security-advisories/about-repository-security-advisories ·
  https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/publishing-a-repository-security-advisory ·
  https://github.blog/security/vulnerability-research/a-maintainers-guide-to-vulnerability-disclosure-github-tools-to-make-it-simple/ ·
  https://github.blog/security/vulnerability-research/coordinated-vulnerability-disclosure-cvd-open-source-projects/
- **OpenSSF CVD guide [S]**: maintainer guide, runbook, SECURITY.md and embargo/disclosure templates.
  https://oss-vulnerability-guide.openssf.org/ · https://github.com/ossf/oss-vulnerability-guide/blob/main/maintainer-guide.md ·
  https://github.com/ossf/project-template/blob/main/SECURITY.md
- Bad handling: Huntarr (§B1). Good handling: OpenTofu's evidence-based public response (§B2), a
  legal case but the same pattern.
- Note: Cardinal's repo has `.github/SECURITY.md` inherited from upstream, carrying a note about it.
  Before launch it must point at *Cardinal's* reporting channel, not Requarks'.

## B4. Supply-chain attacks

- **xz utils (CVE-2024-3094) [S]**: "Jia Tan" contributed from Jan 2022 and gained commit and then
  release-manager rights. Sock-puppet accounts pressured the exhausted maintainer ("Why not pass on
  maintainership?"). Backdoor commits from Jan 2024, xz 5.6.0 on 2024-02-24, found by Andres Freund
  on 2024-03-29 via 500ms SSH logins. https://en.wikipedia.org/wiki/XZ_Utils_backdoor ·
  https://sscsecurity.dev/book1/chapter-07/ch-7.5/
  → A solo maintainer who is the only human reviewer is the exact profile targeted. Be wary of
  eager co-maintainer offers and pressure campaigns.
- **npm, Sept 2025 [V/S]**: chalk/debug and ~18 other packages compromised on 2025-09-08 after a
  maintainer was phished via a fake `npmjs.help` email that captured credentials plus a live TOTP.
  The **Shai-Hulud** self-propagating worm followed on 2025-09-15, harvesting CI secrets and
  republishing packages (500+ packages removed). CISA alert on 2025-09-23. A "Shai-Hulud 2.0" wave
  came later in 2025.
  https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem ·
  https://unit42.paloaltonetworks.com/npm-supply-chain-attack/ ·
  https://blog.checkpoint.com/research/shai-hulud-2-0-inside-the-second-coming-the-most-aggressive-npm-supply-chain-attack-of-2025/
- **2026 waves [S]**: TeamPCP CI/CD campaign (Mar 2026: trivy-action 75/76 tags poisoned, kics
  action, 66+ npm packages, from one incompletely rotated PAT). node-gyp compromise (Jun 2026).
  **keyv/cacheable (2026-08-04)**: maintainer's GitHub account taken over, the worm spread to 400+
  packages, and **poisoned versions carried valid GitHub Actions provenance**. Microsoft "ChainDrop"
  analysis (2026-08-04).
  https://www.wiz.io/blog/keyv-and-cacheable-npm-supply-chain-attack ·
  https://www.microsoft.com/en-us/security/blog/2026/08/04/chaindrop-supply-chain-compromise-anatomy-self-propagating-worm/ ·
  https://snyk.io/blog/node-gyp-supply-chain-compromise-self-propagating-npm-worm-binding-gyp/ ·
  https://phoenix.security/accelerating-supply-chain-attacks-npm-pypi-vsx-ai-enabled-2026/
- **GitHub/npm platform responses 2026 [V]** https://github.blog/security/supply-chain-security/disrupting-supply-chain-attacks-on-npm-and-github-actions/
  npm 72h read-only mode after 2FA/email changes on high-impact accounts; staged publishing with
  extra 2FA approval (May 2026); **npm v12 disables install scripts by default** (Jun 2026);
  Dependabot 3-day cooldown default (Jul 2026); Actions cache read-only for untrusted workflows;
  safer `checkout` defaults; workflow execution policies.
- **tj-actions/changed-files (CVE-2025-30066) [V/S]**: tags retroactively repointed to a malicious
  commit (~2025-03-14) that dumped secrets into logs. Likely enabled by reviewdog/action-setup@v1
  (CVE-2025-30154, 2025-03-11). Fixed in v46.0.1. Mitigation: pin actions to full commit SHAs,
  verify pinned commits, rotate exposed secrets.
  https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction ·
  https://www.wiz.io/blog/github-action-tj-actions-changed-files-supply-chain-attack-cve-2025-30066 ·
  https://github.com/advisories/ghsa-mrrh-fwg8-r2c3
  → Cardinal's `build.yml` pushes to GHCR from `scarlett`. Check whether its actions are SHA-pinned [not checked this session].
- **Docker Hub typosquatting [S]**: >1,650 malicious images impersonating popular projects (Aqua,
  2023). ~70% of 2,500+ confirmed malicious images are cryptominers. Typosquats like `mongdb` and
  `ngingx` reached ~17k pulls. https://www.bleepingcomputer.com/news/security/docker-hub-repositories-hide-over-1-650-malicious-containers/ ·
  https://www.sysdig.com/blog/analysis-of-supply-chain-attacks-through-public-docker-images ·
  https://blog.qualys.com/product-tech/2026/01/22/public-container-registry-security-risks-malicious-images
  → Reserve `cardinal`/`cardinaljs` style namespaces on Docker Hub even if GHCR is canonical, and sign images [cosign/provenance: not researched].

## B5. Toxicity, burnout and fake stars

- **Burnout and entitlement [S]**: ~60% of maintainers unpaid; 60% have quit or considered it;
  44% cite burnout (State of Open 2025 coverage). Hector Martin (Asahi) quit in 2025 citing burnout
  and demanding users. https://www.theregister.com/2025/02/16/open_source_maintainers_state_of_open/ ·
  https://mirandaheath.website/static/oss_burnout_report_mh_25.pdf ·
  https://opensource.guide/maintaining-balance-for-open-source-maintainers/
  → A launch spike creates an issue flood. Have issue templates, a "support vs bug" split and a
  published response-time expectation ready.
- **Fake stars (StarScout, CMU/Socket/NCSU; ICSE 2026) [S]**: ~6M suspected fake stars, ~18.6k
  repos, ~301k accounts (2019–2024). Campaigns grew two orders of magnitude in 2024, peaking at 16%
  of star-active repos (Jul 2024). GitHub deleted ~91% of flagged repos and 62% of flagged accounts
  by Oct 2024. Detection: low-activity default-avatar accounts starring in lockstep.
  https://arxiv.org/html/2412.13459v2 · https://cmustrudel.github.io/papers/icse2026fakestars.pdf ·
  https://sc.cs.cmu.edu/news/2025/0903-github-stars.html · detector tool https://github.com/mercurialsolo/realstars
  → Never buy stars or run star-for-star exchanges. A spike of lockstep stars (even from a
  well-meaning share in a Discord) can be flagged and publicly called out.
- Astroturfing / brigading case studies specific to self-hosted launches: **not found this session [UNVERIFIED]**.
  HN's "don't solicit upvotes" rule and voting-ring detection (§A1) apply.

## B6. Public demo instance abuse

- **Kaneo (May 2026) [V]**: an open-signup hosted instance was abused. 949 bot accounts with
  throwaway emails in 3 hours created workspaces named with phishing subject lines and sent
  **14,520 invitations** through the developer's verified sending domain. Detected only via Resend's
  quota alert. Fixes: CAPTCHA on signup, disposable-email blocking, invite endpoint rate limits,
  workspace-name filtering, no invites from guests.
  https://andrej.sh/posts/phishing-through-my-open-source-project · HN https://news.ycombinator.com/item?id=48322753
  → Cardinal has open registration, invite/notification mail, page comments, file uploads (asset
  hosting = phishing/malware hosting), a public MCP endpoint and outbound fetchers (diagram
  rendering, Kroki/PlantUML, Iconify). A public demo should have registration and mail disabled,
  read-only or scheduled resets, upload limits, and no SMTP on a domain you care about.
- General demo abuse (link injection, crawler load): https://dev.to/arina_cholee/tired-of-your-open-source-demo-site-breaking-this-free-tool-keeps-it-stable-without-any-maintenance-4h8b [S]

---

## Gaps to close manually before launch
1. r/selfhosted's current rules verbatim (sidebar, the "Vibe Code Friday" thread status, and the new AI tagging methodology due ~mid/late Sept 2026).
2. r/opensource, r/sysadmin, r/homelab, r/devops, r/docker, r/wikijs rules.
3. HN /showlim thresholds.
4. selfh.st apps directory criteria (page 403'd).
5. SCALE / All Things Open / Open Source Summit / EU public-sector CfP dates.
6. CasaOS, Railway, Render, DO Marketplace, Elestio, Artifact Hub requirements.
7. YouTuber and podcast contact norms.
8. Whether Cardinal's GitHub Actions are SHA-pinned; whether `.github/SECURITY.md` points to Cardinal.
