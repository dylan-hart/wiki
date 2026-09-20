import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * App stylesheets read colours, radii and shadows through runtime custom properties rather than
 * literals, so a suite's claim that a rule paints a given colour splits in two: that the rule
 * names the right token, and that the token holds the right value. Asserting only the token name
 * would let its value change silently; asserting a copied literal would go stale. Reading the
 * value out of the stylesheet keeps both halves honest.
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
 * @param {'ledger'|'cobalt'|'cobalt-dark'} [aesthetic] Falls back to Ledger's block for a token
 *   this one does not declare.
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
 * A `:root` rule `test/setup.js` installs, since `happy-dom` resolves `var()` only against
 * properties something actually declared. Read out of the stylesheet rather than restated, so the
 * installed values cannot drift from the ones the app ships.
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
