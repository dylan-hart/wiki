import { apiErrorMessage } from '@/helpers/apiError'

export const AI_ASSIST_CONTEXT_KEY = 'cardinalAiAssist'

export const AI_MAX_TEXT_LENGTH = 20000

const UNAVAILABLE = Object.freeze({
  available: false,
  reason: 'error',
  cap: 0,
  remaining: 0,
  retryAfter: null
})

export async function fetchAiStatus(siteId) {
  if (!siteId) {
    return { ...UNAVAILABLE }
  }
  try {
    const status = await API_CLIENT.get(`sites/${siteId}/ai/status`).json()
    return {
      available: status?.available === true,
      reason: status?.reason ?? null,
      cap: status?.cap ?? 0,
      remaining: status?.remaining ?? 0,
      retryAfter: status?.retryAfter ?? null
    }
  } catch {
    return { ...UNAVAILABLE }
  }
}

export async function aiGenerate(siteId, { action, text, prompt, pageId, path, locale }) {
  const json = { action, text, path, locale }
  if (prompt) {
    json.prompt = prompt
  }
  if (pageId) {
    json.pageId = pageId
  }
  const result = await API_CLIENT.post(`sites/${siteId}/ai/generate`, { json }).json()
  return typeof result?.text === 'string' ? result.text : ''
}

const STATUS_MESSAGES = {
  401: 'editor.ai.errors.signIn',
  403: 'editor.ai.errors.forbidden',
  429: 'editor.ai.errors.capReached',
  503: 'editor.ai.errors.unavailable'
}

export function aiErrorMessage(err, t) {
  const key = STATUS_MESSAGES[err?.response?.status]
  if (key) {
    return t(key)
  }
  return apiErrorMessage(err, t('editor.ai.errors.failed'))
}
