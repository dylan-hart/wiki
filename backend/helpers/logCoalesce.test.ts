import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  coalesce,
  DEFAULT_COALESCE_THRESHOLD,
  resetCoalesce,
  type CoalesceSummary
} from './logCoalesce.ts'

/**
 * `helpers/logCoalesce.ts` is a pure helper — no `WIKI`, no database, no logger — so this suite runs
 * as plain unit tests against the module's own state, with `node:test`'s mock timers standing in for
 * the window rather than a real `setTimeout` a test would have to sleep through.
 *
 * The module-level pending map is shared across cases the way `helpers/rateLimit.ts`'s
 * `activeBanMemo` is, so every case clears it afterwards.
 */
describe('coalesce', () => {
  afterEach(() => {
    resetCoalesce()
    mock.timers.reset()
  })

  /** The three-argument call every case below makes, with a recorder for the summary. */
  function makeEmitter() {
    const summaries: CoalesceSummary[] = []
    return {
      summaries,
      emit: (summary: CoalesceSummary) => {
        summaries.push(summary)
      }
    }
  }

  test('lets the first three events through and folds the rest', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    const answers = Array.from({ length: 20 }, () => coalesce('k', 300_000, emit))

    assert.equal(
      answers.filter((through) => through).length,
      3,
      'exactly three of twenty attempts should be logged individually'
    )
    assert.deepEqual(answers.slice(0, 3), [true, true, true])
    assert.ok(
      answers.slice(3).every((through) => through === false),
      'everything after the threshold folds'
    )
    assert.equal(summaries.length, 0, 'nothing is summarised until the window closes')
  })

  test('emits one summary carrying the window total when the window closes', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    for (let i = 0; i < 20; i += 1) {
      coalesce('k', 300_000, emit)
    }
    mock.timers.tick(300_000)

    assert.equal(summaries.length, 1)
    assert.deepEqual(summaries[0], {
      key: 'k',
      // -> The whole window, the three individually-logged attempts included: "twenty attempts from
      //    this address" is the number an operator acts on.
      total: 20,
      suppressed: 20 - DEFAULT_COALESCE_THRESHOLD,
      windowMs: 300_000
    })
  })

  test('says nothing at all when the window never passes the threshold', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    assert.equal(coalesce('k', 1000, emit), true)
    assert.equal(coalesce('k', 1000, emit), true)
    assert.equal(coalesce('k', 1000, emit), true)
    mock.timers.tick(1000)

    assert.equal(
      summaries.length,
      0,
      'three lines already said everything; a "3 times" summary would only repeat them'
    )
  })

  test('opens a fresh window after the previous one closed', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    for (let i = 0; i < 5; i += 1) {
      coalesce('k', 1000, emit)
    }
    mock.timers.tick(1000)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].total, 5)

    // -> A new burst after the window closed starts over: three through, then folding again.
    assert.deepEqual(
      Array.from({ length: 4 }, () => coalesce('k', 1000, emit)),
      [true, true, true, false]
    )
    mock.timers.tick(1000)
    assert.equal(summaries.length, 2)
    assert.equal(summaries[1].total, 4)
  })

  test('does not extend the window when events keep arriving', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    for (let i = 0; i < 5; i += 1) {
      coalesce('k', 1000, emit)
      mock.timers.tick(200)
    }
    // -> 5 x 200ms = the full window; a sliding window would still be open here.
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].total, 5)
  })

  test('keeps keys independent', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    for (let i = 0; i < 10; i += 1) {
      coalesce('a', 1000, emit)
    }
    // -> `b`'s own first three still go through, untouched by `a` having exhausted its threshold.
    assert.deepEqual(
      Array.from({ length: 4 }, () => coalesce('b', 1000, emit)),
      [true, true, true, false]
    )

    mock.timers.tick(1000)
    assert.equal(summaries.length, 2)
    assert.deepEqual(summaries.map((s) => [s.key, s.total]).sort(), [
      ['a', 10],
      ['b', 4]
    ])
  })

  test('honours a caller-supplied threshold', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    assert.deepEqual(
      Array.from({ length: 4 }, () => coalesce('k', 1000, emit, { threshold: 1 })),
      [true, false, false, false]
    )
    mock.timers.tick(1000)
    assert.equal(summaries[0].suppressed, 3)
  })

  test('summarises with the most recent call’s emitter, not the first', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const first = makeEmitter()
    const latest = makeEmitter()

    coalesce('k', 1000, first.emit)
    for (let i = 0; i < 5; i += 1) {
      coalesce('k', 1000, latest.emit)
    }
    mock.timers.tick(1000)

    assert.equal(first.summaries.length, 0)
    assert.equal(
      latest.summaries.length,
      1,
      'the summary reports the latest context, not a stale one'
    )
  })

  test('turns coalescing off for a non-positive or non-finite window', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    for (const windowMs of [0, -1, Number.NaN]) {
      assert.deepEqual(
        Array.from({ length: 5 }, () => coalesce('k', windowMs, emit)),
        [true, true, true, true, true],
        `every event should log itself for a window of ${windowMs}`
      )
    }
    mock.timers.tick(600_000)
    assert.equal(summaries.length, 0, 'nothing was ever scheduled')
  })

  test('survives an emitter that throws, and starts the next window clean', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    for (let i = 0; i < 5; i += 1) {
      coalesce('k', 1000, () => {
        throw new Error('the log itself is what failed')
      })
    }
    // -> A throw here would be an `uncaughtException` inside a timer callback if it escaped.
    assert.doesNotThrow(() => mock.timers.tick(1000))

    assert.deepEqual(
      Array.from({ length: 4 }, () => coalesce('k', 1000, emit)),
      [true, true, true, false],
      'the failed window was cleared, so the next burst is not swallowed'
    )
    mock.timers.tick(1000)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].total, 4)
  })

  test('resetCoalesce drops one key without emitting, leaving the others pending', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { emit, summaries } = makeEmitter()

    for (let i = 0; i < 5; i += 1) {
      coalesce('a', 1000, emit)
      coalesce('b', 1000, emit)
    }
    resetCoalesce('a')
    mock.timers.tick(1000)

    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].key, 'b')
  })
})
