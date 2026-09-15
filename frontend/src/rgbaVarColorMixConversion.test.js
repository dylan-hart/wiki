import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #3247 ("Sass removal 2/9: convert the 3 rgba($var, …) call sites to color-mix()").
 * `docs/frontend-sass-removal-plan.md`'s footprint count named exactly 3 `rgba($variable, …)` call
 * sites left in `frontend/src` -- `EditorMarkdown.vue:2153` and `GroupRulesEditor.vue:703-704` -- and
 * this is a source-scan for the same reason every other Sass-removal regression test in this
 * workspace is: nothing compiles Sass here at all any more (OpenProject #3254 dropped the pipeline
 * entirely), so a re-introduced `rgba($var, …)` would now be a plain-CSS parse casualty -- a dropped
 * declaration, not a build error -- and this source-scan is what still catches it.
 *
 * The two converted sites are also asserted individually against the exact `color-mix(in srgb,
 * var(--color-x) N%, transparent)` text, matching the pattern already shipped two rules above in
 * `GroupRulesEditor.vue` (`.is-allow`/`.is-deny`) that this WP's own scope note says to finish, not
 * reinvent.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

describe('no rgba($variable, …) call sites remain in frontend/src', () => {
  const files = listSourceFiles(SRC_ROOT, { ext: ['.vue', '.css'] })

  it('has at least one file to check (scan is not silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('never calls rgba(...) with a bare $variable as its first argument', () => {
    const offenders = []
    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/rgba\(\s*\$[\w-]+/g)) {
        offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('GroupRulesEditor.vue .is-forceallow uses color-mix(), matching .is-allow/.is-deny above it', () => {
  const source = readFileSync(resolve(SRC_ROOT, 'components/GroupRulesEditor.vue'), 'utf-8')
  const forceallowRule = source.match(/\.is-forceallow \{([^}]*)\}/)

  it('finds the .is-forceallow rule', () => {
    expect(forceallowRule, '.is-forceallow rule found').toBeTruthy()
  })

  it('mixes var(--color-blue) at 10%/30% against transparent, the same values rgba($blue, 0.1/0.3) drew', () => {
    const body = forceallowRule[1]
    expect(body).toMatch(
      /background-color:\s*color-mix\(in srgb, var\(--color-blue\) 10%, transparent\);/
    )
    expect(body).toMatch(
      /border-bottom:\s*1px solid color-mix\(in srgb, var\(--color-blue\) 30%, transparent\);/
    )
  })
})

describe('EditorMarkdown.vue teal callout dark-mode tint uses color-mix()', () => {
  const source = readFileSync(resolve(SRC_ROOT, 'components/EditorMarkdown.vue'), 'utf-8')
  /*
   * OpenProject #3252 (a later, sibling WP) hand-converted this rule's `@at-root .theme--dark &`
   * escape to a flat, unnested rule at the bottom of the same style block -- and corrected its
   * class from the never-applied `.theme--dark` to the app's real `.body--dark` in the same move
   * (see EditorMarkdown.vue's own "Hand-converted @at-root escapes" comment). This scan follows the
   * rule to its new selector; the color-mix() value this WP (#3247) set is unchanged.
   */
  const darkContentRule = source.match(
    /\.body--dark \.editor-markdown-preview-content \.tabset-content \{\s*background-color:\s*([^;]+);\s*\}/
  )

  it('finds the callout content dark-mode rule', () => {
    expect(darkContentRule, 'callout content dark-mode rule found').toBeTruthy()
  })

  it('mixes var(--color-teal-5) at 10% against transparent, the value rgba($teal-5, 0.1) drew', () => {
    expect(darkContentRule[1].trim()).toBe(
      'color-mix(in srgb, var(--color-teal-5) 10%, transparent)'
    )
  })
})
