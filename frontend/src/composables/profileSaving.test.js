import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isSavingVisible, pendingProfileSaves, profileSaving } from './profileSaving'

/** A module singleton: nothing hands a test a fresh one, so each resets it explicitly. */
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

describe('isSavingVisible', () => {
  beforeEach(() => {
    pendingProfileSaves.value = 0
    isSavingVisible.value = false
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts false', () => {
    expect(isSavingVisible.value).toBe(false)
  })

  it('stays false through a save that settles within 500ms', async () => {
    profileSaving.begin()
    await vi.advanceTimersByTimeAsync(300)
    expect(isSavingVisible.value).toBe(false)

    profileSaving.end()
    await vi.advanceTimersByTimeAsync(300)
    expect(isSavingVisible.value).toBe(false)
  })

  it('flips true only once the count has stayed above zero for 500ms', async () => {
    profileSaving.begin()
    await vi.advanceTimersByTimeAsync(499)
    expect(isSavingVisible.value).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(isSavingVisible.value).toBe(true)
  })

  it('drops back to false instantly once the count returns to zero, once visible', async () => {
    profileSaving.begin()
    await vi.advanceTimersByTimeAsync(500)
    expect(isSavingVisible.value).toBe(true)

    profileSaving.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(isSavingVisible.value).toBe(false)
  })

  it('does not restart the timer for an overlapping second begin()', async () => {
    profileSaving.begin()
    await vi.advanceTimersByTimeAsync(300)
    profileSaving.begin()
    await vi.advanceTimersByTimeAsync(200)
    // -> 500ms after the FIRST begin(), not 500ms after the second
    expect(isSavingVisible.value).toBe(true)
  })

  it('judges a fresh begin() after a full end() from its own edge, with its own full delay', async () => {
    profileSaving.begin()
    await vi.advanceTimersByTimeAsync(300)
    profileSaving.end()
    expect(isSavingVisible.value).toBe(false)

    profileSaving.begin()
    await vi.advanceTimersByTimeAsync(300)
    expect(isSavingVisible.value).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(isSavingVisible.value).toBe(true)
  })
})
