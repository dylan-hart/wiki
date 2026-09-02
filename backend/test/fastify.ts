/**
 * The shared Fastify harness for route-level backend tests (TEST-F2).
 *
 * Before this existed, 66 test files each carried their own copy of the same preamble: a `fastify()`
 * boot, `@fastify/sensible`, a hand-written `setErrorHandler` that only APPROXIMATED `index.ts`'s
 * real one, a hand-picked list of `registerSchemas` imports, and — in six files — a re-implementation
 * of the route-permission `preHandler` that had all independently dropped the `req.apiKey` branch.
 * Everything here installs the REAL production piece instead:
 *
 * - `helpers/errorHandler.ts#apiErrorHandler` — the actual `/_api/` branch of `index.ts`'s handler.
 * - `core/http/authHooks.ts#permissionPreHandler` — the actual route-permission gate, API-key branch
 *   included, so a test app answers 401/403 exactly as the running server does.
 * - `api/index.ts#registerAllSchemas` — the actual shared-schema set, so a suite can never `$ref` a
 *   schema the real app registers but its own hand-picked list forgot.
 *
 * What stays the harness's own concern is session seeding: there is no production
 * `testSessionOnRequest` to borrow, because the running server gets a session from a signed cookie.
 * `session: 'header'` below is the one convention that replaces the four incompatible ones the suites
 * had grown (`x-test-session`, `x-test-permissions`, `x-test-api-key`, `x-simulate-api-key`).
 */
import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifySwagger from '@fastify/swagger'
import ajvFormats from 'ajv-formats'
import { mock } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

import { registerAllSchemas } from '../api/index.ts'
import { permissionPreHandler } from '../core/http/authHooks.ts'
import { apiKeySitePinHook } from '../helpers/apiKeySite.ts'
import { apiErrorHandler } from '../helpers/errorHandler.ts'
import { installTestWiki } from './mocks.ts'

/** One route plugin, optionally mounted under its own prefix. */
export type TestRoutes =
  | FastifyPluginAsync
  | { plugin: FastifyPluginAsync; prefix?: string }
  | Array<FastifyPluginAsync | { plugin: FastifyPluginAsync; prefix?: string }>

/** A shared-schema registrar — `registerSchemas` / `registerParamsSchemas` from `api/schemas/*.ts`. */
export type SchemaRegistrar = (app: FastifyInstance) => void | Promise<void>

export interface BuildTestAppOptions {
  /** The route plugin(s) under test. */
  routes: TestRoutes
  /**
   * A `WIKI` global to install for the lifetime of the app, deep-merged over `createWikiStub()`'s
   * defaults. Omit to leave whatever global is already in place alone — which is what a DB-backed
   * suite wants, since `setupTestDb()` has already installed one.
   */
  wiki?: Record<string, any>
  /**
   * `'all'` registers every shared schema the real app does (`registerAllSchemas`); an array
   * registers exactly the named registrars, in order. Defaults to `'all'`.
   */
  schemas?: 'all' | SchemaRegistrar[]
  /**
   * How `req.session` (and `req.apiKey`) are seeded:
   * - `false` / omitted — not at all.
   * - `'header'` — from the request's own test headers, so one app can serve many identities.
   * - an object — that exact session on every request.
   * - a function — its return value as the session, `undefined` to leave the request anonymous.
   */
  session?: false | 'header' | Record<string, any> | ((req: FastifyRequest) => any)
  /** Install the real `permissionPreHandler`, so `config.permissions` is actually enforced. */
  permissions?: boolean
  /** Install the real `apiKeySitePinHook`, so a site-pinned key is refused off its own site. */
  apiKeySitePin?: boolean
  /** Build the instance with `index.ts`'s ajv customization (`ajv-formats` + the `hexcolor` format). */
  ajv?: boolean
  /** Register `@fastify/swagger` with `hideUntagged: true`, for a suite asserting on the OpenAPI doc. */
  swagger?: boolean
  /** Mount `routes` under this prefix (the real app's own `/sites`, `/users`, … registration prefix). */
  prefix?: string
}

/**
 * The test headers `session: 'header'` understands.
 *
 * `x-test-session` carries a whole session object as JSON; `x-test-permissions` is the shorthand for
 * the common case of "an authenticated caller holding exactly these", accepted as either a JSON array
 * or a comma-separated list because both spellings were already in use across the suites this
 * replaces. `x-test-api-key` seeds `req.apiKey` instead, which is what makes the API-key branch of
 * the real `permissionPreHandler` reachable at all.
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

/** Build the `{ session, apiKey }` a request's own test headers ask for. */
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

/** The ajv customization `index.ts` builds its own instance with — same plugin, same custom format. */
function ajvOptions() {
  return {
    // -> `ajv-formats` is CJS: the default import resolves to `module.exports`, so the callable
    //    plugin is reached via `.default`. Same tuple assertion `index.ts` needs, for the same
    //    overload-resolution and variance reasons documented there.
    plugins: [[ajvFormats.default, {}] as any],
    onCreate: (ajv: any) => {
      // -> Accepts the shorthand, alpha and full forms a color picker can produce:
      //    #RGB, #RGBA, #RRGGBB and #RRGGBBAA
      ajv.addFormat('hexcolor', (data: unknown) => {
        return (
          typeof data === 'string' &&
          /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(data)
        )
      })
    }
  }
}

/** Restore handles keyed by the app that owns them, so `closeTestApp` can put `WIKI` back. */
const wikiHandles = new WeakMap<FastifyInstance, { restore(): void }>()

/**
 * Boot a Fastify instance carrying the real error handler, the real shared schemas and — when asked —
 * the real auth hooks, with `routes` registered on it and `ready()` already awaited.
 *
 * Always pair with `closeTestApp(app)` in `after()`: that is what closes the instance AND restores
 * whatever `WIKI` global was in place before.
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

  // -> Decorated rather than assigned onto a bare request, exactly as `index.ts` does: Fastify
  //    optimises a decorated property into the request's shape, and `permissionPreHandler` reads
  //    both of these by name. `session` is typed non-nullable by `@fastify/session`'s augmentation
  //    (a real boot always has one), so the null default needs the cast.
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

/** Close the instance and restore whatever `WIKI` global `buildTestApp` displaced. */
export async function closeTestApp(app: FastifyInstance | undefined): Promise<void> {
  if (!app) {
    return
  }
  await app.close()
  wikiHandles.get(app)?.restore()
  wikiHandles.delete(app)
}

/**
 * A bare `FastifyRequest` stand-in for a hook or helper tested directly, with no server around it.
 *
 * Defaults describe an anonymous `GET /_api/pages` from a fixed IP — enough for every rate-limit,
 * site-resolution and permission helper that reads `method`/`url`/`ip`/`session`/`apiKey`.
 */
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

/**
 * A `FastifyReply` stand-in recording every terminal call a hook may make, chainable like the real
 * one. `calls.forbidden` / `calls.notFound` hold the MESSAGES (`string[]`), which is the accessor
 * shape `helpers/common.test.ts` asserts against.
 */
export function makeReplyStub() {
  const calls: {
    forbidden: string[]
    notFound: string[]
    unauthorized: string[]
    badRequest: string[]
    tooManyRequests: string[]
  } = { forbidden: [], notFound: [], unauthorized: [], badRequest: [], tooManyRequests: [] }
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

/**
 * A `done` callback recording whether — and with what — a callback-style hook completed. `called` is
 * what proves a hook fell through rather than answering the request itself.
 */
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
