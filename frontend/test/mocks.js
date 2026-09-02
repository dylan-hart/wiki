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

/**
 * A URL-to-payload routing table for the current `API_CLIENT` stub — what 24 files hand-rolled as
 * `API_CLIENT.get.mockImplementation((url) => { if (url === 'sites') return … })`, and what five
 * more had already reinvented as a lookup object (`pages/AdminApi.test.js`, `pages/ProfileApi.test.js`).
 *
 *   stubApi({ sites: [{ id: 'site-1' }], 'users/whoami': USER })
 *
 * A plain object keys by exact URL, which covers almost every call site. Pass a `Map` when a route
 * needs a `RegExp` (a prefix or a path with an id in the middle) — an exact string key always wins
 * over a `RegExp` that also matches, so a table can carry both. A value that is a function is called
 * per request with the URL, which is how a paginated route returns a different page each time
 * (`pages/AdminPagesDeleted.test.js`'s cursor walk).
 *
 * `method` picks which HTTP method to stub (`get` by default); `fallback` is the payload for a URL
 * no route matches, which is otherwise `undefined` — the same thing `createApiClientStub()` resolves
 * by default, so an unstubbed route stays a quiet `undefined` rather than a throw.
 *
 * Returns `{ calls }`, the URLs seen in order — `App.test.js` and `AdminPagesDeleted.test.js` had
 * each built their own recorder for exactly that assertion.
 */
export function stubApi(routes, { method = 'get', fallback } = {}) {
  const entries = routes instanceof Map ? [...routes.entries()] : Object.entries(routes ?? {})
  const exact = new Map(entries.filter(([key]) => typeof key === 'string'))
  const patterns = entries.filter(([key]) => key instanceof RegExp)
  const calls = []

  globalThis.API_CLIENT[method].mockImplementation((url) => {
    calls.push(url)
    const match = exact.has(url)
      ? exact.get(url)
      : (patterns.find(([pattern]) => pattern.test(url))?.[1] ?? fallback)
    const payload = typeof match === 'function' ? match(url) : match
    return {
      json: () => Promise.resolve(payload),
      blob: () => Promise.resolve(payload)
    }
  })

  return { calls }
}
