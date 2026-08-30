import { afterEach, describe, expect, it, vi } from 'vitest'

import { isApplePlatform } from './platform'

describe('isApplePlatform (OpenProject #2050)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers navigator.userAgentData.platform when present', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: 'Win32' })

    expect(isApplePlatform()).toBe(true)
  })

  it('falls back to the deprecated navigator.platform when userAgentData is absent', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })

    expect(isApplePlatform()).toBe(true)
  })

  it('recognizes iPhone/iPad/iPod platform strings', () => {
    vi.stubGlobal('navigator', { platform: 'iPhone' })
    expect(isApplePlatform()).toBe(true)

    vi.stubGlobal('navigator', { platform: 'iPad' })
    expect(isApplePlatform()).toBe(true)
  })

  it('returns false for non-Apple platforms', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' }, platform: 'Win32' })

    expect(isApplePlatform()).toBe(false)
  })

  it('returns false when neither source is available', () => {
    vi.stubGlobal('navigator', {})

    expect(isApplePlatform()).toBe(false)
  })
})
