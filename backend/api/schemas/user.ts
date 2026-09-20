import type { FastifyInstance } from 'fastify'
import {
  SEARCH_FILTERS_MAX_ROWS,
  SEARCH_FILTER_MODES,
  SEARCH_FILTER_PUBLISH_STATES,
  SEARCH_FILTER_TYPES,
  SEARCH_FILTER_VALUE_MAX_LENGTH
} from '../../helpers/searchFilters.ts'
import { HOOK_EVENTS } from '../../models/hooks.ts'
import { PROFILE_PUBLIC_FIELDS } from '../../models/users.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'Passkey',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The WebAuthn credential ID, base64url-encoded.'
      },
      name: {
        type: 'string',
        description: 'What the user called it, e.g. the device it lives on.'
      },
      siteHostname: {
        type: 'string',
        description:
          'The hostname it was registered against. A passkey only works on that host, so this is stored rather than resolved from the site, which may since have been renamed.'
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      }
    }
  })

  app.addSchema({
    $id: 'UserCore',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description:
          'The display name. Derived from the two halves below on every write, unless a human has explicitly authored it — see Feature #2608.'
      },
      firstName: {
        type: 'string',
        maxLength: 255
      },
      lastName: {
        type: 'string',
        maxLength: 255,
        description: 'Empty for a mononym — nothing fabricates a surname.'
      },
      email: {
        type: 'string',
        format: 'email'
      },
      hasAvatar: {
        type: 'boolean'
      },
      avatarProviderUrl: {
        type: 'string',
        nullable: true,
        description:
          'The provider-reported avatar URL cached at login, or null when none has been synced. A manually-uploaded avatar (hasAvatar) always takes precedence over this as a rendering fallback.'
      },
      isSystem: {
        type: 'boolean'
      },
      isActive: {
        type: 'boolean'
      },
      isVerified: {
        type: 'boolean'
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
      },
      lastLoginAt: {
        // -> A plain `string` would make the serializer coerce null to an empty string. `nullable`
        //    rather than `type: ['string', 'null']`: the emitted spec declares OpenAPI 3.0, where a
        //    type array is not valid.
        type: 'string',
        nullable: true,
        format: 'date-time',
        description: 'RFC 3339 Date Time, or null if the user has never logged in'
      }
    }
  })

  app.addSchema({
    $id: 'UserDefaults',
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA time zone name, e.g. `America/New_York`.',
        maxLength: 255
      },
      dateFormat: {
        type: 'string',
        description: 'Empty string means the locale default.',
        enum: ['', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD']
      },
      timeFormat: {
        type: 'string',
        enum: ['12h', '24h']
      }
    }
  })

  /**
   * Values are strings rather than enums: this is the serialized response, and a preference stored
   * before an option existed must still be readable.
   */
  app.addSchema({
    $id: 'UserProfile',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string'
      },
      firstName: {
        type: 'string'
      },
      lastName: {
        type: 'string'
      },
      email: {
        type: 'string',
        format: 'email'
      },
      hasAvatar: {
        type: 'boolean'
      },
      avatarProviderUrl: {
        type: 'string',
        nullable: true,
        description:
          'The provider-reported avatar URL cached at login, or null when none has been synced. A manually-uploaded avatar (hasAvatar) always takes precedence over this as a rendering fallback.'
      },
      handle: {
        type: 'string',
        nullable: true,
        description:
          'The unique, case-insensitive @handle, or null when none is set. Letters, digits, dots, underscores and hyphens only.'
      },
      location: {
        type: 'string'
      },
      jobTitle: {
        type: 'string'
      },
      pronouns: {
        type: 'string'
      },
      timezone: {
        type: 'string',
        description: 'IANA time zone name, or an empty string to use the client time zone.'
      },
      dateFormat: {
        type: 'string',
        description: 'Empty string means the locale default.'
      },
      timeFormat: {
        type: 'string'
      },
      appearance: {
        type: 'string'
      },
      aesthetic: {
        type: 'string'
      },
      contentWidth: {
        type: 'string',
        description:
          "Per-user content-width preference: 'site' inherits the site's own `contentWidth` admin setting, or 'measured'/'full' overrides it for this reader on every page."
      },
      cvd: {
        type: 'string',
        description: 'Color vision deficiency to adjust the palette for.'
      },
      locale: {
        type: 'string',
        description:
          'Locale code to address this user in outbound mail. Empty string means no preference recorded (falls back to `en`).'
      },
      graph: {
        type: 'object',
        description:
          "The knowledge graph view's five persisted controls (OpenProject #2854), or absent for a user who has never saved one. Values are deliberately typed as plain strings/arrays rather than enums, same reasoning as the rest of this schema -- a preference stored before an option existed must still be readable.",
        properties: {
          groupBy: { type: 'string' },
          sizeBy: { type: 'string' },
          count: { type: 'string' },
          over: { type: 'string' },
          clientTypes: { type: 'array', items: { type: 'string' } }
        }
      },
      iconPicker: {
        type: 'object',
        description:
          "The icon picker's persisted icon-set filter, or absent for a user who has never saved one. A plain string, same reasoning as `graph` above -- a preference stored before a set existed must still be readable.",
        properties: {
          set: { type: 'string' }
        }
      },
      publicFields: {
        type: 'array',
        description:
          'The About Me fields this user chose to show other users. Does not include the ones an administrator forces public: those are in `forcedPublicFields`.',
        items: { type: 'string', enum: [...PROFILE_PUBLIC_FIELDS] }
      },
      forcedPublicFields: {
        type: 'array',
        description:
          'The About Me fields an administrator shows to other users on every profile, whatever `publicFields` says. Read-only here; a forced field is only visible once it is filled in.',
        items: { type: 'string', enum: [...PROFILE_PUBLIC_FIELDS] }
      },
      searchFilters: {
        type: 'array',
        description:
          "The user's saved search filter rows, or absent for a user who has never saved any. Plain strings rather than enums, same reasoning as `graph` above -- a row stored before an option existed must still be readable.",
        items: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            type: { type: 'string' },
            value: { type: 'string' }
          }
        }
      }
    }
  })

  app.addSchema({
    $id: 'UserPublicProfile',
    type: 'object',
    description:
      'What another user may see of an account. Never carries the email, and `fields` holds only the About Me fields that are both public and filled in.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      hasAvatar: { type: 'boolean' },
      avatarProviderUrl: { type: 'string', nullable: true },
      fields: {
        type: 'object',
        properties: Object.fromEntries(
          PROFILE_PUBLIC_FIELDS.map((field) => [field, { type: 'string' }])
        )
      }
    }
  })

  app.addSchema({
    $id: 'ProfileVisibility',
    type: 'object',
    properties: {
      forcedPublicFields: {
        type: 'array',
        description:
          'About Me fields shown to other users on every profile. Forcing a field public does not require anybody to fill it in.',
        items: { type: 'string', enum: [...PROFILE_PUBLIC_FIELDS] },
        uniqueItems: true
      },
      guestsMayView: {
        type: 'boolean',
        description:
          "Whether signed-out visitors may open another user's profile. Off by default: guests are answered 401."
      }
    },
    additionalProperties: false
  })

  /**
   * The email is absent on purpose: it identifies the account and is the local strategy's username.
   */
  app.addSchema({
    $id: 'UserProfileUpdate',
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description:
          'The display name, sent only to author it explicitly. Sending exactly what `firstName`/`lastName` derive to puts the account back on derivation rather than marking it authored.'
      },
      firstName: {
        type: 'string',
        maxLength: 255
      },
      lastName: {
        type: 'string',
        maxLength: 255,
        description: 'May be empty — a mononym derives its display name from `firstName` alone.'
      },
      handle: {
        type: 'string',
        maxLength: 32,
        description:
          'A unique, case-insensitive handle of letters, digits, dots, underscores and hyphens. An empty string clears it; one already taken answers 409.'
      },
      location: {
        type: 'string',
        maxLength: 255
      },
      jobTitle: {
        type: 'string',
        maxLength: 255
      },
      pronouns: {
        type: 'string',
        maxLength: 255
      },
      timezone: {
        type: 'string',
        description: 'IANA time zone name, e.g. `America/New_York`.',
        maxLength: 255
      },
      dateFormat: {
        type: 'string',
        description: 'Empty string means the locale default.',
        enum: ['', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD']
      },
      timeFormat: {
        type: 'string',
        enum: ['12h', '24h']
      },
      appearance: {
        type: 'string',
        enum: ['site', 'light', 'dark']
      },
      aesthetic: {
        type: 'string',
        enum: ['site', 'ledger', 'cobalt']
      },
      contentWidth: {
        type: 'string',
        description:
          "'site' (default) inherits the site's own `contentWidth` admin setting; 'measured'/'full' overrides it for this reader on every page they view, regardless of what the site currently has configured.",
        enum: ['site', 'measured', 'full']
      },
      cvd: {
        type: 'string',
        enum: ['none', 'protanopia', 'deuteranopia', 'tritanopia']
      },
      locale: {
        type: 'string',
        description:
          'Locale code to address this user in outbound mail. Must be a locale installed on this instance, or an empty string to clear the preference.',
        maxLength: 35
      },
      graph: {
        type: 'object',
        description:
          "The knowledge graph view's five persisted controls (OpenProject #2854): group-by, size-by, the unique/total count mode, the pageviews time window, and the pageview client types. Always sent as one whole object -- the graph page saves the merged five back together, never one key at a time.",
        properties: {
          groupBy: { type: 'string', enum: ['folder', 'tag', 'classification'] },
          sizeBy: { type: 'string', enum: ['edits', 'visits'] },
          count: { type: 'string', enum: ['unique', 'total'] },
          over: { type: 'string', enum: ['last30d', 'last6mo', 'last2yr'] },
          clientTypes: {
            type: 'array',
            items: { type: 'string', enum: ['browser', 'api', 'mcp'] }
          }
        },
        additionalProperties: false
      },
      iconPicker: {
        type: 'object',
        description:
          'The icon picker\'s persisted icon-set filter -- an Iconify set prefix (`tabler`, `mdi`, ...), or an empty string for "every enabled set." Not an enum: which sets exist is instance-specific and only known at runtime, same reasoning as `locale` above.',
        properties: {
          set: { type: 'string', maxLength: 255 }
        },
        additionalProperties: false
      },
      publicFields: {
        type: 'array',
        description:
          'The About Me fields to show other users, replacing the stored list. An empty array hides them all (apart from any an administrator forces public).',
        items: { type: 'string', enum: [...PROFILE_PUBLIC_FIELDS] },
        uniqueItems: true
      },
      searchFilters: {
        type: 'array',
        description: `The user's saved search filter rows, replaced wholesale on every save; an empty array clears them. A \`publishState\` row's value must be one of ${SEARCH_FILTER_PUBLISH_STATES.join(', ')}, which the server checks beyond this schema. Stored per account so any device sees the same rows.`,
        maxItems: SEARCH_FILTERS_MAX_ROWS,
        items: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: [...SEARCH_FILTER_MODES] },
            type: { type: 'string', enum: [...SEARCH_FILTER_TYPES] },
            value: { type: 'string', minLength: 1, maxLength: SEARCH_FILTER_VALUE_MAX_LENGTH }
          },
          required: ['mode', 'type', 'value'],
          additionalProperties: false
        }
      }
    }
  })

  /**
   * Unrelated to the `Notification` schema (`schemas/notification.ts`, the in-app page-watch
   * inbox): this is a per-user, per-event-type email toggle, not a per-page watch.
   */
  app.addSchema({
    $id: 'UserNotificationSubscriptions',
    type: 'object',
    description:
      'Per-event-type email notification subscription, keyed by event (e.g. `page:create`). Every event this instance can fire is always present; one never explicitly set defaults to false.',
    properties: Object.fromEntries(HOOK_EVENTS.map((event) => [event, { type: 'boolean' }])),
    additionalProperties: false
  })

  app.addSchema({
    $id: 'UserNotificationSubscriptionsUpdate',
    type: 'object',
    description: 'Any subset of event types to change; omitted ones are left as they are.',
    properties: Object.fromEntries(HOOK_EVENTS.map((event) => [event, { type: 'boolean' }])),
    additionalProperties: false
  })

  app.addSchema({
    $id: 'User',
    allOf: [
      {
        $ref: 'UserCore#'
      },
      {
        type: 'object',
        properties: {
          // Deliberately loose: `models/users.ts` treats `meta`/`prefs` as free-form blobs.
          meta: {
            type: 'object',
            additionalProperties: true
          },
          prefs: {
            type: 'object',
            additionalProperties: true
          },
          auth: {
            type: 'array',
            description:
              'Authentication providers linked to this user. Secrets are never included — `config.isPasswordSet` and `config.isTfaSetup` report their state instead.',
            items: {
              type: 'object',
              properties: {
                authId: {
                  type: 'string',
                  format: 'uuid'
                },
                authName: {
                  type: 'string'
                },
                strategyKey: {
                  type: 'string'
                },
                strategyIcon: {
                  type: 'string'
                },
                // Deliberately loose: values for whichever props the linked module declares.
                config: {
                  type: 'object',
                  additionalProperties: true
                }
              }
            }
          },
          groups: {
            type: 'array',
            description: 'Groups this user belongs to.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  format: 'uuid'
                },
                name: {
                  type: 'string'
                }
              }
            }
          }
        }
      }
    ]
  })
}
