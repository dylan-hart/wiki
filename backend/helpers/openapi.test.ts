import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { OPENAPI_SECURITY, OPENAPI_SECURITY_SCHEMES } from './openapi.ts'

/**
 * Regression test for the dead `X-API-Key` / `apiKeyAuth` security scheme.
 *
 * The Swagger doc used to declare two auth options (`apiKeyAuth` reading an `X-API-Key` header, and
 * `bearerAuth`), but the only real auth path — the `onRequest` hook in `index.ts` — has only ever read
 * `Authorization: Bearer <token>` and verified it via `WIKI.models.apiKeys.verify()`. Nothing in the
 * codebase reads an `X-API-Key` header, so `apiKeyAuth` documented a credential style that could never
 * authenticate a request: picking it in the Swagger UI Authorize dialog produced requests the server
 * silently ignored (the `onRequest` hook only inspects `req.headers.authorization`), which is worse
 * than not documenting a scheme at all.
 */
describe('OpenAPI security config', () => {
  test('declares bearerAuth as the sole security scheme', () => {
    assert.deepEqual(Object.keys(OPENAPI_SECURITY_SCHEMES), ['bearerAuth'])
    assert.equal(OPENAPI_SECURITY_SCHEMES.bearerAuth.type, 'http')
    assert.equal(OPENAPI_SECURITY_SCHEMES.bearerAuth.scheme, 'bearer')
  })

  test('does not declare the dead apiKeyAuth scheme', () => {
    assert.equal((OPENAPI_SECURITY_SCHEMES as Record<string, unknown>).apiKeyAuth, undefined)
  })

  test('top-level security requirement lists only bearerAuth', () => {
    assert.deepEqual(OPENAPI_SECURITY, [{ bearerAuth: [] }])
  })
})
