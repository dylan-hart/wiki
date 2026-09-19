import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import {
  isPublicRateLimitedPath,
  limitApiKey,
  limitApiRequests,
  limitPublicRequests
} from './helpers/rateLimit.ts'
import { isBearerAuthenticatedPath } from './helpers/apiKeySite.ts'
import { installTestWiki } from './test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * A replica of the two rate-limit `onRequest` hooks `core/http/authHooks.ts#registerAuthHooks`
 * registers back to back -- same order, same exported helpers; keep in sync -- so the only thing
 * under test is the wiring: a root-mounted public path reaches the public limiter, not the
 * `/_api/` one, on its own separately-accounted bucket.
 */
describe('rate limiter hook wiring (index.ts)', () => {
  let app: FastifyInstance
  let consume: ReturnType<typeof mock.fn>

  before(async () => {
    app = fastify()
    await app.register(fastifySensible)

    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/_api/')) {
        return
      }
      return limitApiRequests(req, reply)
    })
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0] ?? req.url
      if (!isPublicRateLimitedPath(path)) {
        return
      }
      return limitPublicRequests(req, reply)
    })

    app.get('/_api/pages', async () => ({ ok: true }))
    app.get('/sitemap.xml', async () => '<urlset></urlset>')
    app.get('/login', async () => ({ ok: true }))

    await app.ready()
  })

  after(async () => {
    await app.close()
  })

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    wikiHandle = installTestWiki({
      config: { security: { apiRateLimitEnabled: true, apiRateLimitMax: 300 } },
      models: { rateLimits: { consume } },
      logger: { debug: mock.fn() }
    })
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  test('a request to a root-mounted public path reaches the public limiter', async () => {
    const res = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'public:ip:127.0.0.1')
  })

  test('a request to an untouched route (neither /_api/ nor a public path) reaches no limiter', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 0)
  })

  test('a root-mounted public path never reaches the /_api/ limiter', async () => {
    await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.ok(
      consume.mock.calls.every((call) => (call.arguments[0] as string).startsWith('public:'))
    )
  })

  test("the public path's budget is accounted separately from /_api/'s", async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).CARDINAL.config.security.apiRateLimitMax = 1

    const firstApi = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(firstApi.statusCode, 200)
    const secondApi = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(secondApi.statusCode, 429)

    const publicReq = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(publicReq.statusCode, 200)
  })
})

/**
 * A replica of the "API Key Authentication" `onRequest` hook in
 * `core/http/authHooks.ts#registerAuthHooks` -- keep in sync. `req.apiKey` must be populated on
 * every `isBearerAuthenticatedPath` prefix, not only `/_api/`: left null, those controllers' own
 * API-key site-pin checks silently never run.
 */
describe('API-key population hook wiring (index.ts)', () => {
  let app: FastifyInstance
  let verifyCalls: string[]
  let verifyResult: any
  let verifyShouldThrow: boolean

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        apiKeys: {
          verify: async (token: string) => {
            verifyCalls.push(token)
            if (verifyShouldThrow) {
              throw new Error('Invalid or expired API key')
            }
            return verifyResult
          }
        },
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        }
      }
    })

    app = fastify()
    await app.register(fastifySensible)
    app.decorateRequest('apiKey', null)

    app.addHook('onRequest', async (req, reply) => {
      if (!isBearerAuthenticatedPath(req.url)) {
        return
      }
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        return
      }
      const token = header.slice('Bearer '.length).trim()
      if (!token) {
        return
      }
      try {
        ;(req as any).apiKey = await CARDINAL.models.apiKeys.verify(token)
      } catch (err: any) {
        return reply.unauthorized(err.message)
      }
      return limitApiKey(req, reply)
    })

    const echoApiKey = async (req: any) => ({ ok: true, apiKey: req.apiKey })
    app.get('/_files/some/asset.png', echoApiKey)
    app.get('/_site/current/logo', echoApiKey)
    app.get('/_thumb/some-id.webp', echoApiKey)
    app.get('/_pages/some-id/script.js', echoApiKey)
    // -> Deliberately uncovered: render.ts resolves no site and is never fetched with an API key.
    //    `/login` stands in for every other cookie-authenticated route.
    app.get('/_render/', echoApiKey)
    app.get('/login', echoApiKey)

    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  beforeEach(() => {
    verifyCalls = []
    verifyShouldThrow = false
    verifyResult = { id: 'key-1', permissions: ['read:pages'], siteId: 'site-a' }
  })

  for (const url of [
    '/_files/some/asset.png',
    '/_site/current/logo',
    '/_thumb/some-id.webp',
    '/_pages/some-id/script.js'
  ]) {
    test(`populates req.apiKey for a valid Bearer token against ${url}`, async () => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer valid-token' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(verifyCalls.length, 1)
      assert.equal(verifyCalls[0], 'valid-token')
      assert.deepEqual(res.json().apiKey, verifyResult)
    })

    test(`refuses with 401 and never sets req.apiKey when the token is rejected, against ${url}`, async () => {
      verifyShouldThrow = true
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer bad-token' }
      })
      assert.equal(res.statusCode, 401)
      assert.equal(verifyCalls.length, 1)
    })

    test(`leaves req.apiKey null with no Authorization header, against ${url}`, async () => {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 200)
      assert.equal(verifyCalls.length, 0)
      assert.equal(res.json().apiKey, null)
    })
  }

  test('does not verify a Bearer token against /_render/, which carries no API key by design', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_render/',
      headers: { authorization: 'Bearer valid-token' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(verifyCalls.length, 0)
    assert.equal(res.json().apiKey, null)
  })

  test('does not verify a Bearer token against an ordinary cookie-authenticated route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { authorization: 'Bearer valid-token' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(verifyCalls.length, 0)
    assert.equal(res.json().apiKey, null)
  })
})

/**
 * The preBoot failure test below runs a real `node backend` boot rather than stubbing
 * `dbManager.init()`: "the process dies with an unhandled rejection" cannot be reproduced inside
 * this `node --test` run without taking the test runner down with it.
 */

const repoRoot = path.resolve(import.meta.dirname, '..')

let configDir: string
let configFile: string

before(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-preboot-test-'))
  configFile = path.join(configDir, 'config.yml')
  // -> Everything else comes from backend/base.yml's defaults, and DATABASE_URL below overrides
  //    every db.* connection field.
  await writeFile(configFile, 'port: 0\n')
})

after(async () => {
  await rm(configDir, { recursive: true, force: true })
})

test(
  'a failing dbManager.init() during preBoot logs one deliberate error and exits non-zero, with no unhandled-rejection stack',
  // -> `dbManager.connect()` retries a connection failure for ~30s before it throws.
  { timeout: 45000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--require',
        './backend/test/fixtures/spoofSupportedNodeVersion.cjs',
        '--require',
        './backend/test/fixtures/polyfillTemporalForSpawnedBoot.cjs',
        'backend'
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CONFIG_FILE: configFile,
          // -> Nothing listens on loopback port 1, so each attempt fails immediately with
          //    ECONNREFUSED rather than timing out.
          DATABASE_URL: 'postgres://wiki:wiki@127.0.0.1:1/wiki',
          WIKI_PORT: '0'
        }
      }
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
    })

    const output = stdout + stderr

    assert.notEqual(
      exitCode,
      0,
      `expected a non-zero exit code, got ${exitCode}\n--- output ---\n${output}`
    )
    assert.match(
      output,
      /database initialization failed/,
      `expected the deliberate error message in the output\n--- output ---\n${output}`
    )
    // -> Node spells its warning `UnhandledPromiseRejection`; `core/processGuards.ts` spells its
    //    line `unhandled promise rejection`. `preBoot()` catches this failure itself, so either
    //    one means its catch stopped covering it.
    assert.doesNotMatch(
      output,
      /Unhandled(Promise)?Rejection|unhandled promise rejection/i,
      `expected no unhandled-rejection stack in the output\n--- output ---\n${output}`
    )
  }
)

/**
 * Importing `backend/index.ts` runs the whole boot sequence against a real Postgres connection and
 * a bound listener, so the boot-ordering contract is asserted against the file's source text.
 *
 * `CARDINAL.server.setReady()` must not fire until `postBoot()` has resolved: until
 * `sites.reloadCache()` has run every page request resolves to `not-found`, and `/_ready` would
 * report 200 throughout that window.
 *
 * `postBoot()` is invoked through `runBootPhaseOrExit()`, which either resolves or calls
 * `process.exit(1)` -- a statement after that call is only reached on success, so the ordering
 * assertions key off `runBootPhaseOrExit(postBoot,` rather than a literal `await postBoot()`.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexTs = readFileSync(path.join(REPO_ROOT, 'backend/index.ts'), 'utf8')

/** Counts raw braces, so a string or comment inside the function must keep its own balanced. */
function extractFunctionBody(source: string, name: string): string {
  const header = `async function ${name}() {`
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `expected to find "${header}" in backend/index.ts`)
  let depth = 1
  let i = start + header.length
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
  }
  return source.slice(start + header.length, i - 1)
}

describe('backend/index.ts boot sequence (OpenProject #2062)', () => {
  test('initHTTPServer() no longer calls CARDINAL.server.setReady()', () => {
    const body = extractFunctionBody(indexTs, 'initHTTPServer')
    assert.doesNotMatch(body, /setReady/)
  })

  test('the module-level sequence calls setReady() only after preBoot(), initHTTPServer() and postBoot() have all been awaited, in that order', () => {
    const preBootIdx = indexTs.indexOf('await preBoot()')
    const initHTTPServerIdx = indexTs.indexOf('await initHTTPServer()')
    const postBootIdx = indexTs.indexOf('runBootPhaseOrExit(postBoot,')
    const setReadyIdx = indexTs.lastIndexOf('CARDINAL.server.setReady()')

    assert.notEqual(preBootIdx, -1, 'expected a module-level `await preBoot()`')
    assert.notEqual(initHTTPServerIdx, -1, 'expected a module-level `await initHTTPServer()`')
    assert.notEqual(
      postBootIdx,
      -1,
      'expected a module-level `await runBootPhaseOrExit(postBoot, ...)`'
    )
    assert.notEqual(setReadyIdx, -1, 'expected a module-level `CARDINAL.server.setReady()` call')

    assert.ok(preBootIdx < initHTTPServerIdx, 'preBoot() must be awaited before initHTTPServer()')
    assert.ok(initHTTPServerIdx < postBootIdx, 'initHTTPServer() must be awaited before postBoot()')
    assert.ok(
      postBootIdx < setReadyIdx,
      'setReady() must come after postBoot() has been awaited, not before'
    )
  })

  test('setReady() is the final statement of the boot sequence, with nothing after it', () => {
    const setReadyIdx = indexTs.lastIndexOf('CARDINAL.server.setReady()')
    const trailing = indexTs.slice(setReadyIdx + 'CARDINAL.server.setReady()'.length)
    assert.match(trailing, /^\s*$/)
  })
})

/**
 * Source-text assertions, for the same reason as the suite above. The derivations are covered as
 * real functions in `helpers/bootSummary.test.ts` and `core/config.test.ts`; what is only
 * checkable here is that `index.ts` calls them, once, in the right places.
 */
describe('backend/index.ts boot narrative (OpenProject #2671)', () => {
  test('the starting line reports the resolved config path and the honoured overrides', () => {
    const startingIdx = indexTs.indexOf("CARDINAL.logger.info('boot', 'starting'")
    assert.notEqual(startingIdx, -1, "expected one `info('boot', 'starting', …)` call")
    const call = indexTs.slice(startingIdx, indexTs.indexOf('})', startingIdx))

    assert.match(call, /config: configProvenance\.configPath/)
    assert.match(call, /overrides: configProvenance\.overrides/)
    // -> Reading `CONFIG_FILE` here would report the unresolved value, not what `init()` honoured.
    assert.doesNotMatch(call, /process\.env\.CONFIG_FILE/)
  })

  test('the provenance comes back from configSvc.init(), not from a second read of the environment', () => {
    assert.match(indexTs, /const configProvenance = await CARDINAL\.configSvc\.init\(\)/)
    // -> `init()` runs before `CARDINAL.logger` exists, so it returns this rather than logging it.
    const initIdx = indexTs.indexOf('await CARDINAL.configSvc.init()')
    // -> A call prefix, not an exact `init()`: this is about ordering, not the logger's arguments.
    const loggerInitIdx = indexTs.indexOf('CARDINAL.logger = logger.init(')
    assert.ok(initIdx < loggerInitIdx, 'config must still be loaded before the logger is built')
  })

  /** Whitespace-tolerant, so reformatting the call across lines does not read as a missing line. */
  const READY_CALL = /CARDINAL\.logger\.info\(\s*'boot',\s*'ready',/

  test('the ready line is emitted exactly once, after postBoot() and before setReady()', () => {
    const readyMatch = READY_CALL.exec(indexTs)
    assert.notEqual(readyMatch, null, "expected one `info('boot', 'ready', …)` call")
    const readyIdx = readyMatch!.index
    assert.equal(
      READY_CALL.exec(indexTs.slice(readyIdx + readyMatch![0].length)),
      null,
      'the ready line must be emitted exactly once'
    )

    const postBootIdx = indexTs.indexOf('runBootPhaseOrExit(postBoot,')
    const setReadyIdx = indexTs.lastIndexOf('CARDINAL.server.setReady()')
    assert.ok(postBootIdx < readyIdx, 'every postBoot() summary must land before the ready line')
    // -> Before `setReady()`, which logs nothing: this is still the last line written, and the
    //    "nothing follows setReady()" assertion above stays true.
    assert.ok(readyIdx < setReadyIdx, 'the ready line must precede setReady()')
  })

  test('the ready line carries sites, url and ms, derived by helpers/bootSummary.ts', () => {
    assert.match(indexTs, /import \{ readyFields \} from '\.\/helpers\/bootSummary\.ts'/)
    const readyIdx = READY_CALL.exec(indexTs)!.index
    const call = indexTs.slice(readyIdx, indexTs.indexOf('\n)', readyIdx))

    assert.match(call, /readyFields\(\{/)
    assert.match(call, /sites: CARDINAL\.sites/)
    assert.match(call, /bindIP: CARDINAL\.config\.bindIP/)
    assert.match(call, /port: CARDINAL\.config\.port/)
    // -> A number, which is what the text renderer needs to print a closing `in 1.2s` clause.
    assert.match(call, /ms: Temporal\.Now\.instant\(\)\.epochMilliseconds - CARDINAL\.startedAt\./)
  })
})
