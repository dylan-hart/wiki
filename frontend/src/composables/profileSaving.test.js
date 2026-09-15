import { beforeEach, describe, expect, it } from 'vitest'

import { pendingProfileSaves, profileSaving } from './profileSaving'

/**
 * `pendingProfileSaves`/`profileSaving` is a module singleton (OpenProject #3282's whole point --
 * see the composable's own doc comment), so each test resets it explicitly rather than relying on
 * a fresh import per test file the way a per-component `ref` would get for free.
 */
beforeEach(() => {
  pendingProfileSaves.value = 0
})

describe('profileSaving', () => {
  it('starts at zero', () => {
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('increments on begin() and decrements on end()', () => {
    profileSaving.begin()
    expect(pendingProfileSaves.value).toBe(1)

    profileSaving.end()
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('counts overlapping writes rather than collapsing to a boolean', () => {
    profileSaving.begin()
    profileSaving.begin()
    expect(pendingProfileSaves.value).toBe(2)

    profileSaving.end()
    expect(pendingProfileSaves.value).toBe(1)

    profileSaving.end()
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('never drops below zero on an unbalanced end()', () => {
    profileSaving.end()
    expect(pendingProfileSaves.value).toBe(0)
  })
})
