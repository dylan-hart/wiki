import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { listSourceFiles } from './sourceFiles.js'

/**
 * One recursive source walker for the seven that were copied across `src/` (TEST-F15):
 * `autofocusUsage` ≡ `buttonAccessibility`, `imgAlt` ≡ `adminIconHeaderSize`, plus
 * `components/dialogAccessibleName`, `i18nSourceGate`, `css/_base`, `physicalPositioning` and
 * `i18nUnexpectedErrorLiteral` -- each the same readdir-recurse-filter loop, differing only in the
 * extensions it keeps and whether it skips test files.
 */
let root

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'source-files-'))
  mkdirSync(join(root, 'nested', 'deeper'), { recursive: true })
  writeFileSync(join(root, 'a.vue'), '')
  writeFileSync(join(root, 'a.test.js'), '')
  writeFileSync(join(root, 'a.js'), '')
  writeFileSync(join(root, 'notes.md'), '')
  writeFileSync(join(root, 'nested', 'b.vue'), '')
  writeFileSync(join(root, 'nested', 'deeper', 'c.js'), '')
})

const relative = (files) =>
  files
    .map((f) =>
      f
        .slice(root.length + 1)
        .split(sep)
        .join('/')
    )
    .sort()

describe('listSourceFiles', () => {
  it('recurses the whole tree and returns absolute paths', () => {
    const files = listSourceFiles(root, { ext: ['.vue'] })
    expect(files.every((f) => f.startsWith(root))).toBe(true)
    expect(relative(files)).toEqual(['a.vue', 'nested/b.vue'])
  })

  it('keeps every listed extension', () => {
    expect(relative(listSourceFiles(root, { ext: ['.vue', '.js'] }))).toEqual([
      'a.js',
      'a.test.js',
      'a.vue',
      'nested/b.vue',
      'nested/deeper/c.js'
    ])
  })

  it('defaults to .vue and .js, the pair every existing walker wanted', () => {
    expect(relative(listSourceFiles(root))).toEqual([
      'a.js',
      'a.test.js',
      'a.vue',
      'nested/b.vue',
      'nested/deeper/c.js'
    ])
  })

  it('skips paths matching any string in skip', () => {
    expect(relative(listSourceFiles(root, { skip: ['.test.js'] }))).toEqual([
      'a.js',
      'a.vue',
      'nested/b.vue',
      'nested/deeper/c.js'
    ])
  })

  it('skips paths a skip predicate rejects', () => {
    const files = listSourceFiles(root, { ext: ['.js'], skip: (f) => f.includes('deeper') })
    expect(relative(files)).toEqual(['a.js', 'a.test.js'])
  })

  it('returns a stable, sorted order regardless of readdir order', () => {
    expect(listSourceFiles(root)).toEqual([...listSourceFiles(root)].sort())
  })
})
