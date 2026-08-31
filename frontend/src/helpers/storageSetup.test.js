import { describe, expect, it } from 'vitest'

import { nextSetupStepName } from './storageSetup'

describe('nextSetupStepName', () => {
  it('sends the fixed "start" step for a target that has never begun setup', () => {
    expect(nextSetupStepName('notconfigured')).toBe('start')
  })

  it('sends "start" for a target with no setup state at all yet', () => {
    expect(nextSetupStepName(null)).toBe('start')
    expect(nextSetupStepName(undefined)).toBe('start')
  })

  it('echoes back whatever step name the module last reported, to advance a step already in progress', () => {
    expect(nextSetupStepName('awaiting-oauth-callback')).toBe('awaiting-oauth-callback')
  })

  it('returns null for a target that has nothing left to advance', () => {
    expect(nextSetupStepName('configured')).toBeNull()
  })
})
