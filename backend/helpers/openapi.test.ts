import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { OPENAPI_SECURITY, OPENAPI_SECURITY_SCHEMES, swaggerTransform } from './openapi.ts'

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

describe('swaggerTransform', () => {
  test('folds a flat permission list into the description as an OR, always adding manage:system', () => {
    const { schema } = swaggerTransform({
      schema: { description: 'List sites.' },
      url: '/_api/sites',
      route: { config: { permissions: ['read:sites', 'manage:sites'] } }
    })
    assert.equal(
      schema.description,
      'List sites.\n\n**Required Permissions:** `read:sites` or `manage:sites` or `manage:system`'
    )
    assert.deepEqual(schema['x-permissions'], ['read:sites', 'manage:sites'])
  })

  test('renders a nested (ANDed) entry joined with +', () => {
    const { schema } = swaggerTransform({
      schema: { description: 'Do the thing.' },
      url: '/_api/thing',
      route: { config: { permissions: [['manage:users', 'manage:groups']] } }
    })
    assert.equal(
      schema.description,
      'Do the thing.\n\n**Required Permissions:** `manage:users + manage:groups` or `manage:system`'
    )
  })

  test('a route already declaring manage:system does not list it twice', () => {
    const { schema } = swaggerTransform({
      schema: { description: 'Danger.' },
      url: '/_api/system',
      route: { config: { permissions: ['manage:system'] } }
    })
    assert.equal(schema.description, 'Danger.\n\n**Required Permissions:** `manage:system`')
  })

  test('an undescribed route gets the permission line with no leading blank lines', () => {
    const { schema } = swaggerTransform({
      schema: {},
      url: '/_api/sites',
      route: { config: { permissions: ['read:sites'] } }
    })
    assert.equal(schema.description, '**Required Permissions:** `read:sites` or `manage:system`')
  })

  test('a publicAccess route says so instead', () => {
    const { schema } = swaggerTransform({
      schema: { description: 'Anyone may read this.' },
      url: '/_api/flags',
      route: { config: { publicAccess: true } }
    })
    assert.equal(
      schema.description,
      'Anyone may read this.\n\n**This API is public.** No special permissions required.'
    )
    assert.equal(schema['x-permissions'], undefined)
  })

  test('a route with neither says the answer is scoped to the caller, not that it is public', () => {
    const { schema } = swaggerTransform({
      schema: { description: 'Pages you may read.' },
      url: '/_api/pages',
      route: { config: {} }
    })
    assert.match(schema.description, /^Pages you may read\.\n\n\*\*No fixed permission\.\*\* /)
    assert.ok(!schema.description.includes('This API is public'))
    assert.equal(schema['x-permissions'], undefined)
  })

  test('a route with no config at all is treated the same way', () => {
    const { schema } = swaggerTransform({ schema: {}, url: '/_api/anything' })
    assert.match(schema.description, /^\*\*No fixed permission\.\*\* /)
  })

  test('passes the url through and leaves the caller-supplied schema untouched', () => {
    const original: any = { description: 'List sites.', tags: ['Sites'] }
    const { schema, url } = swaggerTransform({
      schema: original,
      url: '/_api/sites',
      route: { config: { permissions: ['read:sites'] } }
    })
    assert.equal(url, '/_api/sites')
    assert.deepEqual(original, { description: 'List sites.', tags: ['Sites'] })
    assert.deepEqual(schema.tags, ['Sites'])
  })
})
