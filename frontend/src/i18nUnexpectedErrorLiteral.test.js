import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/** The misspelled literal is untranslatable; shipped source uses `t('common.error.unexpected')`. */
describe('frontend/src source scan: misspelled unexpected-error literal', () => {
  const self = fileURLToPath(import.meta.url)
  const srcDir = dirname(self)

  it('never reintroduces the misspelled "An unexpected error occured" literal', () => {
    const offenders = []
    for (const file of listSourceFiles(srcDir, { ext: ['.vue', '.js'], skip: [self] })) {
      // -> A test may quote the literal to pin the defect down; only shipped source can reintroduce it
      if (file.endsWith('.test.js')) continue
      const content = readFileSync(file, 'utf-8')
      if (content.includes('An unexpected error occured')) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
