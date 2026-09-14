# GTM 09 — Threat Register & Response Playbooks

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md). Case studies:
[`gtm-research/research-launch-attacks.md`](gtm-research/research-launch-attacks.md).

Likelihood and impact are *judgment* for the first 12 months after launch. Every playbook follows the
same shape: **Prepare** (before it happens) → **Detect** → **First hour** → **First week** → **Never**.

---

## 0. Universal rules for any crisis

1. **Users first, reputation second.** Huntarr's maintainer protected the brand over the users and lost both.
2. **Never delete criticism.** Lock a thread only for abuse, and say why.
3. **Acknowledge fast, conclude slow.** A holding reply within hours; facts when you have them.
4. **One authoritative place** for updates (a GitHub advisory or pinned discussion), linked from everywhere.
5. **Write it yourself, calmly, after a pause.** Not at midnight. Not AI-drafted in community venues.
6. **Evidence beats adjectives** (OpenTofu's C&D rebuttal is the model).
7. **Keep a private incident log** — timestamps, decisions, who you told.

---

## 1. Threat register

| ID | Threat | Likelihood | Impact | Prep status |
|---|---|---|---|---|
| **P1** | Critical vulnerability disclosed (responsibly or publicly) | **High** | **Severe** | Not ready — no private reporting, SECURITY.md points to Requarks |
| **P2** | "Vibe-coded slop" pile-on (HN/Reddit/YouTube) | **High** | High | Not ready — no AI_POLICY, no security review |
| **P3** | Upstream/NGPixel public objection, or trademark complaint | Medium | High | Partly — renamed; branding residue remains |
| **P4** | Upstream ships 3.0 GA and/or a 2.x importer | **Medium-High, within ~2–4 months** (re-rated 2026-09-13: confirmed tagged-prerelease cadence + 10/13 of his own "3.0" milestone closed) | High | Strategy exists (doc 02 §6); Cardinal's own launch date is now fixed (doc 00 §2, doc 04) specifically to land ahead of this |
| **P5** | Upstream or competitors absorb Cardinal's differentiators | Medium | Medium | Moats defined (doc 00 §2) |
| **P6** | Competitor SEO/marketing attack (Docmost, tela comparison pages) | Medium | Medium | No compare pages yet |
| **P7** | Supply-chain compromise (account takeover, poisoned image/release, CI secret theft) | Medium | **Severe** | Partly — SHA-pinned Actions + provenance; accounts/registry hygiene unverified |
| **P8** | Public demo abuse (phishing, malware hosting, defacement, crawler load) | **High** if open | Medium | Not ready — no demo yet |
| **P9** | Importer loses/corrupts a production wiki | Medium | High | Partly — dry-run/verify exist; silent losses documented |
| **P10** | Entitled users, harassment, toxic threads | **High** | Medium | Not ready — CoC contact is upstream's |
| **P11** | xz-style social-engineering for maintainer access | Low | **Severe** | Not ready — no governance doc |
| **P12** | Fake-star / astroturf accusation | Low-medium | Medium | OK if you never solicit |
| **P13** | Name/trademark conflict over "Cardinal" | Medium | High | Not ready — no clearance search |
| **P14** | Maintainer burnout, day-job conflict, bus factor | **High** | **Severe** | Not ready |
| **P15** | AI-generated issue/PR/security-report floods | **High** | Medium | Not ready |
| **P16** | AGPL-compliance accusation (notices, funding, source offer) | Medium | High | Partly — `docs/legal/` exists, actions open |
| **P17** | Commercial freeloading / pressure for free enterprise support | **High** | Low-medium | Doc 08 price sheet |
| **P18** | Someone hosts "Cardinal Cloud" commercially / hostile fork of Cardinal | Low-medium | Medium | Trademark policy needed |
| **P19** | Regulatory obligations (EU Cyber Resilience Act for commercial activity, GDPR for hosting) | Medium (2027) | Medium | Not started |
| **P20** | Chronic red trunk / broken release reaches users | Medium | High | History says likely without discipline |
| **P21** | "Fork erased the original author" / "scrubbed the AI commits" after the history reset | Medium (**High** if full flatten) | High | Depends on D13 (doc 10) |

---

## 2. Playbooks

### P1 — Security vulnerability

**Prepare**
- GitHub private vulnerability reporting on; SECURITY.md with scope, business-day acknowledgement target,
  90-day default disclosure, CVE via GitHub CNA; `security.txt`.
- External security review before launch (doc 04 B2); regression tests for upstream's historical CVE
  classes (priv-esc via group validation, SVG/MIME XSS, path traversal, disabled-user reset bypass).
- Advisory template, severity rubric (CVSS), a private fork workflow rehearsed once.
- Know your blast radius per surface: SSO secrets in settings, storage credentials, API keys, MCP tools,
  custom blocks, collab websocket.

**Detect:** private report · public GitHub issue · Reddit/HN post · a scanner/CVE feed · user reporting odd behaviour.

**First hour**
- Private report: acknowledge ("Received, thank you, investigating; update within N business days").
- **Public disclosure without warning:** do not argue about process. Post in the thread: "Thank you —
  confirmed we're investigating now. Updates at [advisory link]. If you run Cardinal exposed to the
  internet, [interim mitigation, if any]." Open the draft advisory immediately.
- Assess exploitability; if actively exploitable, publish mitigation *now* (config toggle, WAF rule,
  disable feature), even before a fix.

**First week**
- Fix on the private fork, regression test, patched release, advisory with CVE, credit the reporter
  prominently. Notify support customers per the embargo policy.
- Post-mortem (public, short): root cause class, how it got past review, what process changed.

**Never:** delete or lock criticism; ban the reporter; "no user data was affected" before you know; quiet
fixes without an advisory; threats of legal action against good-faith researchers.

### P2 — "Vibe-coded slop" pile-on

**Prepare**
- Disclose first: README, AI_POLICY, "How Cardinal is built" page (doc 03 §6).
- Have the verification story ready with *links*: CI config, test counts, security review, advisories.
- Know the honest weak spots (`ngpixel-field-notes.md`: duplicate filings, same-day broken features,
  formatter gate exit 0) and fix the ones that are cheap before anyone finds them.

**Detect:** HN top comment; Reddit thread title; YouTube video; a "code review" blog post of your repo.

**First hour**
- One reply, in your own words: acknowledge the concern as legitimate; state the disclosure; point to
  verification evidence; invite specific technical criticism; offer to fix anything concrete they found.
- If they found a real bug: thank them, file it publicly, fix it fast.

**First week**
- If a substantive critique (e.g. a code-review post) exists: respond with a public "what we changed"
  write-up. Treat it like a free audit.
- Don't relitigate every thread. Shipping fixes is the rebuttal.

**Never:** claim "every line human-reviewed"; attack the critic; brigade; say "NGPixel uses Claude too" as a
defence (true per their FAQ, reads as deflection); hide or rewrite the Co-Authored-By history.

### P3 — Upstream objection or trademark complaint

**Prepare**
- Finish all branding/legal residue (doc 04 A5–A6) — the most likely *legitimate* complaint.
- Courtesy note before launch (D5).
- Provenance: fork point commit `d0c5a8bfa`, NOTICE, AGPL §5(a) statement, source link with revision.
- A lawyer's name you can call (Software Freedom Conservancy can point to resources; a trademark attorney
  for the name).

**Detect:** NGPixel post/comment; email from Requarks; GitHub DMCA notice; community thread "is this legit?"

**First hour**
- **Public criticism from NGPixel:** read twice, wait. Reply once, briefly and warmly: thank them for
  Wiki.js; acknowledge any valid point and state what you'll change; correct factual errors once with
  links; no rebuttal of opinions. Then do not reply again in that thread.
- **Trademark/brand complaint:** acknowledge receipt; ask for specifics if vague; don't admit liability;
  consult counsel before substantive reply.
- **DMCA takedown on GitHub:** don't counter-notice without counsel; publish a factual note that the repo
  is temporarily unavailable and why; mirror status to Codeberg only if counsel agrees.

**First week**
- Comply quickly with anything reasonable (wording, logo remnants, "Wiki.js" in names/metadata).
- If a demand is unreasonable (e.g. to stop existing as an AGPL fork): counsel; an evidence-based public
  response only if necessary, OpenTofu-style (publish the letter redacted, the provenance, the license).

**Never:** mock or characterise NGPixel; mobilise your community against them; make "they're
threatened by us" the story.

### P4 — Upstream ships 3.0 GA and/or a 2.x importer

**Prepare:** vs-3.x matrix kept current; migration quality metrics (all 5 DBs, fidelity report, shim) that
outperform a first-version importer; governance/agent/support messaging already live. This is now the
single biggest reason Cardinal's launch date is fixed rather than gate-driven (doc 00 §2, doc 04) — the
goal is to be the one already established when this happens, not the one still in quiet preview.

**First day:** sincere public congratulations. Update compare pages with the GA facts (including where
upstream wins). Test their importer against your corpus privately.

**First month:** shift headline from "the only way off 2.x" to "the best way off 2.x, for every
database, with support" and to governance/agents; publish the fidelity comparison only if you win
honestly.

**Never:** "rushed", "half-baked", or any quality insinuation without reproducible evidence.

### P5 — Differentiators absorbed

**Prepare:** moats that aren't code (doc 00 §2); ship depth, not checkboxes.
**Response:** thank publicly; point out it's AGPL working as intended; move the frontier (next importer,
next governance feature, better support).
**Never:** accuse anyone of "stealing" AGPL code that was properly attributed. If attribution is missing,
ask politely and privately first.

### P6 — Competitor marketing attack

**Prepare:** your own dated compare pages; a corrections process ("spot an error? open an issue").
**Response:** if a competitor page is factually wrong, email them once with sources and a polite request;
update your own page; never engage in public spats. Out-publish, don't out-argue.
**Never:** brigade their GitHub discussions (e.g. Docmost's 2FA paywall thread).

### P7 — Supply-chain compromise

**Prepare**
- Hardware-key 2FA on GitHub, Docker Hub, registrar, DNS, email; no SMS 2FA; unique passwords.
- Phishing hygiene: treat any "urgent 2FA reset" email as hostile (chalk/debug were compromised via a fake
  `npmjs.help` domain capturing a live TOTP).
- Branch protection, required reviews for workflow-file changes, CODEOWNERS on `.github/`.
- Actions SHA-pinned (done) + Dependabot cooldown; least-privilege `GITHUB_TOKEN` per job; no long-lived PATs;
  OIDC for registries where possible.
- Signed tags, cosign-signed images, provenance attestations (exists), published verification instructions.
- Reserve Docker Hub namespace to block typosquats; publish the canonical image name on the security page.
- Recovery: documented steps to rotate every secret; a second trusted org owner.

**Detect:** unexpected release/tag; image digest mismatch vs provenance; GitHub security log alerts; user
reports of odd network traffic; registry notifications.

**First hour:** revoke sessions/tokens; lock the org; pull or deprecate poisoned tags/images; post a
security advisory with affected digests and safe versions; rotate *every* secret (TeamPCP 2026: one
incompletely rotated PAT enabled the second wave).

**First week:** forensic timeline; clean rebuild from verified commit; publish full post-mortem; notify
catalogs/partners that mirror your images.

**Never:** re-publish over the same tag silently; assume provenance means safe (keyv 2026 had valid
provenance on poisoned versions).

### P8 — Demo abuse

**Prepare:** read-only guest demo + a sandbox that resets hourly; registration, mail, uploads, outbound
fetchers (diagram/icon/live-data) off or allowlisted; rate limits; no SMTP on your main domain; robots
noindex on the sandbox; separate VPS with nothing else on it.
**First hour:** flip to read-only; purge content; block abusive ranges; if phishing was hosted, report to
the hosting provider and Google Safe Browsing yourself before someone reports you.
**Never:** leave an open-signup instance with outbound mail on a domain you care about (Kaneo: 14,520
phishing invites in 3 hours).

### P9 — Importer data-loss incident

**Prepare:** the importer never writes to the source (verify and state it); dry-run and verify steps
prominent; rehearsal-on-a-copy as the documented default; corpus tests; a "migration incident" issue form.
**First hour:** help the user first — confirm their source is untouched; get the dry-run + error report;
advise rollback (keep 2.x running).
**First week:** reproduce, fix, add to corpus, release; advisory if others may be affected; add detection
to dry-run.
**Never:** blame the user's data in public; promise recovery you can't deliver.

### P10 — Entitlement, harassment, toxic threads

**Prepare:** CoC with your enforcement contact; saved "boundary" replies; moderation tools configured
(interaction limits, lock, hide).
**Response ladder:** (1) one kind boundary reply; (2) hide/lock with reason; (3) temporary block; (4)
permanent block + platform report; (5) threats → document, report, authorities.
**Never:** debate in public at length; tolerate abuse from "important" users; respond while angry.

### P11 — Social-engineered maintainer takeover (xz pattern)

**Prepare:** `GOVERNANCE.md` with slow, criteria-based commit access; releases only by you (or two-person
rule later); no one gets release or CI secret access for ≥ 12 months of track record; watch for
coordinated pressure ("you're too slow, add X") from new accounts.
**Response:** decline politely; don't let guilt or pace pressure drive access decisions.

### P12 — Fake-star / astroturf accusation

**Prepare:** never solicit stars or upvotes; never run star exchanges; tell friends not to "help" in
coordinated bursts; keep launch-traffic referrer data.
**Response:** publish referrer/traffic data; invite GitHub to review; ignore after one reply.

### P13 — Name conflict

**Prepare:** knockout search before assets (doc 04 A2); keep a runner-up name cleared; product name
decoupled from the domain in code (config-driven branding) so a rename is days, not weeks.
**Response:** counsel; if the claim is credible, rename early and loudly ("we're renaming to avoid
confusion") — Vaultwarden's rename is remembered positively.

### P14 — Burnout, day-job conflict, bus factor

**Prepare:** time budget (doc 07 §2); written continuity plan; a second org owner; employment agreement
cleared; business-day-only commitments.
**Signals:** doc 07 §9.
**Response:** announce a maintenance mode period honestly ("security fixes only for 4 weeks"); pause
services intake; delegate triage to a trusted volunteer. A planned pause is survivable; a silent
disappearance is fatal.

### P15 — AI-generated report/PR floods

**Prepare:** discuss-before-PR for non-trivial changes; issue forms requiring repro; security reports
require PoC; no cash bug bounty at launch (curl ended theirs after valid rates fell below 5%).
**Response:** template-close unverifiable reports; rate-limit via GitHub interaction limits during
floods; publish the policy.

### P16 — AGPL-compliance accusation

**Prepare:** close every `docs/legal/07-recommended-actions.md` item; NOTICE; exact source link in the
running app (§13); OCI labels; third-party notices in images.
**Response:** thank the reporter; fix within days; changelog entry "license compliance fix"; never argue
that "nobody reads notices."

### P17 — Commercial freeloading

**Prepare:** price sheet (doc 08); support boundary templates.
**Response:** "Happy to help in public on best-effort terms — if you need it faster or privately, here's
how support works." Say it once, without resentment.

### P18 — Commercial hosting by others / hostile fork of Cardinal

**Prepare:** trademark policy (hosts may say "runs Cardinal", not "Official"); §13 obligations explained
on a page; your own "official" partner program.
**Response:** if AGPL §13 source isn't offered, ask politely, then escalate with counsel; if the name is
misused, trademark process. A respectful fork of Cardinal is AGPL working — wish them well.

### P19 — Regulation (CRA, GDPR)

**Prepare (2027):** once you monetise, you may count as a "manufacturer" or open-source steward under the
EU Cyber Resilience Act for EU-distributed commercial offerings — get advice before selling support/hosting
to EU customers at scale; keep SBOMs, a vulnerability handling process (P1) and security update policy —
most of which you need anyway. Hosting requires a DPA and GDPR processes.

### P20 — Broken release reaches users

**Prepare:** release gates (doc 04 B8, `docs/release-checklist.md`); rehearsed rollback (images by digest;
DB migration notes); release candidates for a week before major releases.
**First hour:** pull the release from "latest"; pinned discussion with workaround; hotfix.
**Never:** "works on my machine"; releasing on a Friday evening.

### P21 — History-reset attribution attack

**Prepare:** choose the graft method (doc 10 §2 B) so upstream authorship stays verifiable in git; the
squash commit names `requarks/wiki@d0c5a8bfa` and carries the AI disclosure; README "History" section;
NOTICE + AUTHORS; a private offline `git bundle` of the pre-reset repo as your own evidence.
**Detect:** "git blame says he wrote everything"; "where did the Claude commits go?"
**Response:** one reply with links: the upstream fork-point commit, NOTICE/AUTHORS, the README history
note, AI_POLICY. State the reason for the reset plainly (a clean start on a new host, internal tracker
noise removed) and that nothing about authorship or AI use was hidden.
**Never:** claim the original history never existed; claim the work wasn't AI-assisted.

---

## 3. Holding statements (fill in, rewrite in your voice — never paste verbatim into HN/Reddit)

**Security (public disclosure):** "Thanks for reporting this. We've confirmed it and are working on a fix
now. Follow [advisory link] for updates and mitigations. If you run Cardinal on the internet, [interim
step]. We'll credit the reporter in the advisory."

**Upstream criticism:** "Thank you for Wiki.js — Cardinal wouldn't exist without it. You're right about
[X]; we've [changed/filed] it. On [factual point], here's the current state: [link]. Appreciate you
taking the time to look."

**AI criticism:** "Fair question. Cardinal is built by one maintainer directing AI agents, disclosed in
every commit and in [AI_POLICY]. What keeps that honest is [gates + security review links]. If you've
found something concrete, I'd genuinely like to see it — I'll fix it."

**Migration incident:** "Sorry this happened. Your Wiki.js 2.x database isn't modified by the importer,
so your original is intact — please keep it running. Can you share the dry-run and error report here or
privately at [channel]? I'm looking at it today."

**Pausing:** "I'm taking [N weeks] to recover from [launch/work]. Security reports will still be handled
within [N] business days; everything else resumes on [date]."
