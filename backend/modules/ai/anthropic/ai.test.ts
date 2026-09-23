import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { installTestWiki } from '../../../test/mocks.ts'
import generate, {
  API_URL,
  API_VERSION,
  DEFAULT_MODEL,
  EFFORT_MODELS,
  FALLBACK_BETA,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  buildRequest,
  extractText
} from './ai.ts'

const API_KEY = 'sk-ant-test-secret-key'
const PROMPT = 'Rewrite this sentence: the quick brown fox.'
const OUTPUT = 'A swift auburn fox.'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function messageResponse(content: unknown[], stopReason = 'end_turn'): Response {
  return jsonResponse({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: stopReason
  })
}

function recordingLogger() {
  const lines: { level: string; args: unknown[] }[] = []
  const logger: any = {}
  for (const level of ['error', 'warn', 'info', 'debug']) {
    logger[level] = (...args: unknown[]) => lines.push({ level, args })
  }
  logger.scope = () => logger
  return { logger, lines }
}

let wiki: { restore(): void }
let logged: ReturnType<typeof recordingLogger>

before(() => {
  wiki = installTestWiki()
})

after(() => {
  wiki.restore()
})

beforeEach(() => {
  logged = recordingLogger()
  CARDINAL.logger = logged.logger
  CARDINAL.config.offline = false
})

afterEach(() => {
  mock.restoreAll()
})

describe('definition.yml', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const doc = load(readFileSync(path.join(dir, 'definition.yml'), 'utf8')) as any

  test('declares the anthropic key', () => {
    assert.equal(doc.key, 'anthropic')
  })

  test('apiKey is a required, sensitive string', () => {
    assert.equal(doc.props.apiKey.type, 'String')
    assert.equal(doc.props.apiKey.sensitive, true)
    assert.equal(doc.props.apiKey.required, true)
  })

  test('model defaults to the module default', () => {
    assert.equal(doc.props.model.type, 'String')
    assert.equal(doc.props.model.default, DEFAULT_MODEL)
  })
})

describe('buildRequest()', () => {
  test('sends the key and API version as headers and the prompt as a single user turn', () => {
    const { headers, body } = buildRequest(PROMPT, { siteId: 's1' }, API_KEY, 'claude-sonnet-5')
    assert.equal(headers['x-api-key'], API_KEY)
    assert.equal(headers['anthropic-version'], API_VERSION)
    assert.equal(headers['anthropic-beta'], undefined)
    assert.deepEqual(body, {
      model: 'claude-sonnet-5',
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: PROMPT }],
      output_config: { effort: 'low' }
    })
  })

  test('passes the system prompt through', () => {
    const { body } = buildRequest(PROMPT, { siteId: 's1', system: 'Be terse.' }, API_KEY, 'm')
    assert.equal(body.system, 'Be terse.')
  })

  test('raises a small maxOutputTokens to the floor, honours one in range and clamps a larger or invalid one', () => {
    const at = (maxOutputTokens: number) =>
      buildRequest(PROMPT, { siteId: 's1', maxOutputTokens }, API_KEY, 'm').body.max_tokens
    assert.equal(MIN_OUTPUT_TOKENS, 4096)
    assert.equal(at(512), MIN_OUTPUT_TOKENS)
    assert.equal(at(1024), MIN_OUTPUT_TOKENS)
    assert.equal(at(2048), MIN_OUTPUT_TOKENS)
    assert.equal(at(8192), 8192)
    assert.equal(at(1_000_000), MAX_OUTPUT_TOKENS)
    assert.equal(at(0), MAX_OUTPUT_TOKENS)
    assert.equal(at(Number.NaN), MAX_OUTPUT_TOKENS)
  })

  test('asks an effort-capable model for low effort and leaves room for thinking', () => {
    const { body } = buildRequest(
      PROMPT,
      { siteId: 's1', maxOutputTokens: 1024 },
      API_KEY,
      'claude-opus-5'
    )
    assert.deepEqual(body.output_config, { effort: 'low' })
    assert.ok((body.max_tokens as number) >= 4096)
    assert.equal(body.thinking, undefined)
  })

  test('sets low effort on every listed model', () => {
    assert.deepEqual([...EFFORT_MODELS].sort(), [
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5'
    ])
    for (const model of EFFORT_MODELS) {
      const { body } = buildRequest(PROMPT, { siteId: 's1' }, API_KEY, model)
      assert.deepEqual(body.output_config, { effort: 'low' }, model)
    }
  })

  test('sends no effort to Haiku 4.5 or an unlisted model id', () => {
    for (const model of ['claude-haiku-4-5', 'claude-opus-5-20260101', 'my-custom-model']) {
      const { body } = buildRequest(PROMPT, { siteId: 's1', maxOutputTokens: 1024 }, API_KEY, model)
      assert.equal(body.output_config, undefined, model)
      assert.equal(body.max_tokens, MIN_OUTPUT_TOKENS, model)
    }
  })

  test('opts a fallback-capable model into server-side refusal fallbacks', () => {
    const { headers, body } = buildRequest(PROMPT, { siteId: 's1' }, API_KEY, DEFAULT_MODEL)
    assert.equal(headers['anthropic-beta'], FALLBACK_BETA)
    assert.equal(body.fallbacks, 'default')
  })
})

describe('extractText()', () => {
  test('joins the text blocks and skips thinking blocks', () => {
    const result = extractText({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hello, ' },
        { type: 'text', text: 'world.' }
      ]
    })
    assert.deepEqual(result, { text: 'Hello, world.' })
  })

  test('treats a refusal, a truncated answer, blank text and a malformed body as unusable', () => {
    assert.deepEqual(extractText({ stop_reason: 'refusal', content: [] }), { reason: 'refusal' })
    assert.deepEqual(
      extractText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }),
      { reason: 'max_tokens' }
    )
    assert.deepEqual(
      extractText({ stop_reason: 'end_turn', content: [{ type: 'text', text: ' ' }] }),
      {
        reason: 'empty'
      }
    )
    assert.deepEqual(extractText(null), { reason: 'malformed' })
    assert.deepEqual(extractText({ stop_reason: 'end_turn' }), { reason: 'malformed' })
  })
})

describe('generate()', () => {
  test('returns the generated text for a valid key', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      messageResponse([{ type: 'text', text: OUTPUT }])
    )
    const text = await generate(
      PROMPT,
      { siteId: 's1', system: 'Be terse.', maxOutputTokens: 1024 },
      { apiKey: API_KEY, model: 'claude-sonnet-5' }
    )
    assert.equal(text, OUTPUT)
    assert.equal(fetchMock.mock.calls.length, 1)
    const [url, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit]
    assert.equal(url, API_URL)
    assert.equal(init.method, 'POST')
    assert.ok(init.signal instanceof AbortSignal)
    const sent = JSON.parse(init.body as string)
    assert.equal(sent.model, 'claude-sonnet-5')
    assert.equal(sent.max_tokens, MIN_OUTPUT_TOKENS)
    assert.deepEqual(sent.output_config, { effort: 'low' })
    assert.equal(sent.system, 'Be terse.')
    assert.deepEqual(sent.messages, [{ role: 'user', content: PROMPT }])
  })

  test('falls back to the default model when none is configured', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      messageResponse([{ type: 'text', text: OUTPUT }])
    )
    await generate(PROMPT, { siteId: 's1' }, { apiKey: API_KEY, model: '  ' })
    const init = fetchMock.mock.calls[0]!.arguments[1] as RequestInit
    assert.equal(JSON.parse(init.body as string).model, DEFAULT_MODEL)
  })

  test('returns null without calling the API when the key is missing or blank', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => messageResponse([]))
    assert.equal(await generate(PROMPT, { siteId: 's1' }, {}), null)
    assert.equal(await generate(PROMPT, { siteId: 's1' }, { apiKey: '   ' }), null)
    assert.equal(await generate(PROMPT, { siteId: 's1' }, undefined as any), null)
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('returns null without calling the API for an empty prompt', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => messageResponse([]))
    assert.equal(await generate('  ', { siteId: 's1' }, { apiKey: API_KEY }), null)
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('returns null without calling the API in offline mode', async () => {
    CARDINAL.config.offline = true
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      messageResponse([{ type: 'text', text: OUTPUT }])
    )
    assert.equal(await generate(PROMPT, { siteId: 's1' }, { apiKey: API_KEY }), null)
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('returns null for an invalid key (401) and never logs the key or the text', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(
        {
          type: 'error',
          error: { type: 'authentication_error', message: `invalid x-api-key ${PROMPT}` }
        },
        401
      )
    )
    const text = await generate(PROMPT, { siteId: 's1' }, { apiKey: API_KEY })
    assert.equal(text, null)
    const warning = logged.lines.find((line) => line.level === 'warn')
    assert.ok(warning)
    assert.equal((warning.args[2] as any).status, 401)
    assert.equal((warning.args[2] as any).type, 'authentication_error')
    const serialized = JSON.stringify(logged.lines)
    assert.ok(!serialized.includes(API_KEY))
    assert.ok(!serialized.includes(PROMPT))
  })

  test('returns null for a server error with a non-JSON body', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('upstream down', { status: 529 }))
    assert.equal(await generate(PROMPT, { siteId: 's1' }, { apiKey: API_KEY }), null)
  })

  test('returns null when the request itself fails, logging the error but not the key or text', async () => {
    const failure = new TypeError('fetch failed')
    mock.method(globalThis, 'fetch', async () => {
      throw failure
    })
    assert.equal(await generate(PROMPT, { siteId: 's1' }, { apiKey: API_KEY }), null)
    const warning = logged.lines.find((line) => line.level === 'warn')
    assert.ok(warning)
    assert.equal(warning.args[0], 'ext')
    assert.equal((warning.args[2] as any).error, failure)
    const serialized = JSON.stringify(logged.lines)
    assert.ok(!serialized.includes(API_KEY))
    assert.ok(!serialized.includes(PROMPT))
  })

  test('returns null when the request times out', async () => {
    mock.method(AbortSignal, 'timeout', () =>
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    )
    mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      init.signal?.throwIfAborted()
      return messageResponse([{ type: 'text', text: OUTPUT }])
    })
    assert.equal(await generate(PROMPT, { siteId: 's1' }, { apiKey: API_KEY }), null)
    const warning = logged.lines.find((line) => line.level === 'warn')
    assert.ok(warning)
    assert.equal((warning.args[2] as any).error.name, 'TimeoutError')
  })

  test('returns null when the caller aborts, without a warning', async () => {
    mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      init.signal?.throwIfAborted()
      return messageResponse([{ type: 'text', text: OUTPUT }])
    })
    const controller = new AbortController()
    controller.abort()
    assert.equal(
      await generate(PROMPT, { siteId: 's1', signal: controller.signal }, { apiKey: API_KEY }),
      null
    )
    assert.equal(logged.lines.filter((line) => line.level === 'warn').length, 0)
  })

  test('returns null for a refusal, a truncated answer and a malformed body', async () => {
    const responses = [
      messageResponse([], 'refusal'),
      messageResponse([{ type: 'text', text: 'partial' }], 'max_tokens'),
      new Response('not json', { status: 200 })
    ]
    mock.method(globalThis, 'fetch', async () => responses.shift()!)
    for (let i = 0; i < 3; i++) {
      assert.equal(await generate(PROMPT, { siteId: 's1' }, { apiKey: API_KEY }), null)
    }
    assert.ok(!JSON.stringify(logged.lines).includes('partial'))
  })
})
