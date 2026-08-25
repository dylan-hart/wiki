import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
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

/**
 * Fixtures for the `POST /` and `PUT /:userId` group-validation tests (OpenProject #1603): a known
 * group list `getAllGroups()` answers with, plus the target user `getById()` returns for the PUT
 * path. Both routes' pre-flight guards run before the write itself, so nothing here needs to model an
 * actual database write -- only enough for the handler to reach the `groups` validation block.
 */
let allGroupsFixture: Array<{ id: string; name: string }> = []
let targetUserFixture: any = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'target@example.com',
  isSystem: false
}
let createUserMock: ReturnType<typeof mock.fn>

before(async () => {
  createUserMock = mock.fn(async () => '55555555-5555-5555-5555-555555555555')
  ;(globalThis as any).WIKI = {
    models: {
      users: {
        getUserGroups: async () => userGroupsFixture,
        getNonMemberGroups: async () => nonMemberGroupsFixture,
        getByEmail: async () => null,
        getById: async () => targetUserFixture,
        createUser: createUserMock
      },
      groups: {
        getAllGroups: async () => allGroupsFixture,
        holdsSystemPermission: () => true
      },
      mail: {
        isConfigured: () => false
      },
      auditLog: {
        record: async () => {}
      },
      sites: {
        getSiteByHostname: async () =>
          siteFeatures ? { config: { features: siteFeatures } } : null
      }
    },
    logger: { warn: () => {} }
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
  // -> Mirrors `index.ts`'s own `setErrorHandler`, minimally: a `reply.badRequest()` (and friends)
  //    from `@fastify/sensible` serializes against the `ApiError#` response schema, which requires
  //    `ok` -- without this, this minimal harness's own default error handling fails to serialize the
  //    error at all rather than reproducing the real 400/403/etc. response shape.
  app.setErrorHandler((error: any, _req, reply) => {
    reply
      .code(error.statusCode ?? 500)
      .type('application/json')
      .send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
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

/**
 * `POST /` and `PUT /:userId` (OpenProject #1603): an id naming no real group must be rejected
 * outright rather than silently dropped by `setUserGroups` -- see the model-layer doc comment on why
 * that leniency exists (IdP enrolment) and why it must NOT extend to these two routes.
 */

const UNKNOWN_GROUP_ID = '99999999-9999-9999-9999-999999999999'
const KNOWN_GROUP = { id: '11111111-1111-1111-1111-111111111111', name: 'Editors' }

test('POST / rejects a group id that names no group, and does not create the user', async () => {
  allGroupsFixture = [KNOWN_GROUP]
  createUserMock.mock.resetCalls()
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'a-long-password',
        groups: [KNOWN_GROUP.id, UNKNOWN_GROUP_ID]
      }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'One of the groups does not exist.')
    assert.equal(createUserMock.mock.callCount(), 0)
  } finally {
    allGroupsFixture = []
  }
})

test('POST / succeeds when every group id is known', async () => {
  allGroupsFixture = [KNOWN_GROUP]
  createUserMock.mock.resetCalls()
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'a-long-password',
        groups: [KNOWN_GROUP.id]
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    assert.equal(createUserMock.mock.callCount(), 1)
  } finally {
    allGroupsFixture = []
  }
})

test('PUT /:userId rejects a group id that names no group', async () => {
  allGroupsFixture = [KNOWN_GROUP]
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/${targetUserFixture.id}`,
      payload: {
        groups: [UNKNOWN_GROUP_ID]
      }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'One of the groups does not exist.')
  } finally {
    allGroupsFixture = []
  }
})
