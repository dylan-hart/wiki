/**
 * Hand-registered instead of pulling in the CJS `ajv-formats` package, which needs a `.default`
 * interop read and an `as any` cast against `@fastify/ajv-compiler`'s plugin-options type. Only the
 * formats the schemas use are here.
 *
 * `uuid`, `hostname` and `email` are `ajv-formats`' `fullFormats` regexes verbatim. `date-time` is
 * its `fastFormats` regex instead: callers need a well-shaped RFC 3339 timestamp, not calendar
 * validity.
 *
 * Shared by the real server and every test harness that builds an ajv instance, so none can
 * validate a schema `format:` differently from the others.
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
