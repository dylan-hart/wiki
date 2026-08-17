import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { limitApiKey } from './rateLimit.ts'

/**
 * `limitApiKey` is the global per-key limiter wired into the onRequest API-key-auth hook in
 * `index.ts` (not a per-route hook like `limitAuthAttempts`/`limitRenders`), so it is exercised here
 * the way `api/apiKeys.test.ts` exercises route wiring: a real fastify instance with `@fastify/
 * sensible` registered (for the real `reply.tooManyRequests()`), `WIKI.models.rateLimits.consume`
 * stubbed so no database is touched, and an inline route standing in for "any `/_api/` route with a
 * verified key attached".
 */

let consumeCalls: any[]
let consumeResult: { allowed: boolean; hits: number; retryAfter: number }
let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      rateLimits: {
        consume: async (key: string, policy: any) => {
          consumeCalls.push({ key, policy })
          return consumeResult
        }
      }
    },
    logger: {
      debug: () => {}
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  app.get(
    '/probe',
    {
      preHandler: (req, _reply) => {
        ;(req as any).apiKey = { id: 'key-123', permissions: ['read:pages'] }
        return Promise.resolve()
      }
    },
    async (req, reply) => {
      await limitApiKey(req as any, reply)
      if (reply.sent) {
        return
      }
      return { ok: true }
    }
  )
  app.get(
    '/probe-admin-key',
    {
      preHandler: (req, _reply) => {
        ;(req as any).apiKey = { id: 'admin-key-456', permissions: ['manage:system'] }
        return Promise.resolve()
      }
    },
    async (req, reply) => {
      await limitApiKey(req as any, reply)
      if (reply.sent) {
        return
      }
      return { ok: true }
    }
  )
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  consumeCalls = []
})

test('lets a request through and keys the counter by the api key id, not by ip', async () => {
  consumeResult = { allowed: true, hits: 1, retryAfter: 0 }
  const res = await app.inject({ method: 'GET', url: '/probe' })
  assert.equal(res.statusCode, 200)
  assert.equal(consumeCalls.length, 1)
  assert.equal(consumeCalls[0].key, 'apikey:key-123')
})

test('refuses with 429 and a Retry-After header once the key is banned', async () => {
  consumeResult = { allowed: false, hits: 301, retryAfter: 123 }
  const res = await app.inject({ method: 'GET', url: '/probe' })
  assert.equal(res.statusCode, 429)
  assert.equal(res.headers['retry-after'], '123')
})

test('does not exempt a key whose resolved permissions include manage:system', () => {
  return (async () => {
    consumeResult = { allowed: false, hits: 301, retryAfter: 60 }
    const res = await app.inject({ method: 'GET', url: '/probe-admin-key' })
    assert.equal(res.statusCode, 429)
    assert.equal(consumeCalls[0].key, 'apikey:admin-key-456')
  })()
})
