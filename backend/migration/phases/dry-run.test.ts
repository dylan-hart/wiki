import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'

import { placeholderRow, writeUnlessDryRun } from './dry-run.ts'

/**
 * The dry-run split had no direct coverage of its own — every assertion about it went through a
 * phase's integration suite, which is a slow and indirect way to state the one property that
 * matters: in dry-run mode the `write` callback is never invoked at all, so a `dryRun: true` run
 * cannot touch the destination even by accident.
 */

describe('writeUnlessDryRun', () => {
  test('a dry run answers the placeholder and never calls write', async () => {
    const write = mock.fn(async () => ({ id: 'real-id' }))
    const result = await writeUnlessDryRun(true, () => ({ id: 'placeholder-id' }), write)
    assert.deepEqual(result, { id: 'placeholder-id' })
    assert.equal(write.mock.calls.length, 0)
  })

  test('a live run calls write once and answers what it returned', async () => {
    const placeholder = mock.fn(() => ({ id: 'placeholder-id' }))
    const write = mock.fn(async () => ({ id: 'real-id' }))
    const result = await writeUnlessDryRun(false, placeholder, write)
    assert.deepEqual(result, { id: 'real-id' })
    assert.equal(write.mock.calls.length, 1)
    assert.equal(placeholder.mock.calls.length, 0)
  })

  test("a live write's rejection reaches the caller rather than being swallowed", async () => {
    await assert.rejects(
      writeUnlessDryRun(
        false,
        () => ({ id: 'placeholder-id' }),
        async () => {
          throw new Error('destination refused')
        }
      ),
      /destination refused/
    )
  })
})

describe('placeholderRow', () => {
  test('is a fresh id each call, and carries nothing else', async () => {
    const a = placeholderRow()
    const b = placeholderRow()
    assert.deepEqual(Object.keys(a), ['id'])
    assert.notEqual(a.id, b.id)
    assert.match(a.id, /^[0-9a-f-]{36}$/)
  })
})
