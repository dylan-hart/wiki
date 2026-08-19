import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import groupsRoutes from './groups.ts'
import { registerSchemas as registerGroupSchema } from './schemas/group.ts'
import { registerSchemas as registerUserSchema } from './schemas/user.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * Feature 357 / task 448: `Groups#clampGuestPatch` (`models/groups.ts`) strips any role outside
 * `GUEST_ROLES` from a rule written to the guests group, rather than rejecting the request — the
 * task description's explicit ask is to confirm that holds calling the real route directly
 * (`PUT /_api/groups/:groupId` — the model's own type is named `GroupPatch`, which is presumably
 * what the task description's "PATCH" refers to; there is no separate `PATCH` method on this
 * route), not just through `GroupEditOverlay.vue`, which only ever offers `GUEST_ROLES` in its
 * `<select>` in the first place and so could never exercise this path.
 *
 * DB-backed rather than a stub of `WIKI.models.groups`, deliberately: `clampGuestPatch` is a
 * private method of the real `Groups` class, reachable only through the real `updateGroup`, so a
 * stubbed model would prove nothing about the guard actually running. `WIKI.data.systemIds
 * .guestsGroupId` is pointed at the fixture group `setupTestDb()` seeds, standing in for the real
 * guests group the same way `models/groups.test.ts` already treats it as a stand-in group.
 */
describe(
  'PUT /:groupId — guests-group role clamp (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures
    let groupsModel: typeof import('../models/groups.ts').groups

    before(async () => {
      fixtures = await setupTestDb()
      ;({ groups: groupsModel } = await import('../models/groups.ts'))
      // -> Stand in for the real guests group: `clampGuestPatch` only activates for whichever group
      //    id this points at.
      ;(globalThis as any).WIKI.data.systemIds = { guestsGroupId: fixtures.groupId }

      app = fastify({
        ajv: {
          plugins: [[ajvFormats.default, {}] as any]
        }
      })
      await app.register(fastifySensible)
      await registerUserSchema(app)
      await registerGroupSchema(app)
      await app.register(groupsRoutes)
      await app.ready()
    })

    after(async () => {
      await app.close()
      await teardownTestDb()
    })

    test('drops a disallowed role rather than rejecting the request', async () => {
      const warn = mock.method(WIKI.logger, 'warn')

      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: {
          rules: [
            {
              id: 'attempted-write-grant',
              name: 'Attempted write grant',
              // -> 'read:pages' is in GUEST_ROLES; 'write:pages' and 'manage:pages' are not.
              roles: ['read:pages', 'write:pages', 'manage:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        }
      })

      // -> "Drop rather than refuse", per the comment on `clampGuestPatch`: the request succeeds...
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      // -> ...but what actually landed on the group has the disallowed roles stripped.
      const saved = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(saved?.rules[0]!.roles, ['read:pages'])

      // -> And the drop was not silent.
      assert.ok(
        warn.mock.calls.length > 0,
        'expected WIKI.logger.warn to fire when roles are dropped'
      )
      assert.match(warn.mock.calls[0]!.arguments[0] as string, /dropped/i)

      warn.mock.restore()
    })

    test('a patch with only already-allowed roles does not warn', async () => {
      const warn = mock.method(WIKI.logger, 'warn')

      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: {
          rules: [
            {
              id: 'allowed-only',
              name: 'Allowed only',
              roles: ['read:pages', 'read:comments'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        }
      })

      assert.equal(res.statusCode, 200)
      const saved = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(saved?.rules[0]!.roles, ['read:pages', 'read:comments'])
      assert.equal(warn.mock.calls.length, 0)

      warn.mock.restore()
    })
  }
)
