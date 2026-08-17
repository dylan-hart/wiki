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
