import { vi } from 'vitest'

/**
 * Shaped after `ky`'s own chainable surface (`API_CLIENT.get(url, opts).json()`) so store code
 * needs no test-only branch to call it.
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
 * Keys are exact URLs; a route needing a `RegExp` goes in a `Map`, since an object cannot key by
 * one. An exact key wins over a `RegExp` that also matches, so a table can carry both; a function
 * value is called per request with the URL, for a route that must answer differently each time.
 * An unmatched URL stays a quiet `undefined` (or `fallback`) rather than throwing.
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
