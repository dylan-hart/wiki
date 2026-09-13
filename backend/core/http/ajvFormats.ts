/**
 * The 5 ajv string `format:` validators this instance's schemas actually use, hand-registered
 * instead of pulling in the `ajv-formats` package (OpenProject #3081/#3115).
 *
 * `ajv-formats` is CJS and ships ~20 formats; schema `format:` usage across `api/schemas/` only
 * ever exercises `uuid`, `date-time`, `email` and `hostname` — plus this codebase's own `hexcolor`,
 * which was already hand-registered here before the other 4 joined it, proving the pattern. Reusing
 * the package for 4 formats meant a `.default` CJS-interop read and an `as any` cast bridging
 * `@fastify/ajv-compiler`'s `unknown` plugin-options type against `ajv-formats`' own narrower one;
 * neither is needed once the validators are plain functions.
 *
 * `uuid`, `hostname` and `email` below are `ajv-formats`' own `fullFormats` regex definitions
 * (`ajv-formats/dist/formats.js`) verbatim — the mode every call site that used to register the
 * plugin ran in (`{}` options, which default to `fullFormats` over `fastFormats`). `date-time` uses
 * `fullFormats`' simpler `fastFormats` sibling instead: `fullFormats`' own `date-time` is a semantic
 * function (real day-in-month/leap-year/leap-second checks), while every place this codebase
 * validates a `date-time` on the way in (`api/auditLog.ts`'s `from`/`to` querystring) only needs a
 * well-shaped RFC 3339 timestamp, not calendar validity — a plain regex keeps this format the same
 * shape as the other 4 rather than pulling `Temporal` into ajv setup for it alone.
 *
 * Shared by every place that builds a fastify/ajv instance carrying this instance's schemas:
 * `createHttpApp()` (the real server), `test/fastify.ts#buildTestApp` (the route-test harness) and
 * `helpers/apiKeySite.coverage.test.ts` (its own bare-fastify route scan) — one definition, so the
 * three can never drift into validating a schema `format:` differently from each other.
 */
export function registerAjvFormats(ajv: any): void {
  // -> Accepts the shorthand, alpha and full forms a color picker can produce:
  //    #RGB, #RGBA, #RRGGBB and #RRGGBBAA
  ajv.addFormat('hexcolor', (data: unknown) => {
    return (
      typeof data === 'string' && /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(data)
    )
  })
  ajv.addFormat('uuid', (data: unknown) => {
    return (
      typeof data === 'string' &&
      /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data)
    )
  })
  ajv.addFormat('hostname', (data: unknown) => {
    return (
      typeof data === 'string' &&
      /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i.test(
        data
      )
    )
  })
  ajv.addFormat('email', (data: unknown) => {
    return (
      typeof data === 'string' &&
      /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(
        data
      )
    )
  })
  ajv.addFormat('date-time', (data: unknown) => {
    return (
      typeof data === 'string' &&
      /^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i.test(
        data
      )
    )
  })
}
