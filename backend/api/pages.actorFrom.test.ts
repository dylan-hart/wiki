import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyRequest } from 'fastify'
import { actorFrom } from './pages.ts'

/**
 * OpenProject #788: `actorFrom()` used to return `null` for every API-key-authenticated request —
 * there was no user behind a key to attribute a page to. A personal access token (`req.apiKey.userId`
 * set) changes that: it acts as its owner, so this covers the three shapes `actorFrom()` now has to
 * tell apart — a personal token, an admin-issued key (still `null`, unchanged), and a session — plus
 * that the personal-token branch is checked first when a request somehow carries both.
 */

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        // -> Only reached on the session branch; a personal token supplies its own `groupIds` and
        //    never calls this.
        groupIdsForRequest: (req: any) => req.session?.groups ?? []
      }
    }
  }
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

test('actorFrom: a personal access token resolves to a real PageActor for its owning user', () => {
  const req = {
    apiKey: {
      id: 'key-1',
      userId: 'user-42',
      permissions: ['read:pages', 'write:pages'],
      groupIds: ['group-a'],
      siteId: null
    }
  } as unknown as FastifyRequest

  assert.deepEqual(actorFrom(req), {
    id: 'user-42',
    permissions: ['read:pages', 'write:pages'],
    groupIds: ['group-a']
  })
})

test('actorFrom: an admin-issued key (no userId) still resolves to null, same as before personal tokens existed', () => {
  const req = {
    apiKey: {
      id: 'key-1',
      userId: null,
      permissions: ['manage:system'],
      groupIds: ['admin-group'],
      siteId: null
    }
  } as unknown as FastifyRequest

  assert.equal(actorFrom(req), null)
})

test('actorFrom: a logged in session resolves through groups.groupIdsForRequest, unaffected by the apiKey branch', () => {
  const req = {
    session: {
      authenticated: true,
      user: { id: 'user-7' },
      permissions: ['read:pages'],
      groups: ['group-b']
    }
  } as unknown as FastifyRequest

  assert.deepEqual(actorFrom(req), {
    id: 'user-7',
    permissions: ['read:pages'],
    groupIds: ['group-b']
  })
})

test('actorFrom: neither a session nor an API key resolves to null', () => {
  const req = {} as unknown as FastifyRequest
  assert.equal(actorFrom(req), null)
})

test('actorFrom: a personal token takes priority even alongside a session on the same request', () => {
  const req = {
    apiKey: {
      id: 'key-1',
      userId: 'user-42',
      permissions: ['read:pages'],
      groupIds: ['group-a'],
      siteId: null
    },
    session: {
      authenticated: true,
      user: { id: 'user-7' },
      permissions: ['manage:system'],
      groups: ['group-b']
    }
  } as unknown as FastifyRequest

  assert.deepEqual(actorFrom(req), {
    id: 'user-42',
    permissions: ['read:pages'],
    groupIds: ['group-a']
  })
})
