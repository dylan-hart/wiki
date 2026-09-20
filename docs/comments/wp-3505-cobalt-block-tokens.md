# WP 3505: comment changes recommended for `frontend/src/css/tailwind.css`

The Cobalt-light block-token block now restates every composite `--block-*` token whose alias
target Cobalt light redefines, so the FIXME above it is resolved and two claims around it are wrong.

## Cobalt light block, header comment (above `body.body--cobalt {` in the block-token section)

Replace

```css
/*
  Cobalt light. `--block-bg`, `--block-caption-fg`, `--block-eyebrow-fg` and the three accent roles
  are safe left undeclared: the generic tokens they alias either do not change under Cobalt or are
  not referenced only from `:root`.

  FIXME: `--block-border` is not safe -- verified in real Chromium that it has the nested-var()
  cascade bug described in the Ledger-dark block above under plain `body.body--cobalt`, resolving to
  Ledger light's hairline rather than Cobalt's own. Restate it here, as the two shape rows below
  already are.
*/
```

with

```css
/*
  Cobalt light. Every `--block-*` alias whose target Cobalt redefines is restated here (nested-var()
  rule, see the Ledger-dark block above). Only `--block-bg` and `--block-accent-fg` are left
  undeclared: `--color-white` and `--color-accent` do not change under Cobalt.
*/
```

The removed claim that caption, eyebrow and the accent roles were safe was false: real Chromium
resolved them (and `--block-error-border`) against Ledger light's values.

## Restatement comment inside the block (`Restated per the nested-var() rule ...`)

Optional trim: it names only the two shape rows ("leaving every block that reads them square-cornered
with Ledger corner marks"), while the rows below it now cover the colour and radius aliases too. Fold
it into the header above, or reword to "Restated per the nested-var() rule ... for every alias below".

## New test file

`frontend/src/css/blockTokensCobaltRealBrowser.test.js` carries no comment. A header in the style of
`infoboxTokensRealBrowser.test.js` would be worth adding: a `var()` nested in a custom property is
substituted where the property is declared, so a `--block-*` alias assigned only at `:root` reaches
`<body>` already resolved against Ledger's values, and only real compiled CSS in a real browser shows
that.
