import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import cfgHelper from './config.ts'

/**
 * Regression test for `parseConfigValue`'s `$(ENV_VAR:default)` regex: the default-value capture
 * group used to be greedy (`(.+)`), so two references on the same line collapsed into a single
 * match -- the first reference's default swallowed everything up to and including the final `)`,
 * including the second reference's own `$(...)` syntax. Made lazy (`(.+?)`) so each reference stops
 * at its own closing paren.
 */

let previousA: string | undefined
let previousB: string | undefined

beforeEach(() => {
  previousA = process.env.A
  previousB = process.env.B
  delete process.env.A
  delete process.env.B
})

afterEach(() => {
  if (previousA === undefined) {
    delete process.env.A
  } else {
    process.env.A = previousA
  }
  if (previousB === undefined) {
    delete process.env.B
  } else {
    process.env.B = previousB
  }
})

test('substitutes both references on the same line, each falling back to its own default', () => {
  const result = cfgHelper.parseConfigValue('pass: $(A:x) other: $(B:y)')
  assert.equal(result, 'pass: x other: y')
})

test('prefers the environment variable over the default when set', () => {
  process.env.A = 'envA'
  process.env.B = 'envB'
  const result = cfgHelper.parseConfigValue('pass: $(A:x) other: $(B:y)')
  assert.equal(result, 'pass: envA other: envB')
})

test('substitutes a reference with no default at all', () => {
  process.env.A = 'envA'
  const result = cfgHelper.parseConfigValue('single: $(A)')
  assert.equal(result, 'single: envA')
})
