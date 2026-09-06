import type { FastifyInstance } from 'fastify'
import { HOOK_EVENTS } from '../../models/hooks.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * PASSKEY - One registered authenticator, without any of its key material
   */
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

  /**
   * USER CORE - Essential fields only
   */
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
        // -> Users who have never logged in have no value here, and a plain `string` would make the
        //    serializer coerce null to an empty string. `nullable` is used rather than
        //    `type: ['string', 'null']` because the emitted spec declares OpenAPI 3.0, where a type
        //    array is not valid.
        type: 'string',
        nullable: true,
        format: 'date-time',
        description: 'RFC 3339 Date Time, or null if the user has never logged in'
      }
    }
  })

  /**
   * USER DEFAULTS - Instance-wide defaults applied to new users
   */
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
   * USER PROFILE - The logged in user's own view of itself
   *
   * The `meta` / `prefs` blobs are flattened into plain fields here. Values are deliberately typed as
   * strings rather than enums: this is the serialized response, and a preference stored before an
   * option existed must still be readable.
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
      cvd: {
        type: 'string',
        description: 'Color vision deficiency to adjust the palette for.'
      },
      locale: {
        type: 'string',
        description:
          'Locale code to address this user in outbound mail. Empty string means no preference recorded (falls back to `en`).'
      }
    }
  })

  /**
   * USER PROFILE UPDATE - The fields a user may change on its own profile
   *
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
      cvd: {
        type: 'string',
        enum: ['none', 'protanopia', 'deuteranopia', 'tritanopia']
      },
      locale: {
        type: 'string',
        description:
          'Locale code to address this user in outbound mail. Must be a locale installed on this instance, or an empty string to clear the preference.',
        maxLength: 35
      }
    }
  })

  /**
   * USER NOTIFICATION SUBSCRIPTIONS - one boolean per event type the logged in user may opt into
   * receiving an email for (Feature #2425)
   *
   * Both this and its `...Update` sibling below generate their `properties` from `HOOK_EVENTS`
   * (`models/hooks.ts`) rather than listing the 18 keys by hand, so a future event added there needs
   * no schema edit here to become selectable. This is a distinct concept from the unrelated
   * `Notification` schema (`schemas/notification.ts`, the in-app page-watch inbox backed by
   * `pageWatchEvents`) -- this one is a per-user, per-event-TYPE toggle read by `#2481`'s email
   * dispatch, not a per-page watch.
   */
  app.addSchema({
    $id: 'UserNotificationSubscriptions',
    type: 'object',
    description:
      'Per-event-type email notification subscription, keyed by event (e.g. `page:create`). Every event this instance can fire is always present; one never explicitly set defaults to false.',
    properties: Object.fromEntries(HOOK_EVENTS.map((event) => [event, { type: 'boolean' }])),
    additionalProperties: false
  })

  /**
   * USER NOTIFICATION SUBSCRIPTIONS UPDATE - any subset of event types to change
   */
  app.addSchema({
    $id: 'UserNotificationSubscriptionsUpdate',
    type: 'object',
    description: 'Any subset of event types to change; omitted ones are left as they are.',
    properties: Object.fromEntries(HOOK_EVENTS.map((event) => [event, { type: 'boolean' }])),
    additionalProperties: false
  })

  /**
   * USER - All fields
   */
  app.addSchema({
    $id: 'User',
    allOf: [
      {
        $ref: 'UserCore#'
      },
      {
        type: 'object',
        properties: {
          // Deliberately loose: `models/users.ts` treats `meta`/`prefs` as free-form blobs (its own
          // comment says so at `updateProfile()`) — `meta` holds ad-hoc profile fields plus internal
          // bookkeeping like a login-attempt counter, `prefs` is keyed per editor under
          // `prefs.editors[editor]` so each editor owns an arbitrary blob of its own.
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
                // Deliberately loose: same reason as `AuthStrategy.config` in schemas/authentication.ts
                // — values for whichever props the linked module declares.
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
