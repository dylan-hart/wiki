import type { FastifyInstance, FastifyRequest } from 'fastify'

const PICKER_GLOBAL_PERMISSIONS = ['manage:sites', 'manage:system']

const PICKER_AUTHOR_ROLES = ['write:pages', 'manage:pages']

/**
 * Anyone who can put an icon somewhere needs to search for one and have it stored. The picker has
 * no path to check a rule against, so this asks the coarser `mayHoldPermissionSomewhere()`
 * question. An in-handler check because `config.permissions` reads the group-wide list only, and
 * `write:pages`/`manage:pages` are granted by page rules: declared there, they refuse every author.
 */
function mayUseIconPicker(req: FastifyRequest): boolean {
  const actor = CARDINAL.models.groups.actorForRequest(req)
  if (PICKER_GLOBAL_PERMISSIONS.some((permission) => actor.permissions.includes(permission))) {
    return true
  }
  // -> `null`: icon sets are instance-wide, so there is no site to narrow by.
  return CARDINAL.models.groups.mayHoldPermissionSomewhere(actor, PICKER_AUTHOR_ROLES, null)
}

/** The icons themselves are served outside `/_api`, under `/_icons`: see `controllers/icons.ts`. */
async function routes(app: FastifyInstance) {
  // No route-level permissions: picker access — see mayUseIconPicker() above.
  app.get(
    '/sets',
    {
      schema: {
        summary: 'List the icon sets added to this wiki',
        description:
          'Alphabetical. `iconCount` is how many icons of the set are stored in the database, which is what this instance can serve on its own — the disk cache is derived from those rows and may be empty.',
        tags: ['Icons'],
        response: {
          200: {
            description: 'List of icon sets',
            type: 'array',
            items: { $ref: 'IconSet#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!mayUseIconPicker(req)) {
        return reply.forbidden()
      }
      return CARDINAL.models.icons.getSets()
    }
  )

  app.post<{ Body: { prefix: string } }>(
    '/sets',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Add an icon set',
        description:
          'The set must exist upstream, and its name and metadata are taken from there — so this call needs outbound access to the Iconify API. Nothing is downloaded beyond the metadata: icons are stored the first time something references them.',
        tags: ['Icons'],
        body: {
          type: 'object',
          required: ['prefix'],
          properties: {
            prefix: {
              type: 'string',
              maxLength: 64,
              description: 'Iconify prefix of the set, e.g. `tabler`.'
            }
          }
        },
        response: {
          200: {
            description: 'Icon set added successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              set: { $ref: 'IconSet#' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      try {
        const set = await CARDINAL.models.icons.addSet(req.body.prefix.toLowerCase())
        return {
          ok: true,
          message: `The ${set.name} icon set has been added.`,
          set
        }
      } catch (err: any) {
        // -> No log line: admin-only, and the reply already carries the whole reason.
        return reply.badRequest(err.message)
      }
    }
  )

  app.put<{ Params: { prefix: string }; Body: { isEnabled: boolean } }>(
    '/sets/:prefix',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Enable or disable an icon set',
        description:
          'A disabled set disappears from the picker and stops taking on new icons. Icons already stored for it keep being served, since content referencing them is already published.',
        tags: ['Icons'],
        params: {
          type: 'object',
          properties: {
            prefix: {
              type: 'string',
              maxLength: 64
            }
          },
          required: ['prefix']
        },
        body: {
          type: 'object',
          required: ['isEnabled'],
          properties: {
            isEnabled: {
              type: 'boolean'
            }
          }
        },
        response: {
          200: {
            description: 'Icon set updated successfully',
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
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const prefix = req.params.prefix.toLowerCase()
      if (!(await CARDINAL.models.icons.getSet(prefix))) {
        return reply.notFound('Icon set has not been added.')
      }
      await CARDINAL.models.icons.setSetState(prefix, req.body.isEnabled)
      return {
        ok: true,
        message: `The ${prefix} icon set has been ${req.body.isEnabled ? 'enabled' : 'disabled'}.`
      }
    }
  )

  app.delete<{ Params: { prefix: string } }>(
    '/sets/:prefix',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Delete an icon set',
        description:
          'Deletes the set and every icon stored for it, and drops its disk cache. Content still referencing those icons stops rendering them — disable the set instead to keep serving what is already in use.',
        tags: ['Icons'],
        params: {
          type: 'object',
          properties: {
            prefix: {
              type: 'string',
              maxLength: 64
            }
          },
          required: ['prefix']
        },
        response: {
          200: {
            description: 'Icon set deleted successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              deletedIcons: {
                type: 'integer'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const prefix = req.params.prefix.toLowerCase()
      if (!(await CARDINAL.models.icons.getSet(prefix))) {
        return reply.notFound('Icon set has not been added.')
      }
      const deletedIcons = await CARDINAL.models.icons.deleteSet(prefix)
      return {
        ok: true,
        message: `The ${prefix} icon set has been deleted.`,
        deletedIcons
      }
    }
  )

  app.get(
    '/available-sets',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the icon sets offered by the Iconify API',
        description:
          'The catalog an administrator picks from, marking the sets already added. Fetched from upstream and memoized for an hour, so it needs outbound access.',
        tags: ['Icons'],
        response: {
          200: {
            description: 'List of available icon sets',
            type: 'array',
            items: { $ref: 'AvailableIconSet#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          502: { $ref: 'ApiError#', description: 'The Iconify API could not be reached.' }
        }
      }
    },
    async (_req, reply) => {
      try {
        return await CARDINAL.models.icons.getAvailableSets()
      } catch (err: any) {
        CARDINAL.logger.warn('icons', 'could not list the available sets from the Iconify API', {
          error: err
        })
        return reply.badGateway(`Could not reach the Iconify API: ${err.message}`)
      }
    }
  )

  app.post(
    '/sets/refresh',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Refresh the metadata of every added icon set',
        description:
          'Re-reads names, totals and licenses from upstream. Stored icons are untouched.',
        tags: ['Icons'],
        response: {
          200: {
            description: 'Icon sets refreshed successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              refreshed: {
                type: 'integer'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          502: { $ref: 'ApiError#', description: 'The Iconify API could not be reached.' }
        }
      }
    },
    async (_req, reply) => {
      try {
        const refreshed = await CARDINAL.models.icons.refreshSets()
        return {
          ok: true,
          message: `Refreshed ${refreshed} icon sets.`,
          refreshed
        }
      } catch (err: any) {
        CARDINAL.logger.warn('icons', 'could not refresh the sets from the Iconify API', {
          error: err
        })
        return reply.badGateway(`Could not reach the Iconify API: ${err.message}`)
      }
    }
  )

  app.post(
    '/sideload',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Sideload icon sets from the data volume',
        description:
          'Rescans `<dataPath>/icons/` for vendored Iconify collection JSON files and loads them into the DB — the offline-mode path (OpenProject #820/#2939) for adding or updating an icon set against a running instance with no rebuild, redeploy, or network access. Always re-loads every file found there: unlike the locale sideload, there is no freshness gate to force past.',
        tags: ['Icons'],
        response: {
          200: {
            description: 'What the rescan did',
            type: 'object',
            properties: {
              loaded: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    prefix: { type: 'string' },
                    iconCount: { type: 'integer' }
                  }
                },
                description: 'Icon sets loaded or updated from the sideload directory.'
              },
              skipped: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    prefix: { type: 'string' },
                    error: { type: 'string' }
                  }
                },
                description: 'Files found but rejected, with why.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.models.icons.sideloadFromDataPath()
    }
  )

  // No route-level permissions: picker access — see mayUseIconPicker() above.
  app.get<{ Querystring: { query: string; prefixes?: string; limit?: number } }>(
    '/search',
    {
      schema: {
        summary: 'Search icons across the enabled icon sets',
        description:
          'Searched upstream, then narrowed to the sets enabled here — so results are always icons that can actually be used. Returns references shaped `prefix:name`, which is what content stores.',
        tags: ['Icons'],
        querystring: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              minLength: 2,
              maxLength: 128
            },
            prefixes: {
              type: 'string',
              description:
                'Comma-separated set prefixes to search in. Defaults to every enabled set.'
            },
            limit: {
              type: 'integer',
              minimum: 32,
              maximum: 999,
              default: 96
            }
          }
        },
        response: {
          200: {
            description: 'Matching icon references',
            type: 'object',
            properties: {
              icons: {
                type: 'array',
                items: {
                  type: 'string'
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          502: { $ref: 'ApiError#', description: 'The Iconify API could not be reached.' }
        }
      }
    },
    async (req, reply) => {
      if (!mayUseIconPicker(req)) {
        return reply.forbidden()
      }
      try {
        const icons = await CARDINAL.models.icons.searchIcons({
          query: req.query.query,
          prefixes: req.query.prefixes?.split(',').filter(Boolean),
          limit: req.query.limit
        })
        return { icons }
      } catch (err: any) {
        CARDINAL.logger.warn('icons', 'could not search the Iconify API', { error: err })
        return reply.badGateway(`Could not reach the Iconify API: ${err.message}`)
      }
    }
  )

  // No route-level permissions: picker access — see mayUseIconPicker() above.
  app.get<{ Params: { prefix: string } }>(
    '/sets/:prefix/icons',
    {
      schema: {
        summary: 'List every icon name in an enabled set',
        description:
          'For browsing a set with no search term. Deprecated icons are left out. Fetched from upstream and memoized for an hour.',
        tags: ['Icons'],
        params: {
          type: 'object',
          properties: {
            prefix: {
              type: 'string',
              maxLength: 64
            }
          },
          required: ['prefix']
        },
        response: {
          200: {
            description: 'Icon names, without the set prefix',
            type: 'object',
            properties: {
              prefix: {
                type: 'string'
              },
              icons: {
                type: 'array',
                items: {
                  type: 'string'
                }
              }
            }
          },
          400: { $ref: 'ApiError#', description: 'The set is not enabled or does not exist.' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!mayUseIconPicker(req)) {
        return reply.forbidden()
      }
      const prefix = req.params.prefix.toLowerCase()
      try {
        return { prefix, icons: await CARDINAL.models.icons.listSetIcons(prefix) }
      } catch (err: any) {
        // -> No log line: the reply already carries the whole reason.
        return reply.badRequest(err.message)
      }
    }
  )

  // No route-level permissions: picker access — see mayUseIconPicker() above.
  app.post<{ Body: { icons: string[] } }>(
    '/materialize',
    {
      schema: {
        summary: 'Store icons so this instance can serve them',
        description:
          'Called when an icon is chosen, while the author is online: it fetches the icon from upstream and writes it to the database, after which the wiki serves it forever without the Iconify API. Icons already stored are a no-op.',
        tags: ['Icons'],
        body: {
          type: 'object',
          required: ['icons'],
          properties: {
            icons: {
              type: 'array',
              minItems: 1,
              maxItems: 128,
              items: {
                type: 'string',
                maxLength: 320,
                description: 'An icon reference shaped `prefix:name`.'
              }
            }
          }
        },
        response: {
          200: {
            description: 'Icons materialized',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              failed: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description:
                  'References that could not be stored: malformed, from a set that is not enabled, or unknown upstream.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!mayUseIconPicker(req)) {
        return reply.forbidden()
      }
      const failed = await CARDINAL.models.icons.materializeIcons(req.body.icons)
      return {
        ok: failed.length < 1,
        message:
          failed.length < 1
            ? 'Icons are stored and ready to be served.'
            : `${failed.length} of ${req.body.icons.length} icons could not be stored.`,
        failed
      }
    }
  )

  app.get(
    '/cache',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Report what this instance holds and has cached',
        description:
          '`iconCount` is permanent (database), the rest is this instance’s cache and can be discarded at any time.',
        tags: ['Icons'],
        response: {
          200: {
            description: 'Icon storage and cache state',
            type: 'object',
            properties: {
              setCount: {
                type: 'integer'
              },
              enabledSetCount: {
                type: 'integer'
              },
              iconCount: {
                type: 'integer'
              },
              memoryCount: {
                type: 'integer'
              },
              diskCount: {
                type: 'integer'
              },
              diskSize: {
                type: 'integer',
                description: 'Bytes held by the SVG files in the disk cache.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.models.icons.getStats()
    }
  )

  app.delete(
    '/cache',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Purge the icon cache of this instance',
        description:
          'Empties the memory and disk caches. Nothing is lost — both are rebuilt from the database as icons are requested again.',
        tags: ['Icons'],
        response: {
          200: {
            description: 'Cache purged successfully',
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
    async () => {
      await CARDINAL.models.icons.purgeCache()
      return {
        ok: true,
        message: 'The icon cache has been purged.'
      }
    }
  )
}

export default routes
