import { JSONPath } from 'jsonpath-plus'

/**
 * Extracts one value out of a parsed JSON document, for `block-live-data`: an author names the one
 * field of a polled response their block should show.
 *
 * `wrap: true` makes the result unconditionally an array — `wrap: false` unwraps a single scalar
 * match but keeps wrapping the rest — so a path matching several nodes (`$.readings[*].value`)
 * yields its first match rather than a shape this caller has to branch on.
 *
 * `eval: false` is explicit rather than left to the library default: `jsonpath-plus` has an
 * RCE-class history in its script-evaluation feature (GHSA-pppg, GHSA-hw8r), and its current
 * `"safe"` default evaluator is documented as browser-sandbox-only, a no-op in Node. `false` is the
 * only mode that actually refuses a `[?(...)]` filter before its expression body runs.
 *
 * @throws {Error} the library's own message, for a path that fails to parse or uses `[?(...)]`
 *   syntax — distinct from a path that parses but matches nothing, which is
 *   {@link JsonPathNoMatchError}.
 */
export function extractJsonPathValue(data: unknown, path: string): unknown {
  const results = JSONPath({ path, json: data as any, wrap: true, eval: false })
  if (!Array.isArray(results) || results.length < 1) {
    throw new JsonPathNoMatchError(path)
  }
  return results[0]
}

export class JsonPathNoMatchError extends Error {
  constructor(path: string) {
    super(`JSONPath "${path}" matched nothing in the response.`)
    this.name = 'JsonPathNoMatchError'
  }
}
