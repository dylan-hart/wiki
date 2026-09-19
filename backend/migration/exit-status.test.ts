import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeExitCode, notImplementedPhaseIds } from './exit-status.ts'
import type { PhaseResult } from './context.ts'

function result(phase: PhaseResult['phase'], status: PhaseResult['status']): PhaseResult {
  return { phase, status, durationMs: 0 }
}

describe('notImplementedPhaseIds', () => {
  test('returns only the not_implemented phases, in order', () => {
    const results = [
      result('settings', 'ok'),
      result('users', 'not_implemented'),
      result('content', 'ok'),
      result('assets', 'not_implemented')
    ]
    assert.deepEqual(notImplementedPhaseIds(results), ['users', 'assets'])
  })

  test('returns an empty array when every phase resolved', () => {
    const results = [result('settings', 'ok'), result('users', 'error')]
    assert.deepEqual(notImplementedPhaseIds(results), [])
  })
})

describe('computeExitCode', () => {
  test('a live run with every phase ok exits 0', () => {
    const results = [result('settings', 'ok'), result('users', 'ok')]
    assert.equal(computeExitCode(results, false), 0)
  })

  test('a live run with a not_implemented phase exits 1 (the fix under test)', () => {
    const results = [
      result('settings', 'not_implemented'),
      result('users', 'not_implemented'),
      result('content', 'ok'),
      result('assets', 'not_implemented')
    ]
    assert.equal(computeExitCode(results, false), 1)
  })

  test('a dry run with the identical not_implemented shape is unaffected — exits 0', () => {
    const results = [
      result('settings', 'not_implemented'),
      result('users', 'not_implemented'),
      result('content', 'ok'),
      result('assets', 'not_implemented')
    ]
    assert.equal(computeExitCode(results, true), 0)
  })

  test('a live run with a real error exits 1 regardless of not_implemented', () => {
    const results = [result('settings', 'error')]
    assert.equal(computeExitCode(results, false), 1)
  })

  test('a dry run with a real error still exits 1 — dryRun only exempts not_implemented, never error', () => {
    const results = [result('settings', 'error')]
    assert.equal(computeExitCode(results, true), 1)
  })
})
