import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'

import { load } from 'js-yaml'

import { installTestWiki } from '../../../test/mocks.ts'
import generate, {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  HIGH_REASONING_EFFORT,
  isReasoningModel,
  REASONING_EFFORT,
  reasoningEffort,
  RESPONSES_URL
} from './ai.ts'

const API_KEY = 'sk-test-SECRET-key-1234567890'
const PROMPT = 'Rewrite this sentence: the quick brown fox'
const SYSTEM = 'You are a careful technical editor.'
const OUTPUT = 'A swift auburn fox.'

let wikiHandle: { restore(): void }
let previousFetch: typeof fetch
type LogCall = (scope: string, message: string, fields?: any) => void
let logger: Record<'error' | 'warn' | 'info' | 'debug', ReturnType<typeof mock.fn<LogCall>>>

function completed(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      }
    ],
    ...extra
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = mock.fn(impl)
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

function allLogCalls(): unknown[][] {
  return Object.values(logger).flatMap((fn) => fn.mock.calls.map((call) => call.arguments))
}

function assertLogsHideSecrets() {
  const rendered = JSON.stringify(allLogCalls(), (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message } : value
  )
  assert.ok(!rendered.includes(API_KEY), 'a log line carries the API key')
  assert.ok(!rendered.includes('SECRET'), 'a log line carries part of the API key')
  assert.ok(!rendered.includes(PROMPT), 'a log line carries the prompt')
  assert.ok(!rendered.includes(SYSTEM), 'a log line carries the system prompt')
  assert.ok(!rendered.includes(OUTPUT), 'a log line carries the generated text')
}

beforeEach(() => {
  previousFetch = globalThis.fetch
  logger = {
    error: mock.fn<LogCall>(),
    warn: mock.fn<LogCall>(),
    info: mock.fn<LogCall>(),
    debug: mock.fn<LogCall>()
  }
  wikiHandle = installTestWiki({ config: { offline: false }, logger })
})

afterEach(() => {
  globalThis.fetch = previousFetch
  wikiHandle.restore()
})

describe('modules/ai/openai generate()', () => {
  test('returns the output text for a prompt when a valid key is configured', async () => {
    stubFetch(async () => jsonResponse(completed(OUTPUT)))

    const text = await generate(PROMPT, { siteId: 'site-1', system: SYSTEM }, { apiKey: API_KEY })

    assert.equal(text, OUTPUT)
    assertLogsHideSecrets()
  })

  test('joins every output_text part across message items, skipping non-message items', async () => {
    stubFetch(async () =>
      jsonResponse({
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'First ' },
              { type: 'refusal', refusal: 'ignored' }
            ]
          },
          { type: 'message', content: [{ type: 'output_text', text: 'second.' }] }
        ]
      })
    )

    assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), 'First second.')
  })

  test('posts to the Responses API with the key as a bearer token and a bounded body', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(
      PROMPT,
      { siteId: 'site-1', system: SYSTEM, maxOutputTokens: 300 },
      { apiKey: `  ${API_KEY}  `, model: 'gpt-test-model' }
    )

    assert.equal(fetchFn.mock.callCount(), 1)
    const [url, init] = fetchFn.mock.calls[0]!.arguments
    assert.equal(url, RESPONSES_URL)
    assert.equal(init.method, 'POST')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), `Bearer ${API_KEY}`)
    assert.equal(headers.get('content-type'), 'application/json')
    assert.ok(init.signal instanceof AbortSignal, 'the request carries no AbortSignal')
    assert.deepEqual(JSON.parse(init.body as string), {
      model: 'gpt-test-model',
      instructions: SYSTEM,
      input: PROMPT,
      max_output_tokens: 300,
      store: false
    })
  })

  test('falls back to the default model and output-token cap, and omits absent instructions', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY, model: '  ' })

    const body = JSON.parse(fetchFn.mock.calls[0]!.arguments[1].body as string)
    assert.equal(body.model, DEFAULT_MODEL)
    assert.equal(body.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS)
    assert.equal('instructions' in body, false)
  })

  test('ignores a non-positive or non-integer maxOutputTokens rather than sending it', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    for (const maxOutputTokens of [0, -5, 1.5, Number.NaN]) {
      await generate(PROMPT, { siteId: 'site-1', maxOutputTokens }, { apiKey: API_KEY })
    }

    for (const call of fetchFn.mock.calls) {
      assert.equal(
        JSON.parse(call.arguments[1].body as string).max_output_tokens,
        DEFAULT_MAX_OUTPUT_TOKENS
      )
    }
  })

  test('sends low reasoning effort and a token floor for gpt-5-mini under a 1024 cap', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(
      PROMPT,
      { siteId: 'site-1', maxOutputTokens: 1024 },
      { apiKey: API_KEY, model: 'gpt-5-mini' }
    )

    const body = JSON.parse(fetchFn.mock.calls[0]!.arguments[1].body as string)
    assert.equal(REASONING_EFFORT, 'low')
    assert.equal(body.reasoning?.effort, 'low')
    assert.ok(body.max_output_tokens >= 4096, `max_output_tokens was ${body.max_output_tokens}`)
    assert.equal(body.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS)
  })

  test('keeps a reasoning model cap above the floor as requested', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(
      PROMPT,
      { siteId: 'site-1', maxOutputTokens: 8192 },
      { apiKey: API_KEY, model: 'o3' }
    )

    const body = JSON.parse(fetchFn.mock.calls[0]!.arguments[1].body as string)
    assert.equal(body.max_output_tokens, 8192)
    assert.deepEqual(body.reasoning, { effort: 'low' })
  })

  test('sends neither reasoning effort nor a token floor for gpt-4.1', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(
      PROMPT,
      { siteId: 'site-1', maxOutputTokens: 1024 },
      { apiKey: API_KEY, model: 'gpt-4.1' }
    )

    const body = JSON.parse(fetchFn.mock.calls[0]!.arguments[1].body as string)
    assert.equal('reasoning' in body, false)
    assert.equal(body.max_output_tokens, 1024)
  })

  test('sends no reasoning field and no token floor for gpt-5-chat-latest', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(
      PROMPT,
      { siteId: 'site-1', maxOutputTokens: 1024 },
      { apiKey: API_KEY, model: 'gpt-5-chat-latest' }
    )

    const body = JSON.parse(fetchFn.mock.calls[0]!.arguments[1].body as string)
    assert.equal('reasoning' in body, false)
    assert.equal(body.max_output_tokens, 1024)
  })

  test('sends high reasoning effort and keeps the token floor for gpt-5-pro', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(
      PROMPT,
      { siteId: 'site-1', maxOutputTokens: 1024 },
      { apiKey: API_KEY, model: 'gpt-5-pro' }
    )

    const body = JSON.parse(fetchFn.mock.calls[0]!.arguments[1].body as string)
    assert.equal(HIGH_REASONING_EFFORT, 'high')
    assert.deepEqual(body.reasoning, { effort: 'high' })
    assert.equal(body.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS)
  })

  test('sends no reasoning field for an unknown model id', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    await generate(
      PROMPT,
      { siteId: 'site-1', maxOutputTokens: 1024 },
      { apiKey: API_KEY, model: 'some-future-model' }
    )

    const body = JSON.parse(fetchFn.mock.calls[0]!.arguments[1].body as string)
    assert.equal('reasoning' in body, false)
    assert.equal(body.max_output_tokens, 1024)
  })

  for (const [model, expected] of [
    ['gpt-5', 'low'],
    ['gpt-5-mini', 'low'],
    ['gpt-5.1', 'low'],
    ['gpt-5-codex', 'low'],
    ['o1-pro', 'low'],
    ['o3-pro', 'low'],
    ['gpt-5-pro', 'high'],
    ['gpt-5-pro-2025-10-06', 'high'],
    ['gpt-5.2-pro', 'high'],
    ['gpt-5-chat-latest', undefined],
    ['gpt-5.1-chat-latest', undefined],
    ['gpt-4.1', undefined],
    ['gpt-4o', undefined],
    ['my-gpt-5-pro-proxy', undefined],
    ['some-future-model', undefined]
  ] as const) {
    test(`reasoningEffort(${JSON.stringify(model)}) is ${JSON.stringify(expected)}`, () => {
      assert.equal(reasoningEffort(model), expected)
    })
  }

  for (const [model, expected] of [
    ['gpt-5', true],
    ['gpt-5-pro', true],
    ['gpt-5-chat-latest', false],
    ['gpt-5.1-chat-latest', false],
    ['gpt-5-mini', true],
    ['gpt-5-nano', true],
    ['o1', true],
    ['o3', true],
    ['o4-mini', true],
    ['gpt-4.1', false],
    ['gpt-4.1-mini', false],
    ['gpt-4o', false],
    ['omni-moderation-latest', false],
    ['my-gpt-5-proxy', false]
  ] as const) {
    test(`isReasoningModel(${JSON.stringify(model)}) is ${expected}`, () => {
      assert.equal(isReasoningModel(model), expected)
    })
  }

  for (const config of [{}, { apiKey: '' }, { apiKey: '   ' }, { apiKey: 42 }, null, undefined]) {
    test(`returns null without calling the API when the key is missing (${JSON.stringify(config)})`, async () => {
      const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

      const text = await generate(PROMPT, { siteId: 'site-1' }, config as any)

      assert.equal(text, null)
      assert.equal(fetchFn.mock.callCount(), 0)
    })
  }

  test('returns null without calling the API in offline mode', async () => {
    CARDINAL.config.offline = true
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), null)
    assert.equal(fetchFn.mock.callCount(), 0)
  })

  test('returns null for an invalid key (401) and logs a warning without the key or text', async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          error: {
            message: `Incorrect API key provided: ${API_KEY.slice(0, 12)}****7890.`,
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key'
          }
        },
        401
      )
    )

    const text = await generate(PROMPT, { siteId: 'site-1', system: SYSTEM }, { apiKey: API_KEY })

    assert.equal(text, null)
    assert.equal(logger.warn.mock.callCount(), 1)
    const [scope, , fields] = logger.warn.mock.calls[0]!.arguments
    assert.equal(scope, 'ext')
    assert.equal(fields.provider, 'openai')
    assert.equal(fields.status, 401)
    assert.equal(fields.code, 'invalid_api_key')
    assert.equal(fields.site, 'site-1')
    assertLogsHideSecrets()
  })

  test('returns null for a server error with a non-JSON body', async () => {
    stubFetch(async () => new Response('<html>Bad Gateway</html>', { status: 502 }))

    assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), null)
    assert.equal(logger.warn.mock.callCount(), 1)
    assert.equal(logger.warn.mock.calls[0]!.arguments[2].status, 502)
  })

  test('returns null when the network call throws', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })

    assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), null)
    assert.equal(logger.warn.mock.callCount(), 1)
    assertLogsHideSecrets()
  })

  test('returns null when fetch itself is unavailable or misbehaves synchronously', async () => {
    globalThis.fetch = (() => {
      throw new Error('boom')
    }) as unknown as typeof fetch

    assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), null)
  })

  test('returns null, logging at debug only, when the caller aborts the request', async () => {
    const controller = new AbortController()
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        })
    )

    const pending = generate(
      PROMPT,
      { siteId: 'site-1', signal: controller.signal },
      { apiKey: API_KEY }
    )
    controller.abort()

    assert.equal(await pending, null)
    assert.equal(logger.warn.mock.callCount(), 0)
    assert.equal(logger.debug.mock.callCount(), 1)
  })

  test('returns null without calling the API when the caller signal is already aborted', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(completed(OUTPUT)))

    const text = await generate(
      PROMPT,
      { siteId: 'site-1', signal: AbortSignal.abort() },
      { apiKey: API_KEY }
    )

    assert.equal(text, null)
    assert.equal(fetchFn.mock.callCount(), 0)
  })

  test('returns null when the response body is not JSON', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }))

    assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), null)
  })

  test('returns null for an incomplete response rather than applying truncated text', async () => {
    stubFetch(async () =>
      jsonResponse(
        completed('A swift', {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' }
        })
      )
    )

    assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), null)
    const [, , fields] = logger.warn.mock.calls[0]!.arguments
    assert.equal(fields.status, 'incomplete')
    assert.equal(fields.reason, 'max_output_tokens')
  })

  for (const body of [
    completed(''),
    completed('   \n'),
    { status: 'completed', output: [] },
    { status: 'completed' },
    { status: 'failed', error: { code: 'server_error', message: 'x' }, output: [] },
    [],
    null
  ]) {
    test(`returns null when the response carries no usable text (${JSON.stringify(body)})`, async () => {
      stubFetch(async () => jsonResponse(body))

      assert.equal(await generate(PROMPT, { siteId: 'site-1' }, { apiKey: API_KEY }), null)
    })
  }
})

describe('modules/ai/openai definition.yml', () => {
  const definition = load(
    readFileSync(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
  ) as Record<string, any>

  test('is keyed by its directory name', () => {
    assert.equal(definition.key, 'openai')
  })

  test('declares apiKey as a required, sensitive string', () => {
    assert.equal(definition.props.apiKey.type, 'String')
    assert.equal(definition.props.apiKey.sensitive, true)
    assert.equal(definition.props.apiKey.required, true)
  })

  test('declares model, defaulting to the model ai.ts falls back to', () => {
    assert.equal(definition.props.model.type, 'String')
    assert.equal(definition.props.model.default, DEFAULT_MODEL)
  })
})
