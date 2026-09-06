import type { FastifyInstance } from 'fastify'
import { classifyMailError } from '../models/mail.ts'

/**
 * Placeholder sent to the client in place of a stored secret (the SMTP password and the DKIM
 * private key). Sending it back unchanged leaves the stored secret alone.
 */
const PASSWORD_MASK = '********'

/**
 * Mail settings, stored as the `mail` key of the settings table.
 */
const MAIL_CONFIG_KEYS = [
  'senderName',
  'senderEmail',
  'defaultBaseURL',
  'host',
  'port',
  'name',
  'secure',
  'verifySSL',
  'user',
  'pass',
  'useDKIM',
  'dkimDomainName',
  'dkimKeySelector',
  'dkimPrivateKey'
] as const

/**
 * Mail API Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * GET MAIL CONFIG
   */
  app.get(
    '/config',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get mail configuration',
        tags: ['Mail'],
        response: {
          200: {
            description: 'Mail configuration',
            type: 'object',
            $ref: 'MailConfig#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return {
        ...WIKI.config.mail,
        pass: WIKI.config.mail?.pass?.length > 0 ? PASSWORD_MASK : '',
        dkimPrivateKey: WIKI.config.mail?.dkimPrivateKey?.length > 0 ? PASSWORD_MASK : ''
      }
    }
  )

  /**
   * UPDATE MAIL CONFIG
   */
  app.put<{
    Body: {
      senderName?: string
      senderEmail?: string
      defaultBaseURL?: string
      host?: string
      port?: number
      name?: string
      secure?: boolean
      verifySSL?: boolean
      user?: string
      pass?: string
      useDKIM?: boolean
      dkimDomainName?: string
      dkimKeySelector?: string
      dkimPrivateKey?: string
    }
  }>(
    '/config',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update mail configuration',
        tags: ['Mail'],
        body: {
          $ref: 'MailConfig#'
        },
        response: {
          200: {
            description: 'Mail configuration updated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The configuration could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const patch: Record<string, any> = {}
      for (const key of MAIL_CONFIG_KEYS) {
        if (req.body[key] !== undefined) {
          patch[key] = req.body[key]
        }
      }

      // -> Base URLs are used to build links in emails, always without a trailing slash
      if (typeof patch.defaultBaseURL === 'string') {
        patch.defaultBaseURL = patch.defaultBaseURL.replace(/\/+$/, '')
      }

      // -> The client only ever receives a masked password, so an unchanged one must not be stored
      if (patch.pass === PASSWORD_MASK) {
        delete patch.pass
      }

      // -> Same masking contract for the DKIM private key: an unchanged mask must not overwrite it
      if (patch.dkimPrivateKey === PASSWORD_MASK) {
        delete patch.dkimPrivateKey
      }

      const previousConfig = WIKI.config.mail
      WIKI.config.mail = { ...previousConfig, ...patch }

      if (!(await WIKI.configSvc.saveToDb(['mail']))) {
        WIKI.config.mail = previousConfig
        return reply.internalServerError('Failed to save mail configuration.')
      }

      return {
        ok: true,
        message: 'Mail configuration updated successfully.'
      }
    }
  )

  /**
   * SEND TEST EMAIL
   */
  app.post<{
    Body: {
      recipientEmail: string
    }
  }>(
    '/test',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Send a test email',
        tags: ['Mail'],
        body: {
          type: 'object',
          required: ['recipientEmail'],
          properties: {
            recipientEmail: {
              type: 'string',
              format: 'email',
              minLength: 1,
              maxLength: 255
            }
          }
        },
        response: {
          200: {
            description: 'Test email sent successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      try {
        await WIKI.models.mail.sendTestEmail({
          to: req.body.recipientEmail,
          locale: req.session?.user?.locale
        })
      } catch (err: any) {
        if (err.message === 'ERR_MAIL_NOT_CONFIGURED') {
          return reply.badRequest(
            'Mail is not configured. Set an SMTP host under Mail Configuration before sending a test email.'
          )
        }
        WIKI.logger.warn('mail', 'sending the test email failed', { error: err })
        switch (classifyMailError(err)) {
          case 'auth':
            return reply.badRequest(
              'SMTP authentication failed. Check the username and password under Mail Configuration.'
            )
          case 'connection':
            return reply.badGateway(
              'Could not connect to the SMTP server. Check the host and port under Mail Configuration.'
            )
          case 'tls':
            return reply.badGateway(
              'Could not establish a secure connection: the mail server\'s TLS certificate could not be verified. If it is self-signed or issued by an internal certificate authority, either install a certificate trusted by this server or disable "Verify SSL Certificate" under Mail Configuration.'
            )
          case 'send':
            return reply.unprocessableEntity(
              'The mail server rejected the message, often because the recipient address is invalid. Check the address and try again.'
            )
          default:
            return reply.internalServerError(
              'Failed to send the test email. Check the server logs for details.'
            )
        }
      }

      return {
        ok: true,
        message: 'Test email sent successfully.'
      }
    }
  )
}

export default routes
