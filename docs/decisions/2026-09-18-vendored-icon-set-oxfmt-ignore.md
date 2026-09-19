# The vendored icon set is byte-checked, so oxfmt ignores it

**Date:** 2026-09-18
**OpenProject:** #3443 (this record), under Feature #3427; history in #3326, #3357 and #3361

## Decision

`backend/assets/icon-sets/tabler.json` is generated data, not source. It is protected by a byte-exact
check, `npm run vendor-icons:check` (`backend/scripts/vendor-icon-sets.ts --check`, run by
`quality.yml`'s "Backend Vendor Icons Check" step and by `scripts/verify-ci.sh`), which compares the
committed file, character for character, with a fresh merge of the pinned `@iconify-json/tabler`
devDependency's `icons.json` and `info.json`.

The formatter therefore never touches it: the repo-root `.oxfmtrc.json` lists
`backend/assets/icon-sets/**` in `ignorePatterns`, beside the other generated-content entries
(`backend/db/migrations/**`, `backend/locales/**`, `frontend/src/assets/*.generated.js`).
`npm run vendor-icons` is the only thing that should change the file, and it writes compact,
single-line `JSON.stringify` output.

The ignore entry is guarded by a test in `backend/scripts/vendor-icon-sets.test.ts` (Task #3442): it
reads `.oxfmtrc.json` and fails if `backend/assets/icon-sets/**` is removed from `ignorePatterns`,
so this decision cannot be undone by accident.

## Why formatting the file was rejected

The alternative was to let oxfmt own the file and have the generator emit whatever oxfmt would
produce. That was rejected:

- **The generator's output must stay byte-exact.** `vendor-icons:check` is an exact-string
  comparison, so the generator and the checker must agree on one serialisation. Making that
  serialisation "whatever oxfmt outputs" couples the check to a formatter release, and a
  formatter version bump would fail `vendor-icons:check` on a file nobody edited. `CLAUDE.md`
  already treats an oxfmt bump as something that can silently reformat untouched files.
- **Pretty-printing roughly doubles the file for no benefit.** It is vendored data, not
  hand-maintained code, and a diff of it is only ever "the dependency was bumped".
- **The file is derived.** Formatting a generated artifact is churn: the next `npm run vendor-icons`
  would either undo it or need the generator taught to run a formatter.

Excluding it from oxfmt, exactly as the migrations and locale files are excluded, leaves each tool
with one job: oxfmt formats source, `vendor-icons:check` polices this file.

## History

- **#3326.** PR #75 accidentally pretty-printed `tabler.json`, so `vendor-icons:check` failed on
  `scarlett` ("`assets/icon-sets/tabler.json` is out of date with `@iconify-json/tabler`"). Fixed as
  Bug #3336 by regenerating the file compactly with `npm run vendor-icons` (PR #80).
- **#3357.** That fix immediately failed the other gate: the Format Check step
  (`oxfmt --check backend frontend blocks`) flagged the now-compact `tabler.json`. Two tools wanted
  two different serialisations of one file, permanently.
- **#3361.** The root cause was that `.oxfmtrc.json` excluded other generated content but not this
  directory. Fixed by adding `backend/assets/icon-sets/**` to `ignorePatterns`, landed in commit
  `31dba20b4` (PR #83), with both checks green afterwards.

## Why this is not a `docs/variances.md` entry

This is a choice about this project's own tooling, namely which of its two checks owns a generated
file. It is not a divergence from a recognised public standard. Per `CLAUDE.md`'s variances.md
Discipline section, it belongs here in `docs/decisions/`.

## Revisit when

- The vendored set stops being a single committed generated file (for example it is fetched at
  build time instead), at which point neither the check nor the ignore entry is needed, or
- oxfmt gains a way to declare a file "verbatim, checked elsewhere" that is safer than a blanket
  ignore, or the generator is changed to emit a format that the formatter provably leaves alone.
