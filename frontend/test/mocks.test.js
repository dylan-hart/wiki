import { describe, expect, it } from 'vitest'

import { stubApi } from './mocks.js'

/**
 * `stubApi` replaces the 24 hand-rolled `API_CLIENT.get.mockImplementation((url) => { if (url ===
 * …) })` switches the survey counted (TEST-F11), plus the five files that had already reinvented the
 * URL-to-payload lookup table (`pages/AdminApi.test.js`, `pages/ProfileApi.test.js`).
 *
 * `API_CLIENT` itself is rebuilt before every test by `test/setup.js`, so each of these configures
 * the current instance and asserts through it.
 */
describe('stubApi', () => {
  it("resolves an exact string key through ky's .json() shape", async () => {
    stubApi({ sites: [{ id: 'site-1' }] })
    expect(await API_CLIENT.get('sites').json()).toEqual([{ id: 'site-1' }])
  })

  it('resolves undefined for an unmatched url rather than throwing', async () => {
    stubApi({ sites: [] })
    expect(await API_CLIENT.get('users/whoami').json()).toBeUndefined()
  })

  it('matches a RegExp key, as a Map, for the prefix/suffix lookups an object key cannot express', async () => {
    stubApi(new Map([[/^sites\/[^/]+\/pages$/, [{ id: 'p1' }]]]))
    expect(await API_CLIENT.get('sites/site-1/pages').json()).toEqual([{ id: 'p1' }])
    expect(await API_CLIENT.get('sites/site-1/pages/deleted').json()).toBeUndefined()
  })

  it('prefers an exact string key over a RegExp that also matches', async () => {
    stubApi(
      new Map([
        [/^sites\//, 'regexp'],
        ['sites/site-1', 'exact']
      ])
    )
    expect(await API_CLIENT.get('sites/site-1').json()).toBe('exact')
    expect(await API_CLIENT.get('sites/site-2').json()).toBe('regexp')
  })

  it('calls a function value per request, with the url', async () => {
    stubApi({ 'pages/deleted': (url) => ({ url }) })
    expect(await API_CLIENT.get('pages/deleted').json()).toEqual({ url: 'pages/deleted' })
  })

  it('lets a function value return a different payload per call, for cursor pagination', async () => {
    let page = 0
    stubApi({ 'pages/deleted': () => ({ page: page++ }) })
    expect(await API_CLIENT.get('pages/deleted').json()).toEqual({ page: 0 })
    expect(await API_CLIENT.get('pages/deleted').json()).toEqual({ page: 1 })
  })

  it('falls back to `fallback` for an unmatched url', async () => {
    stubApi({ sites: [] }, { fallback: { ok: true } })
    expect(await API_CLIENT.get('anything').json()).toEqual({ ok: true })
  })

  it('stubs the named method, leaving the others alone', async () => {
    stubApi({ 'mail/test': { ok: true } }, { method: 'post' })
    expect(await API_CLIENT.post('mail/test').json()).toEqual({ ok: true })
    expect(await API_CLIENT.get('mail/test').json()).toBeUndefined()
  })

  it('records every url it was asked for, in order', async () => {
    const { calls } = stubApi({ sites: [], 'users/whoami': {} })
    await API_CLIENT.get('users/whoami').json()
    await API_CLIENT.get('sites').json()
    expect(calls).toEqual(['users/whoami', 'sites'])
  })

  it('resolves .blob() the same way .json() does', async () => {
    stubApi({ 'pages/1/export': 'BLOB' })
    expect(await API_CLIENT.get('pages/1/export').blob()).toBe('BLOB')
  })
})
