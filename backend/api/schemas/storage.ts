import { CONTENT_TYPES } from '../../models/storage.ts'
import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
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
          supportedTypes: {
            type: 'array',
            description:
              'The content types the module can act on, read-only. An object-store module lists no `pages`, and `activeTypes` never holds a type it does not support.',
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
          isReadThroughSupported: {
            type: 'boolean'
          },
          streaming: {
            type: 'boolean'
          },
          directAccess: {
            type: 'boolean'
          },
          readThrough: {
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
            // -> `anyOf` with `boolean` first, not `oneOf`: under Fastify's default AJV
            //    `coerceTypes: 'array'` a real `false` also coerces into the `string` branch, which
            //    `oneOf` (exactly one match) rejects and a `string`-first `anyOf` silently turns into
            //    `"false"`. A stray `true` still coerces to `"true"` and validates -- harmless, since
            //    this field is response-only (`StorageTargetInput` has no `schedule`).
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
      props: {
        type: 'object',
        additionalProperties: true,
        description:
          'The module configuration, declared in its `definition.yml`: each entry carries a `type`, `title`, `hint`, `default` and the display hints the admin area renders a control from. A `readOnly` prop is shown but cannot be changed, and is silently kept at its stored value when written to.'
      },
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
          },
          readThrough: {
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
