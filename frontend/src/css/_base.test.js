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
