import { uniq } from 'es-toolkit/array'

/**
 * `bearerAuth` is the only real auth path: the `onRequest` hook in `core/http/authHooks.ts` reads
 * `Authorization: Bearer <token>` and nothing reads an `X-API-Key` header. A scheme the server never
 * checks makes the Swagger UI Authorize dialog produce requests that silently fail to authenticate,
 * so implement a header-style credential in that hook before declaring one here.
 */
export const OPENAPI_SECURITY_SCHEMES = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT'
  }
} as const

export const OPENAPI_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }]

/**
 * `@fastify/swagger`'s `transform`: folds a route's `config.permissions` declaration into its
 * documented description, so declaring a permission is also how it gets documented.
 */
export function swaggerTransform({ schema, url, route }: any): { schema: any; url: string } {
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
      No fixed permission is not the same as public: such a route's answer usually depends on the
      caller, so what it serves is scoped, not unrestricted.
    */
    transformedSchema.description =
      `${currentDescription}\n\n**No fixed permission.** What this returns, and what it acts on, is limited to what the caller is entitled to — their session, their groups' page rules, or their own account. A request that is entitled to nothing gets an empty answer or a refusal rather than an error about permissions.`.trim()
  }

  return { schema: transformedSchema, url }
}
