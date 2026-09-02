import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { listSourceFiles } from './sourceFiles.ts'

const backendDir = path.join(import.meta.dirname, '..')

describe('listSourceFiles', () => {
  test('walks recursively and skips node_modules by default', () => {
    const files = listSourceFiles(backendDir)
    assert.ok(files.some((f) => f.endsWith(path.join('helpers', 'pageRules.ts'))))
    assert.ok(files.some((f) => f.endsWith(path.join('api', 'schemas', 'error.ts'))))
    assert.equal(
      files.some((f) => f.includes(`${path.sep}node_modules${path.sep}`)),
      false
    )
  })

  test('ext keeps only the named extensions', () => {
    const files = listSourceFiles(path.join(backendDir, 'helpers'), { ext: ['.ts'] })
    assert.ok(files.length > 0)
    assert.ok(files.every((f) => f.endsWith('.ts')))
  })

  test('skip drops files by suffix', () => {
    const files = listSourceFiles(path.join(backendDir, 'helpers'), {
      ext: ['.ts'],
      skip: ['.test.ts']
    })
    assert.ok(files.length > 0)
    assert.equal(
      files.some((f) => f.endsWith('.test.ts')),
      false
    )
  })

  test('skipDirs replaces the default set', () => {
    const files = listSourceFiles(path.join(backendDir, 'api'), {
      ext: ['.ts'],
      skipDirs: ['schemas']
    })
    assert.ok(files.length > 0)
    assert.equal(
      files.some((f) => f.includes(`${path.sep}schemas${path.sep}`)),
      false
    )
  })
})
