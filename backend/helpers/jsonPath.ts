import { JSONPath } from 'jsonpath-plus'

/**
 * Extracts one value out of a parsed JSON document by JSONPath expression, for `block-live-data`
 * (OpenProject #868) — an author names the one field of a polled response their block should show.
 *
 * `jsonpath-plus` answers a query with an array either way, so the single value a block wants is the
 * first element of it; a path matching more than one node (`$.readings[*].value`) is not something
 * this block renders, and only its first match is used. `wrap: true` is what makes that array shape
 * unconditional — `wrap: false` unwraps a single scalar match on its own but keeps wrapping the rest,
 * which is a distinction this caller does not want to make twice.
 *
 * @throws {Error} the library's own message, for a path that fails to parse at all (mismatched
 *   brackets, a dangling operator) — distinct from a path that parses but matches nothing, which is
 *   {@link JsonPathNoMatchError} below.
 */
export function extractJsonPathValue(data: unknown, path: string): unknown {
  const results = JSONPath({ path, json: data as any, wrap: true })
  if (!Array.isArray(results) || results.length < 1) {
    throw new JsonPathNoMatchError(path)
  }
  return results[0]
}

/** A JSONPath expression that parsed fine but matched nothing in the document it was run against. */
export class JsonPathNoMatchError extends Error {
  constructor(path: string) {
    super(`JSONPath "${path}" matched nothing in the response.`)
    this.name = 'JsonPathNoMatchError'
  }
}
