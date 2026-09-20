import { afterEach, describe, expect, it } from 'vitest'

import { isolateOnLeftClick, setIsolateOnLeftClick } from './navIsolatePreference'

afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // -> Nothing to clean up if storage was never reachable.
  }
})

describe('navIsolatePreference', () => {
  it('defaults to OFF when nothing has been stored yet', () => {
    expect(isolateOnLeftClick()).toBe(false)
  })

  it('round-trips ON through setIsolateOnLeftClick', () => {
    setIsolateOnLeftClick(true)
    expect(isolateOnLeftClick()).toBe(true)
  })

  it('round-trips back to OFF', () => {
    setIsolateOnLeftClick(true)
    setIsolateOnLeftClick(false)
    expect(isolateOnLeftClick()).toBe(false)
  })

  it('treats unreadable storage the same as absent, rather than throwing', () => {
    const original = globalThis.localStorage
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('storage denied')
        }
      })
      expect(() => isolateOnLeftClick()).not.toThrow()
      expect(isolateOnLeftClick()).toBe(false)
      expect(() => setIsolateOnLeftClick(true)).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: original
      })
    }
  })
})
