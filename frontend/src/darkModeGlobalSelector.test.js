import { readFileSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileStyleAsync } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #2740. Verified against the real `@vue/compiler-sfc@3.5.41`: inside a `<style
 * scoped>` block, `:global(body.body--dark) .foo { ... }` does NOT compile to
 * `body.body--dark .foo { ... }` the way the source reads -- the descendant selector after the
 * `:global(...)` wrapper is silently DROPPED, and the rule compiles to the bare `body.body--dark
 * { ... }` only, never matching `.foo` at all. Any non-inherited property in such a rule
 * (background-color, border-color, ...) therefore never reaches the intended element in dark
 * mode, leaving whatever the light-mode rule already set -- this was confirmed as the live root
 * cause of a real "admin settings pages have issues with dark mode" report.
 *
 * The correct idiom -- used throughout this codebase (`WCardHeader.vue`, `FooterNav.vue`,
 * `WTable.vue`, `WList.vue`, `WPagination.vue`, `WBtnToggle.vue`, `WBtnGroup.vue`, `WToggle.vue`,
 * and the 16 occurrences fixed by #2740) -- wraps the WHOLE compound selector inside
 * `:global(...)`: `:global(body.body--dark .foo) { ... }`.
 *
 * `detectBadGlobalSelector` below is the one detector for the anti-pattern, exercised first
 * against known-good and known-bad fixtures so a change to the detector itself is visible, then
 * run across the whole `frontend/src` tree so a new occurrence of the mistake fails here instead
 * of shipping silently light-only. `compiles the fix correctly` proves the fix's actual compiled
 * behaviour (not just its source text) against one of the components #2740 touched.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Finds every `:global(...)` occurrence in `source` whose matching close paren is followed
 * (after whitespace) by anything other than `{` or `,` -- i.e. more selector text OUTSIDE the
 * `:global(...)` wrapper, which is the exact shape the compiler silently drops. Tolerates one
 * level of nested parens inside the wrapped selector (e.g. a future `:not(...)`).
 */
function detectBadGlobalSelector(source) {
  const violations = []
  const re = /:global\(/g
  let match
  while ((match = re.exec(source))) {
    const openIndex = match.index + ':global('.length - 1
    let depth = 1
    let i = openIndex + 1
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      i++
    }
    if (depth !== 0) continue // unbalanced -- not our concern here
    const closeIndex = i - 1
    let j = closeIndex + 1
    while (j < source.length && /\s/.test(source[j])) j++
    const next = source[j]
    if (next !== undefined && next !== '{' && next !== ',') {
      violations.push({
        index: match.index,
        snippet: source.slice(match.index, Math.min(source.length, j + 20)).split('\n')[0]
      })
    }
    re.lastIndex = closeIndex + 1
  }
  return violations
}

describe('detectBadGlobalSelector', () => {
  it('flags a descendant selector left outside :global(...)', () => {
    const violations = detectBadGlobalSelector(
      ':global(body.body--dark) .w-settings-card__header {\n  background-color: red;\n}'
    )
    expect(violations).toHaveLength(1)
  })

  it('flags a :deep()-combined descendant selector left outside :global(...)', () => {
    const violations = detectBadGlobalSelector(
      ':global(body.body--dark) .page-new-menu :deep(.blueprint-icon) {\n  color: red;\n}'
    )
    expect(violations).toHaveLength(1)
  })

  it('does not flag the whole-selector idiom', () => {
    const violations = detectBadGlobalSelector(
      ':global(body.body--dark .w-settings-card__header) {\n  background-color: red;\n}'
    )
    expect(violations).toHaveLength(0)
  })

  it('does not flag a comma-separated list of whole global selectors', () => {
    const violations = detectBadGlobalSelector(
      ':global(body.body--dark .w-table__row + .w-table__row td::before),\n' +
        ':global(body.body--dark thead + tbody .w-table__row:first-child td::before) {\n' +
        '  border-top: none;\n}'
    )
    expect(violations).toHaveLength(0)
  })

  it('does not flag a plain rule with no :global() at all', () => {
    expect(detectBadGlobalSelector('.foo {\n  color: red;\n}')).toHaveLength(0)
  })
})

describe('frontend/src source tree', () => {
  it('has no `:global(selector) .descendant` rule silently dropping its descendant', () => {
    const offenders = []
    for (const file of listSourceFiles(SRC_ROOT, { ext: ['.vue'] })) {
      const violations = detectBadGlobalSelector(readFileSync(file, 'utf-8'))
      if (violations.length > 0) {
        offenders.push(
          `${relative(SRC_ROOT, file).split(sep).join('/')}: ${violations.map((v) => v.snippet).join(' | ')}`
        )
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('compiled output (OpenProject #2740 regression guard)', () => {
  it('reproduces the compiler dropping the descendant on the pre-fix pattern', async () => {
    const result = await compileStyleAsync({
      source: ':global(body.body--dark) .w-settings-card__header { background-color: red; }',
      filename: 'Regression.vue',
      id: 'data-v-regression',
      scoped: true
    })
    expect(result.code).not.toContain('.w-settings-card__header')
  })

  it('compiles the fixed idiom to a selector that actually nests the descendant', async () => {
    const result = await compileStyleAsync({
      source: ':global(body.body--dark .w-settings-card__header) { background-color: red; }',
      filename: 'Regression.vue',
      id: 'data-v-regression',
      scoped: true
    })
    expect(result.code).toContain('body.body--dark .w-settings-card__header')
  })

  it("WSettingsCard.vue's actual dark-mode header rule compiles with the descendant intact", async () => {
    const source = readFileSync(`${SRC_ROOT}/components/shared/WSettingsCard.vue`, 'utf-8')
    const styleMatch = source.match(/<style scoped>([\s\S]*?)<\/style>/)
    expect(styleMatch).not.toBeNull()
    const result = await compileStyleAsync({
      source: styleMatch[1],
      filename: 'WSettingsCard.vue',
      id: 'data-v-wsettingscard',
      scoped: true
    })
    expect(result.code).toContain('body.body--dark .w-settings-card__header')
    expect(result.code).toContain('--color-dark-2')
  })
})
