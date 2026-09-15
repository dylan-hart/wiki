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
 * workspace is: nothing compiles Sass here, so a re-introduced `rgba($var, …)` (which only fails to
 * build once the `additionalData` Sass injection is eventually dropped in the final teardown Task)
 * would otherwise sit invisible until then.
 *
 * The two converted sites are also asserted individually against the exact `color-mix(in srgb,
 * var(--color-x) N%, transparent)` text, matching the pattern already shipped two rules above in
 * `GroupRulesEditor.vue` (`.is-allow`/`.is-deny`) that this WP's own scope note says to finish, not
 * reinvent.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

describe('no rgba($variable, …) call sites remain in frontend/src', () => {
  const files = listSourceFiles(SRC_ROOT, { ext: ['.vue', '.scss'] })

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
  const forceallowRule = source.match(/&\.is-forceallow \{([^}]*)\}/)

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
  const darkContentRule = source.match(
    /@at-root \.theme--dark & \{\s*background-color:\s*([^;]+);\s*\}/
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
