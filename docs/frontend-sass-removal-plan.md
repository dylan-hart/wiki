# Frontend Sass removal — plan (OpenProject #3172)

Spike output only. No production code changes in this work package (see the acceptance criteria on
#3172); this document is what following Tasks execute against.

## Recommendation

Drop `sass` and the `css.preprocessorOptions.scss.additionalData` injection in favour of native CSS
nesting plus the custom-property token layer `css/tailwind.css` already publishes. The footprint is
small enough, and the overlap with existing tokens complete enough, that this is a mechanical
migration for the large majority of call sites, with a short, enumerable list of genuinely manual
spots called out below. Tailwind 4's own docs disclaim Sass support, `sass` carries a **high** `npm
audit` finding via `immutable` (`docs/audits/2026-09-13-dependency-audit.md` §4/E), and `tailwind.css`
already uses `color-mix()` in production (lines 159, 167) — so the one non-syntactic risk (browser
support for `color-mix()`/native nesting) is already live in the shipped app, not a new one this
migration introduces. Vite's build target is `es2022` and there is no `.browserslistrc` pinning
anything older.

## Current footprint (re-verified 2026-09-14, frontend/src)

| Metric | Count |
| --- | --- |
| `.scss` partial files (`css/`) | 9, 4,053 lines total |
| `_page-contents.scss` alone | 2,962 lines |
| `<style lang="scss">` blocks | 83 files (single block each; the WP's "132" figure over-counted — see note) |
| `.vue` files referencing bare `$variable`s | 44 |
| `@use` | 21 (17 palette/theme imports + 4 dangling `@use 'sass:color'`, see below) |
| `@at-root` | **318**, across 39 files — not counted in the original spike brief; the single largest conversion surface |
| `@include` / `@mixin` | 2 / 1 (one pair: `Graph.vue`'s `graph-panel`) |
| `darken()` / `lighten()` (real calls) | **0** — the two the brief counted are gone; only comment prose using those words remains |
| `rgba($variable, …)` | 3 (`EditorMarkdown.vue:2153`, `GroupRulesEditor.vue:703-704`) |

Note on the block count: `grep -rl 'lang="scss"'` returns 83 *files*; the brief's 132 figure most
likely counted something else (e.g. every `<style>` tag including plain ones, or a stale snapshot) —
re-run `grep -rc 'lang="scss"' frontend/src/**/*.vue` before filing further Tasks if the discrepancy
matters to sizing.

## Variable → token map

`_theme.scss` and `_palette.scss` are almost entirely a Sass face on the same values
`css/tailwind.css`'s `@theme` block already publishes as `--color-*` (the header comment on
`_theme.scss` says as much: "these are the SCSS FACE of the same palette"). Practically every
`$variable` used anywhere outside the two definition files itself has a same-named
`--color-<name>` custom property:

- **Brand** (`$primary`, `$secondary`, `$accent-fill`, `$accent-strong`, `$accent-wash`, `$slate*`,
  `$ink`, `$paper`, `$surface`, `$tint*`, `$hairline*`, `$rule`, `$text-*`, `$positive*`,
  `$negative*`, `$dark*`) → `var(--color-<same-name>)`, 1:1.
- **Material palette** (`$blue-*`, `$blue-grey-*`, `$green-*`, `$grey-*`, `$orange-*`,
  `$deep-orange-*`, `$red-*`, `$teal-*`) → `var(--color-<same-name>)`, 1:1 for every shade actually
  referenced outside `_palette.scss`.
- **`$breakpoint-*-max`** (599.98px / 1023.98px / 1439.98px) has no CSS custom-property equivalent to
  translate to 1:1 — these exist specifically because a **media query** can't read a custom property.
  Keep them as literal numbers in whichever file replaces `_palette.scss`'s role (or a small
  `@media` literal constants file); note `tailwind.css` already documents these as "mirrored" from
  its own `--breakpoint-*` values (`_palette.scss:74-76`) and asks that the two be kept in step by
  hand — that comment moves with them, unchanged.
- **`$shadow-2`** — a literal three-layer `box-shadow`. Zero external references outside
  `_palette.scss` today (unlike `--shadow-card`/`--shadow-menu`/`--shadow-dialog` in `tailwind.css`,
  which are a different, actively-used token family) — drop it rather than port it.

### One real gotcha: `$warning` is NOT `--color-warning`

`_theme.scss`'s bare `$warning` (`#a8801f`) is the **text** tone; `tailwind.css`'s `--color-warning`
resolves (via `--q-warning`) to `#d9a441`, the **fill** tone — i.e. the same value as SCSS's
`$warning-fill`. The two systems chose opposite defaults for which tone gets the bare name:

| SCSS name | value | tone | correct CSS target |
| --- | --- | --- | --- |
| `$warning` | `#a8801f` | text | `var(--color-warning-text)` |
| `$warning-fill` | `#d9a441` | fill | `var(--color-warning)` (== `--color-warning-fill`) |

A naive `$warning` → `var(--color-warning)` rename would silently swap fill and text tones — a real
contrast bug (the fill tone is only 3.0:1 as text; see `tailwind.css`'s own comment at line 197). In
practice this has **zero live blast radius**: `grep -rln '\$warning\b'` (excluding `-fill`) outside
`_theme.scss` itself returns nothing — no component uses the bare name today. Still worth a one-line
callout in the conversion Task that touches `_theme.scss`, and worth a quick grep-before-delete check
by whoever does that Task, in case something lands between now and then.

### Dead variables/imports to drop, not port

- `$yellow-7` (`_palette.scss`) — defined, never referenced anywhere else. No `--color-yellow-7`
  exists in `tailwind.css` either (only `-6`/`-9`); since nothing uses it, don't add one.
- `$accent-text` (`_theme.scss`, `= $primary`) — defined, never referenced outside its own file.
- `$secondary` / `$info` (`_theme.scss` aliases of `$positive`/`$slate`) — same: no external bare
  reference found.
- Four **unused** `@use 'sass:color'` imports — `EditorCode.vue:254`, `EditorAsciidoc.vue:278`,
  `SideDialog.vue:81`, `AdminLayout.vue:788`. None of the four files calls anything from the `color.*`
  namespace (`grep -n 'color\.' <file>` is empty in all four) — leftover from an earlier revision
  that did. Delete the `@use` line; it is dead weight even before any nesting migration.

## Block classification

Three buckets, by what a block actually needs beyond `$variable` substitution:

1. **Trivial** (variables + plain nesting only, including `&` used mid-selector as in
   `.body--light &`) — the majority of the 83 files. Native CSS nesting supports `&` anywhere in a
   compound/complex selector, so `X & { … }` compiles identically whether Sass or the browser resolves
   it. This bucket also absorbs the ~300 of 318 `@at-root <selector> &` occurrences (see next
   section) — in this codebase `@at-root` is used almost exclusively as `@at-root <ancestor-class> &`
   inside a **single level** of nesting (a theme/aesthetic toggle: `.body--light &` /
   `.body--dark &` / `body.body--cobalt &` / `.body--dark:not(.body--cobalt) &`, etc.), which is
   exactly the shape plain nesting already produces without `@at-root` — the keyword is redundant
   there today, not load-bearing. **Still needs a per-file check, not a blind strip**: `@at-root`'s
   actual job is "ignore ALL ambient nesting, not just the immediate parent," so a block that nests
   the theme toggle *inside* another nested rule (more than one level deep) would compile to a
   different, longer selector without `@at-root` than with it. A quick script can flag any `@at-root`
   whose enclosing brace depth (within the same `<style>` block) is greater than 1 for manual review;
   everything at depth 1 converts by deleting the word.
2. **Needs restructuring** (colour functions, the one mixin, or `@at-root` used as a genuine
   "escape to an unrelated selector" rather than a same-selector theme toggle):
   - The 3 `rgba($var, opacity)` call sites → `color-mix(in srgb, var(--color-x) N%, transparent)`,
     following the pattern already sitting in the *same file* at `GroupRulesEditor.vue:695-696`/
     `698-699` (`.is-allow`/`.is-deny` right next to the `.is-forceallow` rule that still uses
     `rgba($blue, …)`) — this is not a new idiom to introduce, just finishing a conversion already
     half-done in that file.
   - `Graph.vue`'s one `@mixin graph-panel` / two `@include graph-panel` sites — no native-CSS
     mixin equivalent; either duplicate the ~15 declarations at both call sites (cheapest, and this
     is the only mixin in the whole codebase) or lift the shared rule to one class both elements
     carry in their template (`class="graph-view-right-rail graph-panel"`). Recommend the class —
     it's one extra `class` attribute at two call sites versus duplicated CSS forever.
   - Genuine `@at-root`-as-escape sites, confirmed by reading each (not inferable from the selector
     shape alone): `NavSidebar.vue:325` (`@at-root body.body--cobalt .sidebar-nav .w-item--clickable`
     — deliberately does NOT include `&`, documented in the block's own comment at line 318 as
     needed so the rule doesn't inherit the surrounding `.sidebar-nav .w-list` scope), the four
     `_page-contents.scss:2299-2308` `@at-root body .table-scroll::-webkit-scrollbar-*` rules
     (escaping out from under a selector the scrollbar pseudo-elements can't be a descendant of —
     see that file's own comment at line 2286), `TableEditorOverlay.vue:556`
     (`@at-root tbody > tr:nth-child(even) > &`), and `EditorMarkdown.vue:2152`
     (`@at-root .theme--dark &` — note this one also uses the legacy `.theme--dark` class rather than
     the app's current `.body--dark`, a second, unrelated thing worth flagging to whoever converts
     it, not silently carrying forward). None of these need a *new* technique — each becomes a
     plain, unnested top-level (or correctly-scoped) rule written outside the enclosing block, the
     same transformation `@at-root` already performs, just done by hand instead of by the
     preprocessor. Six call sites total; each is a two-minute edit once you've read why it's there.
3. **`_page-contents.scss`** (2,962 lines) — kept as its own bucket per the WP's own framing. It is
   the article-rendering stylesheet: every content type (headings, code blocks, tables, callouts,
   diagrams, math) across both themes and both aesthetics (Ledger/Cobalt) lives here, which is also
   why it alone accounts for a large share of the 318 `@at-root` occurrences (the per-file grep
   showed roughly a third of the total sitting in this one file). Its own Task below, and that Task
   should expect to be the one that most needs splitting further once someone is actually inside it.

## Colour-function strategy

`color-mix(in srgb, var(--color-x) N%, transparent)` for every `rgba($var, N)` translucency use —
already proven in this exact codebase (`GroupRulesEditor.vue`, see above) and already shipping in
`tailwind.css`. Relative colour syntax (`rgb(from var(--x) r g b / 0.5)`) is not needed anywhere here:
there are no `darken()`/`lighten()` calls left to replace (confirmed by grep — the WP brief's "1/1"
count predates whatever already removed them), and the sole use of a Sass colour **function** in the
codebase is the module import (`@use 'sass:color'`) that turns out to be dead in all four files that
have it. Browser support is a non-issue: `color-mix()` (Chrome 111, Firefox 113, Safari 16.4) and
native CSS nesting (Chrome 120, Firefox 117, Safari 17.2) both clear Tailwind 4's own minimum browser
matrix, which this app already requires by using Tailwind 4 at all.

## Vitest config retirement

`frontend/vitest.config.js` mirrors `vite.config.js`'s `css.preprocessorOptions.scss.additionalData`
line-for-line (`frontend/CLAUDE.md`'s Testing section explains why: a component's `<style lang="scss">`
block resolving `$primary` bare only works under test if the same `@use` runs there, and `test.css:
true` has to stay on for the same reason it's on today — Sass or no Sass, a real CSS pass still needs
to run for `PageToc.vue`-style suites to catch a token that only breaks in an actual stylesheet).
Once every `<style>` block drops `lang="scss"` and its bare `$variable`s, retiring this is two deletes
in lockstep, same commit:

1. `vite.config.js`: delete `css.preprocessorOptions.scss` (the whole block — nothing else in the
   config references `scss`).
2. `vitest.config.js`: delete the mirrored `css.preprocessorOptions.scss.additionalData` line, and
   the paragraph in `frontend/CLAUDE.md`'s Testing section that documents why it exists (the
   `test.css: true` line stays — it now backs plain CSS, not Sass, and the "silently skip the very
   thing being verified" hazard is unchanged).

This can only land in the **final** Task (after every `<style lang="scss">` block has been converted)
— deleting the injection earlier breaks every not-yet-converted file's bare `$variable` reference with
a Sass "undefined variable" build error, exactly the failure mode `frontend/CLAUDE.md` already warns
the mirrored config exists to prevent.

## Risks / edge cases

- **`@at-root` at nesting depth > 1** (see block classification, bucket 1) — the one place a blind
  find-and-replace of `@at-root X &` → `X &` is not obviously safe. Needs a depth check, not just a
  regex.
- **The `$warning` / `--color-warning` name mismatch** (see above) — zero current blast radius, but a
  landmine for whoever writes the conversion by pattern-matching variable names without reading this
  doc.
- **`.theme--dark` vs `.body--dark`** in `EditorMarkdown.vue:2152` — a pre-existing inconsistency
  unrelated to Sass removal; the Task touching that line should decide (and say explicitly) whether
  it's fixing the class name too or deliberately preserving current (possibly already-dead) behaviour,
  rather than the Sass conversion silently changing which class the rule matches.
- **`_page-contents.scss` is render-critical and touched by no other WP this round** (per the
  epic-tree coordination note, the frontend Vue/helper files for sibling WPs 3160-3176 were verified
  disjoint by grep) — safe to convert in isolation, but needs the heaviest visual-verification pass
  of any Task in this breakdown: every content-type fixture, both themes, both aesthetics.
  `frontend/CLAUDE.md`'s "Any visual/aesthetic change... gets rendered and looked at" testing rule
  applies in full here, not as a formality.
  - Vitest's `jsdom`/`happy-dom` run no layout engine and CSS-reasoning-alone has previously been
    wrong on this exact codebase (`frontend/CLAUDE.md` cites a token declared in only one theme block
    reading correct in diff and drawing ink-on-ink live) — every conversion Task below needs the real
    build-and-screenshot loop that section documents, not just a green Vitest run, before merging.
- **No production code changes are in scope for #3172 itself.** Everything above is analysis; the
  Tasks filed against it are where the actual `.scss`/`.vue`/config edits happen.
- **File-ownership**: this plan touches no file any sibling WP in this round (3160-3176) claims —
  confirmed against the epic-tree coordination note's per-WP file lists. The eventual conversion
  Tasks will touch `frontend/package.json` (removing `sass`) only in the final teardown Task; per the
  coordination note that file is contended by 7 WPs *this* round, none of which are these — future
  rounds picking up these Tasks should re-check contention before that Task's turn.

## Proposed Task breakdown

Filed as Tasks under Feature #1162 (this WP's own parent — #3172 is itself a Task, so new Tasks are
siblings of it, not children; OpenProject's parent policy requires a Task's parent to be a Feature).
Each is independently mergeable and carries its own light/dark(+Cobalt where relevant) screenshot
verification per `frontend/CLAUDE.md`'s visual-change testing rule. Suggested order:

1. **Drop dead Sass artifacts** — `$yellow-7`, `$accent-text`, `$secondary`, `$info` aliases from
   `_theme.scss`/`_palette.scss`, and the four dangling `@use 'sass:color'` imports. Zero visual
   change expected; a quick app-wide light/dark screenshot pass is still the acceptance check (these
   files are injected everywhere).
2. **Convert the 3 `rgba($var, …)` call sites to `color-mix()`** — `EditorMarkdown.vue`,
   `GroupRulesEditor.vue` (finishing the pattern already half-applied there). Screenshot: the
   Markdown editor's teal callout and the group rule editor's forceallow row, both themes.
3. **Convert the small standalone partials**: `app.scss`, `_animation.scss`, `_print.scss`,
   `_content-image-lightbox.scss` (20+91+56+99 = 266 lines, variables/nesting only). One Task; low
   individual risk, bundled for review efficiency.
4. **Convert `_overlay-dialog.scss`** (150 lines) — its own Task since dialogs are a distinct,
   widely-shared surface worth isolating in review.
5. **Convert `_base.scss`** (494 lines) — the shared base layer every page inherits; own Task for the
   same reason as #4.
6. **Convert the ~78 remaining component/page/layout `<style lang="scss">` blocks** — recommend the
   assignee split this further by directory (`components/shared/`, `components/`, `pages/`,
   `layouts/`) once inside it rather than filing it as one PR; each sub-slice still needs its own
   light/dark screenshot pass. This is the bulk of the 318 `@at-root` occurrences at nesting depth 1.
7. **Hand-convert the six genuine `@at-root`-as-escape sites** — `NavSidebar.vue`, the four
   `_page-contents.scss` scrollbar rules, `TableEditorOverlay.vue`, `EditorMarkdown.vue` (deciding
   the `.theme--dark`/`.body--dark` question explicitly). Small in count, highest per-site risk;
   worth its own Task so it gets focused review rather than being buried in #6.
8. **Convert `_page-contents.scss`** (2,962 lines) — its own Task per the original WP framing;
   expect the assignee to split it further once inside (by content-type section) given its size and
   render-criticality. Depends on nothing above but should land after #7 if the two touch overlapping
   scrollbar/table rules.
9. **Mixin removal + final teardown** — convert `Graph.vue`'s `graph-panel` mixin to a shared class;
   delete `_theme.scss`/`_palette.scss`; delete `css.preprocessorOptions.scss` from `vite.config.js`
   and its mirror in `vitest.config.js`; drop the now-unneeded `lang="scss"` attribute across all
   converted `<style>` blocks (native nesting needs no preprocessor, so the attribute becomes a no-op
   once nothing in the block needs Sass); update `frontend/CLAUDE.md`'s Testing section to remove the
   retired paragraph; uninstall the `sass` devDependency from `frontend/package.json` (regenerate the
   lockfile, don't hand-edit — the same convention the coordination note asks of the two other
   contended `package.json`s this round); update
   `docs/audits/2026-09-13-dependency-audit.md` if it still lists `sass`/`immutable` as live findings.
   **Must land last** — every Task above must be merged first, or the additionalData removal breaks
   whatever hasn't converted yet.

Tasks 1-5 and 7 are small and can run in any order relative to each other; 6 and 8 are the two large,
independently-splittable efforts; 9 is a hard final step.
