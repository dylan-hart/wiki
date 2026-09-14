# CLAUDE.md Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the root `CLAUDE.md` (currently 1,482 lines / ~15,700 words / ~29K tokens, loaded in full by every agent that touches this repo) down to only what's genuinely cross-cutting, by relocating workspace-specific content into nested `CLAUDE.md` files that Claude Code auto-loads only when an agent actually works in that directory — then remove every citation of "CLAUDE.md" from source/test/doc files elsewhere in the repo, since CLAUDE.md's content is ambient context and a citation to it is exactly the kind of fragile external pointer this project already got burned by with `docs/decisions/`.

**Architecture:** Four new nested `CLAUDE.md` files (`backend/`, `frontend/`, `blocks/`, `e2e/`) each hold their workspace's deep conventions verbatim, moved (not rewritten) from root, keeping the same section headings. Root `CLAUDE.md` keeps only content that spans workspaces or is cheap-and-high-blast-radius (product naming, the permission taxonomy, the verify-ci gate, commands cheat sheet, icons) plus a one-line pointer per workspace so a human skimming root knows the depth exists. Narrative/incident-history content that isn't an actionable rule (the oxfmt version-bump incident, the Vue-semicolon-formatting saga) moves to a new root `CONTRIBUTING.md`, with the actionable rule staying inline in whichever CLAUDE.md needs it and *no* pointer from that CLAUDE.md to CONTRIBUTING.md (per the user's directive: nothing outside CLAUDE.md references CLAUDE.md, and the reverse — CLAUDE.md pointing out to other docs — is being minimized here too, not expanded). A final sweep removes every "CLAUDE.md" citation from every other file in the repo (~150 files: ~119 in backend/frontend/blocks/e2e source and tests, ~30 in docs/).

**Tech Stack:** Plain Markdown files; no code changes. Verification uses the existing Node test runner (`node --test`), Vitest, oxlint/oxfmt, and Playwright config parsing already used by each workspace — nothing new to install.

**Spec:** This plan file is its own spec; it was developed in conversation with the user (2026-09-14) rather than a separate spec doc. Key decisions the user made explicitly, verbatim in spirit:
- Split into nested CLAUDE.md + a discipline/contributing doc; the root CLAUDE.md should end up "extremely thin."
- A single pointer from root to the nested files is acceptable (silence would recreate the exact `docs/decisions/` staleness problem discovered this session — confirmed zero functional/`readFileSync` dependencies on CLAUDE.md exist anywhere, so this is a pure-prose risk, not a test-breaking one).
- "Nothing in the project should be referencing CLAUDE.md other than CLAUDE.md itself" — no source file, test file, or other doc may contain the literal string "CLAUDE.md" once this plan is done, except CLAUDE.md files themselves (root and nested) referencing each other or themselves.

## Global Constraints

- Every workspace's full test suite must pass after each task (`backend`: `npm run test` from `backend/`; `frontend`/`blocks`: `npm run test` from their own dirs). No functional test reads CLAUDE.md's file content (verified: only `backend/test/operations-doc.test.ts`'s `'links CLAUDE.md'` test checks `README.md` contains the substring `](CLAUDE.md)` — this stays true throughout since root `CLAUDE.md` still exists).
- `npx oxlint` and `npx --prefix backend oxfmt --check <paths>` must stay clean on every file touched (markdown files aren't linted, but any comment edits inside `.ts`/`.js`/`.vue` files during the citation sweep are).
- Preserve section headings verbatim when moving content (e.g. `### Testing (backend)` stays `### Testing (backend)` inside `backend/CLAUDE.md`) so any citation that survives an intermediate step still resolves in spirit — though by the end of this plan no such citation should exist outside CLAUDE.md files at all.
- Never delete substantive rules or the non-obvious "why" behind them. Narrative may be *compressed* (rule + one-line why, matching this project's own memory-file convention) but not dropped. When in doubt, keep it — erring toward a slightly-less-thin root is better than losing a hard-won incident lesson (e.g. the Vue inline-handler-semicolon compiler/formatter conflict, the oxfmt version-bump incident).
- Root `CLAUDE.md`'s existing product-naming rule (Cardinal.js vs Wiki.js) governs this plan's own prose too — don't introduce a stray "Wiki.js" where "Cardinal.js" is meant.
- Work happens directly on the current branch (`docs/variance-cleanup-and-audits`), matching how the rest of this session's work has proceeded — no new worktree needed for a docs-only restructure.

---

## Section Map (source: root CLAUDE.md as of this plan's writing, verify line numbers with `grep -n "^#\{1,4\} " CLAUDE.md` before starting — a prior task's edits shift every later line number)

| Heading | Approx. lines (before Task 1) | Destination |
|---|---|---|
| `# Cardinal.js 3.x` (intro prose) | 1–28 | Root (trim slightly) |
| `## Layout` / `### Root` | 29–41 | Root (keep) |
| `### backend/` (directory breakdown) | 42–183 | `backend/CLAUDE.md`; root keeps 2–3 line summary + pointer |
| `### frontend/` (directory breakdown) | 184–229 | `frontend/CLAUDE.md`; root keeps summary + pointer |
| `### blocks/` (directory breakdown) | 230–326 | `blocks/CLAUDE.md`; root keeps summary + pointer |
| `## Commands` (incl. `### What "verified" means`) | 327–391 | Root (keep, cross-workspace) |
| `## TypeScript (backend)` | 392–458 | `backend/CLAUDE.md` |
| `### Product name` | 461–491 | Root (keep, cross-cutting) |
| `### Style, linting, formatting` | 492–546 | Rule stays in root (short); Vue-semicolon + oxfmt-bump-incident narrative moves to `CONTRIBUTING.md` |
| `### Utilities and dates` | 547–565 | Root (keep, cross-cutting, already short) |
| `### Permissions` | 566–656 | Root (keep in full — dense rules, spans backend+frontend, highest blast radius in the doc) |
| `### Backend patterns` + `#### Shared backend helpers` | 657–795 | `backend/CLAUDE.md` |
| `### Logging` | 796–895 | `backend/CLAUDE.md` (WIKI.logger is backend-only) |
| `### Testing (backend)` | 896–1045 | `backend/CLAUDE.md` |
| `### Frontend patterns` | 1046–1124 | `frontend/CLAUDE.md` |
| `### Testing (frontend)` | 1125–1255 | `frontend/CLAUDE.md` |
| `### Testing (blocks)` | 1256–1305 | `blocks/CLAUDE.md` |
| `### Testing (e2e)` | 1306–1412 | `e2e/CLAUDE.md` (new workspace, no existing directory-layout section to move alongside it) |
| `### Testing (CI)` | 1413–1433 | Root (keep — short, genuinely spans all workspaces) |
| `### Icons` | 1434–1482 | Root (keep — spans backend + frontend) |

Expected result: root drops from 1,482 lines to roughly 400–450; `backend/CLAUDE.md` ~600; `frontend/CLAUDE.md` ~260; `blocks/CLAUDE.md` ~150; `e2e/CLAUDE.md` ~110; `CONTRIBUTING.md` ~50.

---

### Task 1: Extract `backend/CLAUDE.md`

**Files:**
- Create: `backend/CLAUDE.md`
- Modify: `CLAUDE.md` (remove the `### backend/` directory breakdown, `## TypeScript (backend)`, `### Backend patterns`, `#### Shared backend helpers`, `### Logging`, `### Testing (backend)` sections; leave a short pointer)
- Test: none new — run existing `backend/` suite

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `backend/CLAUDE.md` exists with headings `## TypeScript (backend)`, `### Backend patterns`, `#### Shared backend helpers`, `### Logging`, `### Testing (backend)` present verbatim (later tasks and the final sweep don't touch this file's content, only reference its existence)

- [ ] **Step 1: Re-locate current section boundaries**

Run: `grep -n "^#\{1,4\} " CLAUDE.md`

Confirm the six section headings this task moves (`### \`backend/\``, `## TypeScript (backend)`, `### Backend patterns`, `#### Shared backend helpers — one owner per question`, `### Logging`, `### Testing (backend)`) and note their exact current line ranges (they should be close to the Section Map above, but re-verify — this is the first task, so ranges should match exactly).

- [ ] **Step 2: Create `backend/CLAUDE.md`**

Write a new file `backend/CLAUDE.md` with this structure:

```markdown
# Cardinal.js backend

Backend-specific conventions for `backend/`. See the root `CLAUDE.md` for what spans the whole
repo (product naming, permissions, icons, commands, the verify-ci gate).

## Layout

<the exact content currently under root CLAUDE.md's "### `backend/`" heading, demoted one level
 (### -> ##), verbatim>

## TypeScript

<the exact content currently under root CLAUDE.md's "## TypeScript (backend)" heading, demoted
 one level (## -> ###) so it nests under this file's own top-level structure, verbatim>

### Backend patterns

<verbatim, including its "#### Shared backend helpers — one owner per question" sub-section
 unchanged (#### stays #### since it's already nested two levels under a ### parent — adjust only
 if the demotion above shifts its logical depth; check rendered heading nesting makes sense, e.g.
 Backend patterns as ### and Shared backend helpers as #### is already correct relative nesting,
 no change needed>

### Logging

<verbatim>

### Testing (backend)

<verbatim>
```

Use the Read tool on the exact line ranges from Step 1 to copy content verbatim — do not retype from memory, do not paraphrase. Only the heading *levels* change (to nest correctly under this file's own top-level title); heading *text* stays identical so any surviving citation (before the final sweep task removes them) still resolves.

- [ ] **Step 3: Verify no content was lost**

Run a word-count sanity check — the new file's word count should be within a few words of the sum of the moved sections' word counts in the original (use `git show HEAD:CLAUDE.md | sed -n '<start>,<end>p' | wc -w` per section against the original file, before Step 4 deletes them, and compare to `wc -w backend/CLAUDE.md`).

- [ ] **Step 4: Remove the moved sections from root CLAUDE.md**

Delete the six sections from `CLAUDE.md` (the ranges from Step 1). In `## Layout`, replace the `### \`backend/\`` section with a short paragraph (2-4 sentences) summarizing what the backend workspace is (Fastify + Drizzle + poolifier scheduler) and stating that `backend/CLAUDE.md` holds its full layout and conventions — do not use the literal phrase "see backend/CLAUDE.md" as a citation-style pointer to avoid (the goal is a normal cross-reference between two CLAUDE.md files, which the user's directive explicitly allows — only *other* files must not cite CLAUDE.md).

- [ ] **Step 5: Run the backend suite**

Run: `cd backend && npm run typecheck && npx oxlint && npm run test`
Expected: typecheck clean, oxlint clean, test suite matches this session's earlier baseline (5192 tests, only the two known *pre-existing, out-of-scope* failures: `docs-markdown-syntax.test.ts` and `docs-todo-fixme-drift.test.ts` — both already broken before this plan by the unrelated "Remove stale documentation" commit, not to be fixed here unless the user asks separately).

- [ ] **Step 6: Format check and commit**

Run: `cd /Users/dylangles/git/dylan.hart/requarks-wiki-fork && npx --prefix backend oxfmt --check CLAUDE.md backend/CLAUDE.md` (oxfmt does not format markdown meaningfully but confirms no stray formatting issue in files it does touch; this step is mostly a no-op for `.md` files and exists to keep the habit consistent — skip if oxfmt reports it doesn't handle `.md`).

```bash
git add CLAUDE.md backend/CLAUDE.md
git commit -m "$(cat <<'EOF'
Extract backend/CLAUDE.md from root CLAUDE.md

Backend-specific conventions (layout, TypeScript notes, backend patterns
and shared helpers, logging, and backend testing) move into a nested
backend/CLAUDE.md that Claude Code auto-loads only when an agent works in
backend/, rather than being loaded by every agent regardless of relevance.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019wxnJauBLs9C2XFBsfZDjg
EOF
)"
```

---

### Task 2: Extract `frontend/CLAUDE.md`

**Files:**
- Create: `frontend/CLAUDE.md`
- Modify: `CLAUDE.md` (remove `### frontend/` directory breakdown, `### Frontend patterns`, `### Testing (frontend)`; leave a short pointer)

**Interfaces:**
- Consumes: nothing from Task 1 (independent section of root)
- Produces: `frontend/CLAUDE.md` with headings `## Layout`, `### Frontend patterns`, `### Testing (frontend)`

- [ ] **Step 1: Re-locate current section boundaries**

Run: `grep -n "^#\{1,4\} " CLAUDE.md` (line numbers have shifted since Task 1 — always re-run, never reuse the Section Map's numbers directly).

- [ ] **Step 2: Create `frontend/CLAUDE.md`**

Same pattern as Task 1 Step 2:

```markdown
# Cardinal.js frontend

Frontend-specific conventions for `frontend/`. See the root `CLAUDE.md` for what spans the whole
repo.

## Layout

<verbatim content from root's "### `frontend/`" section, demoted one level>

### Frontend patterns

<verbatim>

### Testing (frontend)

<verbatim>
```

- [ ] **Step 3: Verify no content was lost**

Same word-count check as Task 1 Step 3, against `frontend/CLAUDE.md`.

- [ ] **Step 4: Remove the moved sections from root CLAUDE.md**

Same pattern as Task 1 Step 4 — short summary paragraph for the frontend workspace (Vue 3 + Vite SPA, Tailwind, the in-repo `w-*` component library) in place of the removed `### \`frontend/\`` section.

- [ ] **Step 5: Run the frontend suite**

Run: `cd frontend && npx oxlint && npm run test`
Expected: oxlint clean, test suite matches this session's earlier baseline (428 files / 5671 tests, all passing).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md frontend/CLAUDE.md
git commit -m "$(cat <<'EOF'
Extract frontend/CLAUDE.md from root CLAUDE.md

Frontend-specific conventions (layout, frontend patterns, and frontend
testing) move into a nested frontend/CLAUDE.md, auto-loaded only when an
agent works in frontend/.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019wxnJauBLs9C2XFBsfZDjg
EOF
)"
```

---

### Task 3: Extract `blocks/CLAUDE.md`

**Files:**
- Create: `blocks/CLAUDE.md`
- Modify: `CLAUDE.md` (remove `### blocks/` directory breakdown and `### Testing (blocks)`; leave a short pointer)

**Interfaces:**
- Consumes: nothing from Tasks 1–2
- Produces: `blocks/CLAUDE.md` with headings `## Layout`, `### Testing (blocks)`

- [ ] **Step 1: Re-locate current section boundaries**

Run: `grep -n "^#\{1,4\} " CLAUDE.md`.

- [ ] **Step 2: Create `blocks/CLAUDE.md`**

```markdown
# Cardinal.js blocks

Self-contained Lit web-component conventions for `blocks/`. See the root `CLAUDE.md` for what
spans the whole repo.

## Layout

<verbatim content from root's "### `blocks/`" section, demoted one level>

### Testing (blocks)

<verbatim>
```

- [ ] **Step 3: Verify no content was lost** (same pattern)

- [ ] **Step 4: Remove the moved sections from root CLAUDE.md**, short summary paragraph in place (Lit components, `block-*` directory glob, compiled output served under `/_blocks/`).

- [ ] **Step 5: Run the blocks suite**

Run: `cd blocks && npx oxlint && npm run test`
Expected: oxlint clean, test suite matches this session's baseline (41 files / 511 tests, all passing).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md blocks/CLAUDE.md
git commit -m "$(cat <<'EOF'
Extract blocks/CLAUDE.md from root CLAUDE.md

Blocks-specific conventions (layout and blocks testing) move into a
nested blocks/CLAUDE.md, auto-loaded only when an agent works in blocks/.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019wxnJauBLs9C2XFBsfZDjg
EOF
)"
```

---

### Task 4: Extract `e2e/CLAUDE.md`

**Files:**
- Create: `e2e/CLAUDE.md`
- Modify: `CLAUDE.md` (remove `### Testing (e2e)`; leave a short pointer — there is no existing `### e2e/` layout section to fold in, since root CLAUDE.md never documented e2e/'s directory layout separately)

**Interfaces:**
- Consumes: nothing from Tasks 1–3
- Produces: `e2e/CLAUDE.md` with heading `### Testing (e2e)` (or promoted to `## Testing` as this file's only real section — use judgement on heading depth so the file reads naturally as a standalone document, but do not alter any wording)

- [ ] **Step 1: Re-locate current section boundaries**

Run: `grep -n "^#\{1,4\} " CLAUDE.md`.

- [ ] **Step 2: Create `e2e/CLAUDE.md`**

```markdown
# Cardinal.js e2e

Playwright end-to-end suite conventions for `e2e/`. See the root `CLAUDE.md` for what spans the
whole repo.

## Testing (e2e)

<verbatim content from root's "### Testing (e2e)" section>
```

- [ ] **Step 3: Verify no content was lost** (same pattern)

- [ ] **Step 4: Remove `### Testing (e2e)` from root CLAUDE.md.** Since e2e/ never had its own root-level directory-layout summary (only `## Layout`'s `### Root` briefly mentions "`e2e/` — Playwright end-to-end suite... see Testing (e2e)"), update that one existing mention in `### Root`'s workspace table to point at `e2e/CLAUDE.md` instead of the now-removed in-file anchor `#testing-e2e`.

- [ ] **Step 5: Run e2e config sanity check**

There's no fast e2e suite to run without a live Postgres + built assets (per the repo's own e2e docs, this is expensive and DB-gated). Instead: `cd e2e && node -e "require('./playwright.config.js')"` is not valid (it's ESM) — run `node --check playwright.config.js` and `node --check playwright.flaky.config.js` to confirm they still parse (this task doesn't touch those files, but confirms nothing in the working tree is broken). If the user has a Postgres instance available and wants the real suite run, ask before spinning up a container — don't do it unprompted.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md e2e/CLAUDE.md
git commit -m "$(cat <<'EOF'
Extract e2e/CLAUDE.md from root CLAUDE.md

E2e-specific testing conventions move into a nested e2e/CLAUDE.md,
auto-loaded only when an agent works in e2e/.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019wxnJauBLs9C2XFBsfZDjg
EOF
)"
```

---

### Task 5: Create `CONTRIBUTING.md` for narrative/incident history; trim root's Style/linting/formatting section to its rule core

**Files:**
- Create: `CONTRIBUTING.md` (repo root)
- Modify: `CLAUDE.md` (`### Style, linting, formatting` section only)

**Interfaces:**
- Consumes: nothing from Tasks 1–4
- Produces: `CONTRIBUTING.md` holding the Vue-inline-handler-semicolon explanation and the oxfmt-version-bump-incident explanation; root `CLAUDE.md`'s Style section keeps only the actionable rules (oxlint/oxfmt, not ESLint/Prettier, format settings, the "never two statements in a Vue template attribute" rule itself — just not its multi-paragraph *why*)

- [ ] **Step 1: Re-locate current section boundaries**

Run: `grep -n "^#\{1,4\} " CLAUDE.md`. Identify the exact paragraph boundaries inside `### Style, linting, formatting` for: (a) the "Bumping oxlint or oxfmt's version..." incident paragraph, and (b) the "Never put two statements in a Vue template attribute..." explanation paragraph (the *why* — `transformOn`/`exp.content.includes(';')` mechanism — not the rule itself, which stays).

- [ ] **Step 2: Create `CONTRIBUTING.md`**

```markdown
# Contributing to Cardinal.js

Background and incident history behind some of the rules in `CLAUDE.md` and its nested files.
This file is for a human contributor who wants the full story; the actionable rule itself always
lives in the relevant `CLAUDE.md`, not here — this file adds no new *rules*, only the reasoning
behind existing ones.

## Why oxlint/oxfmt version bumps get special care

<verbatim paragraph from root CLAUDE.md's Style section about the oxfmt-version-bump-incident,
 including its example commands>

## Why Vue template attributes never hold two statements

<verbatim paragraph(s) explaining the `transformOn`/semicolon/`exp.content.includes(';')`
 mechanism, kept in full>
```

- [ ] **Step 3: Verify no content was lost** (word-count check as before)

- [ ] **Step 4: Trim root CLAUDE.md's Style section**

Replace the two moved paragraphs with their rule-only equivalent, e.g. (adapt exact wording to fit the surrounding prose, keep it to 1-2 sentences per rule, do not invent new rules):

```markdown
**Bumping oxlint or oxfmt's version is a dependency-bump checklist item, not a plain
version-string edit** — a newer formatter release can silently reformat files nobody touched.
Reformat all three workspaces in the same commit as the bump.

**Never put two statements in a Vue template attribute** (`@click="doOne(); doTwo()"`) — write a
named handler instead. Neither the compiler nor the formatter can be reconfigured to make this
safe.
```

- [ ] **Step 5: Verify and commit**

Run: `cd /Users/dylangles/git/dylan.hart/requarks-wiki-fork && npx --prefix backend oxfmt --check CLAUDE.md CONTRIBUTING.md` (expect no-op / clean for markdown).

```bash
git add CLAUDE.md CONTRIBUTING.md
git commit -m "$(cat <<'EOF'
Move style-rule incident narrative into CONTRIBUTING.md

The oxfmt-version-bump and Vue-inline-handler-semicolon incident writeups
move out of the always-loaded CLAUDE.md into a new CONTRIBUTING.md; the
actionable rule itself stays inline in CLAUDE.md's Style section.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019wxnJauBLs9C2XFBsfZDjg
EOF
)"
```

---

### Task 6: Repo-wide sweep — remove every "CLAUDE.md" citation outside CLAUDE.md files themselves

**Files:**
- Modify: every file found by the audit grep below, except `CLAUDE.md`, `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `blocks/CLAUDE.md`, `e2e/CLAUDE.md`, and `CONTRIBUTING.md` (those are allowed to reference each other or themselves)

**Interfaces:**
- Consumes: the five CLAUDE.md files + CONTRIBUTING.md from Tasks 1–5 must already exist (this task's grep needs a stable target list, and citation rewording benefits from knowing where content actually now lives, though — as established — no citation needs to *redirect* anywhere; it just needs to disappear or have its substance inlined)
- Produces: `grep -rIl "CLAUDE\.md" --exclude-dir=node_modules --exclude-dir=.git .` returns only `CLAUDE.md`, `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `blocks/CLAUDE.md`, `e2e/CLAUDE.md`, `CONTRIBUTING.md`

This task is large (confirmed this session: ~150 files, ~119 under backend/frontend/blocks/e2e, ~30 under docs/) and mechanical-but-judgment-requiring in the same shape as this session's earlier `docs/decisions/` sweep — same treatment applies: **strip the citation, preserve every bit of substantive reasoning that was already written inline in the comment; only delete the broken/now-redundant pointer.** Most citations are of the shape "per CLAUDE.md's 'X' section" or "(see CLAUDE.md)" trailing an already-complete sentence — those just lose the trailing clause. A few (rare) citations carry information found *nowhere else* in the comment (e.g. a comment that says only "see CLAUDE.md" with zero inline reasoning) — those need the substance restated briefly, without naming CLAUDE.md.

Given the size, this task should be split into parallel sub-workers by directory scope, exactly as the `docs/decisions/` sweep was, rather than done as 150 sequential edits in one context.

- [ ] **Step 1: Build the file-scoped worklists**

```bash
cd /Users/dylangles/git/dylan.hart/requarks-wiki-fork
grep -rIl "CLAUDE\.md" --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null \
  | grep -vE "^\./?(CLAUDE\.md|backend/CLAUDE\.md|frontend/CLAUDE\.md|blocks/CLAUDE\.md|e2e/CLAUDE\.md|CONTRIBUTING\.md)$" \
  | sed 's#^\./##' | sort > /tmp/claude-md-citations.txt
wc -l /tmp/claude-md-citations.txt
```

Split that list into `backend_files.txt`, `frontend_files.txt`, `blocks_files.txt`, `misc_files.txt` (docs/, e2e/, scripts/, root-level files) the same way the earlier sweep did, using a scratchpad directory (never `/tmp` per this session's environment rules — use whatever scratchpad path the running session reports).

- [ ] **Step 2: Dispatch parallel sweep workers**

One fork per file group (backend, frontend, blocks, misc — matching the four-way split that worked cleanly for the `docs/decisions/` sweep earlier this session). Each worker's brief:

> Strip every citation of "CLAUDE.md" from the files in your assigned list — root CLAUDE.md and its four nested siblings plus CONTRIBUTING.md are the only files in this repo allowed to mention "CLAUDE.md" (they may reference each other). For each hit: if the surrounding sentence already states its reasoning inline and the CLAUDE.md citation is a trailing pointer ("... per CLAUDE.md's 'X' section", "(CLAUDE.md)", "-- see CLAUDE.md"), delete just that clause and fix punctuation/grammar. If a citation carries information found nowhere else in the comment (rare — most don't), restate that substance in 1 sentence without naming CLAUDE.md, matching the surrounding prose's register. Never delete real information, only the pointer. After editing your scope: `grep -rIn "CLAUDE\.md" <your paths>` must return zero hits; run oxlint and oxfmt --check on any code files you touched; run the single test file directly (`node --test <path>` / `npx vitest run <path>`) for any `*.test.ts`/`*.test.js` you edited to confirm no broken assertion.

- [ ] **Step 3: Repo-wide verification**

```bash
grep -rIl "CLAUDE\.md" --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null
```

Expected output: exactly `CLAUDE.md`, `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `blocks/CLAUDE.md`, `e2e/CLAUDE.md`, `CONTRIBUTING.md` (order may vary). Anything else means a worker missed a file or a citation was reintroduced — fix before continuing.

- [ ] **Step 4: Full verification gate**

```bash
cd backend && npm run typecheck && npx oxlint && npm run test
cd ../frontend && npx oxlint && npm run test
cd ../blocks && npx oxlint && npm run test
cd .. && npx --prefix backend oxfmt --check backend frontend blocks CLAUDE.md backend/CLAUDE.md frontend/CLAUDE.md blocks/CLAUDE.md e2e/CLAUDE.md CONTRIBUTING.md
```

Expected: same baselines as Tasks 1–3 (backend: only the two known pre-existing unrelated failures; frontend: 428/428 files, 5671/5671 tests; blocks: 41/41 files, 511/511 tests). No new failures anywhere — if there are any, a worker's edit broke a test assertion (most likely by editing a string literal a test matches against, the same class of bug this session already fixed once in `fonts.test.js`); find and fix it the same way (check whether the failure is pre-existing via `git stash` before assuming the sweep caused it).

- [ ] **Step 5: Commit**

Given the file count, commit per sub-worker scope (four commits) or as one, matching whatever the session's git-commit conventions have been so far this session (individual, descriptive commits per logical chunk of work — prefer four here, mirroring Step 2's split):

```bash
git add <backend files>
git commit -m "$(cat <<'EOF'
Remove backend/ citations of CLAUDE.md

CLAUDE.md's content is ambient context loaded automatically for any agent
working in this repo; a source comment citing it is a fragile external
pointer of exactly the kind this project already got burned by with
docs/decisions/. Citations are stripped; any substance they carried that
wasn't otherwise inline is restated without naming CLAUDE.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019wxnJauBLs9C2XFBsfZDjg
EOF
)"
```

(repeat per scope: frontend, blocks, misc)

---

### Task 7: Final root CLAUDE.md read-through and sizing report

**Files:**
- Modify: `CLAUDE.md` (only if the read-through finds an actual inconsistency — a dangling internal anchor link, a workspace-summary paragraph that reads awkwardly, a heading level mistake)

**Interfaces:**
- Consumes: the finished state of Tasks 1–6
- Produces: a short report (word count before/after, per-file line counts) to give the user

- [ ] **Step 1: Read root CLAUDE.md top to bottom**

Confirm: the intro still makes sense as an entry point; the `## Layout` section's four workspace summaries each end with a clear pointer to their nested CLAUDE.md; no internal Markdown anchor link (e.g. anything like `#testing-e2e`) still points at a section that moved; heading hierarchy is consistent (no orphaned `####` under a missing `###`).

- [ ] **Step 2: Confirm the citation audit is still clean**

Run: `grep -rIl "CLAUDE\.md" --exclude-dir=node_modules --exclude-dir=.git .` — same expected six-file result as Task 6 Step 3 (re-run since this task may have touched files).

- [ ] **Step 3: Produce the sizing report**

```bash
wc -l -w CLAUDE.md backend/CLAUDE.md frontend/CLAUDE.md blocks/CLAUDE.md e2e/CLAUDE.md CONTRIBUTING.md
```

Report this table to the user directly in chat (not as a new file) alongside the before/after root-CLAUDE.md numbers from this plan's Goal section (1,482 lines / ~15,700 words / ~29K tokens).

- [ ] **Step 4: Final full verification gate + commit (if Step 1 found anything to fix)**

Same commands as Task 6 Step 4. If Step 1 required a fix, commit it:

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Fix up root CLAUDE.md after the nested-CLAUDE.md restructure

Final read-through catching a dangling anchor / heading nesting issue
left over from the section extraction.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019wxnJauBLs9C2XFBsfZDjg
EOF
)"
```

If Step 1 found nothing to fix, skip the commit — no need for an empty one.
