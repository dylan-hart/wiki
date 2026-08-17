# Variances

Genuine, justified deviations from spec — not a changelog. An entry is removed once resolved rather
than left as historical prose.

## 2026-08-17 — KaTeX/MathJax TeX feature-surface parity (Feature 366 / Task 634)

Task 634 asked for two audits — `block-mathjax`'s `PACKAGES` list (`blocks/block-mathjax/
component.js`) and `block-katex`'s extension set (`blocks/block-katex/component.js`) — checked
against 2.5.x's actual MathJax/KaTeX setup, not against the general claim in `PACKAGES`'s own header
comment that it matches "MathJax's own all-packages bundle, less three." 2.5.x's renderers no longer
exist in this branch's tree; they were read from history
(`server/modules/rendering/markdown-mathjax/renderer.js` and `markdown-katex/renderer.js`, last
touched at commits `281172a9` and `db2ad81a` respectively) and are not being restored — this is a
read-only comparison.

### MathJax: PACKAGES is a superset of 2.5.x, not a subset — one finding, no list change

2.5.x's renderer explicitly loaded only nine extra packages (`bbox`, `boldsymbol`, `braket`, `color`,
`extpfeil`, `mhchem`, `newcommand`, `unicode`, `verb`) on top of MathJax's default `input/tex`
bundle. But it also configured `loader: { require, paths: { mathjax: 'mathjax/es5' } }` and never
excluded `autoload` — and `input/tex`'s default package set *includes* `autoload`. Running
server-side in Node with the real `mathjax` package on disk, 2.5.x could therefore load, on first
use, every package `AutoloadConfiguration.ts`'s `autoload` map covers: `action`, `amscd`, `bbox`,
`boldsymbol`, `braket`, `bussproofs`, `cancel`, `color`, `enclose`, `extpfeil`, `html`, `mhchem`,
`newcommand`, `unicode`, `verb` — regardless of whether it was in the explicit nine. `PACKAGES` in
this branch statically declares every one of those except `html`, which is the intentional exclusion
already documented at `component.js:10-23` (a formula is not the place for `\href`/`\class`/`\style`
to write into the page). Confirmed empirically: a MathJax document configured with this branch's
exact `PACKAGES` typesets `\cancel`, `\centernot`, `\bussproofs`'s `prooftree`, and every other
autoload-reachable macro from the list above (except `html`'s). **No package 2.5.x content could
reach is missing from `PACKAGES`.** The list is in fact considerably larger than 2.5.x's reach
(`cases`, `centernot`, `colortbl`, `empheq`, `gensymb`, `mathtools`, `physics`, `textcomp`,
`textmacros`, `upgreek`, `action`, `amscd`, `bussproofs`, `cancel` were either unreachable or
required extra source `\require{}` calls in 2.5.x); that is more parity than the task asked to
confirm, not less, and needed no change.

### A real, unrelated gap this audit surfaced: MathJax dynamic glyph loading is unwired

While generating the parity evidence above (via a scratch script mirroring `component.js`'s exact
MathJax setup, deleted before commit), several *reachable* macros still failed to render:
`\xtwoheadrightarrow`/`\xtwoheadleftarrow`/`\xmapsto` (extpfeil), `\verb`, and any accented or
non-Latin Unicode character typed directly into math mode (e.g. `é`). All three draw glyphs that
`@mathjax/mathjax-newcm-font` ships as separate "dynamic" chunks (`svg/dynamic/arrows.js`,
`svg/dynamic/monospace.js`, `svg/dynamic/latin-i.js`, …) fetched on demand through a
`mathjax.asyncLoad` hook — and `component.js` never sets `mathjax.asyncLoad`. The failure
(`Can't load '…': No mathjax.asyncLoad method specified`, from `@mathjax/src/ts/util/AsyncLoad.ts`)
is not a Node-only artifact of the scratch harness — the hook is checked the same way regardless of
environment, and the block never configures it either place. 2.5.x did not have this problem: running
server-side with `loader.require` pointed at a real `mathjax` install, its `RequireLoad` could fetch
any component file from disk on demand.

This **is** a capability 2.5.x content could rely on that the port dropped — just not a `PACKAGES`
membership problem, so fixing it is not a `PACKAGES` edit. Wiring a browser-safe `mathjax.asyncLoad`
(dynamic `import()` against chunks served from `/_blocks`) is a bundling change to
`blocks/rollup.config.mjs`'s output, not a one-line fix, and is out of this audit task's scope.
Recorded here as a concrete follow-on: **a future task should wire `mathjax.asyncLoad` for
`@mathjax/mathjax-newcm-font`'s dynamic chunks**, scoped from `blocks/block-mathjax/component.js` and
`blocks/rollup.config.mjs`. `blocks/block-mathjax/component.test.js` pins the current (broken)
`\xtwoheadrightarrow` behavior as a regression guard rather than silently accepting or silently
"fixing" it in passing.

### KaTeX: mhchem is correct and complete; no other contrib extension is missing

2.5.x's KaTeX renderer (`markdown-katex/renderer.js`) never loaded a KaTeX contrib module at all. It
vendored its own `mhchem.js` — 1677 lines, header comment intact — which is explicitly "adapted from
MathJax/extensions/TeX/mhchem.js" by the same author (Martin Hensel) whose code later became
`katex/contrib/mhchem` upstream. `block-katex/component.js`'s `import 'katex/contrib/mhchem'` is
therefore not a partial port of what 2.5.x had — it is the maintained descendant of the exact same
code, verified byte-for-byte reachable through the sanitizer in Task 629 and now also verified through
a real component render in `block-katex/component.test.js`.

KaTeX ships four other contrib modules besides `mhchem`: `auto-render`, `copy-tex`,
`mathtex-script-type`, `render-a11y-string`. All four are DOM-integration or UX conveniences
(delimiter auto-detection, clipboard behavior, `<script type="math/tex">` support, an
accessibility-string generator) — none of them parse a single additional TeX construct that
`renderToString` doesn't already handle without them. 2.5.x used none of the four either (confirmed:
no match for `auto-render`, `copy-tex`, or `render-a11y` anywhere in its history). **No KaTeX contrib
extension 2.5.x exposed is missing from `block-katex`.**

### The compatibility table this task asked for

KaTeX supports a materially smaller TeX subset than MathJax by design — this is upstream KaTeX's own
stated tradeoff for speed and synchronous rendering, not something introduced by this port. Verified
by rendering each construct through both engines exactly as `block-katex/component.js` and
`block-mathjax/component.js` configure them (scratch script, deleted before commit; the two rows
marked † are now pinned as running tests in `component.test.js` for their respective blocks):

| Construct | `::block-katex` | `::block-mathjax` |
| --- | --- | --- |
| `\bussproofs`' `prooftree` environment | Errors — no such environment | Typesets |
| `\cancelto{0}{x}` | Errors — `\cancel`/`\bcancel`/`\xcancel` work, `\cancelto` doesn't | Typesets |
| `\centernot` | Errors — undefined | Typesets |
| `colortbl`'s `\columncolor` (in `array`) | Errors — undefined | Typesets |
| `empheq` environment | Errors — no such environment | Typesets |
| `\enclose{shape}{…}` (arbitrary enclosure shapes; `\fbox`/`\cancel` family still work) | Errors — undefined | Typesets |
| `mathtools`' `\Aboxed` (`\coloneqq` and friends work) | Errors — undefined | Typesets |
| `physics`' `\dv`, `\pdv`, `\abs`, `\qty` (`\ket`/`\bra` work, via `braket`) | Errors — undefined | Typesets |
| `textcomp`'s `\textdegree` (`gensymb`'s `\degree` works) | Errors — undefined | Typesets |
| `upgreek`'s `\upalpha` | Errors — undefined | Typesets |
| `\bbox[…]{…}` † | Errors — undefined | Typesets |
| `\label{…}` | Errors — undefined | Typesets (no visible output either way — the gap only matters if content also uses `\ref`, which neither block resolves across formulas) |
| `\xtwoheadrightarrow`/`\xtwoheadleftarrow`/`\xmapsto` (extpfeil) † | Typesets | **Errors — see the dynamic-glyph gap above; `extpfeil` is declared in `PACKAGES` but currently unusable in this block** |
| `\verb\|…\|` | Typesets | **Errors — same dynamic-glyph gap** |
| Accented/non-Latin Unicode typed directly in math mode (é, ü, …) | Typesets | **Errors — same dynamic-glyph gap** |
| `\href{…}{…}`, `\includegraphics{…}` | Renders the raw command as inert red text (KaTeX's default `trust: false` behavior — no thrown error, no working link/image) | Errors — `html` package deliberately excluded (see `component.js:10-23`) |
| `\ce{…}`, `\pu{…}` (mhchem) | Typesets | Typesets |
| `\cancel`, `\bcancel`, `\xcancel` | Typesets | Typesets |
| AMS environments (`align`, `gather`, `cases`, matrices), `\tag`, `\operatorname` | Typesets | Typesets |

The `\href`/`\includegraphics` row is worth calling out on its own: `block-katex/component.js`'s own
comment says leaving KaTeX's `trust` option at its default "gates" those commands "the same reason
the MathJax block leaves out the `html` package" — true in intent, but the two blocks fail
differently in practice. MathJax throws to the block's `.error` panel with an explanation; KaTeX with
`trust: false` doesn't throw at all, it silently prints the literal command name as inert red text
inline where the link/image would have gone. A reader sees `\href` in red rather than a clear "this
formula could not be typeset" message. Not a defect worth changing here — the outcome (no live link,
no remote image) is what both blocks intend — but worth having on record since it means the two
blocks' error-panel treatment (documented at length in both files' headers) isn't actually symmetric
for this one family of input.

### Scope note: the literal `$…$`/`$$…$$` authoring path is not this table

`frontend/src/renderers/markdown.js`'s literal TeX delimiters (Task 624) import plain `katex`, not
`katex/contrib/mhchem` — Task 629 already found and documented that `\ce{}`/`\pu{}` there currently
throw and fall to the error panel, which is a separate, already-tracked gap between that path and
`::block-katex`, not something this task's audit re-derives. Everything else in the table above
applies equally to the literal path, since it uses the same KaTeX engine and default options.
