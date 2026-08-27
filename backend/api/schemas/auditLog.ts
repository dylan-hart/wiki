import type { FastifyInstance } from 'fastify'
import {
  AUDIT_EVENTS,
  AUDIT_LOG_RETENTION_DAYS_FLOOR,
  AUDIT_TARGET_TYPES
} from '../../models/auditLog.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * AUDIT LOG ENTRY - One instance-wide, permission-affecting event
   */
  app.addSchema({
    $id: 'AuditLogEntry',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      event: {
        type: 'string',
        enum: AUDIT_EVENTS
      },
      actor: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            nullable: true,
            description: 'Null once the account is gone, or for an event with no human actor.'
          },
          name: {
            type: 'string',
            description: 'Snapshotted at write time — survives the actor being renamed or deleted.'
          }
        }
      },
      actorIp: {
        type: 'string'
      },
      targetType: {
        type: 'string',
        enum: [...AUDIT_TARGET_TYPES, '']
      },
      targetId: {
        type: 'string'
      },
      targetLabel: {
        type: 'string'
      },
      detail: {
        type: 'object',
        description: 'What changed, shaped per event.'
      },
      siteId: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Null for an instance-wide event.'
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      }
    }
  })

  /**
   * AUDIT LOG SETTINGS - The retention window
   */
  app.addSchema({
    $id: 'AuditLogSettings',
    type: 'object',
    properties: {
      retentionDays: {
        type: 'integer',
        minimum: AUDIT_LOG_RETENTION_DAYS_FLOOR,
        description: 'How many days of history to keep before the retention job trims it.'
      }
    }
  })
}
