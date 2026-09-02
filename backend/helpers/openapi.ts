import { uniq } from 'es-toolkit/array'

/**
 * OpenAPI security scheme declarations for the Swagger doc served at `/_api`.
 *
 * `bearerAuth` is the only real auth path: the `onRequest` hook in `index.ts` reads
 * `Authorization: Bearer <token>` and verifies it via `WIKI.models.apiKeys.verify()`. Nothing in the
 * codebase reads an `X-API-Key` header, so this used to also declare an `apiKeyAuth` scheme that
 * documented a credential style the server never actually checked — picking it in the Swagger UI
 * Authorize dialog produced requests that silently failed to authenticate. If a genuine need for a
 * header-style credential shows up later (e.g. a webhook consumer that can't set `Authorization`),
 * implement it for real in the `onRequest` hook alongside the bearer branch and add it back here —
 * don't document a scheme that doesn't work.
 */
export const OPENAPI_SECURITY_SCHEMES = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT'
  }
} as const

/** Top-level `security` requirement applied to every operation by default. */
export const OPENAPI_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }]

/**
 * `@fastify/swagger`'s `transform`: folds a route's `config.permissions` declaration into its
 * documented description, so declaring a permission is also how it gets documented (see CLAUDE.md's
 * Backend patterns).
 *
 * A pure `(schema, route) => schema` with no Fastify instance behind it, kept here beside the
 * security-scheme constants rather than inline in `core/http/openapi.ts`'s registration so it can be
 * exercised directly (CORE-F12).
 */
export function swaggerTransform({ schema, url, route }: any): { schema: any; url: string } {
  // Add permissions to the route schema description
  const permissions = route?.config?.permissions ?? []
  const transformedSchema = { ...schema }
  const currentDescription = transformedSchema.description || ''

  if (permissions?.length > 0) {
    const nestedPermissions: string[] = []
    for (const perm of permissions) {
      if (Array.isArray(perm)) {
        nestedPermissions.push(`\`${perm.join(' + ')}\``)
      } else {
        nestedPermissions.push(`\`${perm}\``)
      }
    }
    nestedPermissions.push('`manage:system`')
    transformedSchema.description =
      `${currentDescription}\n\n**Required Permissions:** ${uniq(nestedPermissions).join(' or ')}`.trim()
    transformedSchema['x-permissions'] = permissions
  } else if (route?.config?.publicAccess) {
    transformedSchema.description =
      `${currentDescription}\n\n**This API is public.** No special permissions required.`.trim()
  } else {
    /*
      No fixed permission is not the same as public, and saying so was wrong for most of these.
      A route without one is usually a route whose answer depends on the caller: the page rules of
      their groups, their own account, or the queue they happen to be a reviewer for. What it
      serves is scoped, not unrestricted.
    */
    transformedSchema.description =
      `${currentDescription}\n\n**No fixed permission.** What this returns, and what it acts on, is limited to what the caller is entitled to — their session, their groups' page rules, or their own account. A request that is entitled to nothing gets an empty answer or a refusal rather than an error about permissions.`.trim()
  }

  return { schema: transformedSchema, url }
}
