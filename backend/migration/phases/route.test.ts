import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createRecorder } from '../recorder.ts'
import { routeOutcome } from './route.ts'

describe('routeOutcome', () => {
  test("a 'created' outcome counts as a would-create", async () => {
    const recorder = createRecorder(false)

    await routeOutcome(recorder, 'group-1', { outcome: 'created' })

    assert.deepEqual(recorder.snapshot(), {
      wouldCreate: 1,
      wouldSkipExisting: 0,
      conflicts: [],
      unmappable: []
    })
  })

  test("a 'created' outcome logs every note verbatim, in order", async () => {
    const recorder = createRecorder(false)
    const logged: string[] = []

    await routeOutcome(
      recorder,
      'group-1',
      {
        outcome: 'created',
        notes: ['dropped 2 permission(s)', 'dropped 1 malformed page rule(s)']
      },
      (message) => logged.push(message)
    )

    assert.deepEqual(logged, ['dropped 2 permission(s)', 'dropped 1 malformed page rule(s)'])
    assert.equal(recorder.snapshot().wouldCreate, 1)
  })

  test("a 'created' outcome with notes but no logger still records the create", async () => {
    const recorder = createRecorder(false)

    await routeOutcome(recorder, 'group-1', { outcome: 'created', notes: ['a note'] })

    assert.equal(recorder.snapshot().wouldCreate, 1)
  })

  test("a 'skipped' outcome counts as a would-skip-existing, not a conflict", async () => {
    const recorder = createRecorder(false)

    await routeOutcome(recorder, 'user-7', { outcome: 'skipped' })

    assert.deepEqual(recorder.snapshot(), {
      wouldCreate: 0,
      wouldSkipExisting: 1,
      conflicts: [],
      unmappable: []
    })
  })

  test("a 'conflicted' outcome records the identifier and its detail", async () => {
    const recorder = createRecorder(false)

    await routeOutcome(recorder, 'page-42', { outcome: 'conflicted', detail: 'write failed' })

    const snapshot = recorder.snapshot()
    assert.equal(snapshot.wouldCreate, 0)
    assert.equal(snapshot.wouldSkipExisting, 0)
    assert.deepEqual(snapshot.conflicts, [{ identifier: 'page-42', detail: 'write failed' }])
  })

  test('never invokes a destination write of its own — the phase already wrote before routing', async () => {
    let writes = 0
    const recorder = {
      create: async (_identifier: string, write?: () => Promise<void>) => {
        if (write) {
          writes++
          await write()
        }
      },
      skipExisting: () => {},
      conflict: () => {},
      unmappable: () => {},
      snapshot: () => ({
        wouldCreate: 0,
        wouldSkipExisting: 0,
        conflicts: [],
        unmappable: []
      })
    }

    await routeOutcome(recorder, 'page-42', { outcome: 'created' })

    assert.equal(writes, 0)
  })
})
