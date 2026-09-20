import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

async function routes(app: FastifyInstance) {
  app.get(
    '/extensions',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List optional extensions',
        description:
          'Third-party tooling that unlocks extra functionality, with whether each one is present on this system. Detection runs per request, so installing a tool shows up without a restart.',
        tags: ['System'],
        response: {
          200: {
            description: 'List of extensions',
            type: 'array',
            items: { $ref: 'Extension#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.models.extensions.getExtensions()
    }
  )

  app.get(
    '/extensions/status',
    {
      /*
        Public on purpose: a feature gated on an extension (the page-import menu needs Pandoc) asks
        this before showing itself, for any caller. It answers only installed-or-not per key, none
        of the admin-only detail `/extensions` carries.
      */
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Check whether optional extensions are installed',
        description:
          'A minimal presence check for every declared extension: no description, website or install eligibility, just whether each key is installed — enough for a feature that needs one to decide whether to offer itself.',
        tags: ['System'],
        response: {
          200: {
            description: 'Extension key to whether it is installed',
            type: 'object',
            additionalProperties: { type: 'boolean' }
          }
        }
      }
    },
    async () => {
      const extensions = await CARDINAL.models.extensions.getExtensions()
      return Object.fromEntries(extensions.map((ext) => [ext.key, ext.isInstalled]))
    }
  )

  app.post<{ Params: { extensionKey: string } }>(
    '/extensions/:extensionKey/install',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Install or reinstall an extension',
        description:
          'Only extensions flagged `isInstallable` can be installed from here — the npm packages, which are Sharp and Puppeteer. For Sharp this is mostly a repair: it already ships as an optional dependency, and refetching it replaces a prebuilt binary that is missing or does not match this OS and architecture. Puppeteer is not shipped at all, so this is a first install, and it fetches a Chromium build of a few hundred megabytes unless the server points at one it already has through `PUPPETEER_EXECUTABLE_PATH`. Git and Pandoc come from the operating system and answer 409 pointing at the documentation. Runs npm and can take minutes — allow the request a correspondingly long timeout.',
        tags: ['System'],
        params: {
          type: 'object',
          properties: {
            extensionKey: {
              type: 'string',
              maxLength: 255
            }
          },
          required: ['extensionKey']
        },
        response: {
          200: {
            description: 'Extension installed successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              restartRequired: {
                type: 'boolean',
                description:
                  'True when this server already tried and failed to load the module. Node replays a failed module load for the life of the process, so the repaired files cannot be used until the server restarts.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description: 'The extension is not compatible with this system, or is not installable.'
          },
          500: {
            $ref: 'ApiError#',
            description: 'The install failed. The message carries npm’s own output.'
          }
        }
      }
    },
    async (req, reply) => {
      const definition = CARDINAL.models.extensions.getDefinition(req.params.extensionKey)
      if (!definition) {
        return reply.notFound('Extension does not exist.')
      }
      if (!CARDINAL.models.extensions.isCompatible(definition)) {
        return reply.conflict('This extension is not compatible with this system.')
      }
      if (definition.isInstallable !== true) {
        return reply.conflict(
          `${definition.title} must be installed manually. See the documentation for instructions.`
        )
      }

      try {
        await CARDINAL.models.extensions.install(definition)
      } catch (err: any) {
        // -> The message is npm's own output, the only thing that explains a failure such as a
        //    missing build toolchain. Safe to return: only an administrator reaches this route.
        return reply.internalServerError(err.message)
      }

      const restartRequired = CARDINAL.models.extensions.hasLoadFailed(definition)

      await CARDINAL.models.auditLog.record({
        event: 'system.extensionInstalled',
        actor: actorFromRequest(req),
        detail: { extensionKey: definition.key, restartRequired }
      })

      return {
        ok: true,
        message: restartRequired
          ? `${definition.title} was reinstalled, but this server has to be restarted before it can use it.`
          : `${definition.title} installed successfully.`,
        restartRequired
      }
    }
  )
}

export default routes
