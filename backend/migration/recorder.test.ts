import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createRecorder } from './recorder.ts'

describe('createRecorder', () => {
  test('dry run: create() never invokes the write callback, but still counts', async () => {
    const recorder = createRecorder(true)
    let writeCalls = 0
    await recorder.create('user-1', async () => {
      writeCalls++
    })
    assert.equal(writeCalls, 0)
    assert.equal(recorder.snapshot().wouldCreate, 1)
  })

  test('live run: create() awaits the write callback before counting', async () => {
    const recorder = createRecorder(false)
    let writeCalls = 0
    await recorder.create('user-1', async () => {
      writeCalls++
    })
    assert.equal(writeCalls, 1)
    assert.equal(recorder.snapshot().wouldCreate, 1)
  })

  test('live run: a throwing write is not counted, and the error propagates', async () => {
    const recorder = createRecorder(false)
    await assert.rejects(
      () =>
        recorder.create('user-1', async () => {
          throw new Error('insert failed')
        }),
      /insert failed/
    )
    assert.equal(recorder.snapshot().wouldCreate, 0)
  })

  test('create() with no write callback just counts, in either mode', async () => {
    for (const dryRun of [true, false]) {
      const recorder = createRecorder(dryRun)
      await recorder.create('user-1')
      assert.equal(recorder.snapshot().wouldCreate, 1)
    }
  })

  test('skipExisting, conflict and unmappable accumulate independently of create', async () => {
    const recorder = createRecorder(true)
    await recorder.create('a')
    recorder.skipExisting('b')
    recorder.conflict('c', 'duplicate email')
    recorder.unmappable('d', 'unsupported-auth-provider', 'ldap has no 3.0 module')

    const snapshot = recorder.snapshot()
    assert.equal(snapshot.wouldCreate, 1)
    assert.equal(snapshot.wouldSkipExisting, 1)
    assert.deepEqual(snapshot.conflicts, [{ identifier: 'c', detail: 'duplicate email' }])
    assert.deepEqual(snapshot.unmappable, [
      { identifier: 'd', reason: 'unsupported-auth-provider', detail: 'ldap has no 3.0 module' }
    ])
  })

  test('snapshot() returns copies — mutating a returned array does not affect the recorder', async () => {
    const recorder = createRecorder(true)
    recorder.conflict('a', 'x')
    const first = recorder.snapshot()
    first.conflicts.push({ identifier: 'b', detail: 'y' })
    const second = recorder.snapshot()
    assert.equal(second.conflicts.length, 1)
  })
})
