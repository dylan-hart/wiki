# variances.md cleanup — 2026-09-13

Overnight session while you slept. Walked every entry in `docs/variances.md` in file order, one at a
time, against the rule you gave partway through:

> If you can't genuinely defend that an entry is legitimately (1) valid and present and (2) actually a
> variance from expected behavior/function — remove it. If you *can*, but a real fix is clear or an
> investigation is warranted, delete and file a bug/task/issue instead.

Went from **46 entries down to 18**. Everything removed was either fully settled with nothing pending
(no WP needed — it was acting as changelog prose, not a decision record) or had a real, actionable gap
that's now tracked in OpenProject instead. Ran the full lint/typecheck/scoped-test gate at the end —
all green (details at the bottom).

## What's still in variances.md (18 entries, all judged genuinely legitimate + live)

These are permanent or currently-unresolvable tradeoffs with no further action to take right now:

- TODO/FIXME audit list (itself now slated to go away — see #3146 below)
- Glossary render-timing (not instant site-wide)
- Comment provider selectability reconciliation
- Task 437/438/440 — no live auth-provider login round-trips (tracked, see below)
- Tajawal font has no `latin-ext` subset upstream
- Kroki/PlantUML GET-URL transport, no POST proxy (proxy itself now filed — see below)
- Task 785 — diagram pre-rendering (design note, now points at #3191 instead of "future task")
- Telemetry toggle not carried forward
- draw.io purpose-built renderer
- block-openapi swagger-ui vs. Scalar
- asciidoctor build-noise notices (verified still reproduces today)
- Helm/Packer deleted rather than modernized
- Dependency audit accepted exceptions (verified `@twemoji/api` pin still current)
- Elasticsearch smoke suite deliberately manual
- Session cookie `secure: true` unconditional
- `pageEmbeddingChunks` raw SQL (written today, same session as the last work-cycle)

## Removed outright — no OpenProject item (settled, not a live variance)

TOTP drift window · generated/vendored files excluded from format gate · Box/Dropbox/GDrive/OneDrive
storage cut · markdown.test.js using Vitest · Git storage regression pass (#823) audit trail · PDF
footnote fix (already shipped) · Task #549 no search table · Task #550 Algolia rename-in-place · Task
#552 apiVersion drop · Task #552 rebuild scoping · Page ratings dropped · Page Data/Templates dropped ·
PDF export merge reconciliation · `--no-sandbox` merge reconciliation

Your call on several of these mid-session: routine engineering decisions (matching upstream best
practice, excluding build output from a formatter) don't need a ledger entry, and neither does "we cut
a half-built feature and explained why" once the removal is complete — that's what git history is for.

## Moved to OpenProject (real gaps, now tracked instead of sitting in a doc)

| # | Title | From |
|---|---|---|
| **Bug #3142** | Cobalt footer bar wrong-edge inset with right-positioned sidebar | Confirmed by you live |
| **Feature #3143** | Copy CSS Grid tables as real `<table>`, + explicit cell-range select mode | Table/spreadsheet paste regression |
| **Bug #3144** | Type `WIKI.sites` against the real Drizzle row | TODO audit |
| **Epic #3145** | Rename `WIKI` global → `CARDINAL` (~4,515 refs, 273 files) | Your request |
| **Bug #3146** | Remove `docs-todo-fixme-drift.test.ts` — a test shouldn't assert on doc prose | Your objection |
| **Bug #3181** | Glossary "rerender all pages" admin action | Glossary render-timing follow-up |
| **Feature #3183** | Server-side POST proxy for Kroki/PlantUML | Diagram transport follow-on |
| **Issues #3184–#3189** (6) | LDAP/SAML/CAS: CAS 1.0 limit, email fallback, SAML signing posture, dead `baseUrl` (→ **Bug #3187**), missing avatar pipeline, never-verified-live admin flow | LDAP/SAML/CAS entry |
| **Feature #3190** | Wire `mathjax.asyncLoad` (extpfeil/verb/accented-Unicode all broken) | KaTeX/MathJax audit |
| **Feature #3191** | Page-level diagram pre-rendering into the stored-HTML pipeline | Task 785's "future task" |
| **Bug #3200** | Audit log: `login.failed` missing for OAuth/TFA/passkey paths | Audit log gap |
| **Issue #3201** | Confirm sandboxed Puppeteer actually works in the built Docker image | `--no-sandbox` reconciliation loose end |
| **Bug #3202** | Chunk-size warnings drifted far past docs — 6 chunks now, 2 implausibly huge | Verified via a real `npm run build` |
| **Bug #3203** | Add `pageWatchEvents.pageId` FK for real (record synchronously pre-delete) | FK entry |
| **Issues #3197–#3199** (3) | Storage cron-shape gap, `uploads.maxFiles` no destination, 5 unimplemented auth providers | Migration settings/auth/storage entry |
| **Issue #3192** | Migration importer: no post-migration notice re: API tokens/Slack-Discord | Epic 13 scope entry — **grep-confirmed the notice doesn't exist anywhere in code** |
| **Issue #3193** | Investigate carrying 2.x TOTP secrets forward (currently silently dropped) | Security-relevant 2FA-drop entry |
| **Bug #3204** | Migration importer: real timestamps + reply threading for assets/comments | Feature 418 entry |
| **Issue #3205** | Investigate a pinned newer git for the CI-parity devcontainer | devcontainer git entry |
| **Bug #3206** | EditorWysiwyg toolbar has zero i18n wiring (hardcoded English) | **Found during cross-reference audit below, not in the original 46** |

## Bonus finding: ~25 source-code comments were pointing at entries I just deleted

Removing a `docs/variances.md` entry doesn't just affect the doc — a lot of backend/frontend/blocks
code has comments that say "see docs/variances.md's 'X' entry." Grepped the whole tree for every
`docs/variances.md` reference after each deletion and fixed every one that had gone dangling: mostly
swapped in the new OpenProject number, a couple got the reasoning inlined instead since no tracking
number made sense. Full list of touched files is in the git diff — 19 files besides `variances.md`
itself.

Two things worth knowing about that pass specifically:

1. **`vite.config.js`'s own build comment was asserting something false** — it claimed oversized
   chunks were "accounted for in docs/variances.md," which stopped being true the moment I deleted
   that entry (and, per the finding above, was already going stale before that — the real build now
   has 6 oversized chunks, not the 3 the entry named). Fixed to point at #3202.
2. **Found a real bug that was never in the original 46 entries**: `wysiwygMenuBar.js` hardcodes every
   toolbar label as a literal English string (`'Bold'`, `'Italic'`, …), with zero `t()` calls — the
   WYSIWYG editor's toolbar cannot be localized at all, unlike the Markdown editor's. A comment in
   `seed-rtl-test-locale.ts` already knew this and pointed at variances.md for it, but no such entry
   existed there to find — the fact had never actually been written down as its own entry, just
   mentioned in passing. Verified it's still true by reading `wysiwygMenuBar.js` directly. Filed as
   **Bug #3206**.

## Verification

- `npx --prefix backend oxfmt --check backend frontend blocks` — clean (1 pre-existing unrelated
  finding in a vendored `.json` asset, not touched by this session)
- `npm run typecheck` (backend) — clean
- `npx oxlint` in `backend/`, `frontend/`, `blocks/` — clean, all three
- Scoped tests for every file touched (frontend: `markdown.test.js`, `logicalSpacing.test.js`,
  `_page-contents.test.js`, `i18nText.test.js`, `blockLocale.test.js`; blocks: `block-mathjax`,
  `block-katex`, `block-kroki`, `block-plantuml`; backend: `docs-todo-fixme-drift.test.ts`,
  `graph.test.ts`, `export.test.ts`, `export.pdf.test.ts`, `storage.test.ts`,
  `commentProviders.test.ts`, `semanticSearch.test.ts`, `migration/mappers/storage.test.ts`) — **168
  backend tests, 460 frontend tests, 19 blocks tests, all passing.**

Full backend/frontend/blocks suites haven't been run end-to-end (only the scoped ones above, per your
own testing convention) — worth a full run before this lands anywhere, same as always.

## Not done — needs you

- **`docs/variances.md`'s TODO/FIXME audit section** still lists both TODOs (now Bug #3144) — it stays
  until #3144 actually removes the markers, since a test (soon-to-be-removed, #3146) still enforces it.
- **Epic #3145** (the `WIKI` → `CARDINAL` rename) is filed but obviously not started — it's Epic-sized
  and needs a real breakdown pass before anyone touches it.
- Everything filed above is otherwise just sitting in the backlog like normal — nothing was
  auto-gated or auto-scheduled.
