import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../../test/sourceFiles.js'

/**
 * OpenProject #1909 ("Delete dead Quasar CSS and the seven `q-*` utility classes still written in
 * templates"). Quasar is gone from this codebase (`tailwind.css`'s Preflight comment says so
 * outright), but `.q-*` selectors and `q-*` utility class tokens kept surviving in `_base.scss` and
 * a handful of templates as dead weight -- rules matching nothing, and classes that silently applied
 * no styling wherever they were still written.
 *
 * These are source-level regression tests, not runtime ones: there is no component tree or compiled
 * stylesheet that would surface a REintroduced `q-*` selector or class as a visible failure -- it
 * would simply be dead again, quietly. Scanning the source directly is what actually pins this down,
 * the same rationale `_page-contents.test.js` gives for asserting against source rather than
 * computed styles.
 *
 * `--q-*` custom properties are deliberately exempt (see CLAUDE.md's `blocks/` section): that prefix
 * is historical but load-bearing for runtime per-site theming, and neither pattern below can match
 * it -- `\.q-` requires a literal dot immediately before `q-`, which `--q-header` does not have, and
 * the class-token scan only looks inside `class`/`:class` attribute values in `.vue` templates,
 * which never contain a custom-property reference at all.
 */

const CSS_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(CSS_DIR, '..')

describe('no dead Quasar .q-* CSS remains', () => {
  const cssFiles = listSourceFiles(CSS_DIR, { ext: ['.scss', '.css'] })

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
 * OpenProject #2783 ("Literal-color grep sweep"). `--q-header`/`--q-sidebar` are declared exactly
 * once, in `css/tailwind.css`'s `:root` -- this file used to redeclare both, hex literal and all,
 * immediately above the very rules that resolve them through `var()`. A re-themed/re-skinned value
 * would have kept working (this file's `:root` wins the cascade, being the same specificity and
 * loading after `tailwind.css`), but ONLY as long as nobody ever touched the copy here again -- a
 * silent second source of truth is exactly what the token layer exists to prevent.
 */
describe('_base.scss chrome background resolves through the token only', () => {
  const source = readFileSync(resolve(CSS_DIR, '_base.scss'), 'utf-8')

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
 * OpenProject #2815. `.card-header` -- the dialog title band shared by `WConfirmDialog.vue` and
 * 60+ other dialogs -- used to draw its background/border from the compile-time
 * `theme.$dark-2`/`$hairline-dark` Sass constants, which meant it could never pick up
 * the aesthetic's own runtime override and stayed Ledger-colored under every other
 * aesthetic. It now reads `--color-dialog-header-bg`, whose three values (Ledger, Cobalt light,
 * Cobalt dark) are declared beside every other aesthetic value. Same source-scan rationale as the `--q-header`/`--q-sidebar` describe above: nothing
 * compiles Sass in this test environment, so the regression this guards against (a literal or a
 * Sass constant creeping back into the rule) is only visible by reading the rule body directly.
 */
describe('.card-header title band resolves through runtime tokens only', () => {
  const source = readFileSync(resolve(CSS_DIR, '_base.scss'), 'utf-8')
  // -> `\s*\{` (no `--slate` in between) is what keeps this from matching `.card-header--slate`.
  const cardHeaderRule = source.match(/\.card-header\s*\{([^}]*)\}/)

  it('finds the .card-header rule', () => {
    expect(cardHeaderRule, '.card-header rule found').toBeTruthy()
  })

  it('paints background-color and border-bottom with var(--color-*), not a theme.$ Sass constant', () => {
    const body = cardHeaderRule[1]
    /*
      `--color-dialog-header-bg`, not the `--color-dark-2` rung this first reached for: that rung
      carries a Cobalt value in the DARK block alone, so reading it left a Cobalt LIGHT page still
      drawing Ledger's near-black band where `Profile 3x - Cobalt` draws the aesthetic's own raised
      indigo. The token names the role and carries all three values (`css/tailwind.css`).
    */
    expect(body).toMatch(/background-color:\s*var\(--color-dialog-header-bg\)/)
    expect(body).toMatch(/border-bottom:\s*1px solid var\(--color-hairline-dark\)/)
    expect(body).not.toMatch(/theme\.\$/)
  })
})

/**
 * OpenProject #3020 ("Ledger admin-sidebar scrollbar uses light-mode colours on its always-dark
 * ground"). `AdminLayout.vue`'s own header comment is explicit that `.admin-sidebar` is drawn on
 * ink in every aesthetic, in both themes -- so Ledger's dark-ground scrollbar block (the one
 * covering `.body--ledger.body--dark` and `.body--ledger .code-block`) has to cover
 * `.body--ledger .admin-sidebar` too, unconditioned on `.body--dark`, the same way Cobalt's own
 * dark-ground block already does. Source-scan for the same reason as every other describe in this
 * file: nothing compiles Sass here and jsdom has no `::-webkit-scrollbar` pseudo-element to read a
 * computed style off of.
 */
describe('_base.scss Ledger dark-ground scrollbar block covers .admin-sidebar', () => {
  const fullSource = readFileSync(resolve(CSS_DIR, '_base.scss'), 'utf-8')

  // Scoped to the Ledger dark-ground block alone (its own comment through to the Cobalt section
  // header that follows it) so this doesn't also match Cobalt's separate, already-correct block.
  const blockStart = fullSource.indexOf('// Dark mode, and any Ledger surface on ink')
  const blockEnd = fullSource.indexOf('// SCROLLBAR — COBALT', blockStart)
  const source = fullSource.slice(blockStart, blockEnd)

  it('has a Ledger dark-ground block to check (scan is not silently matching nothing)', () => {
    expect(blockStart).toBeGreaterThan(-1)
    expect(blockEnd).toBeGreaterThan(blockStart)
  })

  it('lists .admin-sidebar alongside .body--ledger.body--dark and .body--ledger .code-block in every rule', () => {
    const groupPattern =
      /^[ \t]*\.body--ledger\.body--dark,\s*\n[ \t]*\.body--ledger \.code-block,\s*\n[ \t]*\.body--ledger \.admin-sidebar \{/gm
    // -> The bare-selector form, used once for the @supports scrollbar-color rule.
    expect([...source.matchAll(groupPattern)].length).toBe(1)

    const suffixedGroup = (suffix) =>
      new RegExp(
        `\\.body--ledger\\.body--dark ::-webkit-scrollbar-${suffix},\\s*\\n` +
          `\\.body--ledger \\.code-block::-webkit-scrollbar-${suffix},\\s*\\n` +
          `\\.body--ledger \\.admin-sidebar::-webkit-scrollbar-${suffix} \\{`
      )

    for (const suffix of ['track', 'thumb', 'thumb:hover', 'thumb:active', 'corner']) {
      expect(
        suffixedGroup(suffix).test(source),
        `::-webkit-scrollbar-${suffix} rule includes .admin-sidebar`
      ).toBe(true)
    }
  })

  it('never gates the .admin-sidebar dark-ground selector behind .body--dark', () => {
    expect(source).not.toMatch(/\.body--ledger\.body--dark \.admin-sidebar/)
  })

  it('does not extend the dark-ground tint to .sidebar-nav (theme/site-configurable, not always-dark under Ledger)', () => {
    expect(source).not.toMatch(/\.sidebar-nav/)
  })
})

/**
 * OpenProject #3006 ("Implement Cobalt overlay-pill scrollbar spec, light + dark"). Source-scan,
 * matching the rationale every other describe in this file already gives: nothing compiles Sass in
 * this test environment, and a scrollbar's own visual behavior isn't observable through jsdom either
 * (no real layout engine, no `::-webkit-scrollbar` pseudo-element support) -- so this pins the rule
 * text down directly, the same way `_page-contents.test.js` does for its own file.
 */
describe('_base.scss Cobalt overlay-pill scrollbar block', () => {
  const fullSource = readFileSync(resolve(CSS_DIR, '_base.scss'), 'utf-8')

  /*
    Scoped to this task's own block (its header comment through to the FONTS section that follows
    it), not the whole file: the pre-existing generic scrollbar rule above it (the one OpenProject
    #3005, a sibling task, replaces with its own Ledger-specific block) is a known, separately-owned
    issue -- asserting the engine gotcha file-wide would fail against code this task does not touch.
  */
  const blockStart = fullSource.indexOf('// SCROLLBAR — COBALT')
  const blockEnd = fullSource.indexOf('// FONTS', blockStart)
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
    // -> Every line touching the standards properties, anywhere in this block, must sit inside an
    //    @supports block.
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
    // -> The dark-ground selector group: whole page in dark mode, plus the two real sidebar classes
    //    and the real code-block selector -- none of the latter three gated behind `.body--dark`.
    //    Allows for the @supports-nested occurrence's extra indentation vs. the three top-level
    //    thumb/hover/active occurrences.
    const groupPattern =
      /^[ \t]*\.body--cobalt\.body--dark,\s*\n[ \t]*\.body--cobalt \.sidebar-nav,\s*\n[ \t]*\.body--cobalt \.admin-sidebar,\s*\n[ \t]*\.body--cobalt \.page-contents pre \{/gm
    const groupMatches = [...source.matchAll(groupPattern)]
    // -> The bare-selector form, used once for the @supports scrollbar-color rule.
    expect(groupMatches.length).toBe(1)

    // -> The thumb/hover/active forms each repeat the same four-selector group with
    //    `::-webkit-scrollbar-thumb[:hover|:active]` appended to every one of the four.
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

/**
 * OpenProject #3006. `WScrollArea.vue` used to hardcode its own grey scrollbar, at a specificity
 * (Vue's scoped-style `[data-v-xxx]` attribute) that outranked the new global `.body--ledger`/
 * `.body--cobalt` rules above -- so every `<w-scroll-area>` region silently kept the old grey bar.
 * Source-scan rather than a mount/computed-style assertion for the same reason as the rest of this
 * file: jsdom has no `::-webkit-scrollbar` pseudo-element to read a computed style off of at all.
 */
describe('WScrollArea.vue carries no scrollbar rule of its own', () => {
  const source = readFileSync(resolve(CSS_DIR, '../components/shared/WScrollArea.vue'), 'utf-8')

  it('carries no <style> block at all (the rule it existed for is gone, not just its content)', () => {
    expect(source).not.toMatch(/<style/)
  })

  it('still scrolls via the overflow-auto utility class in its template', () => {
    expect(source).toMatch(/class="w-scroll-area overflow-auto"/)
  })
})
