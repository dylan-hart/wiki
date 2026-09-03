import { CONTENT_TYPES } from '../../models/storage.ts'
import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * STORAGE TARGET - A storage module as configured for a site
   */
  app.addSchema({
    $id: 'StorageTarget',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      siteId: {
        type: 'string',
        format: 'uuid',
        description: 'The site this target belongs to.'
      },
      module: {
        type: 'string',
        description: 'Directory name under `modules/storage`.'
      },
      isEnabled: {
        type: 'boolean'
      },
      title: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      icon: {
        type: 'string'
      },
      banner: {
        type: 'string'
      },
      vendor: {
        type: 'string'
      },
      website: {
        type: 'string'
      },
      contentTypes: {
        type: 'object',
        description: 'Which kinds of content this target holds.',
        properties: {
          activeTypes: {
            type: 'array',
            items: {
              type: 'string',
              enum: [...CONTENT_TYPES]
            }
          },
          largeThreshold: {
            type: 'string',
            description: 'Size above which an asset counts as a large file, e.g. `5MB`.'
          }
        }
      },
      assetDelivery: {
        type: 'object',
        description:
          'How assets reach the user. The `is*Supported` flags come from the module and are read-only.',
        properties: {
          isStreamingSupported: {
            type: 'boolean'
          },
          isDirectAccessSupported: {
            type: 'boolean'
          },
          streaming: {
            type: 'boolean'
          },
          directAccess: {
            type: 'boolean'
          }
        }
      },
      versioning: {
        type: 'object',
        description:
          'Whether past versions are kept. `isForceEnabled` marks a module where versioning is inherent, such as git.',
        properties: {
          isSupported: {
            type: 'boolean'
          },
          isForceEnabled: {
            type: 'boolean'
          },
          enabled: {
            type: 'boolean'
          }
        }
      },
      sync: {
        type: 'object',
        description:
          'How this target dispatches content. `supportedModes` and `schedule` come from the module and are read-only; a module with a single supported mode cannot have it changed per target.',
        properties: {
          supportedModes: {
            type: 'array',
            items: { type: 'string' }
          },
          schedule: {
            description:
              'ISO-8601 duration the module syncs on by default (e.g. `PT5M`), or `false` for a module that only acts on write.',
            // -> `anyOf`, not `oneOf` (OpenProject #2366, same shape as `security.ts`'s `trustProxy`):
            //    under Fastify's default AJV `coerceTypes: 'array'`, `oneOf` must evaluate every
            //    branch to count matches, so a real `false` matches the `boolean` branch and then
            //    also gets coerced to the string `"false"` for the `string` branch, and `oneOf`
            //    (exactly one match) rejects the whole property. `anyOf` short-circuits on the first
            //    match -- which is also why the `boolean` branch has to come FIRST, unlike the
            //    string-then-boolean order this replaced: with `string` first, a real `false` still
            //    gets coerced to `"false"` and matches there before the `boolean` branch is ever
            //    tried, silently turning a real boolean into a string. With `boolean` first, `false`
            //    matches immediately with no coercion attempted, and a real duration string like
            //    `PT5M` fails the `boolean` branch outright (AJV only coerces a string to boolean
            //    from the literal `"true"`/`"false"`/`"1"`/`"0"`) and falls through to match the
            //    `string` branch as-is. This field is read-only/response-only (`StorageTargetInput`
            //    -- the request-body shape a `PUT` actually accepts -- has no `schedule` property at
            //    all, only `mode`/`scheduleOverride`), so there is no live input-validation path for
            //    it to fix; this keeps the declared shape correct and consistent with `trustProxy`
            //    rather than leaving a second copy of the same broken pattern in place. One
            //    asymmetric residual quirk from AJV's coercion, harmless precisely because this is
            //    never validated against real request input: `anyOf` still lets a stray boolean
            //    `true` validate here too (it fails the `boolean` branch's `enum: [false]` check, but
            //    then coerces to the string `"true"` and matches the `string` branch) -- unlike
            //    `trustProxy`, whose `boolean` branch has no `enum` restriction and so always matches
            //    a real boolean outright, both `true` and `false`, before the `string` branch is ever
            //    tried.
            anyOf: [{ type: 'boolean', enum: [false] }, { type: 'string' }]
          },
          mode: {
            type: 'string'
          },
          scheduleOverride: {
            type: ['string', 'null'],
            description: 'Overrides the module schedule for this target, or null to trust it.'
          },
          supportsContentSync: {
            type: 'boolean',
            description:
              'Whether the module actually writes content on a page/asset change. False for a module that is configuration- and manual-action-only (e.g. disk, sftp) even when its supported mode is `push` — enabling such a target does not make it sync live.'
          }
        }
      },
      // Deliberately loose: keys and value types come from each storage module's own
      // `definition.yml` on disk, so the shape genuinely differs per module (db, git, s3, …).
      props: {
        type: 'object',
        additionalProperties: true,
        description:
          'The module configuration, declared in its `definition.yml`: each entry carries a `type`, `title`, `hint`, `default` and the display hints the admin area renders a control from. A `readOnly` prop is shown but cannot be changed, and is silently kept at its stored value when written to.'
      },
      // Deliberately loose: values for whatever `props` the module (above) declares.
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the module props, completed with the module defaults for any prop that has none stored yet.'
      },
      actions: {
        type: 'array',
        description:
          'Operations that can be run on demand. Empty for a module without an implementation, since there would be nothing to run.',
        items: {
          type: 'object',
          properties: {
            handler: {
              type: 'string'
            },
            label: {
              type: 'string'
            },
            hint: {
              type: 'string'
            },
            warn: {
              type: 'string',
              description: 'Present when the action destroys data.'
            },
            icon: {
              type: 'string'
            }
          }
        }
      }
    }
  })

  /**
   * STORAGE SYNC STATUS - A target's sync status at a glance
   */
  app.addSchema({
    $id: 'StorageSyncStatus',
    type: 'object',
    properties: {
      lastSyncedAt: {
        type: ['string', 'null'],
        description: 'The most recent successful sync to this target, across every content item.'
      },
      lastError: {
        type: ['string', 'null'],
        description: 'The error from the most recently attempted sync, if the last attempt failed.'
      },
      lastAttemptAt: {
        type: ['string', 'null'],
        description: 'When `lastError` happened. Null exactly when `lastError` is.'
      },
      outOfDateCount: {
        type: 'integer',
        description:
          'Pages plus assets with no successful sync to this target newer than their own last edit.'
      }
    }
  })

  /**
   * STORAGE TARGET INPUT - A partial update of one target
   */
  app.addSchema({
    $id: 'StorageTargetInput',
    type: 'object',
    required: ['id'],
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      isEnabled: {
        type: 'boolean',
        description: 'The database target cannot be disabled.'
      },
      contentTypes: {
        type: 'object',
        properties: {
          activeTypes: {
            type: 'array',
            items: {
              type: 'string',
              enum: [...CONTENT_TYPES]
            }
          },
          largeThreshold: {
            type: 'string',
            maxLength: 32
          }
        }
      },
      assetDelivery: {
        type: 'object',
        description: 'A delivery mode the module does not support is stored as off.',
        properties: {
          streaming: {
            type: 'boolean'
          },
          directAccess: {
            type: 'boolean'
          }
        }
      },
      versioning: {
        type: 'object',
        description:
          'Ignored by a module that does not support versioning or that forces it on — the module decides, not the client.',
        properties: {
          enabled: {
            type: 'boolean'
          }
        }
      },
      sync: {
        type: 'object',
        description:
          "Refused if `mode` is outside the module's `supportedModes`, or if the module only declares one mode.",
        properties: {
          mode: {
            type: 'string'
          },
          scheduleOverride: {
            type: ['string', 'null']
          }
        }
      },
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the module props. Validated against what the module declares: an unknown key is dropped, a wrong type is refused, and a read-only prop keeps its stored value.'
      }
    }
  })
}
