import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What a design token resolves to under each aesthetic, read out of `css/tailwind.css`.
 *
 * The Cobalt work moved the app's SFC stylesheets off compile-time SCSS literals (`$hairline`,
 * `$ink`, ...) and onto the runtime custom properties that carry the same value under Ledger and a
 * different one under Cobalt -- which is the whole mechanism the aesthetic system runs on. A suite
 * that used to assert a rule painted `#dbe1ec` now sees `var(--color-hairline)`, and the claim it
 * was making splits in two: the RULE still names the hairline, and the hairline is still `#dbe1ec`
 * in Ledger. Asserting the first alone would let a token silently change value; asserting a copied
 * literal would go stale the moment the token moved. This reads the answer from the stylesheet, so
 * both halves stay true or the test fails.
 *
 * Values are resolved through one level of `var()` aliasing, which is as deep as the token layer
 * goes (`--color-header: var(--q-header)`, `--color-accent-text: var(--color-accent)`, ...).
 */
const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'css', 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf8')

const COBALT_LIGHT = 'body.body--cobalt {'
const COBALT_DARK = 'body.body--cobalt.body--dark {'

function block(which) {
  if (which === 'ledger') {
    return source.slice(0, source.indexOf(COBALT_LIGHT))
  }
  const start = source.indexOf(which === 'cobalt' ? COBALT_LIGHT : COBALT_DARK)
  return source.slice(start, source.indexOf('}', source.indexOf('\n}', start)))
}

function declared(name, which) {
  const match = new RegExp(`^\\s*(${name}):\\s*([^;]+);`, 'm').exec(block(which))
  return match ? match[2].trim() : null
}

/**
 * @param {string} name A custom property name, including the leading `--`.
 * @param {'ledger'|'cobalt'|'cobalt-dark'} [aesthetic] Which block to read; falls back to Ledger's.
 * @returns {string} The resolved value, e.g. `#dbe1ec`.
 */
export function tokenValue(name, aesthetic = 'ledger') {
  let value = declared(name, aesthetic) ?? declared(name, 'ledger')
  for (let depth = 0; depth < 6; depth++) {
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value ?? '')
    if (!alias) break
    value = declared(alias[1], aesthetic) ?? declared(alias[1], 'ledger')
  }
  return value
}

/**
 * Every Ledger token, as a `:root` rule a test environment can install.
 *
 * `happy-dom` and `jsdom` resolve `var()` only against properties something actually declared, and
 * neither of these suites builds `css/tailwind.css` -- so a component rule that reads a token (which
 * is now most of them: see the note above) computes to nothing at all, and a `.body--dark` override
 * written that way silently stops overriding. Installing the Ledger half of the token layer in
 * `test/setup.js` is what puts those rules back on their real values, and reading it out of the
 * stylesheet rather than restating it is what keeps them the REAL values.
 *
 * Only the Ledger half: a suite that wants to assert Cobalt's own value asks `tokenValue(name,
 * 'cobalt')` for it, rather than every suite silently rendering under whichever aesthetic happened
 * to be installed last.
 */
export function ledgerTokenCss() {
  const ledgerHalf = block('ledger')
  const declarations = new Map()
  for (const match of ledgerHalf.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    declarations.set(match[1], match[2].trim())
  }
  const body = [...declarations].map(([name, value]) => `${name}:${value};`).join('')
  return `:root{${body}}`
}
