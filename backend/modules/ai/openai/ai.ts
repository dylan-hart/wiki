import type { LogFields } from '../../../core/logger.ts'
import type { AiProviderContext } from '../../../models/ai.ts'

export const RESPONSES_URL = 'https://api.openai.com/v1/responses'

export const DEFAULT_MODEL = 'gpt-5-mini'

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

export const DEFAULT_TIMEOUT_MS = 60_000

export type OpenAiGenerateContext = AiProviderContext

export interface OpenAiConfig {
  apiKey?: unknown
  model?: unknown
}

interface ResponsesContentPart {
  type?: unknown
  text?: unknown
}

interface ResponsesOutputItem {
  type?: unknown
  content?: unknown
}

interface ResponsesBody {
  status?: unknown
  output?: unknown
  incomplete_details?: { reason?: unknown } | null
  error?: { type?: unknown; code?: unknown } | null
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function outputTokenCap(requested: number | undefined): number {
  return Number.isInteger(requested) && (requested as number) > 0
    ? (requested as number)
    : DEFAULT_MAX_OUTPUT_TOKENS
}

function extractText(output: unknown): string {
  if (!Array.isArray(output)) {
    return ''
  }
  const parts: string[] = []
  for (const item of output as ResponsesOutputItem[]) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue
    }
    for (const part of item.content as ResponsesContentPart[]) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
  }
  return parts.join('')
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function errorFields(body: unknown): { type?: unknown; code?: unknown } {
  const error = (body as ResponsesBody | null)?.error
  if (!error || typeof error !== 'object') {
    return {}
  }
  return { type: error.type, code: error.code }
}

export default async function generate(
  prompt: string,
  context: OpenAiGenerateContext,
  config: OpenAiConfig | null | undefined
): Promise<string | null> {
  const standing = { provider: 'openai', site: context?.siteId }
  const log = {
    debug: (message: string, fields: LogFields = {}) =>
      CARDINAL.logger.debug('ext', message, { ...standing, ...fields }),
    warn: (message: string, fields: LogFields = {}) =>
      CARDINAL.logger.warn('ext', message, { ...standing, ...fields })
  }
  try {
    if (CARDINAL.config?.offline) {
      log.debug('skipping ai generation, offline mode')
      return null
    }
    const apiKey = trimmedString(config?.apiKey)
    if (!apiKey) {
      log.debug('skipping ai generation, no api key configured')
      return null
    }
    if (context?.signal?.aborted) {
      return null
    }
    const model = trimmedString(config?.model) || DEFAULT_MODEL
    const system = trimmedString(context?.system)
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout

    let response: Response
    try {
      response = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          ...(system ? { instructions: system } : {}),
          input: prompt,
          max_output_tokens: outputTokenCap(context?.maxOutputTokens),
          store: false
        }),
        signal
      })
    } catch (err) {
      if (context?.signal?.aborted) {
        log.debug('ai generation cancelled by the caller', { model })
      } else {
        log.warn('ai generation request failed', { model, error: err as Error })
      }
      return null
    }

    const body = await readJson(response)
    if (!response.ok) {
      log.warn('ai generation refused', { model, status: response.status, ...errorFields(body) })
      return null
    }
    const result = body as ResponsesBody | null
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      log.warn('ai generation returned an unreadable response', { model })
      return null
    }
    if (result.status !== 'completed') {
      log.warn('ai generation did not complete', {
        model,
        status: typeof result.status === 'string' ? result.status : undefined,
        reason: result.incomplete_details?.reason,
        ...errorFields(result)
      })
      return null
    }
    const text = extractText(result.output)
    if (!text.trim()) {
      log.warn('ai generation returned no text', { model })
      return null
    }
    return text
  } catch (err) {
    log.warn('ai generation failed', { error: err as Error })
    return null
  }
}
