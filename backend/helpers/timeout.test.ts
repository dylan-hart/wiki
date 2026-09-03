import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout } from './timeout.ts'
import { CustomError } from './common.ts'

/** Resolves after `ms`, so a test can hand `withTimeout` work the timer is guaranteed to beat. */
function never<T>(ms = 10_000): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(undefined as T), ms)
    timer.unref?.()
  })
}

describe('withTimeout', () => {
  test('resolves with the work’s own value when it settles first', async () => {
    assert.equal(await withTimeout(Promise.resolve('done'), 5000, () => new Error('nope')), 'done')
  })

  test('rejects with the work’s own rejection, not the expiry error', async () => {
    await assert.rejects(
      withTimeout(Promise.reject(new Error('the work failed')), 5000, () => new Error('nope')),
      /the work failed/
    )
  })

  test('rejects with exactly the error `onExpire` returns once the timer wins', async () => {
    await assert.rejects(
      withTimeout(
        never(),
        5,
        () => new CustomError('renderTimeout', 'Rendering did not finish within 30 seconds.', 504)
      ),
      (err: any) => {
        assert.ok(err instanceof CustomError)
        assert.equal(err.name, 'renderTimeout')
        assert.equal(err.message, 'Rendering did not finish within 30 seconds.')
        assert.equal(err.statusCode, 504)
        return true
      }
    )
  })

  test('never builds the expiry error when the work wins', async () => {
    let expiries = 0
    await withTimeout(Promise.resolve('done'), 5, () => {
      expiries++
      return new Error('expired')
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(expiries, 0)
  })

  test('clears the timer when the work rejects, too', async () => {
    let expiries = 0
    await assert.rejects(
      withTimeout(Promise.reject(new Error('boom')), 5, () => {
        expiries++
        return new Error('expired')
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(expiries, 0)
  })

  test('unrefs the timer when asked, so it cannot hold the process open', async () => {
    const realSetTimeout = globalThis.setTimeout
    let unrefs = 0
    ;(globalThis as any).setTimeout = (fn: any, ms: number) => {
      const handle: any = realSetTimeout(fn, ms)
      const original = handle.unref?.bind(handle)
      handle.unref = () => {
        unrefs++
        return original ? original() : handle
      }
      return handle
    }
    try {
      await withTimeout(Promise.resolve('done'), 5000, () => new Error('nope'), { unref: true })
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    assert.equal(unrefs, 1)
  })

  test('leaves the timer referenced by default', async () => {
    const realSetTimeout = globalThis.setTimeout
    let unrefs = 0
    ;(globalThis as any).setTimeout = (fn: any, ms: number) => {
      const handle: any = realSetTimeout(fn, ms)
      const original = handle.unref?.bind(handle)
      handle.unref = () => {
        unrefs++
        return original ? original() : handle
      }
      return handle
    }
    try {
      await withTimeout(Promise.resolve('done'), 5000, () => new Error('nope'))
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    assert.equal(unrefs, 0)
  })
})
