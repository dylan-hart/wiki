import { afterEach, describe, expect, it, vi } from 'vitest'

import { initializeApi } from './api'

/**
 * Coverage for Task 1758: `throwHttpErrors: true` on the shared `ky` client, replacing the old
 * `(statusNumber) => statusNumber > 400` override that resolved a 400 instead of rejecting.
 *
 * These drive the real `ky` client -- not `test/mocks.js`'s `API_CLIENT` stub, which every other
 * suite uses and which never touches `boot/api.js` at all -- against a stubbed global `fetch`, so
 * `ky`'s own `HTTPError` construction (and its `data` population, see
 * `node_modules/ky/distribution/errors/HTTPError.js`) is exercised for real.
 */
describe('initializeApi', () => {
  afterEach(() => {
    delete window.API_CLIENT
    vi.unstubAllGlobals()
  })

  it('rejects a 400 response with a ky HTTPError carrying the server envelope on data.message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: 'BadRequestError',
            statusCode: 400,
            message: 'Invalid username or password'
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )

    initializeApi()

    await expect(window.API_CLIENT.get('sites/site-1/auth/login').json()).rejects.toMatchObject({
      name: 'HTTPError',
      data: { message: 'Invalid username or password' }
    })
  })

  it('still resolves a 2xx response normally', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )

    initializeApi()

    await expect(window.API_CLIENT.get('sites/site-1').json()).resolves.toEqual({ ok: true })
  })

  it('rejects a 500 response with a ky HTTPError as well, same as before the flip', async () => {
    // -> A factory, not `mockResolvedValue` with a single instance: ky retries a 500 by default
    //    (its default `retry.statusCodes` includes 500), and a `Response` body can only be read
    //    once, so a shared instance would leave the second read's `data` `undefined`.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              error: 'InternalError',
              statusCode: 500,
              message: 'boom'
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          )
        )
      )
    )

    initializeApi()

    await expect(window.API_CLIENT.get('sites/site-1').json()).rejects.toMatchObject({
      name: 'HTTPError',
      data: { message: 'boom' }
    })
  })
})
