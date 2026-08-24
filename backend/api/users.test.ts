import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifySwagger from '@fastify/swagger'
import usersRoutes from './users.ts'
import { registerSchemas as registerUserSchema } from './schemas/user.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
// -> `usersRoutes` now also declares the `/profile/api-keys*` routes (OpenProject #788), whose
//    response schemas `$ref` `ApiKey#`/`ApiKeyExpiration#`/`ApiKeyScopePermission#` — registering the
//    whole plugin fails at boot without them, even though this file's own tests only exercise
//    `/whoami`.
import { registerSchemas as registerApiKeySchema } from './schemas/apiKey.ts'

/**
 * Regression test for the `GET /whoami` response schema gap: with no `response` block, the generated
 * OpenAPI document has no concrete schema for the 200 response. `whoAmI()` (the handler, exported from
 * `./users.ts`) returns `{ authenticated: false }` for a guest, and the session's profile fields plus
 * `permissions` for a logged in user, so both shapes are exercised here via `app.inject`'s `session`.
 */

let app: FastifyInstance

/**
 * Mutable fixtures for `GET /profile/groups` (task 1274): each test sets these ahead of its own
 * `app.inject`, then restores them in a `finally` -- `test()` calls in this file run sequentially, so
 * shared module state is safe as long as every test cleans up after itself rather than assuming the
 * next one will reset it.
 */
let siteFeatures: Record<string, any> | null = null
let userGroupsFixture: Array<{ id: string; name: string }> = []
let nonMemberGroupsFixture: Array<{ id: string; name: string }> = []

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      users: {
        getUserGroups: async () => userGroupsFixture,
        getNonMemberGroups: async () => nonMemberGroupsFixture
      },
      sites: {
        getSiteByHostname: async () =>
          siteFeatures ? { config: { features: siteFeatures } } : null
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: { openapi: '3.1.0', info: { title: 'test', version: '0.0.0' } }
  })
  // -> Fastify session support isn't registered in this minimal harness; `req.session` is simulated
  //    with an `onRequest` hook instead, which is all `whoAmI()` reads.
  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-test-session']
    ;(req as any).session = raw ? JSON.parse(raw as string) : undefined
  })

  await registerErrorSchema(app)
  await registerUserSchema(app)
  await registerApiKeySchema(app)
  await app.register(usersRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('GET /whoami documents a concrete 200 response schema', () => {
  const doc: any = app.swagger()
  const responseSchema =
    doc.paths['/whoami'].get.responses['200'].content['application/json'].schema
  // -> Merged into one schema (rather than a bare `allOf`) once `$ref`s are resolved against
  //    `components.schemas`, so this holds regardless of whether the route composes the shape via
  //    `allOf`, `$ref`, or an inline object.
  const properties = new Set<string>()
  const collect = (schema: any) => {
    if (schema.$ref) {
      const name = schema.$ref.replace('#/components/schemas/', '')
      collect(doc.components.schemas[name])
      return
    }
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) properties.add(key)
    }
    for (const sub of schema.allOf ?? []) collect(sub)
  }
  collect(responseSchema)
  assert.ok(properties.has('authenticated'))
  assert.ok(properties.has('permissions'))
  assert.ok(properties.has('id'))
  assert.ok(properties.has('email'))
  assert.ok(properties.has('name'))
})

test('GET /whoami serializes the guest shape', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/whoami',
    headers: { 'x-test-session': JSON.stringify({ authenticated: false }) }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { authenticated: false })
})

test('GET /whoami serializes the logged in shape, permissions included', async () => {
  const session = {
    authenticated: true,
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'alice@example.com',
      name: 'Alice',
      hasAvatar: true,
      timezone: 'America/New_York',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h',
      appearance: 'dark',
      cvd: 'none'
    },
    permissions: ['read:pages', 'write:pages']
  }
  const res = await app.inject({
    method: 'GET',
    url: '/whoami',
    headers: { 'x-test-session': JSON.stringify(session) }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    authenticated: true,
    ...session.user,
    permissions: session.permissions
  })
})

/**
 * `GET /profile/groups` (task 1274): the response is gated on the caller's site having
 * `features.showOtherGroups` enabled -- off, the shape is exactly the pre-existing plain array; on, it
 * also names the groups the caller is NOT a member of. The route resolves the site from the request's
 * hostname the same way `isProfileEditable` does, so every case below sends a `host` header.
 */

const GROUPS_SESSION = JSON.stringify({
  authenticated: true,
  user: { id: '11111111-1111-1111-1111-111111111111' }
})

test('GET /profile/groups: setting off -> unchanged response shape (plain array)', async () => {
  siteFeatures = { showOtherGroups: false }
  userGroupsFixture = [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }]
  nonMemberGroupsFixture = [{ id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }]
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/profile/groups',
      headers: { host: 'wiki.example.com', 'x-test-session': GROUPS_SESSION }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }])
  } finally {
    siteFeatures = null
    userGroupsFixture = []
    nonMemberGroupsFixture = []
  }
})

test('GET /profile/groups: setting on -> non-member groups included', async () => {
  siteFeatures = { showOtherGroups: true }
  userGroupsFixture = [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }]
  nonMemberGroupsFixture = [{ id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }]
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/profile/groups',
      headers: { host: 'wiki.example.com', 'x-test-session': GROUPS_SESSION }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      groups: [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }],
      otherGroups: [{ id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }]
    })
  } finally {
    siteFeatures = null
    userGroupsFixture = []
    nonMemberGroupsFixture = []
  }
})

test('GET /profile/groups: setting on, member of every group -> empty non-member list', async () => {
  siteFeatures = { showOtherGroups: true }
  userGroupsFixture = [
    { id: '33333333-3333-3333-3333-333333333333', name: 'Editors' },
    { id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }
  ]
  nonMemberGroupsFixture = []
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/profile/groups',
      headers: { host: 'wiki.example.com', 'x-test-session': GROUPS_SESSION }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      groups: userGroupsFixture,
      otherGroups: []
    })
  } finally {
    siteFeatures = null
    userGroupsFixture = []
    nonMemberGroupsFixture = []
  }
})
