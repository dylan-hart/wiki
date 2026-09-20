import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * Nothing compiles Sass in this build, so a re-introduced `rgba($var, …)` is an unrecognised
 * plain-CSS function and silently dropped rather than a build error. This source scan is what
 * catches it.
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
