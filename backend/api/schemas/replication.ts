import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * REPLICATION CONFIG
   */
  app.addSchema({
    $id: 'ReplicationConfig',
    type: 'object',
    properties: {
      isEnabled: {
        type: 'boolean',
        description:
          'Whether the scheduled pull actually runs. Requires sourceUrl, bearerToken and cronSchedule to all be set -- see PUT for the validation.'
      },
      sourceUrl: {
        type: 'string',
        maxLength: 2048,
        description: 'Base URL of the source instance this instance pulls a snapshot from.'
      },
      bearerToken: {
        type: 'string',
        maxLength: 2048,
        description:
          'A personal access token generated on the SOURCE instance, used to authenticate against its bulk-export API. Returned masked as `********` when a token is stored. Send the masked value back unchanged to keep the stored token.'
      },
      cronSchedule: {
        type: 'string',
        maxLength: 255,
        description: 'Standard 5-field cron expression, evaluated in UTC.'
      }
    }
  })
}
