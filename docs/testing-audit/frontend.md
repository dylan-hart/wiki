# Test-value classification: `frontend/`

OpenProject **#2688**, under Feature **#2602** ("Re-proportion the suite"). This is the `frontend/`
half of the classification; **#2687** owns the `backend/` half in the sibling file, and **#2689**
reads both to write `docs/decisions/testing-strategy.md`.

**This document classifies. It deletes nothing, renames nothing, and changes no test.** Feature
#2602's resolved scope puts the pruning pass on `backend/` first and explicitly declines to spend
the pruning budget on `frontend/` without evidence — producing that evidence is what this file is.
Everything in [Pruning candidates](#pruning-candidates-for-a-later-decision) is a candidate for a
later, separate decision, not a recommendation to act now.

## Method

### Enumeration

```sh
# The denominator: every test file in the workspace.
find frontend -name '*.test.js' -not -path '*/node_modules/*' | wc -l   # -> 308

# Test LOC and source LOC.
find frontend -name '*.test.js' -not -path '*/node_modules/*' | xargs wc -l | tail -1
#   -> 58231 total
find frontend/src -type f \( -name '*.js' -o -name '*.vue' \) -not -name '*.test.js' \
  | xargs wc -l | tail -1
#   -> 87597 total
```

Measured at commit **`3b3635f74`** ("Add Claude Design docs"), the tip of `scarlett` when this
classification was made (2026-09-06).

### The denominator covers all four of `vitest.config.js`'s `include` entries

`frontend/vitest.config.js` includes `src/**/*.test.js`, `scripts/**/*.test.js`,
`test/**/*.test.js` and the root `index.test.js`. All four are what `npm run test` actually runs,
and all four are classified here:

| `include` entry | files |
| --- | ---: |
| `src/**/*.test.js` | 299 |
| `scripts/**/*.test.js` | 2 |
| `test/**/*.test.js` | 6 |
| `index.test.js` | 1 |
| **total** | **308** |

Nothing under `frontend/` matches `*.test.js` outside those four — verified — so the `find` above
and the config's own globs agree on the same 308 files.

### Reconciling the WP's 305

Feature #2602 and WP #2688 both say **305 test files, 57,903 test LOC**, measured 2026-09-05. The
tree says otherwise, and the delta is worth pinning down rather than restating. Counting
`frontend/**/*.test.js` out of the tree at each commit gives **304** at `f8bdb5f05^` and **308** at
`f8bdb5f05` itself.

`f8bdb5f05` (2026-09-05) added four test files — `components/NavSidebarItem.test.js`,
`composables/pathDisplay.test.js`, `helpers/pathHumanize.test.js`, `pages/graphSimulation.test.js`
— taking the tree from 304 to 308, where it has stayed through `cdd3bfd9c`, `8559fbcbe` and
`3b3635f74`. **305 matches no commit in this tree**, so it is treated as an approximate same-day
figure from a slightly different enumeration rather than reconciled to a specific SHA. Source LOC
(87,597) matches the WP exactly, so the source side needs no reconciliation.

**Use 308 / 58,231 / `3b3635f74` as the denominators.** #2689 and #2690 should quote these, not the
WP's 305.

### What "classified" means here

Feature #2602 rules out scripting the judgement: *"Classification is a judgement a heuristic script
cannot make well, and the value here is the decisions."* So:

- **Objective signals were gathered mechanically** and used only as input — per-file LOC, per-file
  `it`/`test` count (2,951 cases across 308 files), which files read source text off disk (36),
  which reach into component internals via `wrapper.vm` (90 files, 1,146 occurrences), which assert
  a mock's exact call arguments via `toHaveBeenCalledWith` (104 files, 308 occurrences), and which
  drive a real Chromium (2).
- **The category and the reason are hand-assigned per file**, from that file's own header rationale
  (this codebase writes a substantial one on most suites), its `describe`/`it` titles, and — for
  anything the first two did not settle — a full read of the file.
- **No script produced any row below.** The metrics above are reproducible from the commands in this
  section; nothing else here is.

## The four categories

Feature #2602's four, verbatim. There is deliberately no fifth label — see
[Position: the source-scanning convention gates](#position-the-source-scanning-convention-gates)
for why the convention gates were not given one.

| # | Category | What it means here |
| --- | --- | --- |
| 1 | **product behaviour** | The failure it guards is something a reader, author or administrator would experience: wrong output, a control that does not work, a missing accessible name, an untranslated string, a mirrored-wrong RTL layout, a lost draft, a permission granted that should not be. |
| 2 | **framework behaviour** | The assertion holds because Vue, vue-router, Pinia, Vitest, happy-dom or a third-party library behaves as documented. The app's own code contributes nothing to the outcome, so the test can only fail if a dependency broke. |
| 3 | **implementation restatement** | The assertion is the implementation re-typed in assertion form — a private helper's name, a mock's exact call arguments, an internal `state.*` field, a URL string, a class name with no behavioural consequence. A behaviour-preserving refactor breaks it; a behaviour break does not reliably fail it. |
| 4 | **environment** | What it gates is the toolchain, the build output, the vendored asset set, the config or the test harness itself — not the application. |

Two rules applied consistently, because they decide a lot of rows:

- **Classify by what breaks in the product, not by the mechanism the test uses.** A source-text scan
  that fails when an `<img>` loses its `alt` is gating product behaviour through a textual proxy;
  the proxy is a precision cost, recorded in the reason column, not a different category.
- **A mixed file takes its dominant category in column 2, with the rough share stated in column 3.**
  Hedged labels ("mostly 1, some 3") are not used — #2689 aggregates on the category strings.

## The shape of the suite, before any judgement

| Area | test files | test LOC | source LOC | test : source |
| --- | ---: | ---: | ---: | ---: |
| `src/components/shared/` | 24 | 4,485 | 8,267 | 0.54 |
| `src/components/` (excl. `shared/`) | 104 | 20,730 | 36,542 | 0.57 |
| `src/pages/` | 67 | 16,101 | 25,690 | 0.63 |
| `src/helpers/` | 44 | 4,935 | 5,834 | 0.85 |
| `src/composables/` | 19 | 2,857 | 3,985 | 0.72 |
| `src/stores/` | 10 | 3,178 | 2,452 | **1.30** |
| `src/renderers/` (incl. `modules/`) | 6 | 1,152 | — | — |
| `src/layouts/` | 3 | 775 | — | — |
| `src/` root (`App.*` + convention gates) | 15 | 2,545 | — | — |
| `src/boot/`, `src/build/`, `src/css/`, `src/router/` | 7 | 943 | — | — |
| `scripts/` | 2 | 258 | — | — |
| `test/` (harness's own coverage) | 6 | 509 | — | — |
| `index.test.js` | 1 | 70 | — | — |
| **total** | **308** | **58,231** | **87,597** | **0.66** |

The workspace-level ratio is **0.66 test LOC per source LOC** — not the inverted ratio `backend/`
shows. **`src/stores/` is the one inverted directory in `frontend/`**, at 1.30, and it is the only
place in this workspace where the volume question is worth asking on the numbers alone.

## The four positions this classification is asked for

### Position: the two real-Chromium suites

`components/ApiKeyCreateDialog.test.js` and `components/ProfileApiKeyCreateDialog.test.js` each
carry one `describe` that launches Playwright's bundled Chromium through `test/realGridLayout.js`
to measure how many columns an `auto-fit`/`minmax()` CSS Grid actually renders at a given width.
Both are gated `{ skip: !hasChromium(), timeout: 30000 }`, so a machine with no browser binary
reports them skipped and exits zero.

They are the most expensive tests in the workspace per assertion, and they are worth it.

- **Neither jsdom nor happy-dom runs a layout engine.** There is no cheaper mechanism that answers
  the question at all — not a different emulator, not CSS reasoning. `CLAUDE.md`'s "Testing
  (frontend)" section states that as the reason `test/realGridLayout.js` exists, and Feature
  #2602's own scope names the case that settled it: the overlay scroll/dismiss defect in PR #43 was
  invisible to CSS reasoning *and* to jsdom, and only a real headless Chromium exposed it. (That
  case is recorded in the Feature and in the PR itself; it is not written down anywhere under
  `docs/decisions/`, which is one more reason #2689's policy document should carry it.)
- **The cost is bounded and already contained.** Two `describe` blocks, not two files: the rest of
  both suites is ordinary happy-dom work. The Chromium launch is skipped entirely when no browser
  is installed, so the cost is opt-in per machine and paid once per CI run.
- **The recorded failures were launch timeouts, not measurements.**
  `docs/cardinal-reskin-second-pass.md` attributes them to browser-*launch* timeouts under eight
  Vitest workers — an environment problem that Feature #2601's pinned image and a worker/timeout
  setting both address, not a signal that the assertions are unstable.

**Verdict: keep, and do not quarantine.** They are classified here on what they gate — product
behaviour — with their cost stated as cost. Whether they move to a `*.flaky.*` lane is **#2691's
decision**, and this document deliberately does not pre-empt it by labelling them category 4. If
#2691 does move them, see [Notes for #2689 and #2690](#notes-for-2689-and-2690): two path columns
below go stale.

The one thing worth doing regardless is making them *cheaper to trust* rather than cheaper to run:
the honest gap is that `test/realGridLayout.js` has no co-located coverage of its own (it and
`test/setup.js` are the two harness modules without a suite; `setup.js` is at least exercised
transitively by every test in the workspace, and `realGridLayout.js` is not), so a break in the
harness these two depend on presents as two unexplained layout failures.

### Position: the source-scanning convention gates

Thirty-six files read source text off disk rather than mounting anything. Sixteen of those are
whole-tree or whole-directory scans that exist to hold a convention:
`adminIconHeaderSize`, `autofocusUsage`, `buttonAccessibility`, `docsBaseGate`, `i18nSourceGate`,
`i18nUnexpectedErrorLiteral`, `imgAlt`, `logicalSpacing`, `physicalPositioning`,
`pages/pageTitles`, `pages/pageTitleHeadings`, `components/dialogAccessibleName`,
`components/shared/wComponentAttributeDrift`, `css/_base`, `css/_page-contents`, `css/_print`.
The remaining twenty either read one file's source as a single assertion inside an otherwise
ordinary mounted suite (`NavSidebar`, `PageHeader`, `WDate`, `WDrawer`, `AdminLayout`,
`Graph.darkMode`, the four overlay suites, …) or read files for an unrelated reason —
`helpers/fonts.test.js` validating vendored woff2 binaries, `test/sourceFiles.test.js` building a
temporary tree to walk, `index.test.js` extracting a script out of `index.html`.

**They are not a fifth category, and they split across two of the four.** The question a category
answers is *what breaks in the product when this file is deleted and the thing it guarded
regresses* — not *what mechanism does the assertion use*. On that test:

- **Most are category 1.** A missing `alt`, an unnamed `<w-btn>`, an unnamed dialog, an untranslated
  literal, a physical `margin-left` that does not mirror under RTL, a `<div class="text-h5">`
  standing in for an `<h1>`, a print stylesheet hiding a class no component renders any more — every
  one of those is a defect a real person hits. The scan is a *proxy* for the behaviour, and the
  proxy's cost is real: it can pass while the behaviour is broken some other way, and it fails on a
  refactor that changed the text without changing the behaviour. That cost belongs in the reason
  column, which is where it is recorded, not in a category of its own.
- **A few are category 3.** `autofocusUsage` is the clean example: what it forbids is a *dead*
  `autofocus` attribute that duplicates `useDialogComponent({ autofocus })` wiring. Dead means
  inert — nothing a user could observe changes if it comes back. That is the implementation
  restated, and it is classified as such.

**Why a fifth category was rejected.** "Convention" describes the mechanism, and mechanism-shaped
categories do not help the pruning decision Feature #2602 exists to make: two files using the same
scan can be worth wildly different amounts (`imgAlt` versus `autofocusUsage`), and two files gating
the same accessibility property can use different mechanisms (`imgAlt` scans source,
`shared/WPage.test.js` mounts). Splitting on mechanism would put those pairs on the wrong side of
every line. It would also break #2689's aggregation, which is defined over exactly four strings.

**What the policy needs to say about them** (#2689's call, stated here as the evidence): a
source scan is the right tool when the property is textual and the mount cost is disproportionate —
which is the rationale every one of these files already writes down — and the wrong tool when a
real assertion is available at comparable cost. The two whole-tree scans that overlap
(`pageTitles` ≡ `pageTitleHeadings`, both #1630/#1637) and the two pairs of near-identical scanners
(`autofocusUsage` ≡ `buttonAccessibility`, `imgAlt` ≡ `adminIconHeaderSize`, a similarity
`test/sourceFiles.test.js`'s own header already names) are the evidence that this mechanism
proliferates faster than it is consolidated.

### Position: the `describe.each` cross-component pattern

Three files exist purely to hold what is identical between components:
`components/editorMarkupShared.test.js` (EditorAsciidoc ≡ EditorCode),
`components/apiKeyScopeTree.test.js` (ApiKeyCreateDialog ≡ ProfileApiKeyCreateDialog) and
`src/docsBaseGate.test.js` (seven fork-invented surfaces that previously carried the same
assertion and the same seven-paragraph rationale seven times).

**The pattern is under-used, not over-used.** Every one of the three replaced a real, verbatim
duplication, each records what it consolidated, and none of them dropped coverage — each component
is still exercised and still reports under its own name. Against that, the tree still holds
duplication of exactly the shape the pattern exists to absorb:

- `pages/pageTitles.test.js` and `pages/pageTitleHeadings.test.js` scan the same directory for the
  same #1630/#1637 conversion.
- `src/autofocusUsage.test.js` and `src/buttonAccessibility.test.js` are the same tag-parsing
  scanner with a different predicate; so are `src/imgAlt.test.js` and
  `src/adminIconHeaderSize.test.js`. `test/sourceFiles.test.js`'s header already says so.
- The thirteen `pages/Graph*.test.js` / `pages/graph*.test.js` files re-establish the same
  fixture-and-mount preamble; `pages/graphFixtures.js` exists and is used, but the split is by
  concern rather than by shared assertion, so several dark-mode and i18n claims are asserted more
  than once across the cluster.
- Five suites (`pages/Admin{Api,Cluster,Glossary,Metrics}.test.js` and
  `components/BlockPickerOverlay.test.js`) each assert "has no help/docs button" (`docsBase`) in
  their own file, while `docsBaseGate.test.js` holds the same assertion for seven *other* surfaces.
  The gate's own header says a new fork-invented surface should be added as one line there; those
  five have not been.

**What the policy should say**: when the same claim is asserted about two or more components,
`describe.each` in a named shared file is the form, and the shared file names what stayed behind in
each component's own suite. That is already this repo's documented convention (`CLAUDE.md`,
"Testing (frontend)"); the gap is application, not the rule.

### Position: the harness's own coverage under `frontend/test/`

Six files, 509 LOC, covering `fixtures.js`, `i18n.js`, `mocks.js`, `mount.js`, `router.js` and
`sourceFiles.js`. `CLAUDE.md` states the rationale — *"a break in it fails as itself rather than as
a hundred unrelated component failures."*

**Classified category 4 (environment), and deliberately kept.** They gate the test harness, not the
application, which is what category 4 means; that is not a synonym for waste. The justification is
load-bearing and specific to this harness's fan-in. Measured at `3b3635f74`: `test/setup.js` runs
before **every** test in the workspace (it rebuilds `API_CLIENT` and `EVENT_BUS` and registers the
whole `w-*` library); `test/mount.js` is imported directly by 64 suites and indirectly by more
through the per-component harness modules; `test/sourceFiles.js` by nine of the sixteen scanning
gates (five of the other seven still carry their own `readdirSync` loop — see the consolidation
note below; the remaining two read one named file each). A
regression in any of those produces a failure signature that points everywhere except at the cause.
509 LOC is 0.9% of the workspace's test LOC to make that signature readable.

**Two honest gaps, neither a reason to prune:**

- `test/realGridLayout.js` and `test/setup.js` have no co-located coverage. `setup.js` is exercised
  transitively by everything, but `realGridLayout.js` is not — it stands behind exactly the two
  most expensive and most launch-fragile describes in the workspace, which is the worst place to
  have no self-check.
- The two modules with the widest fan-in (`setup.js`, `realGridLayout.js`) are precisely the two
  with no suite; the six that do have one are the narrower half. `mount.test.js` and
  `sourceFiles.test.js` are the two that earn their keep most obviously.

## Classification

Columns are fixed across both halves of this audit: `path | category | one-line reason | what gates
this behaviour if the file goes away`. Column 4 is mandatory for anything not category 1; for
category 1 it is filled in where there is a real answer and left `—` where the honest answer is
"nothing else does".

Paths are relative to `frontend/`. LOC is the file's own line count at `3b3635f74`.

### `src/components/shared/` — the component library (24 files, 4,485 LOC)

This is the app's own UI vocabulary, not a third-party library, so a claim about `WDialog`'s focus
trap is a claim about this product. The library is where nearly all of the workspace's keyboard,
focus, `inert`, scroll-lock, ARIA and RTL-logical-property coverage lives, and almost none of it is
reachable any other way: `e2e/` drives five flows in one browser at one viewport, and page-level
suites mount these components without exercising their edges.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/components/shared/WDialog.test.js` (772) | product behaviour | The modal contract end to end — `inert` on the app root, focus trap and Tab cycling, focus restore on close and on unmount, stacked-dialog ordering, scroll-lock take/release balance, accessible name, Escape precedence against a nested `WMenu`. | Nothing. `e2e/` opens dialogs but asserts none of this; a broken focus trap is silent to every other suite. |
| `src/components/shared/WMenu.test.js` (640) | product behaviour | Menu keyboard navigation (arrows/Home/End/wrap/skip-disabled), focus return to the trigger on every close path, Escape-stack release on unmount, the Context-Menu key and Shift+F10, and touch long-press with jitter tolerance. | Nothing. |
| `src/components/shared/WSelect.test.js` (417) | product behaviour | Listbox open/close, single- vs multi-select model shapes, filter narrowing, `create` on Enter, disabled/readonly refusal, rule validation with a live region, and the dictionary-resolved empty state. ~15% restatement (attribute forwarding onto the inner control). | Nothing. |
| `src/components/shared/WInput.test.js` (389) | product behaviour | Field behaviour a form depends on: clearable, password reveal with a changing `aria-label`, the three `lazyRules` modes, live-region error announcement, autofocus, and `aria-label` placement on the real `<input>`. ~20% restatement (attribute forwarding, `$attrs` exclusions). | Nothing. |
| `src/components/shared/WRange.test.js` (211) | product behaviour | Both slider shapes (one handle and two) under keyboard control, bound clamping, disabled refusal, per-handle `aria-label`s and the value bubble. | Nothing. |
| `src/components/shared/WTable.test.js` (200) | product behaviour | Row/column rendering, sort direction cycling and column switch, case-insensitive filtering over rendered values, non-mutation of the `rows` prop, and the `#no-data` slot's four visibility states. | Nothing. |
| `src/components/shared/WDate.test.js` (175) | product behaviour | Calendar labels resolve through the app locale rather than a hardcoded English array, and re-derive on a live locale change; plus the view-anchor rules on a `modelValue` set after mount. Includes one source-scan assertion pinning the single legitimate call site of a helper. | Nothing. |
| `src/components/shared/WBtn.test.js` (152) | product behaviour | Button/anchor element choice, click blocking while disabled or loading, the AA-contrast foreground computation per themeable colour, and the icon-only accessible-name rule. | The contrast half overlaps `helpers/accessibility.test.js`'s palette pinning; the rest, nothing. |
| `src/components/shared/WDrawer.test.js` (137) | product behaviour | Drawer side anchoring and borders use logical inset/border properties, so a start-side drawer mirrors under RTL; plus the overlay/narrow breakpoint. Source-scan assertions alongside mounted ones. | Partly `src/logicalSpacing.test.js`'s repo-wide scan, which would catch a physical utility but not a wrong logical one. |
| `src/components/shared/WConfirmDialog.test.js` (131) | product behaviour | The shared destructive-confirmation dialog's prop interactions — cancel visibility, the destructive colour/label defaults, and the unreachable `persistent` + no-cancel combination. | Nothing; `CLAUDE.md` names this dialog as the only supported "delete this" affordance, so its defaults are product policy. |
| `src/components/shared/WTooltip.test.js` (100) | product behaviour | `aria-describedby` is set on the trigger and cleared on hide and on unmount without clobbering a pre-existing value; `labels` switches to `aria-labelledby`. | Nothing. |
| `src/components/shared/WToggle.test.js` (99) | product behaviour | Toggle state, click blocking while disabled and while loading, and the spinner substitution. ~30% restatement (two rest-position/fill class assertions). | Nothing. |
| `src/components/shared/WCardHeader.test.js` (92) | product behaviour | The minted `headingId` that `WDialog`'s `labelled-by` depends on is non-empty, stable across re-renders, lands on the heading and not the hint, and the configurable heading level renders a real `h1`–`h6`. | `components/dialogAccessibleName.test.js` gates that callers pass a name, not that the id is real. |
| `src/components/shared/WCheckbox.test.js` (85) | product behaviour | `aria-checked` reflection, boolean and array model shapes, the indeterminate glyph and its click semantics, and disabled. | Nothing. |
| `src/components/shared/WForm.test.js` (82) | product behaviour | Submit is gated on every field validating, and a failed submit moves focus to the *first* invalid control — the behaviour a keyboard user depends on to find the error. | Nothing. |
| `src/components/shared/WIcon.test.js` (78) | product behaviour | The four rendering paths (`bundled inline svg` / `iconify-icon` / `img:` / nothing), including that a legacy webfont-style name draws nothing rather than silently appearing to work. | `npm run icons:check` gates the bundle, not the component's dispatch. |
| `src/components/shared/WChip.test.js` (73) | product behaviour | Slot-over-label precedence, the clickable/`role="button"` gate, and the remove button's dictionary-resolved label. | Nothing. |
| `src/components/shared/WBadge.test.js` (44) | product behaviour | Label fallback, the floating-position variant, and the native title tooltip. ~25% restatement (positioning class assertions). | Nothing. |
| `src/components/shared/WBreadcrumbs.test.js` (38) | product behaviour | Icon-to-label spacing uses a logical inline-end margin, so breadcrumbs do not mis-space under RTL, and an icon-only crumb gets none. | Partly `src/logicalSpacing.test.js`. |
| `src/components/shared/WCardSection.test.js` (35) | implementation restatement | Four assertions on padding/layout classes and the presence or absence of an `id` attribute — the template restated; no behaviour changes if any of them regress. | Nothing needs to; the `id` is used for scroll-into-view, which `ProfileOverlay.test.js` exercises for real. |
| `src/components/shared/WLinearProgress.test.js` (34) | product behaviour | The determinate fill anchors to the logical inline-start edge (#1590 — it was found filling from the wrong end under RTL) and reports `progressbar` ARIA values. ~30% restatement (the width style assertion). | Partly `src/logicalSpacing.test.js`, which would not catch a `start-0` → `left-0` regression in a shared component's own file. |
| `src/components/shared/WItem.test.js` (30) | product behaviour | A clickable item is a real tab stop with `role="button"`, and a disabled one drops both and swallows the click rather than emitting. | Nothing. |
| `src/components/shared/WPage.test.js` (19) | product behaviour | `<main id="w-page-main" tabindex="-1">` is what `MainLayout`'s skip link targets; without the id and tabindex the skip link moves scroll but not focus (#1630/#1644). | Nothing — `MainLayout.test.js` asserts the link exists, not that it lands anywhere. |
| `src/components/shared/wComponentAttributeDrift.test.js` (452) | product behaviour | Nothing else in `frontend/` rejects an attribute written against a `W*` component that declares no such prop — with default `inheritAttrs` it renders as an inert HTML attribute, so a broken control looks identical to a working one. Roughly half the file is parser unit tests against in-memory fixtures (category 3 in isolation) that exist to prove the real gate's mechanism. | Nothing. `oxlint` has no such rule and Vue emits no warning. |

### `src/components/` — dialogs, overlays, editors, nav (104 files, 20,730 LOC)

The workspace's largest block. Its defining property is **provenance**: a clear majority of these
suites name the OpenProject defect they were written for in their `describe` title or header, so
"what does this gate" is answered by the file itself rather than inferred. That is the strongest
single argument that `frontend/`'s volume is not the same problem `backend/`'s is — this is
accumulated regression coverage for defects that actually happened, not speculative surface
coverage.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/components/NavSidebar.test.js` (1048) | product behaviour | Sidebar tree semantics: current/contains-current resolution, recursive nesting (#814), mixed folder/page side-trees (#832), the landmark role, the `navigationId` fallback (#2527) and both context menus. | Nothing; `e2e/` never opens the sidebar's context menus. |
| `src/components/FileManager.test.js` (747) | product behaviour | The asset manager end to end — drag-and-drop upload (#790), the context menu (#859/#861–#864), `insertMode` (#2530), the homepage guard (#1149), the keyboard shortcut (#2050), detail thumbnails and dates. | `e2e/assets.spec.js` covers one upload round trip and none of the menu or guard branches. |
| `src/components/GroupEditOverlay.test.js` (688) | product behaviour | The group editor is where every permission and page/site rule is authored; the suite covers the global-permission catalog, rule modes and the rule editor's own validation. | Nothing. A wrong rule here grants or denies real access. |
| `src/components/ImportBatchPageDialog.test.js` (672) | product behaviour | Batch import: per-file parsing, per-row failure isolation, and the summary the author acts on. | Nothing. |
| `src/components/AuthLoginPanel.test.js` (600) | product behaviour | Login, register, 2FA and passkey flows against REST, including each failure branch's message. | `e2e/auth.spec.js` covers the happy password path only. |
| `src/components/PageComments.test.js` (565) | product behaviour | Comment listing, posting, editing, deletion and the permission gates in front of each. | Nothing. |
| `src/components/UserEditOverlay.test.js` (508) | product behaviour | Admin user editing: group assignment, 2FA invalidation, admin passkey panel, the provider-sync warning, delete, and dates in the stored profile timezone (#1755). | Nothing. |
| `src/components/PageHistoryOverlay.test.js` (486) | product behaviour | History: cursor pagination, diff-too-large fallback, restore, branch-from, the MCP provenance marker, redirect-editor language resolution and the empty state. | Nothing. |
| `src/components/NavItemEditor.test.js` (459) | product behaviour | Navigation item authoring across `auto`/`mixed` menu modes, "copy from…" (#1012) and the settled add glyph (#2074). ~20% restatement (`wrapper.vm` reads of internal editor state). | Nothing. |
| `src/components/HeaderSearch.preview.test.js` (419) | product behaviour | The live-preview fetch, its result panel, and the edge cases (empty, error, stale response). ~25% restatement (exact endpoint/argument assertions). | Nothing. |
| `src/components/EditorWysiwyg.test.js` (418) | product behaviour | The WYSIWYG editor's toolbar actions — asset insertion, colour/highlight, alignment (#944). ~20% restatement. | Nothing; `e2e/` drives the markdown editor only. |
| `src/components/PageHeader.test.js` (396) | product behaviour | The page header's actions, state chips and permission gating. Includes a source-scan assertion. | Nothing. |
| `src/components/EditorWysiwyg.assets.test.js` (361) | product behaviour | Asset insertion and pending-asset handling inside the WYSIWYG editor. | Nothing. |
| `src/components/ApiKeyCreateDialog.test.js` (328) | product behaviour | API key creation: the site picker's `null` = "All Sites" default, the classification allow-list, and one real-Chromium describe measuring the scope grid's actual column count. See the position above. | The Chromium describe: nothing, at any price. The rest: `composables/apiKeyCreateForm.test.js` covers the shared form logic. |
| `src/components/ProfileApiKeyCreateDialog.test.js` (312) | product behaviour | The profile-side counterpart, including its own real-Chromium layout describe (it renders a single-column form where the admin one is a grid). | As above. |
| `src/components/EditorMarkdown.content.test.js` (308) | product behaviour | Content sync between Monaco and the page store, the debounce, and what a save actually reads. | `e2e/page-publish.spec.js` covers the happy path, on a 500 ms debounce it explicitly waits for. |
| `src/components/EditorWysiwyg.collab.test.js` (307) | product behaviour | Collaborative binding, seed claiming and teardown in the WYSIWYG editor. | Nothing. |
| `src/components/WebhookEditDialog.test.js` (295) | product behaviour | Webhook authoring: URL/origin validation, event selection, the untrusted-certificate opt-in. | `helpers/originPattern.test.js` covers the pattern grammar, not the dialog. |
| `src/components/PageActionsCol.menu.test.js` (295) | product behaviour | The page actions menu: duplicate (#1787), the homepage guard (#1149) and the menu's own composition. | Nothing. |
| `src/components/UploadPendingAssetsDialog.test.js` (284) | product behaviour | Mid-batch failure isolation (#945), the unbounded-timeout cancel path (#1714) and destination folder selection (#879). | Nothing. |
| `src/components/GlossaryVersionHistoryDialog.test.js` (281) | product behaviour | Glossary version load, diff, download and restore. ~20% restatement. | Nothing. |
| `src/components/CommentComposer.test.js` (276) | product behaviour | Comment composition, autofocus and submission. | Nothing. |
| `src/components/TreeBrowserDialog.test.js` (266) | product behaviour | The save/duplicate/rename dialog's path field — slash rejection, the auto-slug-until-focused rule `e2e/helpers/admin.js` has to work around, `includeTranslations`, and the `siteId` prop. A `describe.each` over the three modes. | `e2e/` depends on this behaviour but asserts none of it. |
| `src/components/GlossaryTermDialog.test.js` (264) | product behaviour | Term creation/editing: required fields (#1111), aliases (#1110), acronyms (#2575) and the canonical page path (#1112). ~25% restatement (the highest `toHaveBeenCalledWith` density in this directory). | Nothing. |
| `src/components/EditorAsciidoc.test.js` (231) | product behaviour | The AsciiDoc editor's Monaco language mode, its convert-to-HTML-on-change path and its asset insert syntax. What it shares with `EditorCode` lives in `editorMarkupShared.test.js`. | Nothing. |
| `src/components/NavEditOverlay.test.js` (223) | product behaviour | The navigation editor overlay's load/save cycle and its item list operations. | Nothing. |
| `src/components/BlockCredentialDialog.test.js` (223) | product behaviour | Block credential create/rotate/domains modes and their distinct validation. | Nothing. |
| `src/components/ImportPageDialog.test.js` (222) | product behaviour | Single-page import: format detection, path/title derivation and the failure message. | Nothing. |
| `src/components/EditorMarkdown.pasteHtml.test.js` (217) | product behaviour | HTML paste conversion (#2448) and embedded-image extraction from a paste (#2504) — the OneNote/Word clipboard path. | `helpers/htmlToMarkdown.test.js` covers the conversion; this covers the editor's use of it. |
| `src/components/HeaderSearch.entry.test.js` (215) | product behaviour | Search entry points: popular tags, autofill, the "Browse by tags" entry (#1218) and the keyboard shortcut (#2050). | Nothing. |
| `src/components/EditorCode.test.js` (208) | product behaviour | The code editor's language mode and the fact its raw source *is* the render. Shared behaviour lives in `editorMarkupShared.test.js`. | Nothing. |
| `src/components/EditorMarkdown.preview.test.js` (206) | product behaviour | Initial preview reveal (#809 follow-up) and the "do not render while the pane is closed" optimisation (#1889). | Nothing. |
| `src/components/GlossaryImportDialog.test.js` (188) | product behaviour | Glossary import: loading a file, the editor setup it hands the parsed content, and `submit()`'s success and failure paths. | Nothing. |
| `src/components/ApiKeyCopyDialog.test.js` (187) | product behaviour | The one-time secret display and copy affordance — the only chance the operator gets to read the key. ~25% restatement. | Nothing. |
| `src/components/EditorWysiwyg.darkMode.test.js` (186) | product behaviour | The WYSIWYG surface repaints for dark mode (#2498) rather than staying light on a dark page. | Nothing; no dark-mode assertion exists in `e2e/`. |
| `src/components/EditorMarkdown.resize.test.js` (183) | product behaviour | Divider drag direction (#804 follow-up) and drag-to-hide restoring the pre-drag width (#809). | Nothing. |
| `src/components/PageNewMenu.test.js` (182) | product behaviour | The new-page menu, its import entry and the async loading of the import dialogs. | Nothing. |
| `src/components/ProfileOverlay.test.js` (182) | product behaviour | Section rail navigation, the initial-section prop (#2530/#2532) and close/logout. | Nothing. |
| `src/components/AdminNavEditDialog.test.js` (180) | product behaviour | The admin-side nav item dialog's fields and validation. | Nothing. |
| `src/components/HeaderSearch.suggest.test.js` (176) | product behaviour | Suggestion fetching, debounce and keyboard selection. | Nothing. |
| `src/components/UserCreateDialog.test.js` (175) | product behaviour | User creation, the welcome-email toggle and both failure paths. | Nothing. |
| `src/components/MainOverlayDialog.test.js` (174) | product behaviour | The overlay host's accessible-name map, half-size and dismissible variants, and `overlayOpts` pass-through. Includes source-scan assertions over the overlay registry. | `components/dialogAccessibleName.test.js` overlaps on the name map only. |
| `src/components/HeaderNav.test.js` (172) | product behaviour | The header's tag-browse entry (#1218), the inbox badge destination (#2024), the create glyph (#2074) and the collapsed-search shortcut (#2050). | Nothing. |
| `src/components/UserSearchDialog.test.js` (171) | product behaviour | User lookup, debounce and selection. | Nothing. |
| `src/components/InboxOverlay.test.js` (169) | product behaviour | Inbox overlay: sidenav, dark mode, `overlayOpts` pass-through and close. Includes a source-scan assertion. | Nothing. |
| `src/components/LocaleSelectorMenu.test.js` (169) | product behaviour | Locale switching and the staleness/missing translation badge (#2475). | Nothing. |
| `src/components/EditorMarkdown.collab.test.js` (161) | product behaviour | The editor's collab watchers (#942) — lock, bind and release against session status. | `composables/collab.test.js` covers the session; this covers the editor's reaction to it. |
| `src/components/PagePropertiesDialog.test.js` (160) | product behaviour | Page property authoring — title, description, tags, publish state, classification. | Nothing. |
| `src/components/SiteDeleteDialog.test.js` (159) | product behaviour | Site deletion's type-the-title guard and content reassignment — one of the three `*DeleteDialog` files `CLAUDE.md` sanctions for doing more than confirming. | Nothing. |
| `src/components/ModuleConfigForm.test.js` (153) | product behaviour | The one form every module's config renders through (Analytics, Auth, Comments, Search, Storage) — field types, the `readOnly` hinted-div mode and sensitive-input autocomplete. | `helpers/moduleConfig.test.js` covers the build/serialise pair, not the rendering. |
| `src/components/UserDeleteDialog.test.js` (152) | product behaviour | User deletion and content reassignment. | Nothing. |
| `src/components/WelcomeOverlay.test.js` (152) | product behaviour | The first-run overlay's create-homepage button, dark mode and `overlayOpts` (#2530). Includes a source-scan assertion. | Nothing. |
| `src/components/CopyNavItemsDialog.test.js` (148) | product behaviour | Copying nav items between menus (#1012's dialog half). | Nothing. |
| `src/components/NavBrowseMenu.test.js` (147) | product behaviour | The browse menu, including the nav-root i18n leak (#832). | Nothing. |
| `src/components/CollabPresence.test.js` (143) | product behaviour | Collaborator avatars carry names, and the presence change is announced through an `aria-live` region. | Nothing. |
| `src/components/PageActionsCol.assets.test.js` (142) | product behaviour | Pending-asset rename from the actions column. | `helpers/pendingAssetRename.test.js` covers the sanitiser, not the column. |
| `src/components/PageActionsCol.export.test.js` (141) | product behaviour | The export menu's formats and their availability gating. | Nothing. |
| `src/components/GraphClientTypeFilter.test.js` (134) | product behaviour | The graph's client-type filter, including its dark-mode text colour (#2522). Includes a source-scan assertion. | Nothing. |
| `src/components/NavEditMenu.test.js` (134) | product behaviour | The nav edit menu's entries and their permission gating. | Nothing. |
| `src/components/ClassificationResolutionDialog.test.js` (131) | product behaviour | Classification conflict resolution — the floor invariant a wrong choice here would violate. ~25% restatement. | Nothing. |
| `src/components/SetupTfaDialog.test.js` (130) | product behaviour | 2FA enrolment: QR/secret display, code entry and the failure path. | Nothing. |
| `src/components/EditorMarkdownUserSettingsOverlay.test.js` (128) | product behaviour | Per-user markdown editor settings and the `overlayOpts` prop (#2530). | Nothing. |
| `src/components/WebhookHistoryDialog.test.js` (117) | product behaviour | Webhook delivery history listing and its per-attempt detail. | Nothing. |
| `src/components/GroupUsersPanel.test.js` (115) | product behaviour | The group's user list, assignment and unassignment. | Nothing. |
| `src/components/EditorMarkdownConfigOverlay.test.js` (115) | product behaviour | Site-level markdown editor config, including tab-width validation. | Nothing. |
| `src/components/EditorMarkdown.lifecycle.test.js` (114) | product behaviour | Debounced-handler cleanup on unmount (#808) and not stealing focus already given to another field. | Nothing. |
| `src/components/PageSaveConflictDialog.test.js` (113) | product behaviour | The 409 conflict dialog's choices — the last thing between an author and a lost edit. | `stores/page.save.test.js` covers the store side. |
| `src/components/BlockPickerOverlay.test.js` (112) | product behaviour | Block picking and the `isEnabled` filter — a disabled block must not be insertable. | Nothing. |
| `src/components/EditorCodeBlockMenu.test.js` (111) | product behaviour | The code-block language menu and its insertion. | Nothing. |
| `src/components/AssetRenameDialog.test.js` (109) | product behaviour | Asset filename validation (#2055). | `helpers/pendingAssetRename.test.js` covers the sanitiser only. |
| `src/components/AuthLoginPanel.redirect.test.js` (107) | product behaviour | Post-login redirect handling — including refusing an off-site redirect target. | Nothing. |
| `src/components/NavSidebarItem.test.js` (105) | product behaviour | Leaf and folder label rendering in the sidebar, split out of `NavSidebar` in `f8bdb5f05`. | `NavSidebar.test.js` covers the tree, not the item's own label rules. |
| `src/components/BlockUploadDialog.test.js` (105) | product behaviour | Custom block upload: file validation and the upload round trip. | `helpers/blockUpload.test.js` covers validation only. |
| `src/components/PageToc.test.js` (102) | product behaviour | Table-of-contents rendering and active-heading tracking. Also the suite's proof case that the SCSS `additionalData` injection is wired (`CLAUDE.md` names it as such). | Nothing. |
| `src/components/ClassificationReportDrillDialog.test.js` (101) | product behaviour | Drill-down from a classification report row to the pages behind it. | Nothing. |
| `src/components/PageBacklinksDialog.test.js` (100) | product behaviour | Backlink listing, including the empty state. | Nothing. |
| `src/components/ApiKeyScopePicker.test.js` (100) | product behaviour | Scope selection — what an API key is actually allowed to do. | `helpers/apiKeyScopes.test.js` covers the vocabulary; `apiKeyScopeTree.test.js` the tree shared with both dialogs. |
| `src/components/EditorMentionList.test.js` (96) | product behaviour | The @-mention list's rendering and keyboard selection. | `helpers/editorMentions.test.js` covers the suggestion source. |
| `src/components/EditorMarkdown.assets.test.js` (96) | product behaviour | Paste-versus-drop file naming (#806 follow-up) — a pasted file gets a minted unique name, a dropped one keeps its own. | `stores/editor.test.js` covers the store's half. |
| `src/components/PageDeleteDialog.test.js` (96) | product behaviour | Page deletion's confirmation and the navigation refetch that follows. | Nothing. |
| `src/components/FooterNav.test.js` (93) | product behaviour | `hasSiteFooter` edge cases — whether the footer renders at all. | Nothing. |
| `src/components/SiteActivateDialog.test.js` (90) | product behaviour | Site activation confirm. | Nothing. |
| `src/components/PageHeader.pendingAssets.test.js` (88) | product behaviour | Cancelling a pending-asset upload from the header (#945). | Nothing. |
| `src/components/PasskeyCreateDialog.test.js` (86) | product behaviour | Passkey enrolment and its failure path. | Nothing. |
| `src/components/SiteCreateDialog.test.js` (85) | product behaviour | Site creation fields and hostname validation. | `helpers/siteValidation.test.js` covers the hostname grammar. |
| `src/components/EditorPickerDialog.test.js` (79) | product behaviour | Editor choice when more than one is active. | `helpers/editorPicker.test.js` covers the no-dialog short circuits. |
| `src/components/BlockPropsForm.test.js` (77) | product behaviour | Block prop editing resolves its labels through i18n rather than raw keys. | `composables/blockLocale.test.js` covers the resolution. |
| `src/components/SideDialog.test.js` (74) | product behaviour | The side dialog's accessible-name map. Source-scan assertions. | `components/dialogAccessibleName.test.js`. |
| `src/components/PageHeader.collab.test.js` (68) | product behaviour | The collab-disconnected indicator — the author's only signal that their edits are no longer syncing. | Nothing. |
| `src/components/PageActionsCol.buttons.test.js` (67) | product behaviour | The history button, and that the removed Page Data affordance (#1911) stays removed. ~50% restatement (the removal half asserts absence). | Nothing. |
| `src/components/RecoveryCodesDialog.test.js` (67) | product behaviour | Recovery-code generation and its one-time display. | Nothing. |
| `src/components/RecoveryCodesDisplay.test.js` (67) | product behaviour | The code list's rendering and copy affordance. | Nothing. |
| `src/components/TableEditorOverlay.test.js` (62) | product behaviour | Table editing state (#2530) and the help link. Source-scan assertion for the `docsBase` half. | `src/docsBaseGate.test.js` holds the `docsBase` half for this surface. |
| `src/components/PageTags.test.js` (60) | product behaviour | Tag chip rendering and navigation to the tag browse view. | Nothing. |
| `src/components/ApiKeyRevokeDialog.test.js` (55) | product behaviour | Revocation posts to the right endpoint with the right label prefix. ~50% restatement. | Nothing. |
| `src/components/UtilCodeEditor.test.js` (50) | product behaviour | A raw `<script>` tag survives the editor round trip rather than being mangled. | Nothing. |
| `src/components/FolderCreateDialog.test.js` (46) | product behaviour | Folder creation fields and the parent it creates under. | `composables/navCreateMenu.test.js` covers the caller. |
| `src/components/HeaderActionsMenu.test.js` (36) | product behaviour | The profile row's presence and destination. | Nothing. |
| `src/components/BlueprintIcon.test.js` (34) | product behaviour | The indicator badge's four states, including the "empty string still means a badge" distinction from `null`. | Nothing. |
| `src/components/AccountMenu.test.js` (32) | product behaviour | The profile button's presence and destination. | Nothing. |
| `src/components/EditorMarkdown.deadcode.test.js` (31) | implementation restatement | Three source-text assertions that named identifiers from the pre-Vue-3 event bus (`notImplemented`, `$root.$on`, `window.edInstance`) stay deleted. Nothing observable changes if any came back — they were unreferenced when they were removed (task 477). | Nothing needs to; `oxlint`'s `correctness` category catches an actually-used undefined, and a re-added dead helper is a review concern. |
| `src/components/dialogAccessibleName.test.js` (109) | product behaviour | Every dialog/overlay consumer passes `labelled-by` or `aria-label` (#1620) — a screen reader announcing "dialog" with no name is silent, breaks nothing visually, and throws nothing. Source scan. | Nothing. `WDialog.test.js` proves the props work, not that 60 callers pass them. |
| `src/components/editorMarkupShared.test.js` (115) | product behaviour | The behaviour `EditorAsciidoc` and `EditorCode` share verbatim, as one `describe.each` (TEST-F13.9). Both components are still exercised and each assertion reports under its own component's name. | Each editor's own suite keeps only what differs. |
| `src/components/apiKeyScopeTree.test.js` (108) | product behaviour | The scope tree identical between `ApiKeyCreateDialog` and `ProfileApiKeyCreateDialog`, as one `describe.each`. | As above. |

### `src/pages/` — route-level views (67 files, 16,101 LOC)

Two sub-populations behave very differently and are worth separating before reading the rows.

- **The admin pages (31 files).** These carry the directory's restatement share. Twenty-one
  `Admin*.vue` pages go
  through `composables/adminSettings.js` (`CLAUDE.md` says twenty; the tree says twenty-one at
  `3b3635f74`), so their own suites are largely "did `load()` read the
  right key and did `save()` PUT the right body" — the composable's *own* suite already covers the
  load/save skeleton, the toasts, the overlay and the site watcher. What is genuinely theirs is the
  page-specific behaviour on top: `AdminTheme`'s contrast warnings, `AdminExtensions`' clock-skew
  message, `AdminLocale`'s completeness indicator, `AdminUtilities`' export/scan job polling.
- **The `Graph*` cluster (13 files, 2,308 LOC).** One page with more test LOC than
  `src/composables/` entire. It is genuinely the most algorithmic surface in the frontend — a
  d3-force canvas with clustering, hulls, sqrt-space sizing and a keyboard-reachable fallback — and
  most of the cluster is real. It is also where `wrapper.vm` reads into private computeds are
  densest, which is what pulls its restatement share up.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/pages/AdminAuth.test.js` (832) | product behaviour | Every authentication strategy's configuration, ordering, self-registration gating and per-strategy validation — the page where a misconfiguration locks everyone out. | Nothing. |
| `src/pages/AdminComments.test.js` (576) | product behaviour | Comment moderation and the comments provider's config. One of the two pages that deliberately does not use `adminSettings.js`, so its save path is its own. | Nothing. |
| `src/pages/AdminSearch.test.js` (545) | product behaviour | Engine picker, per-engine config form (#572), the dictionary override editor (#574) and a check that every `admin.search.*` key it renders exists. ~20% restatement. | Nothing. |
| `src/pages/InboxReview.test.js` (539) | product behaviour | Approval review: the 409 staleness path, 404 not-found, decline reasons (#2137), the multi-approver threshold (#828), guest-submission disambiguation and `leaveReview` (#2531). | Nothing. |
| `src/pages/graphFilters.test.js` (534) | product behaviour | The graph's pure filter/hierarchy layer — composite `locale:path` node identity, tag/locale/depth filtering, edge dropping, synthetic folder-and-root synthesis with node-object reuse for d3-force. Includes an assertion that its `MAX_DEPTH` still mirrors `backend/models/tree.ts`. | Nothing; this is the only place the hierarchy synthesis is exercised. |
| `src/pages/TagsBrowse.test.js` (522) | product behaviour | Tag browsing: selection, AND/OR combination, result listing and the empty state. ~25% restatement (the second-highest internal-read density in the workspace). | Nothing. |
| `src/pages/AdminPages.test.js` (493) | product behaviour | The page list: filtering, sorting, pagination and per-row actions. Rewritten from scratch against REST after the Apollo-era page was deleted. ~20% restatement. | Nothing. |
| `src/pages/InboxWatching.test.js` (483) | product behaviour | Notification listing, read/unread transitions and the empty state. | Nothing. |
| `src/pages/AdminGeneral.test.js` (436) | product behaviour | Site general settings: the Sharp-missing indicator on the image uploaders, never showing a new site's logo beside the old site's title, the "send every field `load()` populated" rule, and the stale-`loadSite` guard. | `composables/siteImage.test.js` covers the upload cycle, not this page's cross-site staleness rules. |
| `src/pages/AdminNavigation.test.js` (434) | product behaviour | Navigation menu authoring at the admin level — menu selection, item ordering, visibility limits. ~20% restatement. | `helpers/navigation.test.js` covers the flatten/reconstruct round trip. |
| `src/pages/AdminBlocks.test.js` (415) | product behaviour | Block enablement, the Configure affordance and its dialog's accessible name, the credentials list, destructive confirmations, the self-hosted server note (#829) and the mount loading overlay (#1736). | Nothing. |
| `src/pages/AdminSecurity.test.js` (401) | product behaviour | Security settings — upload limits, CORS/origin policy, cookie and session settings. A wrong value here is a real exposure. ~20% restatement. | Nothing. |
| `src/pages/AdminGlossary.test.js` (386) | product behaviour | Glossary term list, the staged-edit UX and import/version entry points. ~30% restatement (high `toHaveBeenCalledWith` density). | Nothing. |
| `src/pages/graphForces.test.js` (377) | product behaviour | The custom d3 forces — group-centroid attraction recomputed per tick, the hierarchy fan-out angles, and multi-ring splitting past the ring capacity, with a real d3-force run asserting edge-direction concentration stays low. | Nothing. This is genuinely algorithmic and unobservable any other way. |
| `src/pages/AdminClassification.test.js` (349) | product behaviour | Classification level CRUD, reordering, rename focus handling, delete confirmation and report drill-in. ~20% restatement. | Nothing. |
| `src/pages/AdminUtilities.test.js` (343) | product behaviour | Export queue-and-poll, the naming rule ("do not call it a backup"), import behind a destructive confirmation, and the content scan's completion/failure/clean-report states. | Nothing; these are long-poll jobs `e2e/` never runs. |
| `src/pages/Index.missingPage.test.js` (313) | product behaviour | What an unauthenticated or under-permissioned visitor sees for a path with no page — the history link's two-permission gate, the Welcome overlay, the placeholder rather than `/_error/unauthorized`, and the `await fetchPagePermissions` ordering. | Nothing. `e2e/multi-site.spec.js` touches one branch. |
| `src/pages/graphDraw.test.js` (303) | product behaviour | Canvas drawing: light/dark stroke and fill palettes, the zoom-threshold label cull, highlight dimming and rings, and root-node ringing. | Nothing — a canvas draws nothing a DOM assertion can see, so this is the only mechanism available. |
| `src/pages/Index.blocks.test.js` (289) | product behaviour | Block scanning and lazy loading inside rendered page content, including that a disabled block does not load. | `helpers/blockScan.test.js` covers the scan; this covers the page's use of it. |
| `src/pages/AdminExtensions.test.js` (265) | product behaviour | Extension install: the restart-needed badge, per-row inline status, the ticking elapsed readout, and a distinct actionable message for client clock skew versus a real failure. | Nothing. |
| `src/pages/Index.routing.test.js` (263) | product behaviour | The route-path watcher's generation guard against a stale `pageLoad` (#1785), and `/_create` / `/_edit` error handling that would otherwise strand the reader under a raised overlay (#947). | `stores/page.load.test.js` covers the store's `isStale` half. |
| `src/pages/Graph.fallback.test.js` (246) | product behaviour | The screen-reader fallback: one focusable `<a>` per real node with its direct links, visually hidden but real, plus the `?highlight=` parameter carried into navigation. | Nothing. This is the graph's entire accessibility story. |
| `src/pages/Index.view.test.js` (239) | product behaviour | The reader view's conditional chrome — comments gated on both the site feature and the page's own setting, "Last modified" visibility while editing, and the Unpublished chip and its separator. | Nothing. |
| `src/pages/Graph.sizing.test.js` (237) | product behaviour | Node sizing modes (edits/visits), the unique-versus-total count toggle, window selection, the tracking-disabled fallback, and label culling and font capping at zoom. ~35% restatement — the densest `wrapper.vm` file in the workspace, reaching into `contributorCountFor`/`pageviewCountFor`/`paintGraph` by name. | Nothing for the behaviour; the internal-name coupling is the file's own cost. |
| `src/pages/Graph.depth.test.js` (236) | product behaviour | Folder-depth derivation from the full loaded graph, the `MAX_DEPTH` cap, the depth slider's clamped bridge to `activeFilters`, and `clearFilters()` returning to the graph's own maximum. ~30% restatement. | `graphFilters.test.js` covers the pure derivation. |
| `src/pages/Index.highlight.test.js` (234) | product behaviour | The `?highlight=` indicator (#2541): match counting, next/previous with wrap, re-running on a param change, and dismissal by control and by Escape. | `helpers/renderedContent.highlight.test.js` covers the DOM wrapping. |
| `src/pages/AdminPagesDeleted.test.js` (233) | product behaviour | The deleted-pages view: listing, restore and purge. | Nothing. |
| `src/pages/AdminAuditLog.test.js` (216) | product behaviour | Audit log listing, filtering and the retention setting's card-local save. ~30% restatement. | Nothing. |
| `src/pages/Graph.i18n.test.js` (207) | product behaviour | Every control-rail caption, aria-label and option label resolves through `graph.*` keys; the tooltip counts go through real plural messages; and the canvas carries `role="img"` with a computed accessible name that updates with `groupBy`. | Nothing — `src/i18nSourceGate.test.js` catches hardcoded literals, not an unresolved key. |
| `src/pages/AdminLocale.test.js` (205) | product behaviour | Per-locale completeness indicator and its tooltip, the offline sideload control's `manage:system` gate, and sideload's success/failure/skipped/nothing-found states. | Nothing. |
| `src/pages/AdminEditors.test.js` (204) | product behaviour | Which editor rows render without the experimental flag, the asciidoc rendering-pipeline note, and the loading overlay's dependence on `currentSiteId`. ~40% restatement (three `load()`/`save()` round trips through `adminSettings.js`). | `composables/adminSettings.test.js` covers the skeleton. |
| `src/pages/Graph.keywordSearch.test.js` (204) | product behaviour | Keyword search wiring: the debounce, the trim, stale-response dropping, failure degrading to empty rather than stale, and cancellation on unmount. ~25% restatement. | Nothing. |
| `src/pages/AdminApi.test.js` (192) | product behaviour | API key listing with per-key site naming, "All Sites" for an instance-wide key, and the empty-state pointer into Profile. | `helpers/apiKeyState.test.js` covers the state/naming helpers. |
| `src/pages/ProfileApi.test.js` (186) | product behaviour | The user's own API keys: listing, state badges and revocation. | As above. |
| `src/pages/AdminScheduler.test.js` (174) | product behaviour | The Upcoming/Scheduled/history tables' `#no-data` slots and the repeated-task collapse-and-expand. ~30% restatement. | `e2e/scheduler.spec.js` covers the tabs against real job rows — the one page in this directory with real e2e coverage. |
| `src/pages/Graph.darkMode.test.js` (174) | product behaviour | The group palette switches to its dark variant, already-assigned clusters re-colour, and toggling `dark.isActive` alone repaints. Includes a source-scan assertion over the control-rail classes. | Nothing. |
| `src/pages/AdminStorage.test.js` (172) | product behaviour | The delivery-path diagram and its dark-mode surface, plus locale-key coverage for the page. Roughly half the file is source-scan assertions that a removed GitHub setup flow stays removed — category 3 in isolation. The other of the two pages that does not use `adminSettings.js`. | `helpers/storageDeliveryGraph.test.js` covers the graph generation. |
| `src/pages/AdminReplication.test.js` (171) | product behaviour | Cron schedule validation and the save path. | Nothing. |
| `src/pages/Graph.layout.test.js` (168) | product behaviour | Node and edge arrays are kept out of deep reactivity (a real performance requirement on a canvas), `relayout()` rebuilds the quadtree, the zoom handler only repaints, and hull padding and label offsets follow each node's own radius. ~30% restatement. | Nothing. |
| `src/pages/AdminTheme.test.js` (166) | product behaviour | Swatches preview under the admin's own colour-vision-deficiency setting, and contrast warnings fire for a too-dark header and for primary/secondary/accent too close to the page ground. | `helpers/accessibility.test.js` covers the ratio maths, not the warnings. |
| `src/pages/AdminAnalytics.test.js` (155) | product behaviour | Provider enablement and config round-trip through the shared module config form. ~40% restatement. | `helpers/analyticsProviders.test.js` covers the injected snippets. |
| `src/pages/Graph.rendering.test.js` (150) | product behaviour | The page mounts, fetches and renders a canvas with no console noise; same-path translations stay two distinct keyed nodes; synthetic nodes join the visible set; `groupBy: classification` (#1217). | Nothing. |
| `src/pages/ProfileNotifications.test.js` (145) | product behaviour | Notification preference toggles and their persistence. | Nothing. |
| `src/pages/AdminPageviews.test.js` (144) | product behaviour | The tracking toggle, the summary tiles and the empty state. ~40% restatement. | Nothing. |
| `src/pages/AdminUsers.test.js` (140) | product behaviour | User list filtering, sorting and the create entry point. | Nothing. |
| `src/pages/ProfileAuth.test.js` (138) | product behaviour | Remaining-recovery-code count for an enrolled user, the low-count nudge, and rendering nothing rather than a broken line when the status fetch fails. | Nothing. |
| `src/pages/AdminSystem.test.js` (135) | product behaviour | Scheduler health and upgrade-capability rendering, and hiding the loading overlay on failure rather than stranding the admin behind it. | Nothing. |
| `src/pages/AdminCluster.test.js` (129) | product behaviour | Cluster node rows keyed on `id` (the only identity property a node has), zero/one/many rendering, and no `docsBase` help button. | `src/docsBaseGate.test.js` would cover the last assertion if this page were added to it. |
| `src/pages/graphSimulation.test.js` (126) | product behaviour | Link distance and charge scale with node radius rather than staying flat, calibrated against the previous constants, and group hull geometry. | Nothing. |
| `src/pages/AdminMail.test.js` (123) | product behaviour | The test-mail round trip and surfacing the backend's own error rather than a generic one. | Nothing. |
| `src/pages/Login.darkMode.test.js` (113) | product behaviour | The login screen renders correctly in dark mode — the one screen a reader may meet before any app chrome loads. | Nothing. |
| `src/pages/Graph.highlight.test.js` (112) | product behaviour | Highlight set derivation: backend search matches unioned with client-side title matches, cleared correctly, and a match for a page absent from the loaded graph highlighting nothing. ~25% restatement. | `graphFilters.test.js` covers the pure set operations. |
| `src/pages/Graph.keywordIntegration.test.js` (111) | product behaviour | The real keyword input drives the real canvas repaint end to end, including the clearable affordance and a title-only client-side match (#2508). | The unit-level halves are covered; this is the only place they are joined. |
| `src/pages/ProfileGroups.test.js` (101) | product behaviour | The user's own group memberships and the "other groups" section. | Nothing. |
| `src/pages/ErrorGeneric.test.js` (94) | product behaviour | The error page sizes its code and title with a viewport-relative `clamp()` and lets the actions row wrap, so it does not overflow on a narrow viewport. Source-scan assertions against the SFC's own style block. | `e2e/tests/viewport-narrow.spec.js`, which asserts at 390px that the document never grows wider than the viewport — the one place in the workspace where an `e2e` spec genuinely substitutes for a unit suite. |
| `src/pages/AdminWebhooks.test.js` (92) | product behaviour | Webhook list save and the failure toast. | `components/WebhookEditDialog.test.js` covers authoring. |
| `src/pages/AdminMetrics.test.js` (87) | product behaviour | The page advertises the real `manage:system` permission rather than the fictitious `read:metrics` it used to claim, and no longer says the endpoint is unimplemented. ~40% restatement (one `load()` round trip). | Nothing — a docs page that lies about a permission is a real support cost. |
| `src/pages/pageTitles.test.js` (86) | product behaviour | Every `pages/Admin*.vue` page title compiles to a real `<h1>`, not a `text-h5` `<div>` (#1637), so heading navigation lands on it. Source scan. **Overlaps `pageTitleHeadings.test.js`.** | `pageTitleHeadings.test.js` asserts the same conversion from the other direction. |
| `src/pages/graphNodeSize.test.js` (83) | product behaviour | Sizing is ordered by the square root of the count, not the raw count, and degenerate ranges (all-same, empty, single) collapse without dividing by zero. | Nothing. |
| `src/pages/Graph.tooltip.test.js` (76) | product behaviour | The hover tooltip's noun matches the sizing mode and count mode (contributors/edits/unique visitors/visits) and singularises at one (#2293). | `Graph.i18n.test.js` covers the plural message resolution. |
| `src/pages/Graph.syntheticNodeIdentity.test.js` (75) | product behaviour | A synthetic folder/root node keeps the same object identity across `activeFilters` changes — d3-force keeps positions on the object, so a new object per filter change makes the layout jump (#2538) — and the cache resets on `loadGraph()`. | Nothing. |
| `src/pages/Graph.filters.test.js` (65) | product behaviour | The filter panel's keyword input is bound to `keywordQuery`, does *not* narrow the visible set (it highlights), and survives `clearFilters()` (#2478). | Nothing. |
| `src/pages/AdminSites.test.js` (64) | product behaviour | Site list rendering and the create entry point. | Nothing. |
| `src/pages/AdminLogin.test.js` (53) | product behaviour | The Sharp-missing indicator on the login-background uploader. | `AdminGeneral.test.js` asserts the same indicator for logo/favicon. |
| `src/pages/pageTitleHeadings.test.js` (45) | product behaviour | No page-title `<div class="text-h4/text-h5">` remains under `pages/`, and a real heading hierarchy exists (#1630). Source scan. **Overlaps `pageTitles.test.js`.** | `pageTitles.test.js`. |
| `src/pages/ProfileInfo.test.js` (43) | product behaviour | The profile form's save button uses the settled commit glyph rather than a near-namesake. | Nothing; `CLAUDE.md`'s settled-glyph rule has no linter behind it. |
| `src/pages/Search.test.js` (454) | product behaviour | Tag extraction from a query including quoted phrases and CJK, an adversarial ~100 KB query completing promptly (a ReDoS guard), exact-versus-approximate result counts when page rules drop rows, and offset pagination with `loadMore`. ~20% restatement. | Nothing. The ReDoS bound in particular has no other home. |

### `src/stores/` — Pinia stores (10 files, 3,178 LOC)

The one directory in `frontend/` where test LOC exceeds source LOC (1.30). Read on the rows rather
than the ratio, that is defensible: these ten files hold the app's permission answers, its
save-conflict handling and its stale-response guards, and every one of those is a correctness
question with a real failure mode. The restatement share here is concentrated in one place —
`site.test.js`'s field-by-field "adopts X from the payload / defaults to Y when omitted" pairs.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/stores/site.test.js` (650) | product behaviour | Locale direction detection (`isRTL`, including a Chrome-shaped `Intl.Locale`), the navigation-menu cache with stale-response discarding across a fast site switch, the acronym map's fetch gate, and overlay/file-manager opening. ~40% restatement — twelve `applySiteInfo()` adopt/default pairs that restate the payload mapping field by field. | Nothing for the direction and cache halves. |
| `src/stores/user.test.js` (530) | product behaviour | `can()` / `canOnSite()` including the `manage:system` wildcard, refusing a `site:` grant asked about for a different site, failing closed while a fetch is in flight, `setToGuest()` clearing page and site permissions so a stale edit button cannot survive a logout, and the `Temporal`-backed date formatters. | Nothing. This is the client-side half of the permission model. |
| `src/stores/page.save.test.js` (499) | product behaviour | `expectedUpdatedAt` on update but not create, the 409 conflict snapshot and its retry escape hatch, marking clean before navigating, the sidebar refetch after a create, and awaiting `contentFlusher` so the live editor's content is what gets saved (#806). | Nothing. Every branch here is a way to lose an author's work. |
| `src/stores/page.lifecycle.test.js` (447) | product behaviour | Create/edit/move/rename/duplicate/alias/unlock — locale query handling on `/_create`, `includeTranslations` cascade on move, following the page into its new locale, blanking timestamps on a new session, and surfacing the server's refusal message. | Nothing. |
| `src/stores/editor.test.js` (239) | product behaviour | Per-user editor settings kept apart from the site config, unique filename minting for a pasted file versus preserving a dropped one (#806/#952), wrapping a raw `Blob` in a real `File`, the glossary term fold-in (#870), and `discardedContent` as the undo behind the discard toast (#2073). | Nothing. |
| `src/stores/page.load.test.js` (228) | product behaviour | `pageLoad()`'s locale search param, backend-matching path normalisation before hashing, `applyViewerState` defaults, and the `isStale` guard that stops a slow response overwriting a newer page (#1785). | `pages/Index.routing.test.js` covers the route watcher's half. |
| `src/stores/admin.test.js` (222) | product behaviour | Semver-aware version comparison for the update indicator, `currentSiteId` defaulting, and every fetch action degrading to a notification rather than throwing into a caller that cannot handle it. | Nothing. |
| `src/stores/common.test.js` (179) | product behaviour | Locale switching with its `localStorage` write, block-tag URL resolution for built-in versus custom blocks, and once-only tag registration under duplicate and concurrent calls. | `helpers/blocks.test.js` covers config resolution, not URL addressing. |
| `src/stores/page.derived.test.js` (125) | product behaviour | Breadcrumb construction with locale prefixing and site case style, the editor exit path, and `pageWatch()`'s optimistic set with revert-and-rethrow on refusal. | `helpers/pagePaths.test.js` covers the prefixing rules in isolation. |
| `src/stores/flags.test.js` (59) | product behaviour | System flag load and apply, including leaving `loaded` false on an empty or failed response. | Nothing. |

### `src/composables/` — shared behaviour (19 files, 2,857 LOC)

The highest-value-per-line directory in the workspace. Each of these stands behind several
components, so one suite here covers behaviour that would otherwise be asserted (or missed) in
five places — and two of them gate security properties nothing else does.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/composables/collab.test.js` (525) | product behaviour | The collaborative session's whole state machine: locking only on first connect, never reporting "connected" from the raw socket without a sync event, a sticky terminal "denied", the reconnect backoff ceiling, draft offer/restore/discard, and the WYSIWYG seed claim failing open on a network error. | Nothing. |
| `src/composables/adminSettings.test.js` (395) | product behaviour | The load/save skeleton twenty-one admin pages share — the overlay pairing, the four toasts, the failed-save caption's key-then-server-message fallback, the `currentSiteId` watcher, the "no site selected, do not fetch" guard, and `onSaved` running before and being awaited by `onSavedCurrentSite`. | Nothing. Each page's own suite assumes this works. |
| `src/composables/apiKeyCreateForm.test.js` (294) | product behaviour | The shared API-key form: "All Sites" prepending, sending `null` while every classification level is checked versus an explicit narrowed list, `extraState` merged at send time, soft versus loud load failure per caller, and refusing a reply with no key rather than opening an empty copy dialog. | Both dialogs' own suites cover their own shape only. |
| `src/composables/fieldFrame.test.js` (202) | product behaviour | The twelve props `WInput` and `WSelect` share, `validate()`'s first-failing-rule message and generic fallback, and the frame's colour precedence (error outranks active outranks hover). ~30% restatement (class-name assertions, unavoidable without a layout engine). | `WInput`/`WSelect` suites cover their own use, not the shared contract. |
| `src/composables/siteImage.test.js` (198) | product behaviour | The pick → validate → upload/clear → toast → cache-bust cycle for a site's logo, favicon and login background, including refusing a file the endpoint would not take before uploading it. | `AdminGeneral`/`AdminLogin` suites cover the indicator, not the cycle. |
| `src/composables/navSidebarDestination.test.js` (157) | product behaviour | **A security gate**: a nav item's `javascript:` or `data:` target is refused — including disguised behind a line comment or leading whitespace — while `mailto:`, `tel:`, `http(s)://` and same-origin rooted targets still resolve; plus the empty-folder path fallback (#2528). | Nothing. This is the only place nav-item target sanitisation is asserted. |
| `src/composables/escapeStack.test.js` (118) | product behaviour | The Escape stack's ordering, decline-and-fall-through, release semantics and empty-stack no-op — what makes one Escape close the nested menu and the next close the dialog. | `WDialog.test.js` and `WMenu.test.js` exercise it through their own components; this is the contract itself. |
| `src/composables/adminOverlayRoute.test.js` (116) | product behaviour | The `:id`-in-the-route ↔ overlay plumbing: opening on mount from an existing id, closing on unmount so it does not survive a route change, returning to the list route and reloading, and ignoring another overlay's close. | Nothing. |
| `src/composables/siteAdminAccess.test.js` (109) | product behaviour | Which global permission substitutes for which `site:*` delegation, that `manage:sites` alone does **not** grant `site:navigation`, and the redirect-only-after-the-fetch-resolves ordering. | `stores/user.test.js` covers `canOnSite`; this covers the per-surface mapping. |
| `src/composables/anchoredPosition.test.js` (109) | product behaviour | Anchor/self placement fractions, extra offsets, viewport clamping on all four edges, and the fallback for a malformed spec. | `helpers/directionalAnchor.test.js` covers RTL mirroring of the same specs. |
| `src/composables/screen.test.js` (102) | product behaviour | `useMinWidth` reactivity across a breakpoint and one shared `matchMedia` listener per breakpoint; `gte.*` mirrors it at each named breakpoint. | Nothing. |
| `src/composables/navCreateMenu.test.js` (97) | product behaviour | The create menu's `write:assets`-or-`write:pages` gate, folder creation under the right parent (including the locale-root `null`), and force-refetching the sidebar only when the dialog was confirmed. | Nothing. |
| `src/composables/anchoredFloat.test.js` (92) | product behaviour | Trigger resolution past a wrapping span, the pre-measure hook, and doing nothing when there is no float element. | `anchoredPosition.test.js` covers the maths, not the DOM plumbing. |
| `src/composables/pathDisplay.test.js` (72) | product behaviour | Whether path humanisation is active, the site-enum-to-helper-style translation, the acronym override, and re-reading the store on every call rather than snapshotting at setup. | `helpers/pathHumanize.test.js` covers the transformation. |
| `src/composables/dark.test.js` (59) | product behaviour | `set`/`toggle` flip both the reactive flag and the body classes, one shared value across callers, and the transition-suppress class added synchronously and removed after. | Nothing. |
| `src/composables/toggleModel.test.js` (58) | product behaviour | Boolean and array model shapes, non-mutation of the source array, and following a model that changes shape mid-life. | `WCheckbox.test.js` covers one consumer. |
| `src/composables/blockLocale.test.js` (55) | product behaviour | A block's reader-facing strings resolve through `blocks.<tag>.*`, falling back to the raw string rather than exposing the dotted key. | Nothing. |
| `src/composables/i18nText.test.js` (55) | product behaviour | Dictionary lookup with an English-literal fallback, including with no vue-i18n plugin installed at all — the path the shared library takes when mounted outside the app. | Nothing. |
| `src/composables/direction.test.js` (44) | product behaviour | `set` flips both the reactive flag and the document's `dir` attribute, shared across callers — the switch every RTL assertion in the workspace depends on. | Nothing. |

### `src/helpers/` — pure utilities (44 files, 4,935 LOC)

Almost entirely pure-function unit tests, which is the cheapest form of coverage this workspace
has, and the reason its 0.85 ratio is not a concern. Two of these gate security properties and one
gates a cross-workspace contract with the backend.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/helpers/fonts.test.js` (305) | environment | Vendored font assets: every `@font-face` names a real, valid woff2 on disk, declares `font-weight`/`font-style` (the exact bug task 715 fixed), and covers the declared subsets. Roughly a third is `applyFonts()`'s DOM behaviour, which is category 1. | Nothing — the assets are static files no build step validates. |
| `src/helpers/accessibility.test.js` (251) | product behaviour | `contrastRatio()`/`getAccessibleColor()`, plus **pinning the shipped palette**: every Cardinal text tier clears WCAG AA on its real ground in both themes, the two faint slates are proven not to be text colours, and each pin records the value that used to fail. | Nothing. A palette regression is invisible until someone cannot read the page. |
| `src/helpers/datetime.test.js` (230) | product behaviour | Timezone- and pattern-aware rendering, ISO-duration humanisation, and that every formatter follows a live app-locale change rather than caching the boot locale. | `stores/user.test.js` covers the store-level formatter. |
| `src/helpers/htmlToMarkdown.test.js` (229) | product behaviour | Clipboard HTML → markdown: GFM tables and task lists, inline-style bold/italic/underline without double-wrapping, image extraction to pending placeholders, dropping `<style>`/`<script>` content, and stripping the CF_HTML clipboard header — with a realistic OneNote fixture. | `components/EditorMarkdown.pasteHtml.test.js` covers the editor's use of it. |
| `src/helpers/markdownBlocks.test.js` (272) | product behaviour | Block attribute precedence (page over site config over prop default), bare-boolean attribute reading, fenced-code exclusion, tabset children, and round-tripping three real blocks' props. | Nothing. |
| `src/helpers/navigation.test.js` (272) | product behaviour | Flatten/reconstruct round trip for headers, links, separators and nesting; `visibilityLimited` clearing groups when off; generated-item handling; and raising on a nested item with no preceding top-level link. | `pages/AdminNavigation.test.js` covers the page. |
| `src/helpers/pagePaths.test.js` (181) | product behaviour | Home-page recognition, active-locale prefix detection and stripping, `forcePrefix`, app-route locale queries — and one test asserting the path hash **matches known output from the backend implementation it mirrors**, a genuine cross-workspace contract. | Nothing, and nothing else notices if the two hash implementations diverge. |
| `src/helpers/renderedContent.test.js` (177) | product behaviour | Post-render enhancement of page content: idempotent re-runs, localized code-copy and heading-anchor labels (#2357), and same-origin routing versus cross-origin decline. | Nothing. |
| `src/helpers/renderedContent.highlight.test.js` (176) | product behaviour | Keyword highlighting over rendered content: multi-node and multi-element matching in document order, skipping `<script>`/`<style>`, clean unwrapping that merges text nodes back, and leaving an author-written `<mark>` alone. | `pages/Index.highlight.test.js` covers the indicator UI. |
| `src/helpers/pageRedirect.test.js` (159) | product behaviour | **A security gate**: redirect targets refuse `javascript:` (including a newline-comment obfuscation), `data:`, protocol-relative `//host`, backslash-leading `/\host` and relative paths, while accepting rooted paths and complete http(s) URLs; plus locale prefixing of a bare target. | Nothing. |
| `src/helpers/injectHtml.test.js` (150) | product behaviour | Theme head/body injection: containers created and removed correctly, `<script>` elements re-created so they actually execute, no re-execution on an unchanged value, and head and body tracked independently. | Nothing. |
| `src/helpers/jobHistoryGrouping.test.js` (150) | product behaviour | Scheduler history grouping and row flattening — group ordering, per-entry order preservation, expanded/collapsed independence, and synthetic summary ids that cannot collide with a real one. | `pages/AdminScheduler.test.js` covers the rendering. |
| `src/helpers/editorFileTransfer.test.js` (140) | product behaviour | Reading files out of a `DataTransfer` across the `.files`/`.items` split, and the paste/drop claim rules (text wins over an accompanying image; a dragover with only a "Files" type is still accepted). | Nothing; these are the browser inconsistencies the editor's paste path lives on. |
| `src/helpers/apiKeyState.test.js` (139) | product behaviour | Key state precedence (revoked over invalidated over expired), the "works" predicate, the hint wording and dating, site pinning names with an id fallback for a deleted site, and classification allow-list naming. | `pages/AdminApi.test.js` / `ProfileApi.test.js` cover the rendering. |
| `src/helpers/storageDeliveryGraph.test.js` (138) | product behaviour | The storage delivery diagram: per-content-type routing through direct-access, streaming or the wiki, missing origins marked, and disabled targets ignored. | `pages/AdminStorage.test.js` covers the rendering. |
| `src/helpers/pendingAssetRename.test.js` (125) | product behaviour | Filename sanitisation: dotfile handling, path-segment reduction, disallowed-character stripping, leading-dot stripping so a file cannot become hidden, truncation, and the fixed-extension rename rules. | `components/AssetRenameDialog.test.js` covers the dialog. |
| `src/helpers/editorMentions.test.js` (110) | product behaviour | The @-mention suggestion source: no request for a blank query, site id read lazily, and resolving to no items rather than throwing on a failed or shapeless response. | Nothing. |
| `src/helpers/storageSync.test.js` (109) | product behaviour | Sync payload shaping per module capability (mode omitted for single-mode, `scheduleOverride: null` rather than omitted when cleared) and the four sync status kinds including both no-value defaults. | `pages/AdminStorage.test.js`. |
| `src/helpers/pathHumanize.test.js` (107) | product behaviour | The five case styles, title-case minor-word handling, acronym overrides beating the style, and accepting a `Map`, a plain object, `null` or `undefined` as the acronym source. | `composables/pathDisplay.test.js` covers the store wiring. |
| `src/helpers/treeNodes.test.js` (94) | product behaviour | Folder-tree merging: parent resolution by full path, no duplicate children, never making a folder its own child, and tolerating a parent absent from the tree. | Nothing. |
| `src/helpers/randomPassword.test.js` (91) | product behaviour | **A security property**: draws from `crypto.getRandomValues`, never `Math.random`, and rejects out-of-range `Uint32` draws instead of introducing modulo bias — plus the two published alphabets' relationship. | Nothing. |
| `src/helpers/injectCss.test.js` (86) | product behaviour | Theme CSS injection: raw and unscoped, replaced rather than duplicated, removed for an empty value, idempotent as a watcher, and appended after a pre-existing theme stylesheet so equal-specificity rules win. | Nothing. |
| `src/helpers/blocks.test.js` (83) | product behaviour | Block config resolution — site value over prop default, empty string treated as unset rather than as an override. | `helpers/markdownBlocks.test.js` covers the page-source layer. |
| `src/helpers/pointerDrag.test.js` (78) | product behaviour | Pointer capture routing, move reporting until release, ending on `pointercancel`, and dragging on regardless when capture is refused for a synthetic pointer. | `components/EditorMarkdown.resize.test.js` covers one consumer. |
| `src/helpers/markdownMarkup.test.js` (76) | product behaviour | Bold/inline-code wrap and unwrap at a selection, empty-marker insertion at a bare cursor, and asymmetric markers. | Nothing. |
| `src/helpers/passwordStrength.test.js` (71) | product behaviour | Score banding, the hard "anything under 8 characters is weak" rule, and the one score → colour/label mapping every password field resolves through. | Nothing. |
| `src/helpers/markdownFences.test.js` (70) | product behaviour | Fence-aware line visiting: backtick versus tilde, closing-fence length, the three-space indent allowance, four-space indent as ordinary content, and an unclosed fence swallowing the rest. | Nothing; every markdown scan in the editor depends on it. |
| `src/helpers/moduleConfig.test.js` (66) | product behaviour | Building a module's config editor from its declared props and serialising it back, including enum expansion, `Number()` coercion and dropping read-only fields. | `components/ModuleConfigForm.test.js` covers the rendering. |
| `src/helpers/tfaCode.test.js` (66) | product behaviour | Recovery-code formatting as the user types, and TOTP-versus-recovery validation refusing each other's shape and characters outside the Crockford alphabet. | Nothing. |
| `src/helpers/markdownTable.test.js` (65) | product behaviour | Table detection for the table editor — headerless MultiMarkdown tables, trailing attrs lines, and correctly excluding multi-line cells, `^^` rowspans and tables inside fenced code. | Nothing. |
| `src/helpers/originPattern.test.js` (65) | product behaviour | **A security-adjacent grammar**: which origin patterns a webhook may target — rejecting a bare hostname, non-http(s) schemes, query/fragment, multiple or misplaced wildcards, and userinfo. | Nothing. |
| `src/helpers/editorPicker.test.js` (64) | product behaviour | Answering directly with the one active editor, falling back to markdown when none is, and excluding `redirect` from the pickable list. | `components/EditorPickerDialog.test.js` covers the dialog. |
| `src/helpers/analyticsProviders.test.js` (63) | product behaviour | Each provider's injected snippet is parameterised from config, and injects nothing at all when its required id is missing. | `boot/analytics.test.js` covers the boot wiring. |
| `src/helpers/editorUserSettings.test.js` (56) | product behaviour | Saved editor preferences with their fallbacks, and rejecting a stored value that could never have come from a real drag. | Nothing. |
| `src/helpers/fileSize.test.js` (54) | product behaviour | Parsing binary units case-insensitively with and without a space, throwing on garbage, and round-tripping at the unit boundaries. | Nothing. |
| `src/helpers/apiKeyScopes.test.js` (51) | implementation restatement | Three of its five assertions restate the `API_KEY_SCOPES` list itself ("includes the 4 scopes previously missing", no duplicates); the verb-grouping pair is real behaviour. | The scope list's correctness is a backend contract, gated there. |
| `src/helpers/blockScan.test.js` (51) | product behaviour | Resolving embedded block tags against the site index, deduping, and **skipping a block absent from the index — a disabled block must not load**. | `pages/Index.blocks.test.js` covers the page's use. |
| `src/helpers/directionalAnchor.test.js` (45) | product behaviour | Anchor specs mirror left/right under RTL while leaving the vertical axis and `middle`/`center` alone. | Nothing. |
| `src/helpers/blockUpload.test.js` (44) | product behaviour | Custom-block upload validation: extension (case-insensitively), size limit including exactly-at-limit, default limit and the unlimited case. | `components/BlockUploadDialog.test.js` covers the dialog. |
| `src/helpers/platform.test.js` (41) | product behaviour | Apple-platform detection preferring `userAgentData` over the deprecated `navigator.platform` — what decides whether the keyboard shortcut is shown as ⌘ or Ctrl (#2050). | Nothing. |
| `src/helpers/bootstrap.test.js` (40) | product behaviour | What an unresolvable or disabled site's hostname does to a page request (404 versus 403), leaving app-shell `/_` routes and `/login` alone so a disabled site's administrator can still sign in. | Nothing. |
| `src/helpers/apiError.test.js` (37) | product behaviour | The server-message → error-message → caller-fallback precedence every failure toast in the app resolves through. | Nothing. |
| `src/helpers/siteValidation.test.js` (32) | product behaviour | Hostname acceptance including the catch-all wildcard, and one assertion that the pattern **matches the backend JSON schema exactly** — a cross-workspace contract. | Nothing notices divergence from the backend schema. |
| `src/helpers/siteRename.test.js` (26) | product behaviour | Whether a hostname change is substantive, including transitions to and from the catch-all wildcard, which decides whether a reload is needed. | Nothing. |

### `src/renderers/` — the content rendering pipeline (6 files, 1,152 LOC)

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/renderers/markdown.test.js` (800) | product behaviour | The single largest correctness surface in the frontend — this is what turns an author's source into what every reader sees. Covers the markdown-it-attrs allowedAttributes whitelist (#1180, a sanitisation boundary), KaTeX inline/display and its brace interaction with attrs (#829), glossary terms (#870), fenced diagram handoff, codeblock classes (#946), external-link detection against a site origin (#1751), MDC block attribute values with spaces (#2372), multimd-table, and a "previously-broken edge cases" describe. | Nothing. `e2e/` renders one trivial page. |
| `src/renderers/htmlImages.test.js` (90) | product behaviour | `fileSrc`/`rewriteHtmlImages` — how an asset reference in rendered HTML resolves to a served URL. | Nothing. |
| `src/renderers/asciidoc.test.js` (82) | product behaviour | The AsciiDoc renderer's output for the constructs the editor writes. | Nothing. |
| `src/renderers/modules/github-alerts.test.js` (82) | product behaviour | The GitHub-style alert plugin's parsing and output. | `renderers/markdown.test.js` does not cover it. |
| `src/renderers/modules/markdown-it-imsize.test.js` (60) | product behaviour | Image-size syntax parsing — a vendored plugin with no upstream test run here. | Nothing. |
| `src/renderers/modules/markdown-it-underline.test.js` (38) | product behaviour | Underline syntax parsing — same. | Nothing. |

### `src/layouts/` (3 files, 775 LOC)

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/layouts/AdminLayout.test.js` (495) | product behaviour | The admin shell: sidebar entries and their per-permission and per-site-delegation gating, the current-route highlight, and the count badge (asserted from source, since `@media`-driven and pseudo-element styling cannot be exercised under happy-dom). | Nothing; a wrongly-shown admin entry is a permission-model bug in the UI. |
| `src/layouts/MainLayout.test.js` (228) | product behaviour | The reader shell: the skip link (whose target `WPage.test.js` pins), header/sidebar composition, and the drawer breakpoint. | Nothing. |
| `src/layouts/AuthLayout.test.js` (52) | product behaviour | The auth shell's site footer rendering. | Nothing. |

### `src/` root — `App.vue` and the whole-tree gates (15 files, 2,545 LOC)

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/App.navGuard.test.js` (325) | product behaviour | The unsaved-changes navigation guard and `router.onError()` (#951) — the two things standing between an author and a silently discarded edit on a route change or a chunk-load failure. | Nothing. |
| `src/App.locale.test.js` (259) | product behaviour | `applyLocale()`, its eager English-fallback load and its idempotency — a second call must not re-fetch or clobber. | Nothing. |
| `src/App.theme.test.js` (238) | product behaviour | `applyTheme()` — the CSS variables, injected CSS/HTML and dark-mode state a site's theme settings actually produce. | `helpers/injectCss.test.js` / `injectHtml.test.js` cover the injectors. |
| `src/i18nSourceGate.test.js` (213) | product behaviour | Four shapes of hardcoded English (a `notify()` message, a thrown `Error`, a static `aria-label`/`label`, the misspelled unexpected-error literal) stay out of `src/` — oxlint has no i18n rule and no `eslint-plugin-vue-i18n` runs here. Source scan; half the file is detector unit tests against fixtures. | Nothing. |
| `src/App.logout.test.js` (196) | product behaviour | The `logout` `EVENT_BUS` handler (#2208) — session teardown, guest reset and the navigation refetch. | `stores/user.test.js` covers `logout()` itself. |
| `src/App.beforeunload.test.js` (173) | product behaviour | The `beforeunload` guard — the browser-level half of the same unsaved-changes protection. | Nothing. |
| `src/buttonAccessibility.test.js` (162) | product behaviour | Every `<w-btn>`/`<w-btn-toggle>` in `src/` has a label, `aria-label`, `title` or visible text, so no button is announced nameless. Source scan; near-identical in mechanism to `autofocusUsage.test.js`. | `WBtn.test.js` proves the props work, not that every call site passes one. |
| `src/logicalSpacing.test.js` (158) | product behaviour | No unconverted physical `margin`/`padding`, `border-left`/`border-right`, bare `left:`/`right:` or `text-align: left`/`text-align: right` remains in `src/` — every one of which mirrors wrong under RTL (#1601, closing epic #1582). Source scan with an allowlist. | `e2e/rtl.spec.js` renders one RTL page and would not catch a single mis-sided gutter. |
| `src/physicalPositioning.test.js` (130) | product behaviour | The narrower `left-*`/`right-*` position-utility population, with a triaged allowlist for the ~30 genuinely-physical sites (#1590) — "which corner of the screen" is a different question from "which side is this gutter on". | As above. |
| `src/App.prefetch.test.js` (129) | product behaviour | The markdown editor settings prefetch — that it happens once and does not block first paint. ~30% restatement. | Nothing. |
| `src/autofocusUsage.test.js` (87) | implementation restatement | Forbids a *dead* literal `autofocus` attribute that duplicates `useDialogComponent({ autofocus })` wiring. Dead means inert: nothing observable changes if one comes back. Source scan, near-identical in mechanism to `buttonAccessibility.test.js`. | Nothing needs to. `WInput.test.js` covers the real autofocus behaviour. |
| `src/adminIconHeaderSize.test.js` (78) | product behaviour | Every admin page header icon is a sized glyph rather than falling back to a 1em box, because `WIcon`'s scoped rule outranks the global `.admin-icon` height (#2332) — a visible defect on ~30 screens. Source scan. | Nothing; happy-dom computes no cascade. |
| `src/imgAlt.test.js` (61) | product behaviour | Every `<img>` under `src/` carries `alt`, `:alt`, `aria-hidden` or `role="presentation"` (#1663) — without it a screen reader reads out the file path. Source scan; near-identical in mechanism to `adminIconHeaderSize.test.js`. | Nothing. |
| `src/docsBaseGate.test.js` (59) | product behaviour | Seven fork-invented surfaces carry no `docsBase` help button, since no upstream docs page exists for them and the link would 404. One `describe.each` replacing seven byte-identical per-component assertions, with an existence check so a rename cannot silently retire a guard. | Nothing; the seven per-component copies it replaced are gone. |
| `src/i18nUnexpectedErrorLiteral.test.js` (44) | product behaviour | The misspelled `'An unexpected error occured.'` literal (#1605, 110 occurrences across 61 files) stays replaced by `common.error.unexpected`. Source scan. **Fully subsumed by `i18nSourceGate.test.js`'s fourth detector.** | `src/i18nSourceGate.test.js` asserts exactly this as one of its four shapes. |

### `src/boot/`, `src/build/`, `src/css/`, `src/router/` (7 files, 943 LOC)

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `src/css/_page-contents.test.js` (176) | product behaviour | `ul.links-list` and the rest of the content stylesheet use logical properties, so markdown-rendered content mirrors correctly under RTL (#834, reproducing upstream requarks/wiki #1639). Source scan. | `src/logicalSpacing.test.js` covers `src/` broadly; this file is inside that scan's scope but predates and motivates it. |
| `src/build/temporalPolyfillChunk.test.js` (161) | environment | Unit tests for the Rollup plugin that finds and rewrites the Temporal polyfill chunk's filename into the built `index.html`. Pure build tooling. | Nothing; a wrong filename here means pre-Temporal Safari boots without the polyfill, and no browser CI covers that. |
| `src/boot/api.test.js` (152) | product behaviour | The `ky` client's global session-expiry handling (which URLs count, what happens to the reader) and `throwHttpErrors` — the branch every store's `try`/`catch` is written against. | Nothing. |
| `src/router/routes.test.js` (110) | product behaviour | The admin route table registers the per-site child routes the sidebar links at — a missing one lands the reader on the catch-all rather than a page (task 614). ~50% restatement: it reads route objects out of the exported array. | Nothing; nothing else notices a sidebar link with no matching route until someone clicks it. |
| `src/css/_print.test.js` (104) | product behaviour | Every class `_print.scss` hides is still the class the corresponding component renders, so a rename does not silently stop hiding app chrome when a reader prints (#821). Source scan — `@media print` is never evaluated under happy-dom. | Nothing. |
| `src/boot/analytics.test.js` (97) | product behaviour | Each enabled provider's snippet is injected into `document.head` once the site store has loaded, and only then. | `helpers/analyticsProviders.test.js` covers the snippets. |
| `src/css/_base.test.js` (69) | implementation restatement | Two source scans asserting dead Quasar `.q-*` selectors and `q-*` template classes stay deleted (#1909). Both were already inert when removed — a reintroduced one styles nothing and breaks nothing. | Nothing needs to; this is the same shape as `components/EditorMarkdown.deadcode.test.js`. |

### `scripts/`, `test/` and `index.test.js` (9 files, 837 LOC)

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `scripts/check-locales.test.js` (173) | environment | Unit tests for the build-time unreferenced-locale-key checker's matcher collection and detection. | Nothing; the checker is a CI gate whose own correctness is otherwise unverified. |
| `scripts/check-notify-err-message.test.js` (85) | environment | Unit tests for the build-time "bare `err.message` reaching `notify()`" checker. | As above. |
| `index.test.js` (70) | environment | Executes the real inline Temporal-polyfill preload script out of `index.html` (between its marker comments) in both browser conditions — it has to be inline and non-module to run during head parsing, so extracting it to test it would prove nothing about what ships (#1838). | Nothing; `e2e/` runs Chromium, which needs no polyfill. |
| `test/mount.test.js` (170) | environment | The harness's mount helper — fresh pinia per call, selective store seeding, router/i18n wiring. 64 suites import it directly (plus the shared per-component harness modules), so a break in it must fail as itself. | Nothing; it would present as dozens of unrelated component failures. |
| `test/sourceFiles.test.js` (83) | environment | The recursive source walker introduced to replace seven copied readdir loops (TEST-F15); nine of the sixteen scanning gates use it today, the other seven still carry their own. | Nothing. |
| `test/mocks.test.js` (75) | environment | `createApiClientStub()` and `stubApi()`'s URL→payload table, including the `RegExp` and function-value forms. | Nothing. |
| `test/fixtures.test.js` (68) | environment | The `seedSite`/`seedUser`/`seedPage`/`seedAdmin` builders and `stubRouter`. | Nothing. |
| `test/i18n.test.js` (60) | environment | `createTestI18n`'s flat-dotted and nested key handling and its warning suppression. | Nothing. |
| `test/router.test.js` (53) | environment | `createTestRouter`'s bare-string stub routes and its push-then-`isReady()` coda. | Nothing. |

## Roll-up

Every one of the 308 files has exactly one row above, and each row's category is one of Feature
#2602's four strings.

| Category | files | % of files | test LOC | % of test LOC |
| --- | ---: | ---: | ---: | ---: |
| product behaviour | 292 | 94.8% | 56,655 | 97.3% |
| framework behaviour | 0 | 0.0% | 0 | 0.0% |
| implementation restatement | 5 | 1.6% | 273 | 0.5% |
| environment | 11 | 3.6% | 1,303 | 2.2% |
| **total** | **308** | | **58,231** | |

**Whole-file counts understate restatement, so read the next number with them.** Forty
category-1 files carry a stated restatement share in their reason column. Summing those stated
shares against each file's LOC gives roughly **2,900 LOC**, which added to the 273 whole-file total
puts **about 3,200 LOC — some 5.4% of `frontend/`'s test code — in the implementation-restatement
bucket**, embedded inside files that are otherwise worth keeping.

It concentrates in two places, both of which are the finding rather than the noise:

1. **The admin pages.** `AdminEditors`, `AdminAnalytics`, `AdminPageviews`, `AdminMetrics`,
   `AdminStorage` and their siblings each re-assert a `load()`/`save()` round trip that
   `composables/adminSettings.test.js` already covers as a contract. This is the clearest
   candidate for a policy rule (see below), not for a deletion pass — each of those files also
   holds page-specific behaviour that is category 1.
2. **`stores/site.test.js`'s `applySiteInfo()` pairs.** Twelve two-test blocks of the form "adopts
   X from the payload" / "defaults to Y when the payload omits it". That is the payload mapping
   restated field by field; the same file's stale-response and RTL-detection coverage is not.

### Zero files classify as framework behaviour, and that is a real result

Not one file in `frontend/` asserts something Vue, vue-router, Pinia or happy-dom guarantees on its
own. The nearest misses are individual assertions — `WCardSection`'s padding-class checks,
`WBadge`'s positioning class, a handful of "emits X on click" lines in the shared library — and
even most of those turn out to be the app's own logic (a click *not* emitted while disabled, a
model shape the component chose). Two structural reasons for it:

- The shared library is **this app's own code**, not a wrapper over a framework component library.
  There is no Quasar left to accidentally re-test; `components/shared/` is where the behaviour
  lives, so a claim about it is a claim about the product.
- The harness makes the framework wiring somebody else's problem. `test/mount.js` builds the
  pinia/i18n/router stack once, so a suite never has occasion to assert that the stack works.

#2689 should not read the zero as "this category is unused and can be dropped from the policy" —
it is the category the policy exists to keep at zero.

## Headline conclusion

**`frontend/`'s suite is roughly right, and the pruning budget is correctly spent on `backend/`
first.** Feature #2602 allowed for exactly this outcome, and the evidence supports it:

- **The ratio is not inverted** — 0.66 test LOC per source LOC, against `backend/`'s 1.21 (from
  Feature #2602's own 122,946 / 101,557 measurement; #2687 owns the current backend figure).
- **Nearly everything gates product behaviour**, and a large share of it is defect-pinned: suite
  after suite names the OpenProject issue it was written for. That is the difference between
  accumulated regression coverage and speculative surface coverage.
- **The layers `e2e/` cannot reach are exactly the ones carrying the weight.** Ten Playwright specs
  in one Chromium — nine of them at the pinned 1280×800 — cannot assert a focus trap, an
  `aria-live` announcement, an RTL-mirrored gutter, a stale-response discard, a `javascript:`
  refusal or a canvas draw call. Two specs do overlap the unit suite meaningfully
  (`viewport-narrow.spec.js` on overflow, `scheduler.spec.js` on the job tables) and are credited in
  the rows above; delete the frontend unit suite and essentially everything else goes ungated.
- **The restatement share is ~5%, not the majority.** It is real, it is worth a policy rule, and it
  is nowhere near the volume that would justify a pruning pass of its own.

Three qualifications, stated so the conclusion is not read as "nothing to do here":

1. `src/stores/` at 1.30 is the one directory where volume outruns source, and one file
   (`site.test.js`) accounts for most of the excess.
2. The `pages/Graph*` cluster is 2,308 LOC for one page and holds the workspace's densest coupling
   to private component internals. The behaviour is worth gating; the coupling is a maintenance
   cost that a future refactor of `Graph.vue` will pay in full.
3. The source-scanning gate mechanism is proliferating faster than it is consolidated — sixteen
   whole-tree scans, three of which duplicate another.

## Pruning candidates for a later decision

**Not recommendations. Nothing here is acted on by this Task**, and Feature #2602 is explicit that
a deletion is only safe once the audit says what gates the behaviour instead — which is why every
one below names its replacement.

| Candidate | Why it is a candidate | What would still gate the behaviour |
| --- | --- | --- |
| `src/i18nUnexpectedErrorLiteral.test.js` (44) | Fully subsumed: `src/i18nSourceGate.test.js`'s fourth detector asserts the same misspelled literal over the same tree. | `src/i18nSourceGate.test.js`. |
| `src/pages/pageTitles.test.js` (86) **or** `src/pages/pageTitleHeadings.test.js` (45) | Both scan `pages/` for the same #1630/#1637 heading conversion from opposite directions. One of the two, merged into the other, loses nothing. | Whichever survives. |
| `src/autofocusUsage.test.js` (87) | Gates dead, inert markup — the only whole-file category 3 with no product consequence at all. | Nothing needs to; `WInput.test.js` covers real autofocus. |
| `src/css/_base.test.js` (69) | Same shape: dead Quasar selectors and inert template classes staying deleted, three releases after the removal. | Nothing needs to. |
| `src/components/EditorMarkdown.deadcode.test.js` (31) | Same shape again, for three identifiers removed in task 477. | Nothing needs to. |
| `src/helpers/apiKeyScopes.test.js`'s list assertions (3 of 5) | "Includes the 4 previously-missing scopes" and "has no duplicates" restate the constant; the verb-grouping pair is real. | The scope vocabulary is a backend contract, gated there. |
| The `load()`/`save()` round trips in the twenty-one `adminSettings.js` pages | Each re-asserts the composable's contract with a different key name. | `composables/adminSettings.test.js` — provided the policy says so explicitly, since the pages currently do not know they are allowed to stop. |
| `stores/site.test.js`'s twelve `applySiteInfo()` adopt/default pairs | Field-by-field payload-mapping restatement, ~260 LOC. | A single table-driven `it.each` over the fields would keep the coverage at a fraction of the size. |

Two consolidations that are **not** deletions and would repay more than any of the above:

- Merge `src/autofocusUsage.test.js` ≡ `src/buttonAccessibility.test.js` and `src/imgAlt.test.js` ≡
  `src/adminIconHeaderSize.test.js` into shared scanners (they already share
  `test/sourceFiles.js`'s walker, which is where the similarity was first noticed), and move the
  five gates still carrying their own `readdirSync` loop (`logicalSpacing`, `physicalPositioning`,
  `pages/pageTitles`, `pages/pageTitleHeadings`,
  `components/shared/wComponentAttributeDrift`) onto it, which is what TEST-F15 set out to do.
  (`css/_page-contents` and `css/_print` read one named file each and need no walker.)
- Give `test/realGridLayout.js` its own co-located suite. It and `test/setup.js` are the two
  harness modules without one, and unlike `setup.js` it is not exercised transitively — it stands
  behind the two most launch-fragile describes in the workspace with nothing checking it.

## Notes for #2689 and #2690

- **Quote 308 / 58,231 / `3b3635f74`**, not the WP's 305 / 57,903. See
  [Reconciling the WP's 305](#reconciling-the-wps-305).
- **Two path columns are at risk of going stale this round.** #2691 may rename
  `src/components/ApiKeyCreateDialog.test.js` and
  `src/components/ProfileApiKeyCreateDialog.test.js` into a `*.flaky.*` lane. This document argues
  against quarantining them and does not pre-empt the decision; if #2691 lands the rename, those
  two rows need their paths updated and nothing else about them changes.
  `backend/mcp/http.test.ts` has the equivalent exposure in #2687's table.
- **Nothing here was classified category 4 because of the sandbox's Node version.** Feature #2601
  owns the Node 25.9-versus-CI-26.x gap; no row above leans on it, and no file is called
  environment for that reason.
- **The four positions above are this Task's answers to the four questions WP #2688 named**, and
  are the parts #2689 should carry into `docs/decisions/testing-strategy.md`: the real-Chromium
  verdict, why the source-scanning gates are not a fifth category, that `describe.each` is
  under-used rather than over-used, and that the harness's own coverage is deliberate.
- **The `frontend/` pruning pass, if one is ever run, has a budget of roughly 3,200 LOC**, of which
  ~2,900 sits inside files that must be kept. That is the shape of the work, and it is why Feature
  #2602's decision to prune `backend/` first is the right one.
