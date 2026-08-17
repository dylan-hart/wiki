import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { registerSchemas as registerGroupSchema } from './schemas/group.ts'
import { registerSchemas as registerUserSchema } from './schemas/user.ts'
import groupsRoutes from './groups.ts'

/**
 * Task 472: verifies `manage:navigation`'s presence on `GET /groups` (line ~58) is exactly as broad as
 * the comment above it claims -- enough to let the navigation editor's group picker name groups by id
 * and name, but NOT enough to read a group's full permissions/rules (`GET /groups/:groupId`, which
 * still requires `read:groups` or `manage:groups`). A gap here would mean either the picker can't
 * populate (too narrow) or a nav-only account can read every group's permission grants and page rules
 * (too broad, since `GroupCore` omits both but `Group` carries them -- see `api/schemas/group.ts`).
 *
 * Same isolated-route-file approach as `navigation.test.ts`: the real permission gate is `index.ts`'s
 * single global `preHandler` hook, reproduced verbatim here, with a session seeded through a
 * test-only header ahead of it. `WIKI.models.groups` methods below are stubbed rather than hitting a
 * real database -- this test is about the permission surface, not model behavior.
 */

function testSessionOnRequest(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void
) {
  const header = req.headers['x-test-session']
  if (header) {
    ;(req as any).session = JSON.parse(header as string)
  }
  done()
}

function permissionPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
) {
  const routePermissions = req.routeOptions.config?.permissions
  if (routePermissions && routePermissions.length > 0) {
    const session = (req as any).session
    const permissions = session?.authenticated ? session.permissions : null
    if (!permissions || permissions.length < 1) {
      return reply.unauthorized()
    }
    if (!permissions.includes('manage:system')) {
      const isAllowed = routePermissions.some((perms: any) => {
        if (Array.isArray(perms)) {
          return perms.every((perm: string) => permissions.some((p: string) => p === perm))
        }
        return permissions.some((p: string) => p === perms)
      })
      if (!isAllowed) {
        return reply.forbidden()
      }
    }
  }
  done()
}

const GROUP_ID = '33333333-3333-3333-3333-333333333333'

const fullGroup = {
  id: GROUP_ID,
  name: 'Editors',
  isSystem: false,
  userCount: 3,
  permissions: ['write:pages', 'manage:groups'],
  rules: []
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        async getAllGroups() {
          return [{ id: GROUP_ID, name: 'Editors', isSystem: false, userCount: 3 }]
        },
        async getGroupById(id: string) {
          return id === GROUP_ID ? fullGroup : null
        }
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await registerGroupSchema(app)
  await registerUserSchema(app)
  app.addHook('onRequest', testSessionOnRequest)
  app.addHook('preHandler', permissionPreHandler)
  await app.register(groupsRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

function headersFor(permissions: string[]) {
  return {
    'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] })
  }
}

test('a manage:navigation-only account can list groups (for the visibilityGroups picker)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor(['manage:navigation'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [{ id: GROUP_ID, name: 'Editors', isSystem: false, userCount: 3 }])
})

test('a manage:navigation-only account is refused a group detail read', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${GROUP_ID}`,
    headers: headersFor(['manage:navigation'])
  })
  assert.equal(res.statusCode, 403)
})

test('an account with neither read:groups, manage:groups nor manage:navigation is refused the list', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor(['write:pages'])
  })
  assert.equal(res.statusCode, 403)
})

test('an anonymous request is refused the list', async () => {
  const res = await app.inject({ method: 'GET', url: '/' })
  assert.equal(res.statusCode, 401)
})
