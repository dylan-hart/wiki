# Frontend chunk-size warnings (2026-09-14)

`frontend/vite.config.js` keeps `build.chunkSizeWarningLimit` at (near) Rollup's 500 kB default
deliberately — see the comment there — so any chunk over that line prints a warning on every
`npm run build` rather than being silently absorbed by a raised limit. As of this pass, six chunks
still warn. This records what's actually in each one, so a future pass doesn't have to re-derive it
from scratch, and doesn't nervously re-litigate names that sound alarming but aren't.

Investigated by building for real (`npm run build` in `frontend/`) and by running a one-off
instrumented `vite build({ write: false })` with a plugin that dumps `moduleIds` for every chunk
over 500 kB in `generateBundle`, so the actual module contents of each chunk were read directly
rather than inferred from its auto-generated name.

## Fixed here

**`EditorWysiwyg-*.js`** (691.72 kB → 650.45 kB) shipped a full second copy of `highlight.js` (core
plus all ~36 "common" language grammars). Cause: `lowlight@3.3.0` (used by
`@tiptap/extension-code-block-lowlight`) declares `highlight.js: ~11.11.0`, which excludes this
repo's own pinned `highlight.js: 11.12.0` — so npm nested a second, separate `highlight.js@11.11.2`
install under `lowlight/node_modules/` instead of deduping onto the one already installed at the top
level. Fixed with an `overrides` entry in `frontend/package.json`:

```json
"overrides": {
  "lowlight": {
    "highlight.js": "$highlight.js"
  }
}
```

`$highlight.js` (npm's override syntax for "use whatever this repo's own root dependency on
`highlight.js` resolves to") keeps this tracking the repo's own pinned version automatically rather
than hard-coding a second version number to keep in sync by hand — and keeps the repo on its current,
newer `highlight.js`, rather than downgrading to satisfy `lowlight`'s narrower range.

**Residual, not fixed**: even after the version-level dedup, `EditorWysiwyg-*.js` still carries its
own copy of each common language's grammar, separate from `markdown-*.js`'s copy. Cause is different
this time — not a version mismatch, but a **build-format** mismatch: `lowlight`'s own source resolves
`highlight.js`'s ESM build (`highlight.js/es/languages/*.js`), while `frontend/src/renderers/
markdown.js` imports the `highlight.js/lib/common` subpath (the CJS-shaped build). Same package,
same version, but two different files on disk per language, so the bundler can't dedupe across that
boundary. Collapsing it would mean aliasing or vendoring `lowlight`'s internal resolution to force it
onto the `lib/` build too — a real change to a third-party package's own module graph, not a version
bump — so it's left as a known residual rather than attempted in this pass.

## Confirmed genuine, not attempted

**`editor.api-*.js`** (2,654.13 kB) and **`ts.worker-*.js`** (6,914.01 kB, not captured by the
`>500 kB` chunk dump above since Vite builds ES module workers as their own separate sub-build, but
confirmed via the plain `npm run build` output) are Monaco's own core editor API and bundled
TypeScript language service, respectively — both lazy-loaded only when a Monaco-backed editor
actually mounts. Unavoidable; this matches what #1906 already documented.

**`toggleHighContrast-*.js`** (1,166.18 kB) is **not** an oversized "toggle high contrast" feature —
that's just the name Rolldown's automatic chunk-naming happened to pick from among the ~270 modules
actually in this chunk. Its real contents are Monaco's full standalone-editor **contrib feature
bundle**: find/replace, suggest (autocomplete), hover, code actions (the lightbulb), rename, color
picker, bracket matching, clipboard, drop/paste handling, and so on — everything
`monaco.editor.create()` wires up by default. Every editor component in this app does
`import * as monaco from 'monaco-editor'` (a bare package import, which resolves to the package's
full `esm/vs/index.js` entry point), so all of this is reachable and genuinely used. Not a
regression, not trimmable without dropping editor features outright.

**`passwordStrength-*.js`** (1,661.32 kB) is likewise misleadingly named — `frontend/src/helpers/
passwordStrength.js` itself is a ~50-line pure function; it just happens to be the last module in
this shared chunk, so Rolldown named the chunk after it. The actual weight is `@zxcvbn-ts/core` +
`@zxcvbn-ts/language-common` + `@zxcvbn-ts/language-en` — the password-strength scorer plus its
English dictionary, common-password list, and keyboard-adjacency data, shared by every call site that
renders a password-strength badge (`Login`, `UserEditOverlay`, `ProfileAuth`, ...). A password
strength estimator's value comes from that dictionary; there's no meaningful way to shrink it without
making it worse at its job.

**`markdown-*.js`** (721.75 kB, down from the ~1,550 kB #1906 originally recorded). Confirmed
contents: `markdown-it` + its ~15 plugins (attrs, emoji, task-lists, footnote, sup/sub/mark, this
repo's own table/imsize/glossary/blocks/icon-shortcode/underline/tex modules), `katex`, `@twemoji/
api`, and `highlight.js/lib/common`'s 36 curated languages — #1901's fix (importing `highlight.js/
lib/common` instead of the full ~190-language build) is already in place and accounts for the drop
from the old figure. This is the honest remaining floor for this chunk: the only further lever is
dropping specific languages out of the "common" set, which is a product trade-off (which languages a
reader can paste and get highlighted), not a build-tooling fix, and out of scope here.

## Why this isn't a `docs/variances.md` entry

`docs/variances.md` is deliberately scoped to divergences from a **public standard** — a protocol,
format, or published baseline with an existence independent of this project. A build tool's own
`chunkSizeWarningLimit` default isn't one; this is an accepted, investigated build-warning exception,
which is exactly the category `docs/variances.md`'s own header text says belongs in `docs/decisions/`
instead. (This is also why #1898/#1906's original entry was moved out of `variances.md` into this
OpenProject item rather than being rewritten in place there.)
