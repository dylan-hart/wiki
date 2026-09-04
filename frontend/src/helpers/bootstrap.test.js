import { describe, expect, it } from 'vitest'

import { bootstrapFailureRedirectFor } from './bootstrap.js'

describe('bootstrapFailureRedirectFor()', () => {
  it('sends a 404 (no site at this hostname) on a page path to the unknown-site screen', () => {
    const err = { message: 'Not Found', response: { status: 404 } }

    expect(bootstrapFailureRedirectFor('/some/page', err)).toBe('/_error/unknownsite')
  })

  it('sends a 403 (site exists but isEnabled is false) on a page path to the disabled-site screen', () => {
    const err = { message: 'Forbidden', response: { status: 403 } }

    expect(bootstrapFailureRedirectFor('/some/page', err)).toBe('/_error/disabled')
  })

  it('has nothing more specific to say about any other status, so it leaves the navigation alone', () => {
    expect(bootstrapFailureRedirectFor('/some/page', { response: { status: 500 } })).toBeNull()
    expect(bootstrapFailureRedirectFor('/some/page', { response: { status: 401 } })).toBeNull()
  })

  it('does not throw, and redirects nowhere, on a network failure with no response at all', () => {
    expect(bootstrapFailureRedirectFor('/some/page', new Error('network down'))).toBeNull()
    expect(bootstrapFailureRedirectFor('/some/page', undefined)).toBeNull()
  })

  it('leaves every app-shell route (leading /_) alone, root site status notwithstanding', () => {
    const err = { response: { status: 404 } }

    expect(bootstrapFailureRedirectFor('/_admin/sites', err)).toBeNull()
    expect(bootstrapFailureRedirectFor('/_error/unknownsite', err)).toBeNull()
    expect(bootstrapFailureRedirectFor('/_inbox/watching', err)).toBeNull()
  })

  it("leaves /login alone so a disabled site's administrator can still sign in to fix it", () => {
    expect(bootstrapFailureRedirectFor('/login', { response: { status: 403 } })).toBeNull()
    expect(bootstrapFailureRedirectFor('/login', { response: { status: 404 } })).toBeNull()
  })
})
