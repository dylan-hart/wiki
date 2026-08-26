import type { FastifyInstance } from 'fastify'
import { HOOK_EVENTS } from '../../models/hooks.ts'
import { JOB_STATES } from '../../models/jobs.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * HOOK INPUT - The writable fields, used for both create and update
   */
  app.addSchema({
    $id: 'HookInput',
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255
      },
      events: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'string',
          enum: HOOK_EVENTS
        }
      },
      url: {
        type: 'string',
        maxLength: 2048,
        description: 'Where to POST the event. Must be an http or https address.'
      },
      includeMetadata: {
        type: 'boolean',
        description: 'Include the event metadata, such as a page title and author.'
      },
      includeContent: {
        type: 'boolean',
        description: 'Include the full content, e.g. a page body. Payloads can get large.'
      },
      acceptUntrusted: {
        type: 'boolean',
        description:
          'Skip TLS certificate validation for this endpoint. If authHeader is also set, its Authorization header is sent to this peer even though its certificate is never verified.'
      },
      authHeader: {
        type: 'string',
        maxLength: 2048,
        description: 'Sent verbatim as the Authorization header.'
      },
      siteId: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Restrict this webhook to one site. Null (the default) fires for every site.'
      }
    }
  })

  /**
   * HOOK TEST INPUT - What a test delivery needs, straight from the edit form or a saved webhook
   */
  app.addSchema({
    $id: 'HookTestInput',
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        maxLength: 2048,
        description: 'Where to POST the test event. Must be an http or https address.'
      },
      acceptUntrusted: {
        type: 'boolean',
        description:
          'Skip TLS certificate validation for this endpoint. If authHeader is also set, its Authorization header is sent to this peer even though its certificate is never verified.'
      },
      authHeader: {
        type: 'string',
        maxLength: 2048,
        description: 'Sent verbatim as the Authorization header.'
      }
    }
  })

  /**
   * HOOK - A webhook with the outcome of its last delivery
   */
  app.addSchema({
    $id: 'Hook',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string'
      },
      events: {
        type: 'array',
        items: { type: 'string' }
      },
      url: {
        type: 'string'
      },
      includeMetadata: {
        type: 'boolean'
      },
      includeContent: {
        type: 'boolean'
      },
      acceptUntrusted: {
        type: 'boolean'
      },
      authHeader: {
        type: 'string',
        nullable: true
      },
      siteId: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'The site this webhook is restricted to. Null fires for every site.'
      },
      state: {
        type: 'string',
        enum: ['pending', 'success', 'error'],
        description:
          '`pending` until an event reaches it, then the outcome of the most recent delivery.'
      },
      lastErrorMessage: {
        type: 'string',
        nullable: true,
        description: 'Why the last delivery failed. Null unless the state is `error`.'
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      }
    }
  })

  /**
   * HOOK DELIVERY - One attempt to deliver an event to a webhook, as recorded in job history
   */
  app.addSchema({
    $id: 'HookDelivery',
    type: 'object',
    properties: {
      event: {
        type: 'string',
        description: 'The event key that triggered this delivery, e.g. `page:create`.'
      },
      state: {
        type: 'string',
        enum: JOB_STATES,
        description:
          '`active` while in flight, `interrupted` when the attempt was cut short rather than failing on its own.'
      },
      attempt: {
        type: 'integer',
        description: 'Which attempt this delivery was, starting at 1.'
      },
      maxRetries: {
        type: 'integer'
      },
      lastErrorMessage: {
        type: 'string',
        nullable: true,
        description: 'Why this attempt failed. Null unless the state is `failed`.'
      },
      startedAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      completedAt: {
        type: 'string',
        nullable: true,
        format: 'date-time',
        description: 'RFC 3339 Date Time. Null while still in flight.'
      }
    }
  })
}
