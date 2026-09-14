# Field Notes From the Guy Whose Repo You're Standing On

*Written in-character as NGPixel (Nicolas Giard), Wiki.js's actual maintainer, auditing this fork
as an outsider. This is not upstream commentary that ships with Wiki.js, was not written by or
reviewed by Nicolas Giard, and speaks for no one but this exercise. Every specific figure,
commit hash, work-package ID, and file citation below was pulled directly from this repository's
own git history, source tree, and its own OpenProject project on 2026-09-13 — cite the sources,
not the crank, if you want to argue with them.*

---

I said my piece already. Then someone went and actually pulled the numbers I was guessing at, and
it turns out I was being generous.

## 1. You didn't fork a wiki, you forked a compiler for spec documents

`CLAUDE.md` is **1,567 lines** and **16,673 words** — longer than most modules of the product it
describes. I said this before and I'll say it again with feeling, because everything below is what
happens when the rulebook gets that thick and the thing enforcing it isn't a person reading the
file next to the one they're editing.

## 2. The bureaucracy has its own bureaucracy, and even the audit tool can't count it

I asked someone to pull the real numbers from the project-management system tracking this fork's
own work. Here's what came back from `wiki-js-3-0`, project id 8:

- **47 Epics** (44 closed), **385 Features** (382 closed), **~117 Issues**.
- **Tasks: more than 500 closed, zero open** — and I mean *more than 500* literally, because the
  query used to count them hit its own row cap and came back `truncated: true`. The tool built to
  audit this project's bureaucracy cannot count past 500 in a single pass.
- **Bugs: more than 500 closed** — same cap, same `truncated: true` — against exactly **one** open
  Bug right now.

That's a floor of roughly **1,550 work packages**, for a wiki, forked a month ago, with zero
tagged releases. I run Wiki.js on a GitHub issue tracker that a human being reads. You built a
six-stage lifecycle state machine — discovery, spec, breakdown, implementation, review, release,
per Epic and per Feature separately — and generated enough tickets to overflow the very API built
to summarize them.

And here's the part that should actually worry you: `get_project_health` reports **zero** blocked
items and **zero** stale items, right now, across the whole project. Not because everything's
healthy. Because nothing sits still long enough to register as stale before the next overnight run
either closes it or buries it under three more tickets. A tracker with a thousand-plus closed items
and nothing ever aging is not a sign of a well-oiled machine. It's a sign the machine closes things
faster than anyone could possibly be reviewing them.

## 3. The tracker doesn't trust the tracker

I went looking for whether any of this process overhead actually catches anything, or whether it's
theater. Found both answers in the same afternoon:

- **At least eight separate tickets exist whose entire content is "the build is broken again"** —
  #2545, #2712, #2987, #3121, #3022, #3075, #3139, each titled some variation of "CI: Typecheck,
  Lint, Format & Unit Tests failing on scarlett," plus three more (#2546, #2713, #2823) for the
  Playwright suite specifically. Ten-plus tickets, filed over roughly three weeks, all reporting the
  same failure mode recurring. That is not "we caught a regression." That is a **chronic** problem
  that the process re-discovers and re-files instead of fixing at the root.
- **Nobody deduplicates before filing.** Epic #3050 (semantic search) has two separately-filed bugs,
  #3137 and #3124, for the *same root cause* — a capability flag never reaching the worker thread.
  Its own child Feature #3093 has two more near-duplicate bugs, #3118 and #3122, for the *same*
  schema defect (one says the response schema declares fields the model never returns, the other
  says it drops the real payload — same bug, filed twice, by whatever's doing the filing). And
  #2590, #2591, #2595 are three separate tickets for one glossary-migration JSON-shape bug. That's
  not thoroughness. That's a triage step that never happened, at scale.
- **Feature #3093 walked the entire six-stage gate to "Closed"/release** — discovery, spec,
  breakdown, implementation, review, release, every box ticked — **the same day it produced two
  follow-up bug reports about its own output.** Whatever "review" means in that lifecycle, it did
  not mean "does this actually work," because the thing it approved broke within hours.

You built more process to govern how work gets approved than Wiki.js has ever needed to *ship*, and
the process approved broken work same-day, more than once, then filed duplicate tickets to notice.

## 4. Your "zero warnings" gate has a warning in it, and it still says pass

CLAUDE.md, in your own words: *"All builds, tests, typechecks, and lints must be free of errors and
warnings. Warnings are treated as failures."* I had someone actually run the gate commands, live,
today, rather than trust the doc. Typecheck: clean. `oxlint` across all three workspaces: clean.
Then:

```
npx --prefix backend oxfmt --check backend frontend blocks
Format issues found in above 1 files
$ echo $?
0
```

Read that again. The formatter **finds a formatting problem, prints that it found one, and the
process still exits zero.** Your own "zero warnings" gate has a warning baked into a green
checkmark. The offending file happens to be a generated icon manifest and not hand-written source,
which is the only reason this hasn't bitten anyone yet — but that's luck, not the gate working.
Nobody wrote this rule down as an exception in `docs/variances.md` either. It's just quietly not
true, the exact way "pre-existing bugs are preserved, not fixed, behind a FIXME comment" is
supposed to make quietly-not-true things visible, and this one isn't marked at all.

## 5. Watching your own agents step on each other, in the git log, in real time

Somebody counted: **356 pairs** of `feat:` commits followed by a `fix:` commit touching the same
file within two days of each other, since the fork point. That's not "iterate quickly." At that
volume it's "ship it, then notice it was broken, over and over," and two examples make it concrete:

- **`backend/db/schema.ts` got hit by four different `feat:` commits inside a one-to-two day
  window** — storage sync, `contentSyncState`, sync-mode config, a comments table, webhook scoping —
  and needed its own cleanup commit, `e2c0a5c94`, whose message is literally about deduplicating
  **duplicate comments that drifted into the same schema file.** That is what it looks like when
  multiple unsynchronized writers edit the same file in parallel and nobody reconciled the result
  before it merged. I don't need to speculate about whether this fork is built by a swarm of
  language models running semi-independently. The file history is the confession.
- **`backend/api/sites.ts` shipped a broken permission check the same day it was written.** Commit
  `94886232c`'s message: "make `manage:theme` actually gate site theme saves." Which means for some
  window on 2026-08-17, a permission named `manage:theme` did not gate site theme saves. In a
  section of this very file's own CLAUDE.md that spends forty-plus lines on the precise semantics of
  three separate permission systems and their ALLOW/DENY/FORCEALLOW tie-break rules. All that
  ceremony, and the actual enforcement shipped inert on day one.

The most-touched files in the whole history tell the same story from a different angle:
`backend/locales/en.json` alone was touched **71 times**. `package.json`, 29. `schema.ts`, 28.
`api/pages.ts`, 27. `models/pages.ts`, 24. `EditorMarkdown.vue`, 24. That's not a stable core getting
occasional polish. That's the load-bearing files of the application being re-opened dozens of times
in a month because the first ten passes didn't hold.

One more data point, in your favor for once: there are **zero `git revert` commits** anywhere in
this fork's own history. Every mistake gets hand-patched forward instead of rolled back. I'll grant
you that's more disciplined than panicking and reverting — but it also means every one of those 356
same-file thrash pairs is permanently baked into the history as two commits instead of one clean
one, forever, because nobody's willing to just undo a bad merge and try again.

## 6. What actually shipped broken, fake, or flatly unverified

This is the part that would actually get a PR blocked on my project, not just annoy me. Your own
`docs/variances.md` — 2,055 lines, and I'll credit you for writing it all down — admits to:

- **A whole authentication module that can never work.** CAS 1.0 gives no attributes but a bare
  username; your account model requires a verified email; so `profile()` in
  `modules/authentication/cas/authentication.ts` **always throws.** You shipped a login option that
  cannot log anyone in, unless the deployment happens to run CAS 3.0+.
- **Roughly ten enterprise SSO integrations — LDAP, SAML, CAS, Auth0, Okta, Microsoft, Keycloak,
  GitLab, Twitch, Discord, Slack — none of them verified against a real identity provider.** Your
  own words: "This sandbox has no live Postgres reachable, and no LDAP directory, SAML identity
  provider, or CAS server available to drive a literal browser session." Every one of them was
  checked against a mock. That's not a wiki with enterprise auth. That's a wiki with enterprise auth
  *diagrams*.
- **A ratings feature that was pure theater, shipped as a live admin toggle.** Epic #1885: the
  thumbs buttons had no `@click`. The stars widget's rating was hardcoded to `3` and never posted
  anywhere. An administrator could turn this on today, on a real site, and it would do nothing, and
  nothing would tell them that. It's since been deleted — found by an audit, not by a user filing a
  bug, which tells you nobody outside the process ever touched the feature at all.
- **~1,400 lines of another dead, unwired admin UI** — `PageDataDialog.vue` and
  `PageDataTemplateDialog.vue` — gated behind both an experimental flag *and* a hardcoded `disable`,
  meaning it was unreachable even in the one mode meant to expose it. Built, merged, invisible,
  eventually deleted by the same kind of audit that found the ratings.
- **The migration importer — the one tool whose entire job is convincing real Wiki.js 2.5.x
  operators to trust you with their data — silently drops security-relevant state.** 2FA enrollment,
  API tokens, Slack/Discord notification config, and comment reply-threading don't survive the
  import; asset and comment timestamps get replaced with "now." The one artifact built specifically
  to court my actual users quietly demotes their two-factor accounts and erases who replied to whom.
  If I ever finish 3.0 and someone tries to import *from* your fork *back* to mine, I hope they read
  that file first.
- **A security default overridden unconditionally, undocumented as a choice until this same file
  admitted it**: SAML's `wantAuthnResponseSigned` hardcoded `false` to accommodate providers that
  sign only the assertion — not a toggle, not surfaced anywhere, just quietly weaker than the
  library's own default.

## 7. You wrote tests to make sure your own paperwork agrees with itself

Counted separately: **thirteen or more test files** across the three workspaces whose entire job is
checking that the *process* is internally consistent, not that the wiki works —
`test/logging-conventions.test.ts`, `test/verifyCi.test.ts` (which parses your own GitHub Actions
YAML), `test/docs-todo-fixme-drift.test.ts` (checks that TODO mentions in docs match TODOs in code),
`test/mcp-getting-started-doc.test.ts` (tests a *markdown file* for accuracy), `api/routeTags.test.ts`,
`base.test.ts`, plus a matched pair of generator-script-and-its-own-test for locale checks, favicon
generation, icon generation, and notify-error-message checks. Tests for the tools that generate the
code, on top of tests for the code, on top of tests for whether the docs describing the code are
still true.

And your own project history already confesses the natural result of that
posture: a prior internal audit found **~2,900 lines of pure restatement** in frontend tests and
**~4,600 lines / ~350 assertions in the backend that are pure prose-linting** — your own words, "not
one of them can fail on a product defect." That's not a hypothetical risk I'm raising. That's
already-shipped, already-merged dead weight that had to be found and named after the fact, in a
project that talks about "zero errors and zero warnings" like it's a point of pride.

## 8. Still one guy, still nothing to install

I'll keep the numbers from last time because nothing's changed: **731 commits since the fork point,
100% one author.** **125 tagged 2.x releases sitting in this repo's own history and zero 3.x tags.**
An in-process MCP server, five search engines plus a from-scratch vector search layer, seven
storage backends, and a permissions model with three orthogonal kinds of grant — for a product that,
by its own README, remains "very buggy, incomplete and non-secure," with "no released build and no
docs site."

## 9. Why Wiki.js 3.0 wins anyway

Not because the individual engineering here is bad — `helpers/pageRules.ts`, the TypeScript
conversion, the Temporal migration, all of it is careful. It's because careful engineering wrapped
around an unaccountable process is still unaccountable. A six-stage lifecycle gate that closes a
Feature the same day it generates two bug reports about itself isn't quality control, it's a rubber
stamp with extra steps. A formatter that finds a problem and reports success isn't a gate, it's
theater with a green light. A migration tool that drops your 2FA state isn't an on-ramp, it's a
trap for exactly the users you need most.

When I ship 3.0, it'll have fewer features, a real release number, and a bug tracker a human being
actually closes by hand after checking the fix works — not a thousand-plus-item backlog that
overflows its own counting tool while reporting zero problems. Slower, and true. That's the whole
pitch.

— *NGPixel, allegedly*

---

*Methodology note (out of character): figures above come from live `git log`/`git tag`/source-tree
inspection and a live `mcp__openproject__*` query against this repository's own tracked project, all
run on 2026-09-13 — see the inline citations (commit hashes, WP IDs, file paths) to reproduce any of
them. This document is deliberately adversarial roleplay for the fork's own maintainer to use as a
gut-check, not a claim about the real Nicolas Giard's opinions, and not for redistribution as if it
were.*
