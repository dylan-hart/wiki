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
