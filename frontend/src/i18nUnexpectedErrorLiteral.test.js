import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #1605 ("Replace the 110 'An unexpected error occured.' literals with
 * `common.error.unexpected`").
 *
 * The standard error idiom `t(\`admin.x.${resp?.error}\`, resp?.message || 'An unexpected error
 * occured.')` used to put a raw, untranslatable, misspelled English literal in the default slot,
 * 110 times across 61 files -- some call sites carried a variant tail ("...while fetching
 * passkeys.", "...while fetching group details.", one with no trailing period at all), but every
 * one has now been replaced with `t('common.error.unexpected')` (or, in the two plain-JS modules
 * with no component context, `i18n.global.t('common.error.unexpected')` via the module-scope
 * export `boot/i18n.js` added for exactly this) -- the correctly-spelled, already-translated
 * (de/ru) key that `backend/locales/en.json` already carried.
 *
 * This is a source-level regression test in the same style as `css/_page-contents.test.js`:
 * asserting the compiled-from source directly, rather than mounting every one of 61 components,
 * is what actually pins a source-text literal down -- and a fresh occurrence typo'd back in by a
 * future edit (copy-pasting an old call site, say) would otherwise ship silently.
 */
describe('frontend/src source scan: misspelled unexpected-error literal', () => {
  const self = fileURLToPath(import.meta.url)
  const srcDir = dirname(self)

  it('never reintroduces the misspelled "An unexpected error occured" literal', () => {
    const offenders = []
    for (const file of listSourceFiles(srcDir, { ext: ['.vue', '.js'], skip: [self] })) {
      const content = readFileSync(file, 'utf-8')
      if (content.includes('An unexpected error occured')) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
