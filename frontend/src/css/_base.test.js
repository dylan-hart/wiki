import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../../test/sourceFiles.js'

/**
 * Quasar is gone from this codebase, but a `.q-*` selector or `q-*` class token creeping back in
 * would simply be dead weight -- a rule matching nothing, a class applying no styling -- with no
 * component tree or compiled stylesheet to surface it as a visible failure. Hence a source scan.
 *
 * `--q-*` custom properties are deliberately exempt: that prefix is historical but load-bearing for
 * runtime per-site theming. Neither pattern below can match one -- `\.q-` requires a literal dot
 * immediately before `q-`, and the class-token scan only reads `class`/`:class` attribute values.
 */

const CSS_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(CSS_DIR, '..')

describe('no dead Quasar .q-* CSS remains', () => {
  const cssFiles = listSourceFiles(CSS_DIR, { ext: ['.css'] })

  it('has at least one stylesheet to check (scan is not silently matching nothing)', () => {
    expect(cssFiles.length).toBeGreaterThan(0)
  })

  it('defines no `.q-*` selector anywhere under frontend/src/css', () => {
    const offenders = []
    for (const file of cssFiles) {
      const source = readFileSync(file, 'utf-8')
      if (/\.q-[a-z]/.test(source)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('no dead Quasar q-* utility classes remain in templates', () => {
  const vueFiles = listSourceFiles(SRC_DIR, { ext: ['.vue'] })

  it('has at least one component to check (scan is not silently matching nothing)', () => {
    expect(vueFiles.length).toBeGreaterThan(0)
  })

  it('writes no `q-[a-z]` class token in any `class`/`:class` attribute', () => {
    const offenders = []
    for (const file of vueFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/\b(?:class|:class)="([^"]*)"/g)) {
        if (/\bq-[a-z][a-z0-9-]*\b/.test(match[1])) {
          offenders.push(`${file}: ${match[1]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * `--q-header`/`--q-sidebar` are declared exactly once, in `css/tailwind.css`'s `:root`. A second
 * declaration in `_base.css` would keep working -- same specificity, loaded later -- which is
 * exactly what makes it dangerous: a silent second source of truth for a re-themed value.
 */
describe('_base.css chrome background resolves through the token only', () => {
  const source = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')

  it('declares no `--q-header`/`--q-sidebar` custom property of its own', () => {
    expect(source).not.toMatch(/--q-header\s*:/)
    expect(source).not.toMatch(/--q-sidebar\s*:/)
  })

  it('paints `.header`/`.bg-header` and `.sidebar`/`.bg-sidebar` with `var()` alone, no literal fallback', () => {
    const headerRule = source.match(/\.header,\s*\n\s*\.bg-header\s*\{([^}]*)\}/)
    const sidebarRule = source.match(/\.sidebar,\s*\n\s*\.bg-sidebar\s*\{([^}]*)\}/)
    expect(headerRule, '.header/.bg-header rule found').toBeTruthy()
    expect(sidebarRule, '.sidebar/.bg-sidebar rule found').toBeTruthy()
    expect(headerRule[1].trim()).toBe('background: var(--q-header);')
    expect(sidebarRule[1].trim()).toBe('background: var(--q-sidebar);')
  })
})

/**
 * The dialog title band has to read `--color-dialog-header-bg`, whose three values (Ledger, Cobalt
 * light, Cobalt dark) are declared beside every other aesthetic value: a compile-time Sass constant
 * could never pick up an aesthetic's runtime override and would stay Ledger-coloured everywhere.
 * Nothing compiles Sass in this test environment, so a literal or a constant creeping back into the
 * rule is only visible by reading the rule body directly.
 */
describe('.card-header title band resolves through runtime tokens only', () => {
  const source = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')
  // -> `\s*\{` (no `--slate` in between) is what keeps this from matching `.card-header--slate`.
  const cardHeaderRule = source.match(/\.card-header\s*\{([^}]*)\}/)

  it('finds the .card-header rule', () => {
    expect(cardHeaderRule, '.card-header rule found').toBeTruthy()
  })

  it('paints background-color and border-bottom with var(--color-*), not a theme.$ Sass constant', () => {
    const body = cardHeaderRule[1]
    /*
      `--color-dialog-header-bg`, not the `--color-dark-2` rung: that rung carries a Cobalt value in
      the DARK block alone, so reading it leaves a Cobalt LIGHT page drawing Ledger's near-black band
      where the aesthetic's own raised indigo belongs.
    */
    expect(body).toMatch(/background-color:\s*var\(--color-dialog-header-bg\)/)
    expect(body).toMatch(/border-bottom:\s*1px solid var\(--color-hairline-dark\)/)
    expect(body).not.toMatch(/theme\.\$/)
  })
})

/**
 * `.admin-sidebar` is drawn on ink in every aesthetic, in both themes, so Ledger's dark-ground
 * scrollbar block has to cover it unconditioned on `.body--dark`. Source-scan because jsdom has no
 * `::-webkit-scrollbar` pseudo-element to read a computed style off of.
 */
describe('_base.css Ledger dark-ground scrollbar block covers .admin-sidebar', () => {
  const fullSource = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')

  // Scoped to the Ledger dark-ground block alone, so this doesn't also match Cobalt's separate one.
  const blockStart = fullSource.indexOf('/* Dark mode, and any Ledger surface on ink')
  const blockEnd = fullSource.indexOf('/* SCROLLBAR — COBALT', blockStart)
  const source = fullSource.slice(blockStart, blockEnd)

  it('has a Ledger dark-ground block to check (scan is not silently matching nothing)', () => {
    expect(blockStart).toBeGreaterThan(-1)
    expect(blockEnd).toBeGreaterThan(blockStart)
  })

  it('lists .admin-sidebar alongside .body--ledger.body--dark and .body--ledger .code-block in every rule', () => {
    const groupPattern =
      /^[ \t]*\.body--ledger\.body--dark,\s*\n[ \t]*\.body--ledger \.code-block,\s*\n[ \t]*\.body--ledger \.admin-sidebar \{/gm
    // -> No descendant combinator needed for the @supports rule: scrollbar-color is an inherited
    // property, so setting it on .admin-sidebar itself cascades down to the nested <w-scroll-area>
    // that actually scrolls.
    expect([...source.matchAll(groupPattern)].length).toBe(1)

    // A ::-webkit-scrollbar-* pseudo-element is NOT inherited -- it has to be declared on the
    // element that actually has the scrollbar. .admin-sidebar has no `overflow` of its own and
    // never scrolls; the real scroll region is the nested <w-scroll-area class="admin-nav">
    // descendant, so every one of these rules needs the descendant-combinator space. A selector
    // missing it (`.admin-sidebar::-webkit-scrollbar-*`) compiles and lists the class name, but
    // matches nothing on the real page.
    const suffixedGroup = (suffix) =>
      new RegExp(
        `\\.body--ledger\\.body--dark ::-webkit-scrollbar-${suffix},\\s*\\n` +
          `\\.body--ledger \\.code-block::-webkit-scrollbar-${suffix},\\s*\\n` +
          `\\.body--ledger \\.admin-sidebar ::-webkit-scrollbar-${suffix} \\{`
      )

    for (const suffix of ['track', 'thumb', 'thumb:hover', 'thumb:active', 'corner']) {
      expect(
        suffixedGroup(suffix).test(source),
        `::-webkit-scrollbar-${suffix} rule reaches .admin-sidebar's nested <w-scroll-area> via a descendant combinator`
      ).toBe(true)
    }
  })

  it('never gates the .admin-sidebar dark-ground selector behind .body--dark', () => {
    expect(source).not.toMatch(/\.body--ledger\.body--dark \.admin-sidebar/)
  })

  it('regression: does not compound .admin-sidebar directly onto ::-webkit-scrollbar-* (OpenProject #3036 -- matches nothing, since .admin-sidebar itself never scrolls)', () => {
    expect(source).not.toMatch(/\.body--ledger \.admin-sidebar::-webkit-scrollbar/)
  })

  it('does not extend the dark-ground tint to .sidebar-nav (theme/site-configurable, not always-dark under Ledger)', () => {
    expect(source).not.toMatch(/\.sidebar-nav/)
  })
})

/**
 * Source-scan: a scrollbar's own visual behavior isn't observable through jsdom at all -- no layout
 * engine, no `::-webkit-scrollbar` pseudo-element support -- so this pins the rule text down.
 */
describe('_base.css Cobalt overlay-pill scrollbar block', () => {
  const fullSource = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')

  /*
    Scoped to the Cobalt block (its header comment through to the FONTS section that follows it), so
    the separately-owned Ledger block above can neither satisfy nor break these assertions.
  */
  const blockStart = fullSource.indexOf('/* SCROLLBAR — COBALT')
  const blockEnd = fullSource.indexOf('/* FONTS', blockStart)
  const source = fullSource.slice(blockStart, blockEnd)

  it('has a Cobalt scrollbar block to check (scan is not silently matching nothing)', () => {
    expect(blockStart).toBeGreaterThan(-1)
    expect(blockEnd).toBeGreaterThan(blockStart)
  })

  it('wraps the standards scrollbar-width/scrollbar-color properties in @supports not selector(::-webkit-scrollbar)', () => {
    const supportsBlocks = [
      ...source.matchAll(/@supports not selector\(::-webkit-scrollbar\) \{([^]*?)\n\}/g)
    ]
    expect(supportsBlocks.length).toBe(2)
    expect(supportsBlocks[0][1]).toMatch(
      /\.body--cobalt\s*\{\s*scrollbar-width:\s*thin;\s*scrollbar-color:\s*rgba\(31,\s*79,\s*214,\s*0\.28\)\s*transparent;/
    )
    expect(supportsBlocks[1][1]).toMatch(
      /scrollbar-color:\s*rgba\(255,\s*255,\s*255,\s*0\.22\)\s*transparent;/
    )
  })

  it('never states scrollbar-width/scrollbar-color unwrapped alongside a ::-webkit-scrollbar* rule on the same selector', () => {
    const lines = source.split('\n')
    let depth = 0
    const supportsDepths = []
    for (const line of lines) {
      if (/@supports not selector\(::-webkit-scrollbar\)/.test(line)) {
        supportsDepths.push(depth)
      }
      const insideSupports = supportsDepths.length > 0
      if (/\b(scrollbar-width|scrollbar-color)\s*:/.test(line)) {
        expect(insideSupports, `"${line.trim()}" must be wrapped in @supports`).toBe(true)
      }
      depth += (line.match(/\{/g) || []).length
      depth -= (line.match(/\}/g) || []).length
      while (supportsDepths.length && depth <= supportsDepths[supportsDepths.length - 1]) {
        supportsDepths.pop()
      }
    }
  })

  it('draws a 14px gutter with no track fill and no rule', () => {
    expect(source).toMatch(
      /\.body--cobalt ::-webkit-scrollbar \{\s*width:\s*14px;\s*height:\s*14px;\s*\}/
    )
    expect(source).toMatch(
      /\.body--cobalt ::-webkit-scrollbar-track,\s*\n\.body--cobalt ::-webkit-scrollbar-corner \{\s*background:\s*transparent;\s*\}/
    )
  })

  it('draws an 8px pill thumb (via a 3px transparent border) that narrows to 2px on hover/active', () => {
    const thumbRule = source.match(/\.body--cobalt ::-webkit-scrollbar-thumb \{([^}]*)\}/)
    expect(thumbRule, 'idle thumb rule found').toBeTruthy()
    expect(thumbRule[1]).toMatch(/background:\s*rgba\(31,\s*79,\s*214,\s*0\.28\);/)
    expect(thumbRule[1]).toMatch(/border:\s*3px solid transparent;/)
    expect(thumbRule[1]).toMatch(/background-clip:\s*padding-box;/)
    expect(thumbRule[1]).toMatch(/border-radius:\s*999px;/)

    const hoverRule = source.match(/\.body--cobalt ::-webkit-scrollbar-thumb:hover \{([^}]*)\}/)
    expect(hoverRule[1]).toMatch(/background-color:\s*rgba\(31,\s*79,\s*214,\s*0\.5\);/)
    expect(hoverRule[1]).toMatch(/border-width:\s*2px;/)

    const activeRule = source.match(/\.body--cobalt ::-webkit-scrollbar-thumb:active \{([^}]*)\}/)
    expect(activeRule[1]).toMatch(/background-color:\s*#1f4fd6;/)
    expect(activeRule[1]).toMatch(/border-width:\s*2px;/)
  })

  it('hides the scrollbar buttons', () => {
    expect(source).toMatch(/\.body--cobalt ::-webkit-scrollbar-button \{\s*display:\s*none;\s*\}/)
  })

  it('applies the white dark-ground tint to dark mode, the sidebar and rendered code blocks alike, unconditioned on .body--dark', () => {
    // -> `[ \t]*` allows for the @supports-nested occurrence's extra indentation.
    const groupPattern =
      /^[ \t]*\.body--cobalt\.body--dark,\s*\n[ \t]*\.body--cobalt \.sidebar-nav,\s*\n[ \t]*\.body--cobalt \.admin-sidebar,\s*\n[ \t]*\.body--cobalt \.page-contents pre \{/gm
    const groupMatches = [...source.matchAll(groupPattern)]
    // -> The bare-selector form appears once, for the @supports rule.
    expect(groupMatches.length).toBe(1)

    const suffixedGroup = (suffix) =>
      new RegExp(
        `\\.body--cobalt\\.body--dark ::-webkit-scrollbar-thumb${suffix},\\s*\\n` +
          `\\.body--cobalt \\.sidebar-nav ::-webkit-scrollbar-thumb${suffix},\\s*\\n` +
          `\\.body--cobalt \\.admin-sidebar ::-webkit-scrollbar-thumb${suffix},\\s*\\n` +
          `\\.body--cobalt \\.page-contents pre::-webkit-scrollbar-thumb${suffix} \\{([^}]*)\\}`
      )

    const thumbMatch = source.match(suffixedGroup(''))
    expect(thumbMatch, 'dark-ground idle thumb rule found').toBeTruthy()
    expect(thumbMatch[1]).toMatch(/background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.22\);/)

    const hoverMatch = source.match(suffixedGroup(':hover'))
    expect(hoverMatch, 'dark-ground hover thumb rule found').toBeTruthy()
    expect(hoverMatch[1]).toMatch(/background-color:\s*rgba\(143,\s*176,\s*255,\s*0\.6\);/)

    const activeMatch = source.match(suffixedGroup(':active'))
    expect(activeMatch, 'dark-ground active thumb rule found').toBeTruthy()
    expect(activeMatch[1]).toMatch(/background-color:\s*#8fb0ff;/)
  })

  it('never gates the sidebar/code-block dark-ground selectors behind .body--dark', () => {
    expect(source).not.toMatch(/\.body--cobalt\.body--dark \.sidebar-nav/)
    expect(source).not.toMatch(/\.body--cobalt\.body--dark \.admin-sidebar/)
    expect(source).not.toMatch(/\.body--cobalt\.body--dark \.page-contents pre/)
  })
})

describe('_base.css carries no Sass-specific syntax', () => {
  const source = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')

  it('declares no @use import', () => {
    expect(source).not.toMatch(/^\s*@use\b/m)
  })

  it('uses no @at-root escape', () => {
    expect(source).not.toMatch(/@at-root/)
  })

  it('still themes .card-actions and .translucent-menu via plain & nesting', () => {
    expect(source).toMatch(/\.card-actions \{\s*\n\s*\.body--light &/)
    expect(source).toMatch(/\.translucent-menu \{[^]*?\n\s*\.body--light &/)
  })
})

// A scoped `<style>` block here would outrank the global `.body--ledger`/`.body--cobalt` scrollbar
// rules on Vue's `[data-v-xxx]` specificity, silently restoring the component's own grey bar.
describe('WScrollArea.vue carries no scrollbar rule of its own', () => {
  const source = readFileSync(resolve(CSS_DIR, '../components/shared/WScrollArea.vue'), 'utf-8')

  it('carries no <style> block at all (the rule it existed for is gone, not just its content)', () => {
    expect(source).not.toMatch(/<style/)
  })

  it('still scrolls via the overflow-auto utility class in its template', () => {
    expect(source).toMatch(/class="w-scroll-area overflow-auto"/)
  })
})
