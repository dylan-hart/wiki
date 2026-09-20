/**
 * The shared Fastify harness for route-level backend tests. Every piece it installs is the REAL
 * production one — `apiErrorHandler`, `permissionPreHandler` (API-key branch included) and
 * `registerAllSchemas` — so a suite exercises the app's own gate rather than a replica of it that
 * can quietly drift.
 *
 * Session seeding is the exception, and stays the harness's own concern: a running server takes its
 * session from a signed cookie, so there is no production piece to borrow.
 */
import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifySwagger from '@fastify/swagger'
import { mock } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

import { registerAllSchemas } from '../api/index.ts'
import { registerAjvFormats } from '../core/http/ajvFormats.ts'
import { permissionPreHandler } from '../core/http/authHooks.ts'
import { apiKeySitePinHook } from '../helpers/apiKeySite.ts'
import { apiErrorHandler } from '../helpers/errorHandler.ts'
import { installTestWiki } from './mocks.ts'

export type TestRoutes =
  | FastifyPluginAsync
  | { plugin: FastifyPluginAsync; prefix?: string }
  | Array<FastifyPluginAsync | { plugin: FastifyPluginAsync; prefix?: string }>

export type SchemaRegistrar = (app: FastifyInstance) => void | Promise<void>

export interface BuildTestAppOptions {
  routes: TestRoutes
  /**
   * Deep-merged over `createWikiStub()`'s defaults. Omit to leave whatever global is already in
   * place alone — which is what a DB-backed suite wants, `setupTestDb()` having installed one.
   */
  wiki?: Record<string, any>
  /** Defaults to `'all'`; an array registers exactly the named registrars, in order. */
  schemas?: 'all' | SchemaRegistrar[]
  /**
   * How `req.session` (and `req.apiKey`) are seeded: `'header'` reads the request's own test
   * headers, so one app can serve many identities; an object is that exact session on every
   * request; a function's return value is the session, `undefined` leaving the request anonymous.
   */
  session?: false | 'header' | Record<string, any> | ((req: FastifyRequest) => any)
  /** Enforce `config.permissions` with the real `permissionPreHandler`. */
  permissions?: boolean
  /** Install the real `apiKeySitePinHook`, so a site-pinned key is refused off its own site. */
  apiKeySitePin?: boolean
  ajv?: boolean
  swagger?: boolean
  prefix?: string
}

/**
 * `x-test-session` carries a whole session as JSON; `x-test-permissions` is the shorthand for an
 * authenticated caller holding exactly these, as a JSON array or a comma-separated list;
 * `x-test-api-key` seeds `req.apiKey`, which is what makes the real `permissionPreHandler`'s
 * API-key branch reachable at all.
 */
export const TEST_SESSION_HEADER = 'x-test-session'
export const TEST_PERMISSIONS_HEADER = 'x-test-permissions'
export const TEST_API_KEY_HEADER = 'x-test-api-key'

function parsePermissions(raw: string): string[] {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }
  return trimmed.split(',').filter(Boolean)
}

function identityFromHeaders(req: FastifyRequest): { session?: any; apiKey?: any } {
  const out: { session?: any; apiKey?: any } = {}
  const sessionHeader = req.headers[TEST_SESSION_HEADER]
  const permissionsHeader = req.headers[TEST_PERMISSIONS_HEADER]
  const apiKeyHeader = req.headers[TEST_API_KEY_HEADER]
  if (typeof sessionHeader === 'string') {
    out.session = JSON.parse(sessionHeader)
  } else if (typeof permissionsHeader === 'string') {
    out.session = {
      authenticated: true,
      permissions: parsePermissions(permissionsHeader),
      groups: []
    }
  }
  if (typeof apiKeyHeader === 'string') {
    out.apiKey = JSON.parse(apiKeyHeader)
  }
  return out
}

function ajvOptions() {
  return { onCreate: registerAjvFormats }
}

const wikiHandles = new WeakMap<FastifyInstance, { restore(): void }>()

/**
 * Always pair with `closeTestApp(app)` in `after()`: that is what closes the instance AND restores
 * whatever `CARDINAL` global was in place before.
 */
export async function buildTestApp(opts: BuildTestAppOptions): Promise<FastifyInstance> {
  const handle = opts.wiki ? installTestWiki(opts.wiki) : null

  const app = fastify(opts.ajv ? { ajv: ajvOptions() } : {})
  if (handle) {
    wikiHandles.set(app, handle)
  }

  await app.register(fastifySensible)
  app.setErrorHandler(apiErrorHandler)

  if (opts.swagger) {
    await app.register(fastifySwagger, {
      hideUntagged: true,
      openapi: { openapi: '3.1.0', info: { title: 'test', version: '0.0.0' } }
    })
  }

  const schemas = opts.schemas ?? 'all'
  if (schemas === 'all') {
    await registerAllSchemas(app)
  } else {
    for (const register of schemas) {
      await register(app)
    }
  }

  // -> Decorated rather than assigned onto a bare request, as `index.ts` does: Fastify optimises a
  //    decorated property into the request's shape. `session` is typed non-nullable by
  //    `@fastify/session`'s augmentation, so the null default needs the cast.
  app.decorateRequest('session', null as any)
  app.decorateRequest('apiKey', null)

  if (opts.session) {
    const seed = opts.session
    app.addHook('onRequest', (req, _reply, done) => {
      if (seed === 'header') {
        const { session, apiKey } = identityFromHeaders(req)
        if (session !== undefined) {
          ;(req as any).session = session
        }
        if (apiKey !== undefined) {
          ;(req as any).apiKey = apiKey
        }
      } else if (typeof seed === 'function') {
        const session = seed(req)
        if (session !== undefined) {
          ;(req as any).session = session
        }
      } else {
        ;(req as any).session = seed
      }
      done()
    })
  }

  if (opts.permissions) {
    app.addHook('preHandler', permissionPreHandler)
  }
  if (opts.apiKeySitePin) {
    app.addHook('preHandler', apiKeySitePinHook)
  }

  const routes = Array.isArray(opts.routes) ? opts.routes : [opts.routes]
  for (const entry of routes) {
    const plugin = typeof entry === 'function' ? entry : entry.plugin
    const prefix = typeof entry === 'function' ? opts.prefix : (entry.prefix ?? opts.prefix)
    if (prefix) {
      await app.register(plugin, { prefix })
    } else {
      await app.register(plugin)
    }
  }

  await app.ready()
  return app
}

export async function closeTestApp(app: FastifyInstance | undefined): Promise<void> {
  if (!app) {
    return
  }
  await app.close()
  wikiHandles.get(app)?.restore()
  wikiHandles.delete(app)
}

export function makeRequestStub(overrides: Partial<FastifyRequest> | Record<string, any> = {}) {
  return {
    method: 'GET',
    url: '/_api/pages',
    ip: '203.0.113.4',
    headers: {},
    apiKey: null,
    session: undefined,
    ...overrides
  } as unknown as FastifyRequest
}

export function makeReplyStub() {
  const calls: {
    forbidden: string[]
    notFound: string[]
    unauthorized: string[]
    badRequest: string[]
    tooManyRequests: string[]
    serviceUnavailable: string[]
  } = {
    forbidden: [],
    notFound: [],
    unauthorized: [],
    badRequest: [],
    tooManyRequests: [],
    serviceUnavailable: []
  }
  const reply: any = {
    header: mock.fn(() => reply),
    code: mock.fn(() => reply),
    type: mock.fn(() => reply),
    send: mock.fn(() => reply)
  }
  for (const name of Object.keys(calls) as Array<keyof typeof calls>) {
    reply[name] = mock.fn((message?: string) => {
      calls[name].push(message as string)
      return reply
    })
  }
  return { reply: reply as FastifyReply, calls }
}

export function makeDoneStub() {
  const done = mock.fn((_err?: Error) => {})
  return {
    done: done as unknown as (err?: Error) => void,
    get called() {
      return done.mock.calls.length > 0
    },
    get error() {
      return done.mock.calls[0]?.arguments[0]
    }
  }
}
