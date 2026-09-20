import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What a design token resolves to under each aesthetic, read out of `css/tailwind.css`.
 *
 * App stylesheets read colours, radii and shadows through runtime custom properties rather than
 * literals, so a suite's claim that a rule paints a given colour actually splits in two: that the
 * rule names the right token, and that the token holds the right value. Asserting only the token
 * name would let its value silently change; asserting a copied literal would go stale the moment
 * the token's value changed. Reading the value from the stylesheet keeps both halves honest.
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
 * neither builds `css/tailwind.css` -- so a component rule that reads a token computes to nothing at
 * all, and a `.body--dark` override written that way silently stops overriding. `test/setup.js`
 * installs this to put those rules back on real values; reading them out of the stylesheet rather
 * than restating them is what keeps them real.
 *
 * Only the Ledger half: a suite that wants Cobalt's own value asks `tokenValue(name, 'cobalt')` for
 * it, rather than every suite silently rendering under whichever aesthetic was installed last.
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
