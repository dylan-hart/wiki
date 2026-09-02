import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

/**
 * The optional native extensions (Pandoc, Puppeteer, ...): what is available, what is actually
 * installed and working, and installing one.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST EXTENSIONS
   */
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
      return WIKI.models.extensions.getExtensions()
    }
  )

  /**
   * EXTENSIONS STATUS
   */
  app.get(
    '/extensions/status',
    {
      /*
        No route-level `permissions`, unlike LIST EXTENSIONS above: this is the lightweight presence
        check a feature gated on an extension asks before showing itself — e.g. the page-import menu
        item (task 668) asking whether Pandoc is installed — and every caller who could see that menu,
        not just `manage:system` admins, needs an answer. It carries none of the admin-only detail
        the full listing does (description, website, install eligibility), only whether each key is
        installed, so there is nothing here worth gating.
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
      const extensions = await WIKI.models.extensions.getExtensions()
      return Object.fromEntries(extensions.map((ext) => [ext.key, ext.isInstalled]))
    }
  )

  /**
   * INSTALL EXTENSION
   */
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
      const definition = WIKI.models.extensions.getDefinition(req.params.extensionKey)
      if (!definition) {
        return reply.notFound('Extension does not exist.')
      }
      if (!WIKI.models.extensions.isCompatible(definition)) {
        return reply.conflict('This extension is not compatible with this system.')
      }
      if (definition.isInstallable !== true) {
        return reply.conflict(
          `${definition.title} must be installed manually. See the documentation for instructions.`
        )
      }

      try {
        await WIKI.models.extensions.install(definition)
      } catch (err: any) {
        // -> The message carries npm's own output, which is the only thing that explains a failure
        //    like a missing build toolchain. An administrator is the only caller.
        return reply.internalServerError(err.message)
      }

      // -> A fresh install is usable at once, since nothing has tried to load it yet. Repairing one this
      //    process already choked on is a different story, and saying so beats leaving an administrator
      //    to wonder why nothing changed.
      const restartRequired = WIKI.models.extensions.hasLoadFailed(definition)

      await WIKI.models.auditLog.record({
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
