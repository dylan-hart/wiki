import {
  AI_ASSIST_ACTIONS,
  AI_ASSIST_MAX_PROMPT_LENGTH,
  AI_ASSIST_MAX_TEXT_LENGTH,
  AI_ASSIST_REFUSALS,
  aiRegistry,
  buildAiAssistPrompt,
  consumeAiAssistQuota,
  evaluateAiAssist
} from '../helpers/aiAssist.ts'
import type { AiAssistAction, AiAssistReason } from '../helpers/aiAssist.ts'
import type { FastifyInstance, FastifyReply } from 'fastify'

const PROVIDER_FAILED_MESSAGE =
  'The AI provider could not complete this request. Try again in a little while.'

function sendRefusal(reply: FastifyReply, reason: AiAssistReason, retryAfter = 0) {
  const { message } = AI_ASSIST_REFUSALS[reason]
  switch (reason) {
    case 'guest':
      return reply.unauthorized(message)
    case 'disabled':
    case 'forbidden':
      return reply.forbidden(message)
    case 'capReached':
      if (retryAfter > 0) {
        reply.header('Retry-After', String(retryAfter))
        return reply.tooManyRequests(
          `${message} Try again in ${Math.ceil(retryAfter / 60)} minute(s).`
        )
      }
      return reply.tooManyRequests(message)
    case 'unconfigured':
      return reply.serviceUnavailable(message)
  }
}

const statusSchema = {
  type: 'object',
  properties: {
    available: { type: 'boolean' },
    reason: {
      type: ['string', 'null'],
      enum: ['guest', 'disabled', 'forbidden', 'capReached', 'unconfigured', null]
    },
    cap: { type: 'integer' },
    remaining: { type: 'integer' },
    retryAfter: { type: 'integer' }
  }
}

async function routes(app: FastifyInstance) {
  app.get<{
    Params: { siteId: string }
    Querystring: { pageId?: string; path?: string; locale?: string }
  }>(
    '/sites/:siteId/ai/status',
    {
      schema: {
        summary: 'Get the writing assistant status for the caller',
        description:
          "Whether the caller may use the Markdown editor's writing assistant right now, and how much of their daily allowance is left. Reading it uses none of the allowance. `reason` names the first check that refused, in the order the generate route applies them: `guest`, `disabled` (`ai.assist` is off), `forbidden` (no `write:pages` on the page named by `pageId`, or by `path` and `locale`; skipped when neither is given), `capReached`, `unconfigured` (no AI provider is set up for the site).",
        tags: ['AI'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            pageId: { type: 'string', format: 'uuid' },
            path: { type: 'string', maxLength: 1024 },
            locale: { type: 'string', maxLength: 32 }
          }
        },
        response: {
          200: { description: "The caller's writing assistant status", ...statusSchema }
        }
      }
    },
    async (req) => {
      const { status } = await evaluateAiAssist(req, req.params.siteId, req.query)
      return status
    }
  )

  app.post<{
    Params: { siteId: string }
    Body: {
      action: AiAssistAction
      text: string
      prompt?: string
      pageId?: string
      path: string
      locale: string
    }
  }>(
    '/sites/:siteId/ai/generate',
    {
      schema: {
        summary: 'Run a writing assistant action',
        description:
          "Runs one of the Markdown editor's writing assistant actions through the site's AI provider and returns the text to insert. The prompt templates live on the server. Checks run in this order: 401 for a guest, 403 when `ai.assist` is off, 403 without `write:pages` on the page, 429 (with `Retry-After`) once the caller's daily allowance (`ai.assistDailyCap`) is used up, and 503 when no provider is configured or the provider returns nothing. One unit of the allowance is used just before the provider is called, and it is not refunded if the call fails.",
        tags: ['AI'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['action', 'text', 'path', 'locale'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: [...AI_ASSIST_ACTIONS] },
            text: { type: 'string', maxLength: AI_ASSIST_MAX_TEXT_LENGTH },
            prompt: { type: 'string', maxLength: AI_ASSIST_MAX_PROMPT_LENGTH },
            pageId: { type: 'string', format: 'uuid' },
            path: { type: 'string', maxLength: 1024 },
            locale: { type: 'string', minLength: 1, maxLength: 32 }
          }
        },
        response: {
          200: {
            description: 'The text the action produced',
            type: 'object',
            properties: {
              text: { type: 'string' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          429: { $ref: 'ApiError#' },
          503: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const { siteId } = req.params
      const { action, text, prompt, pageId, path, locale } = req.body

      if ((action === 'rewrite' || action === 'summarize') && text.trim().length < 1) {
        return reply.badRequest(`The ${action} action needs some selected text.`)
      }
      if (action === 'generate' && (prompt ?? '').trim().length < 1) {
        return reply.badRequest('The generate action needs a prompt.')
      }

      const { status, userId, counter } = await evaluateAiAssist(req, siteId, {
        pageId,
        path,
        locale
      })
      if (!status.available || !userId) {
        return sendRefusal(reply, status.reason ?? 'guest', status.retryAfter)
      }

      const registry = aiRegistry()
      if (!registry) {
        return sendRefusal(reply, 'unconfigured')
      }

      const quota = await consumeAiAssistQuota(siteId, userId, status.cap, counter)
      if (!quota.allowed) {
        return sendRefusal(reply, 'capReached', quota.retryAfter)
      }

      const request = buildAiAssistPrompt({ action, text, prompt, locale })
      let output: string | null
      try {
        output = await registry.generate(siteId, request.prompt, {
          system: request.system,
          maxOutputTokens: request.maxOutputTokens
        })
      } catch {
        output = null
      }
      if (typeof output !== 'string') {
        return reply.serviceUnavailable(PROVIDER_FAILED_MESSAGE)
      }
      return { text: output }
    }
  )
}

export default routes
