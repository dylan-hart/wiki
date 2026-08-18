# Variances

This file records genuine, justified deviations from spec — cases where the team knowingly chose
not to match a stated requirement or convention, and has a concrete reason that choice is still
correct today. It is never an excuse for a lint error, type error, or behavioral bug that is
actually fixable — fix those instead of writing them down here. An entry is deleted the moment its
deviation is resolved; it is never left behind afterward as changelog prose describing something
that used to be true. See the "variances.md Discipline" section of the root CLAUDE.md for the full
rule this file operates under.

## Entry template

Copy this block for each new entry and fill in all four fields.

```md
### <short title>

- **What deviates**: <the spec, standard, or convention being deviated from, and exactly how>
- **Why it's justified**: <the concrete, current reason this deviation is the right call>
- **Cost of the alternative**: <what actually conforming would cost — effort, risk, scope, or
  the tradeoff it would force>
- **Resolved when**: <the observable condition that means this entry should be deleted>
```

## Entries

### Generated icon/emoji bundles excluded from oxfmt

- **What deviates**: `frontend/src/assets/icons.generated.js` and
  `frontend/src/assets/emoji.generated.js` are excluded from oxfmt via `ignorePatterns` in the root
  `.oxfmtrc.json`, so `npx oxfmt --check frontend` (equivalently `npx oxfmt --check .` run from
  `frontend/`) never inspects them even though their single-line, minified-object-per-entry layout
  does not match the rest of the codebase's formatting.
- **Why it's justified**: Both files are deterministic build output written by
  `frontend/scripts/generate-icons.mjs` and `frontend/scripts/generate-emoji.mjs` (`npm run icons`,
  `npm run emoji`), and each generator already owns its own freshness gate —
  `npm run icons:check` / `npm run emoji:check` — that asserts the checked-in file is
  byte-for-byte identical to what the generator would produce right now. Reformatting either file
  with oxfmt would desync it from that gate immediately, and the next regeneration would silently
  revert it to the generator's own layout anyway, since the generator has no reason to know or care
  what oxfmt wants.
- **Cost of the alternative**: Making the generators themselves emit oxfmt-compliant output would
  mean either shelling out to `oxfmt --write` as a build step (a new runtime dependency and
  subprocess inside a plain data-serialization script) or hand-tuning the two serializers'
  line-wrapping to match oxfmt's formatter rules by hand — engineering effort spent on a file
  format that nobody reads or hand-edits, for two files whose entire content is machine-produced.
- **Resolved when**: `frontend/scripts/generate-icons.mjs` and
  `frontend/scripts/generate-emoji.mjs` are changed to emit output that already satisfies oxfmt
  (verified by removing the `ignorePatterns` entry and confirming `npx oxfmt --check frontend`
  still passes after a fresh `npm run icons && npm run emoji`), at which point delete this entry
  and the `frontend/src/assets/*.generated.js` line from `.oxfmtrc.json`'s `ignorePatterns`.

Every other file `npx oxfmt --check` previously flagged in `frontend/` (~41 pre-oxfmt `.vue`/`.js`
sources plus a handful of incidentally-drifted config/HTML/CSS files) was reviewed diff-by-diff and
found to be purely stylistic pre-oxfmt drift — standard-JS space-before-parens, template
interpolation spacing, quote/semicolon and line-wrap differences, with no behavioral change in any
file — and has been brought current with `npx oxfmt --write`. There is therefore no "stays as-is"
exception list for source files: as of this entry, `npx oxfmt --check frontend` (run from the repo
root) is the exact command that defines "current" for `frontend/`, and it exits clean except for the
two generated bundles this entry documents.

## TODO/FIXME audit

A full sweep of every `TODO`/`FIXME` marker under `backend/` and `frontend/src/` (`blocks/` has
none) was run against this file's bar. None qualified as an entry — recorded here so each exclusion
is reasoned about, not silently dropped, per this feature's acceptance criteria. Re-run the grep
(`grep -rn -E 'TODO|FIXME' backend/ frontend/src/`) before trusting this list; it drifts.

- **The four bugs feature #422 exists to fix no longer have markers at all.** `sites.ts`'s
  `req.querystring.strict`, `config.ts`'s `Promise.trim()`, `scheduler.ts`'s cron-parser/`useWorker`
  mismatch, and `HeaderSearch.vue`'s `popularTags` sort order were all independently fixed, with
  regression tests, in `c608b179` while standing up this branch's own test infrastructure (feature
  #424) — their FIXME comments were removed along with the fix. There is nothing left under those
  four names to exclude; #422's sibling branch fixes the same bugs independently and has not been
  merged here.
- **Forward-looking backlog TODOs, already owned by an epic in the roadmap**
  (`docs/superpowers/specs/2026-08-16-wikijs-3-epic-roadmap-design.md`) — excluded, not deviations:
  `backend/index.ts:644` (RTL, epic 9), `backend/tasks/simple/update-locales.ts:37` (locale sync
  for v3, epic 9), `frontend/src/components/AuthLoginPanel.vue:709` (forgot password, epic 5),
  `frontend/src/components/UserEditOverlay.vue:921` (invalidate 2FA on user edit, epic 5),
  `frontend/src/components/EditorWysiwyg.vue:480,689` (link insertion / suggestions, epic 1),
  `frontend/src/pages/AdminBlocks.vue:206` (custom block registration needs an upload endpoint that
  doesn't exist yet, epic 10), `frontend/src/pages/AdminMail.vue:490` (no SMTP transport to test
  against yet, epic 8), `frontend/src/components/UploadPendingAssetsDialog.vue:80` (per-page asset
  folders, epic 6), `frontend/src/components/FileManager.vue:1329` (opening an asset from the file
  browser, epics 1/2), `frontend/src/components/EditorMarkdown.vue:1278` (a `window.edInstance`
  debug hook left in during active Monaco/table-editor work, epic 1's parity-and-gap-closing scope).
- **Vendored, not this repo's debt to carry**: `frontend/src/helpers/monacoTypes.js:492` sits inside
  code adapted from a third-party MIT-licensed source (`monaco-markdown`, credited in the file's
  header); its inert commented-out line is upstream's TODO, not ours.
- **Stale, corrected directly rather than logged as a variance**: `backend/types/global.d.ts`'s
  `WIKI.sites` field said `any` awaited `db/schema.ts` conversion — `sites` has been a real Drizzle
  table since `backend/db/schema.ts:622`, so the comment now names the actual remaining gap (nobody
  has typed the field against the row type yet). `backend/api/pages.ts:67-68` carries the same kind
  of stale "per-path rules are not implemented" claim, even though `mayOnPage()`/`checkAccess()` a
  few lines below implement exactly that — left untouched here because it is explicitly owned by
  sibling task #781, which also has to resolve a live `mayBypassPassword()` discrepancy the stale
  wording was masking; fixing it here would duplicate that task's work.
- **Deliberate, currently-justified tradeoffs**: none found. Every marker above is already fixed,
  backlog, vendored, or a wording correction — none of them deviates from a stated requirement or
  convention the way this file exists to document, so no entry was added for this pass.
