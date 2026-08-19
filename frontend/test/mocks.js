import { vi } from 'vitest'

/**
 * A stand-in for the `API_CLIENT` global (`src/boot/api.js`), which is the real `ky` HTTP client
 * everywhere outside a test — not something a unit test should ever let a request through to.
 *
 * Shaped after `ky`'s own chainable surface (`API_CLIENT.get(url, opts).json()`) so store code needs
 * no test-only branch to call it. Every HTTP method is a fresh `vi.fn()` per instance, each returning
 * a response whose `.json()` / `.blob()` resolve to `undefined` by default — a test that cares about
 * the payload overrides the method directly:
 *
 *   API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ id: '1' }) })
 *
 * or, for a rejection (the `try { API_CLIENT... } catch` shape every store call is wrapped in):
 *
 *   API_CLIENT.post.mockImplementationOnce(() => { throw new Error('network') })
 */
export function createApiClientStub() {
  const stubResponse = () => ({
    json: vi.fn().mockResolvedValue(undefined),
    blob: vi.fn().mockResolvedValue(undefined)
  })
  const client = {}
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    client[method] = vi.fn(stubResponse)
  }
  return client
}
