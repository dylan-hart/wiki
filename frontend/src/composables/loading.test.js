import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { content, isActive, loading } from './loading'

/**
 * OpenProject #3385: `show()` used to take no parameters at all, so every call site passing
 * `{ message }` (the six auth overlays) had it silently discarded -- a slow login/register/TFA
 * wait rendered a wordless spinner. These tests cover the composable's own mechanics -- the
 * message/caption reactive state and the delay/timer behavior around it -- independent of any one
 * component that calls it.
 */

describe('loading', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // -> Module-level singleton, shared across the whole file: undo whatever a test left showing
    //    or pending so it cannot bleed into the next test.
    loading.hide()
    content.message = ''
    content.caption = ''
    vi.useRealTimers()
  })

  it('does not activate before the delay elapses', () => {
    loading.show({ message: 'Signing in...' })

    expect(isActive.value).toBe(false)
    vi.advanceTimersByTime(499)
    expect(isActive.value).toBe(false)
  })

  it('sets content and activates after the default 500ms delay', () => {
    loading.show({ message: 'Signing in...', caption: 'One moment' })

    vi.advanceTimersByTime(500)

    expect(isActive.value).toBe(true)
    expect(content.message).toBe('Signing in...')
    expect(content.caption).toBe('One moment')
  })

  it('defaults message and caption to empty strings when omitted', () => {
    loading.show()

    vi.advanceTimersByTime(500)

    expect(content.message).toBe('')
    expect(content.caption).toBe('')
  })

  it('updates the message on a repeat call while a show is still pending, without re-arming the timer', () => {
    loading.show({ message: 'Signing in...' })
    vi.advanceTimersByTime(200)
    loading.show({ message: 'Still signing in...' })

    // -> Had the repeat call re-armed the timer, this would still be false at t=500 (200 + 500).
    vi.advanceTimersByTime(300)
    expect(isActive.value).toBe(true)
    expect(content.message).toBe('Still signing in...')
  })

  it('updates the message on a repeat call once already active, without hiding and re-showing', () => {
    loading.show({ message: 'Signing in...' })
    vi.advanceTimersByTime(500)
    expect(isActive.value).toBe(true)

    loading.show({ message: 'Login Successful! Redirecting...' })

    expect(isActive.value).toBe(true)
    expect(content.message).toBe('Login Successful! Redirecting...')
  })

  it('shows immediately when delay is 0, cancelling a pending timer', () => {
    loading.show({ message: 'Signing in...' })
    vi.advanceTimersByTime(200)

    loading.show({ message: 'Done!', delay: 0 })

    expect(isActive.value).toBe(true)
    expect(content.message).toBe('Done!')
  })

  it('hide() cancels a pending show and deactivates an active one, but leaves content in place', () => {
    loading.show({ message: 'Signing in...' })
    vi.advanceTimersByTime(500)
    expect(isActive.value).toBe(true)

    loading.hide()

    expect(isActive.value).toBe(false)
    // -> Not cleared: the overlay fades out over 200ms, and blanking the text as the fade starts
    //    would empty the box before it's gone.
    expect(content.message).toBe('Signing in...')
  })

  it('hide() cancels a pending (not-yet-active) show', () => {
    loading.show({ message: 'Signing in...' })
    vi.advanceTimersByTime(200)

    loading.hide()
    vi.advanceTimersByTime(300)

    expect(isActive.value).toBe(false)
  })
})
