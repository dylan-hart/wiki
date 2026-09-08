# Where the Cobalt implementation departs from its mockups

`ui-redesign-cobalt/` is the source of truth for the Cobalt aesthetic, and its `HANDOFF.md` says so
twice over: "the mockups are the spec", and "where a derived screen and this document disagree, this
document wins". Both were followed. This file records the handful of places the shipped app draws
something the mockup files do not — every one of them either a rule the handoff itself states, or a
divergence Ledger already made for the same reason.

Nothing here is a shortcut. If a row below stops being true — a contrast floor is raised, a mockup is
redrawn — the fix is to change the code, and to change this file with it.

## The fill / text split

The handoff's own tables split every accent into two tones: an **untexted fill** (`#ff4d5a`) and a
tone for **a fill carrying white text or for accent text on paper** (`#c8303c`). It then says, in
"Cobalt tokens":

> The mockups were drawn with `#ff4d5a` under white labels and were corrected to `#c8303c` in this
> folder before handoff … If any screen in this folder still shows `#ff4d5a` under white type, that
> is a defect in the mockup, not a spec; use `#c8303c`.

Three screens still show the uncorrected value, and all three take `#c8303c`:

| Screen | What it draws | What ships |
| --- | --- | --- |
| `Editor 3x - Cobalt` | the editor's page-actions rail, `#ff4d5a` under white glyphs and a white overline | `--color-accent` (`#c8303c`, 5.3:1) |
| `Page View 3x - Cobalt` | the rail's primary action plate, `#ff4d5a` under a white glyph | `--color-accent` |
| `Tags 3x - Cobalt` | a selected tag chip, `#ff4d5a` under white | `--color-accent` |

Ledger enforces the identical split with `$accent-fill` against `$primary`, and its own page-actions
rail already diverges from its own mockup for exactly this reason (see `PageActionsCol.vue`).

## The positive tone under a white label

`Primitives 3x - Cobalt` draws the positive toast on `#22a37f` and `Editor 3x - Cobalt` the "Save
changes" button on the same. That is the handoff's positive **fill**; its positive **text** tone is
`#177a5e`, and both of those surfaces carry a white label (`#22a37f` under white is 2.6:1).

The app paints them `#177a5e`, through `--q-positive`. This is not a new judgement call: Ledger's own
`Primitives 3x - Ledger` draws the same toast on `#5f9c86` and the app has always painted it
`#3f7a66`, for the same reason and under the same rule (`css/_theme.scss`, "Status").

## Line numbers in a code block

Neither aesthetic's mockups draw the line-number gutter a rendered code block actually has — Ledger's
`Page View 3x - Ledger` shows a bare block too. The gutter is an app feature outside what the
mockups describe rather than something Cobalt removes, so both aesthetics keep it, and Cobalt's
`bash` language label sits beside it.

## The tree's root row

Both aesthetics' `File Manager 3x` mockups draw the file manager tree's root row in the panel's own
ink with a chrome glyph (`#1c2233`/`#64789f` in Ledger, `#10194a`/`#1f4fd6` in Cobalt). The app drew
it in the Material palette's purple in both themes — a hue in neither language and in no mockup. It
now follows the mockups, which changes Ledger as well; this is the one place fixing Cobalt corrected
a pre-existing Ledger defect rather than leaving it.

## Syntax colours inside a code block

The handoff gives Cobalt two syntax tones (`#ff7a84`, `#8fb0ff`) and, separately, keeps
`codeBlocksTheme` an administrator setting whose Cobalt default is the same `github-dark` as Ledger's.
Those two statements are compatible — `github-dark`'s own keyword and variable tones are `#ff7b72`
and `#79c0ff` — so the block's GROUND is the aesthetic's (`#10194a`, forced over the injected
theme's own background, which is what `_page-contents.scss` restates it for) while the token colours
stay the administrator's to choose. The `--content-code-*` fallback palette, which is what a site
with no code theme selected renders, does carry the handoff's two tones exactly.
