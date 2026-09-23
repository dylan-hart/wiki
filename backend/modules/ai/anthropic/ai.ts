import type { AiProviderContext } from '../../../models/ai.ts'

const MODULE_KEY = 'anthropic'

export const API_URL = 'https://api.anthropic.com/v1/messages'
export const API_VERSION = '2023-06-01'
export const DEFAULT_MODEL = 'claude-opus-5'
export const MAX_OUTPUT_TOKENS = 16000
export const MIN_OUTPUT_TOKENS = 4096
export const TIMEOUT_MS = 60_000
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
export const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-fable-5-1'])
export const EFFORT = 'low'
export const EFFORT_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6'
])

export type AiGenerateContext = AiProviderContext

export interface AnthropicConfig {
  apiKey?: string
  model?: string
}

interface MessagesRequest {
  headers: Record<string, string>
  body: Record<string, unknown>
}

function resolveMaxTokens(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) {
    return MAX_OUTPUT_TOKENS
  }
  return Math.min(Math.max(Math.floor(requested), MIN_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS)
}

export function buildRequest(
  prompt: string,
  context: AiGenerateContext,
  apiKey: string,
  model: string
): MessagesRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: resolveMaxTokens(context.maxOutputTokens),
    messages: [{ role: 'user', content: prompt }]
  }
  if (context.system) {
    body.system = context.system
  }
  if (EFFORT_MODELS.has(model)) {
    body.output_config = { effort: EFFORT }
  }
  if (FALLBACK_MODELS.has(model)) {
    headers['anthropic-beta'] = FALLBACK_BETA
    body.fallbacks = 'default'
  }
  return { headers, body }
}

type ExtractResult = { text: string } | { reason: string }

export function extractText(payload: unknown): ExtractResult {
  if (!payload || typeof payload !== 'object') {
    return { reason: 'malformed' }
  }
  const { stop_reason: stopReason, content } = payload as {
    stop_reason?: unknown
    content?: unknown
  }
  if (stopReason === 'refusal') {
    return { reason: 'refusal' }
  }
  if (stopReason === 'max_tokens') {
    return { reason: 'max_tokens' }
  }
  if (!Array.isArray(content)) {
    return { reason: 'malformed' }
  }
  const text = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block && block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('')
  if (text.trim().length === 0) {
    return { reason: 'empty' }
  }
  return { text }
}

async function errorType(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: { type?: unknown } }
    return typeof payload?.error?.type === 'string' ? payload.error.type : undefined
  } catch {
    return undefined
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export default async function generate(
  prompt: string,
  context: AiGenerateContext,
  config: AnthropicConfig
): Promise<string | null> {
  try {
    if (CARDINAL.config.offline) {
      return null
    }
    const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
    if (!apiKey || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return null
    }
    const model =
      typeof config.model === 'string' && config.model.trim() ? config.model.trim() : DEFAULT_MODEL
    const { headers, body } = buildRequest(prompt, context ?? { siteId: '' }, apiKey, model)

    let response: Response
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(context?.signal)
      })
    } catch (err: any) {
      if (context?.signal?.aborted) {
        CARDINAL.logger.debug('ext', 'the Anthropic request was cancelled', {
          module: MODULE_KEY,
          site: context.siteId,
          model
        })
        return null
      }
      CARDINAL.logger.warn('ext', 'the Anthropic request failed', {
        module: MODULE_KEY,
        site: context?.siteId,
        model,
        error: err
      })
      return null
    }

    if (!response.ok) {
      CARDINAL.logger.warn('ext', 'the Anthropic API refused the request', {
        module: MODULE_KEY,
        site: context?.siteId,
        model,
        status: response.status,
        type: await errorType(response)
      })
      return null
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const result = extractText(payload)
    if ('reason' in result) {
      CARDINAL.logger.warn('ext', 'the Anthropic response had no usable text', {
        module: MODULE_KEY,
        site: context?.siteId,
        model,
        reason: result.reason
      })
      return null
    }
    return result.text
  } catch (err: any) {
    CARDINAL.logger.warn('ext', 'generating text with Anthropic failed', {
      module: MODULE_KEY,
      site: context?.siteId,
      error: err
    })
    return null
  }
}
