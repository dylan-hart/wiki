import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { CustomError, rethrowAsBadRequest } from '../../helpers/common.ts'
import { siteForHostname } from '../../helpers/siteResolution.ts'
import { detectImageMime, imageMimeTypes } from '../../helpers/images.ts'
import { issueKey, validateApiKeyInput } from '../../models/apiKeys.ts'
import type { KeyExpiration } from '../../models/apiKeys.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import type {
  NotificationSubscriptions,
  UserProfile,
  UserProfilePatch
} from '../../models/users.ts'

/** How large an avatar upload may be, before any resizing. */
const avatarUploadLimit = 2 * 1024 * 1024

/** A group's identity only -- no member count, no permissions. Shared by both halves of `GET /profile/groups`. */
const GROUP_IDENTITY_SCHEMA = {
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

/**
 * The user the session belongs to, or null when the request is not from a logged in user.
 *
 * The `/profile` routes are session-authenticated rather than permission-gated: every logged in user
 * may read and change its own profile, and no permission expresses that.
 *
 * Exported for `./admin.ts`, whose delete route asks the same question ("is the caller deleting
 * themselves?") about a request that is NOT behind this file's `requireSessionUser` hook and so has
 * to handle the null answer itself.
 */
export function sessionUserIdOrNull(req: FastifyRequest): string | null {
  return req.session?.authenticated && req.session.user?.id ? req.session.user.id : null
}

/**
 * Refuse a request carrying no logged in session, before any handler in this sub-plugin runs.
 *
 * Every one of these routes opened with the same four lines -- `const userId = sessionUserId(req)`,
 * then `if (!userId) return reply.unauthorized()` -- 21 identical copies (API-F5). As a `preHandler`
 * it runs at exactly the point in the lifecycle those did: after body/querystring validation, so a
 * malformed request still answers 400 first, and after the app-level route-permission hook. The 401
 * body is unchanged, since `reply.unauthorized()` is called with no message here too.
 */
async function requireSessionUser(req: FastifyRequest, reply: FastifyReply) {
  if (!sessionUserIdOrNull(req)) {
    return reply.unauthorized()
  }
}

/**
 * The user this request's session belongs to.
 *
 * Non-null by construction rather than by a check: every route in this sub-plugin sits behind
 * `requireSessionUser`, which has already answered 401 for a session-less request by the time any
 * handler runs.
 */
function sessionUserId(req: FastifyRequest): string {
  return sessionUserIdOrNull(req)!
}

/**
 * Whether self-service profile editing is enabled on the site being browsed.
 *
 * It is a per-site feature: an instance whose user data comes from an external identity provider turns
 * it off. The site is resolved from the request hostname, which is how the admin flag is scoped; an
 * unresolvable hostname leaves the feature at its default.
 */
async function isProfileEditable(req: FastifyRequest): Promise<boolean> {
  const site = await siteForHostname(req.hostname)
  return !site || site.config?.features?.profile !== false
}

/**
 * Whether the profile Groups tab's "other groups" section is enabled on the site being browsed.
 *
 * Off by default: unlike `isProfileEditable`, an unresolvable site does NOT fall back to enabled --
 * naming every group's identity to every logged in user is only ever done because an administrator
 * explicitly opted in, never as a default.
 */
async function isShowOtherGroupsEnabled(req: FastifyRequest): Promise<boolean> {
  const site = await siteForHostname(req.hostname)
  return site?.config?.features?.showOtherGroups === true
}

/**
 * The signed-in user's own account: profile, avatar, groups, editor settings, personal access keys,
 * password, 2FA and passkeys.
 *
 * Nothing here is permission-gated -- these routes are SESSION-authenticated, since every logged in
 * user may read and change their own account and no permission expresses that. That single condition
 * is the `requireSessionUser` hook below, registered once for the whole sub-plugin rather than
 * repeated as the same four lines at the top of all 21 handlers (API-F5).
 */
async function routes(app: FastifyInstance) {
  app.addHook('preHandler', requireSessionUser)

  // -> An avatar upload is the raw image rather than a multipart form: one file, no fields, and no
  //    dependency to add. Registered inside this plugin, so every other route keeps rejecting an
  //    image body outright.
  app.addContentTypeParser(
    [...imageMimeTypes],
    { parseAs: 'buffer', bodyLimit: avatarUploadLimit },
    (req, body, done) => {
      done(null, body)
    }
  )

  /**
   * GET OWN PROFILE
   */
  app.get(
    '/profile',
    {
      schema: {
        summary: "Get the logged in user's own profile",
        description:
          'Returns the profile of the user the session belongs to, with the `meta` / `prefs` blobs flattened into plain fields.',
        tags: ['Users'],
        response: {
          200: {
            description: 'User profile',
            type: 'object',
            $ref: 'UserProfile#'
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const userId = sessionUserId(req)
      const profile = await WIKI.models.users.getProfile(userId)
      if (!profile) {
        // -> The session outlived the user it points at
        return reply.unauthorized()
      }
      return profile
    }
  )

  /**
   * UPDATE OWN PROFILE
   */
  app.put<{ Body: UserProfilePatch }>(
    '/profile',
    {
      schema: {
        summary: "Update the logged in user's own profile",
        description:
          'Updates any subset of the profile fields; omitted ones are left unchanged. Requires the current site to have the `profile` feature enabled. The email cannot be changed here, and neither can any field an administrator owns.',
        tags: ['Users'],
        body: {
          $ref: 'UserProfileUpdate#'
        },
        response: {
          200: {
            description: 'Profile updated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              profile: {
                $ref: 'UserProfile#'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)
      if (!(await isProfileEditable(req))) {
        return reply.forbidden('Profile editing is disabled on this site.')
      }

      // -> A bad time zone would break every date the user sees, and the list of valid zones is only
      //    known at runtime, so it cannot be expressed as a schema enum
      if (req.body.timezone !== undefined && req.body.timezone !== '') {
        if (!Intl.supportedValuesOf('timeZone').includes(req.body.timezone)) {
          throw new CustomError(
            'userProfileInvalidTimezone',
            `Not a recognized IANA time zone: ${req.body.timezone}`
          )
        }
      }

      const patch: UserProfilePatch = {}
      for (const key of [
        'name',
        'location',
        'jobTitle',
        'pronouns',
        'timezone',
        'dateFormat',
        'timeFormat',
        'appearance',
        'cvd',
        'locale'
      ] as const) {
        if (req.body[key] !== undefined) {
          patch[key] = req.body[key]
        }
      }
      if (Object.keys(patch).length < 1) {
        throw new CustomError('userProfileEmpty', 'No profile fields provided to update.')
      }
      if (patch.name !== undefined && !/^[^<>"]+$/.test(patch.name)) {
        throw new CustomError('userProfileInvalidName', 'Invalid User Name')
      }

      let profile: UserProfile | null
      try {
        profile = await WIKI.models.users.updateProfile(userId, patch)
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
      if (!profile) {
        return reply.unauthorized()
      }

      // -> The session carries a copy of the name and the preferences, which `/whoami` serves on
      //    every page load. Left alone, it would hand back the pre-save values.
      req.session.user = {
        ...req.session.user!,
        name: profile.name,
        timezone: profile.timezone,
        dateFormat: profile.dateFormat,
        timeFormat: profile.timeFormat,
        appearance: profile.appearance,
        cvd: profile.cvd,
        locale: profile.locale
      }

      return {
        ok: true,
        message: 'Profile updated successfully.',
        profile
      }
    }
  )

  /**
   * UPLOAD OWN AVATAR
   */
  app.put(
    '/profile/avatar',
    {
      schema: {
        summary: "Replace the logged in user's own avatar",
        description: `The body is the raw image, not a multipart form — send the file itself with its \`Content-Type\`. At most ${avatarUploadLimit / 1024 / 1024} MB, and it must really be one of the accepted formats: the bytes are checked, not the declared type. Resized to a 180x180 JPEG when the Sharp extension is installed, otherwise stored as uploaded. Requires the current site to have the \`profile\` feature enabled.`,
        tags: ['Users'],
        consumes: [...imageMimeTypes],
        response: {
          200: {
            description: 'Avatar uploaded successfully',
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
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)
      if (!(await isProfileEditable(req))) {
        return reply.forbidden('Profile editing is disabled on this site.')
      }

      const data = req.body
      if (!Buffer.isBuffer(data) || data.length < 1) {
        throw new CustomError('userAvatarEmpty', 'No image was sent.')
      }
      // -> The declared content type got the request this far; what the bytes actually are is what
      //    decides, since they are what gets stored and served back
      if (!detectImageMime(data)) {
        throw new CustomError(
          'userAvatarInvalidImage',
          'Not a PNG, JPEG, WebP or GIF image, whatever the request said it was.'
        )
      }

      await WIKI.models.users.setAvatar(userId, data)
      // -> The account menu reads `hasAvatar` off the session on every page load
      req.session.user = { ...req.session.user!, hasAvatar: true }

      return {
        ok: true,
        message: 'Avatar uploaded successfully.'
      }
    }
  )

  /**
   * CLEAR OWN AVATAR
   */
  app.delete(
    '/profile/avatar',
    {
      schema: {
        summary: "Remove the logged in user's own avatar",
        description:
          'Leaves the user to be rendered as a placeholder again. Succeeds even if there was no avatar to remove. Requires the current site to have the `profile` feature enabled.',
        tags: ['Users'],
        response: {
          200: {
            description: 'Avatar cleared successfully',
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
      const userId = sessionUserId(req)
      if (!(await isProfileEditable(req))) {
        return reply.forbidden('Profile editing is disabled on this site.')
      }

      await WIKI.models.users.clearAvatar(userId)
      req.session.user = { ...req.session.user!, hasAvatar: false }

      return {
        ok: true,
        message: 'Avatar cleared successfully.'
      }
    }
  )

  /**
   * GET OWN GROUPS
   *
   * A user may see which groups it belongs to without holding `read:groups`, which would expose every
   * group on the instance. When the site being browsed has `features.showOtherGroups` enabled, the
   * response also names the groups the caller does NOT belong to -- gated here, at the source, rather
   * than always fetching the full roster and trusting the frontend to hide the non-member half: that
   * would defeat this route's entire reason for existing (see above), the moment the setting is off.
   */
  app.get(
    '/profile/groups',
    {
      schema: {
        summary: 'Get the groups the logged in user belongs to',
        description:
          'Only the identity of each group. Reading what a group grants requires `read:groups`. When ' +
          'the site enables `features.showOtherGroups`, the response also names the groups the caller ' +
          'does NOT belong to.',
        tags: ['Users'],
        response: {
          200: {
            description:
              'The groups the user belongs to (the default shape), or -- only when the site enables ' +
              '`features.showOtherGroups` -- an object naming both the groups it belongs to and the ' +
              'ones it does not.',
            oneOf: [
              {
                type: 'array',
                description: 'The default shape: only the groups the caller belongs to.',
                items: GROUP_IDENTITY_SCHEMA
              },
              {
                type: 'object',
                description: 'Shown only when the site enables `features.showOtherGroups`.',
                properties: {
                  groups: { type: 'array', items: GROUP_IDENTITY_SCHEMA },
                  otherGroups: { type: 'array', items: GROUP_IDENTITY_SCHEMA }
                },
                required: ['groups', 'otherGroups']
              }
            ]
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const userId = sessionUserId(req)
      if (!(await isShowOtherGroupsEnabled(req))) {
        return await WIKI.models.users.getUserGroups(userId)
      }
      const [groups, otherGroups] = await Promise.all([
        WIKI.models.users.getUserGroups(userId),
        WIKI.models.users.getNonMemberGroups(userId)
      ])
      return { groups, otherGroups }
    }
  )

  /**
   * LIST OWN PERSONAL ACCESS TOKENS
   *
   * Self-service, mirroring `GET /api-keys` but scoped to `WHERE userId = <this session>` — a regular
   * user has no `manage:system`, so it cannot reach the admin listing. See `models/apiKeys.ts`'s doc
   * comment for what makes a personal token different from an admin-issued key.
   */
  app.get(
    '/profile/api-keys',
    {
      schema: {
        summary: "List the logged in user's own personal access tokens",
        description:
          'Revoked and expired tokens are listed too, so the profile page can show their state — same as the admin listing.',
        tags: ['Users'],
        response: {
          200: {
            description: 'List of personal access tokens',
            type: 'array',
            items: { $ref: 'ApiKey#' }
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const userId = sessionUserId(req)
      return WIKI.models.apiKeys.listKeysForUser(userId)
    }
  )

  /**
   * CREATE OWN PERSONAL ACCESS TOKEN
   *
   * No `groups` field, unlike the admin-issued form: a personal token always carries exactly the
   * creating user's own current permissions, resolved live on every request rather than picked here —
   * see `models/apiKeys.ts`'s doc comment for why. `scope` can still narrow it, and `siteId` still pin
   * it, exactly like an admin-issued key (Feature 395).
   */
  app.post<{
    Body: {
      name: string
      expiration: KeyExpiration
      scope?: string[] | null
      allowedClassifications?: string[] | null
      siteId?: string | null
    }
  }>(
    '/profile/api-keys',
    {
      schema: {
        summary: 'Create a new personal access token',
        description:
          "The response carries the token, which is the only time it can be read: only its last characters are stored. The token holds exactly the creating user's own current permissions, revalidated live on every request — not a snapshot of them at creation — narrowed to `scope` when one is given.",
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['name', 'expiration'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description: 'What the token is for.'
            },
            expiration: { $ref: 'ApiKeyExpiration#' },
            scope: {
              type: ['array', 'null'],
              default: null,
              description:
                'An explicit permission allow-list to narrow the token to. Omit or pass null for no narrowing — the token then carries the full extent of your own current permissions. Can only narrow: a permission here you do not hold still grants nothing.',
              items: { $ref: 'ApiKeyScopePermission#' }
            },
            allowedClassifications: {
              type: ['array', 'null'],
              default: null,
              description:
                'A per-level classification allow-set (OpenProject #1205): the token may never be granted a page permission on a page whose classification is not in this list -- what keeps a Claude agent authenticating with this token away from your most sensitive pages even though your account can read them. Omit or pass null for unrestricted (every level, including one added later).',
              items: {
                type: 'string',
                format: 'uuid'
              }
            },
            siteId: {
              type: ['string', 'null'],
              format: 'uuid',
              default: null,
              description:
                'The single site to pin the token to, or null for instance-wide (every site you can already reach).'
            }
          }
        },
        response: {
          200: {
            description: 'Personal access token created successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              id: { type: 'string', format: 'uuid' },
              key: {
                type: 'string',
                description: 'The token. Shown once and never again.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)
      // -> The same name/site/classification checks the admin-issued route makes, in the same order
      //    and with the same messages — only the noun differs
      const invalid = validateApiKeyInput(req.body, 'Token')
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const { id, key } = await issueKey(
        {
          name: req.body.name,
          expiration: req.body.expiration,
          scope: req.body.scope ?? null,
          allowedClassifications: req.body.allowedClassifications ?? null,
          siteId: req.body.siteId ?? null,
          userId
        },
        {
          actor: actorFromRequest(req),
          detail: { personal: true, siteId: req.body.siteId ?? null }
        }
      )

      return {
        ok: true,
        message: 'Personal access token created successfully.',
        id,
        key
      }
    }
  )

  /**
   * REVOKE OWN PERSONAL ACCESS TOKEN
   *
   * `revokeKeyForUser` scopes the update to `WHERE userId = <this session>`, so a keyId belonging to
   * someone else — or to an admin-issued key with no owner — comes back 404, the same answer as a
   * keyId that does not exist at all. Nothing here can revoke another user's token or an admin key.
   */
  app.post<{ Params: { keyId: string } }>(
    '/profile/api-keys/:keyId/revoke',
    {
      schema: {
        summary: "Revoke one of the logged in user's own personal access tokens",
        description:
          'Permanent: the token stays listed as revoked and stops authenticating on the next request.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            keyId: { type: 'string', format: 'uuid' }
          },
          required: ['keyId']
        },
        response: {
          200: {
            description: 'Personal access token revoked successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#', description: 'The token is already revoked.' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)
      const key = await WIKI.models.apiKeys.getKeyById(req.params.keyId)
      if (!key || key.userId !== userId) {
        return reply.notFound('Personal access token does not exist.')
      }
      if (key.isRevoked) {
        return reply.conflict('This personal access token is already revoked.')
      }

      await WIKI.models.apiKeys.revokeKeyForUser(key.id, userId)
      await WIKI.models.auditLog.record({
        event: 'apiKey.revoked',
        actor: actorFromRequest(req),
        targetType: 'apiKey',
        targetId: key.id,
        targetLabel: key.name,
        detail: { personal: true }
      })

      return {
        ok: true,
        message: 'Personal access token revoked successfully.'
      }
    }
  )

  /**
   * GET OWN EDITOR SETTINGS
   *
   * Per-user and per-editor, e.g. whether the markdown editor opens with its preview pane showing.
   * Session-scoped like the rest of `/profile`, so it needs no permission of its own: a user can
   * only ever read its own.
   */
  app.get<{ Params: { editor: string } }>(
    '/profile/editor-settings/:editor',
    {
      schema: {
        summary: "Get the logged in user's settings for one editor",
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            editor: { type: 'string', description: 'Editor key, e.g. `markdown`' }
          },
          required: ['editor']
        },
        response: {
          200: {
            description: 'Editor settings. An object whose shape belongs to the editor.',
            type: 'object',
            additionalProperties: true
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const userId = sessionUserId(req)
      return WIKI.models.users.getEditorSettings(userId, req.params.editor)
    }
  )

  /**
   * UPDATE OWN EDITOR SETTINGS
   */
  app.put<{ Params: { editor: string }; Body: Record<string, any> }>(
    '/profile/editor-settings/:editor',
    {
      schema: {
        summary: "Update the logged in user's settings for one editor",
        description:
          "Replaces the settings for this editor. Other editors' settings, and every other preference, are left alone.",
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            editor: { type: 'string', description: 'Editor key, e.g. `markdown`' }
          },
          required: ['editor']
        },
        body: {
          type: 'object',
          additionalProperties: true
        },
        response: {
          200: {
            description: 'Editor settings updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              config: { type: 'object', additionalProperties: true }
            }
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)
      const config = await WIKI.models.users.setEditorSettings(userId, req.params.editor, req.body)
      if (config === null) {
        // -> The session outlived the user it points at
        return reply.unauthorized()
      }
      return { ok: true, config }
    }
  )

  /**
   * GET OWN NOTIFICATION SUBSCRIPTIONS
   *
   * Feature #2425: which event types email the logged in user when they fire on this instance's
   * existing webhook-dispatch triggers. Session-scoped like the rest of `/profile`, since a user can
   * only ever read or change its own.
   */
  app.get(
    '/profile/notifications',
    {
      schema: {
        summary: "Get the logged in user's per-event-type email notification subscriptions",
        description:
          'One boolean per event type this instance can fire (see `HookEvent`). An event never explicitly set defaults to false — receiving email is opt-in.',
        tags: ['Users'],
        response: {
          200: { $ref: 'UserNotificationSubscriptions#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const userId = sessionUserId(req)
      const subscriptions = await WIKI.models.users.getNotificationSubscriptions(userId)
      if (!subscriptions) {
        // -> The session outlived the user it points at
        return reply.unauthorized()
      }
      return subscriptions
    }
  )

  /**
   * UPDATE OWN NOTIFICATION SUBSCRIPTIONS
   */
  app.put<{ Body: Partial<NotificationSubscriptions> }>(
    '/profile/notifications',
    {
      schema: {
        summary: "Update the logged in user's per-event-type email notification subscriptions",
        description: 'Merges into the existing set; omitted event types are left as they are.',
        tags: ['Users'],
        body: { $ref: 'UserNotificationSubscriptionsUpdate#' },
        response: {
          200: {
            description: 'Notification subscriptions updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              subscriptions: { $ref: 'UserNotificationSubscriptions#' }
            }
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)
      const subscriptions = await WIKI.models.users.setNotificationSubscriptions(userId, req.body)
      if (!subscriptions) {
        // -> The session outlived the user it points at
        return reply.unauthorized()
      }
      return { ok: true, subscriptions }
    }
  )

  /**
   * GET OWN AUTHENTICATION METHODS
   *
   * What the profile's authentication page is built from: the providers linked to the account and the
   * passkeys registered against it. Session-scoped like the rest of `/profile` — a user can only ever
   * see its own, and no permission expresses that.
   */
  app.get(
    '/profile/auth',
    {
      schema: {
        summary: "Get the logged in user's authentication methods",
        description:
          'The providers the account can be signed in with, plus its registered passkeys. Secrets are never included: each provider reports only whether a password is set, whether 2FA is active, and whether the user is allowed to turn it off.',
        tags: ['Users'],
        response: {
          200: {
            description: 'Authentication methods',
            type: 'object',
            properties: {
              authMethods: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    authId: { type: 'string', format: 'uuid' },
                    authName: { type: 'string' },
                    strategyKey: { type: 'string' },
                    strategyIcon: { type: 'string' },
                    config: {
                      type: 'object',
                      properties: {
                        isPasswordSet: { type: 'boolean' },
                        isTfaSetup: { type: 'boolean' },
                        isTfaRequired: {
                          type: 'boolean',
                          description:
                            'Either this user is flagged for 2FA or the strategy enforces it. Turning 2FA off is refused while this holds.'
                        },
                        isPasswordLoginEnabled: {
                          type: 'boolean',
                          description:
                            'False once password login has been turned off, by the user or by an administrator.'
                        },
                        canDisablePasswordLogin: {
                          type: 'boolean',
                          description:
                            'Whether the account has another way in — a passkey or another linked provider — and may therefore turn password login off.'
                        },
                        recoveryCodesRemaining: {
                          type: 'integer',
                          description:
                            '2FA recovery codes still unused. 0 when 2FA is off. Never a code itself — see `/users/profile/tfa/recovery-codes` for that.'
                        }
                      }
                    }
                  }
                }
              },
              passkeys: {
                type: 'array',
                items: { $ref: 'Passkey#' }
              }
            }
          },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      reply.preventCache()
      const userId = sessionUserId(req)
      return {
        authMethods: await WIKI.models.userCredentials.getProfileAuthMethods(userId),
        passkeys: await WIKI.models.passkeys.list(userId)
      }
    }
  )

  /**
   * CHANGE OWN PASSWORD
   */
  app.put<{ Body: { strategyId: string; currentPassword: string; newPassword: string } }>(
    '/profile/password',
    {
      schema: {
        summary: "Change the logged in user's own password",
        description:
          'The current password has to be given, and is what authorizes the change. Only a provider that stores the password on this instance can be changed here. Also clears any pending forced password change.',
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['strategyId', 'currentPassword', 'newPassword'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid',
              description: 'The provider whose password is being changed.'
            },
            currentPassword: { type: 'string', minLength: 1, maxLength: 255 },
            newPassword: { type: 'string', minLength: 8, maxLength: 255 }
          }
        },
        response: {
          200: {
            description: 'Password changed successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      try {
        await WIKI.models.userCredentials.changeOwnPassword({
          userId,
          strategyId: req.body.strategyId,
          currentPassword: req.body.currentPassword,
          newPassword: req.body.newPassword
        })
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }

      return {
        ok: true,
        message: 'Password changed successfully.'
      }
    }
  )

  /**
   * TURN OWN PASSWORD LOGIN ON OR OFF
   */
  app.put<{ Body: { strategyId: string; isEnabled: boolean } }>(
    '/profile/password-login',
    {
      schema: {
        summary: "Turn password login on or off for the logged in user's own account",
        description:
          'The same restriction an administrator can apply from the admin area. Turning it off is refused unless the account has another way in — a registered passkey or another linked provider — so that a user cannot lock themselves out. The password itself is kept, so turning it back on restores it.',
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['strategyId', 'isEnabled'],
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid',
              description:
                'The provider to change, which has to be one that stores a password here.'
            },
            isEnabled: { type: 'boolean' }
          }
        },
        response: {
          200: {
            description: 'Password login setting updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      try {
        await WIKI.models.userCredentials.setPasswordLoginEnabled({
          userId,
          strategyId: req.body.strategyId,
          isEnabled: req.body.isEnabled
        })
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }

      return {
        ok: true,
        message: req.body.isEnabled ? 'Password login enabled.' : 'Password login disabled.'
      }
    }
  )

  /**
   * START OWN 2FA SETUP
   *
   * Two steps, because the server cannot know the secret reached the user's authenticator until the
   * user proves it did: this hands out a QR code and a continuation token, and `PUT` activates the
   * secret once a code generated from it comes back.
   */
  app.post<{ Body: { strategyId: string } }>(
    '/profile/tfa',
    {
      schema: {
        summary: "Start setting up 2FA on the logged in user's account",
        description:
          'Generates a secret and returns the QR code to scan. The secret does nothing until a code produced by it is submitted to `PUT /users/profile/tfa` with the continuation token returned here. Starting again replaces a secret that was never activated.',
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['strategyId'],
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          }
        },
        response: {
          200: {
            description: '2FA setup started',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              continuationToken: { type: 'string' },
              tfaQRImage: {
                type: 'string',
                description: 'The `otpauth://` URI as an SVG QR code, to be rendered as-is.'
              },
              tfaSecret: {
                type: 'string',
                description:
                  'The base32 secret the QR code encodes, for a user who would rather type it into an authenticator app than scan it. Only ever returned here, to the user setting 2FA up on their own account.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      // -> The site names the entry in the user's authenticator app, and is the one being browsed
      //    rather than one the client names: nothing else about this request is client-chosen either
      const site = await siteForHostname(req.hostname)

      try {
        const { continuationToken, tfaQRImage, tfaSecret } =
          await WIKI.models.login.startProfileTfaSetup({
            userId,
            strategyId: req.body.strategyId,
            siteId: site?.id
          })
        return {
          ok: true,
          continuationToken,
          tfaQRImage,
          tfaSecret
        }
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
    }
  )

  /**
   * FINISH OWN 2FA SETUP
   */
  app.put<{ Body: { strategyId: string; continuationToken: string; securityCode: string } }>(
    '/profile/tfa',
    {
      schema: {
        summary: 'Activate the 2FA secret the logged in user just set up',
        description:
          'Checks a code from the user’s authenticator against the secret generated by `POST /users/profile/tfa`, and activates it. A wrong code can be retried a handful of times before the continuation token is discarded and the setup has to be started again.',
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['strategyId', 'continuationToken', 'securityCode'],
          properties: {
            strategyId: { type: 'string', format: 'uuid' },
            continuationToken: { type: 'string', minLength: 1, maxLength: 255 },
            securityCode: {
              type: 'string',
              pattern: '^[0-9]{6}$',
              description: 'The six digits shown by the authenticator app.'
            }
          }
        },
        response: {
          200: {
            description: '2FA activated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              recoveryCodes: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'The fresh recovery codes in plaintext. Only ever returned here, to the user activating 2FA on their own account — only hashes are kept afterwards. Show them once and prompt to save; `POST /users/profile/tfa/recovery-codes` is the only way to see the count remaining again, and regenerating is the only way to get a readable set back.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      try {
        const { recoveryCodes } = await WIKI.models.login.confirmTfaSetup({
          userId,
          strategyId: req.body.strategyId,
          continuationToken: req.body.continuationToken,
          securityCode: req.body.securityCode
        })
        return {
          ok: true,
          message: '2FA enabled successfully.',
          recoveryCodes
        }
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
    }
  )

  /**
   * TURN OWN 2FA OFF
   */
  app.delete<{ Params: { strategyId: string } }>(
    '/profile/tfa/:strategyId',
    {
      schema: {
        summary: "Turn 2FA off on the logged in user's account",
        description:
          'Forgets the secret, so setting 2FA up again starts from a new one. Refused when the account is flagged for 2FA or the strategy enforces it — the next login would only ask for it again.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          },
          required: ['strategyId']
        },
        response: {
          204: {
            description: '2FA turned off successfully'
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)

      try {
        await WIKI.models.userCredentials.disableTfa(userId, req.params.strategyId)
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }

      return reply.code(204).send()
    }
  )

  /**
   * VIEW REMAINING RECOVERY CODE COUNT
   *
   * Never re-displays a code, used or not — only how many of the original set are still good, so the
   * profile page can nudge a user running low toward regenerating before they are locked out.
   *
   * No route-level permissions: self-scoped by session, same as the rest of `/profile/tfa*`.
   */
  app.get<{ Querystring: { strategyId: string } }>(
    '/profile/tfa/recovery-codes',
    {
      schema: {
        summary: "Get the logged in user's remaining 2FA recovery code count",
        description:
          'Never returns a code, used or unused — only how many of the last-issued set are still unused. 400s if 2FA is not active on this strategy, since there is nothing to count.',
        tags: ['Users'],
        querystring: {
          type: 'object',
          required: ['strategyId'],
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          }
        },
        response: {
          200: {
            description: 'Recovery code status',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              total: {
                type: 'integer',
                description: 'How many codes the current set was issued with.'
              },
              remaining: { type: 'integer', description: 'How many of them are still unused.' }
            }
          }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      try {
        const { total, remaining } = await WIKI.models.userCredentials.getRecoveryCodesStatus(
          userId,
          req.query.strategyId
        )
        return { ok: true, total, remaining }
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
    }
  )

  /**
   * REGENERATE RECOVERY CODES
   */
  app.post<{ Body: { strategyId: string } }>(
    '/profile/tfa/recovery-codes',
    {
      schema: {
        summary: "Regenerate the logged in user's 2FA recovery codes",
        description:
          'Invalidates every code from the previous set — used or not — and issues a fresh one. `hadUnusedCodes` reports whether the set just replaced still had unused codes in it, which is the client’s cue to warn the user that codes they saved are being thrown away rather than topped up. 400s if 2FA is not active on this strategy.',
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['strategyId'],
          properties: {
            strategyId: { type: 'string', format: 'uuid' }
          }
        },
        response: {
          200: {
            description: 'Fresh recovery codes',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              recoveryCodes: {
                type: 'array',
                items: { type: 'string' },
                description: 'The new codes in plaintext. Only ever returned here, once.'
              },
              hadUnusedCodes: {
                type: 'boolean',
                description: 'Whether the set just replaced still had unused codes in it.'
              }
            }
          }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      try {
        const { recoveryCodes, hadUnusedCodes } =
          await WIKI.models.userCredentials.regenerateRecoveryCodes(userId, req.body.strategyId)
        return { ok: true, recoveryCodes, hadUnusedCodes }
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
    }
  )

  /**
   * START REGISTERING A PASSKEY
   */
  app.post(
    '/profile/passkeys/challenge',
    {
      schema: {
        summary: 'Get the options for registering a new passkey',
        description:
          "Pass the result to the browser's WebAuthn API, then send what the authenticator produces to `POST /users/profile/passkeys`. The credential is bound to the hostname of this request, so a passkey registered on one site of a multi-site instance does not work on another.",
        tags: ['Users'],
        response: {
          200: {
            description: 'Registration options',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              registrationOptions: {
                type: 'object',
                additionalProperties: true,
                description: 'A WebAuthn `PublicKeyCredentialCreationOptions`, JSON-encoded.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      try {
        const { registrationOptions, pending } = await WIKI.models.passkeys.startRegistration({
          userId,
          hostname: req.hostname,
          origin: req.headers.origin
        })
        // -> Kept out of the client's hands: what the authenticator signs is only worth anything if the
        //    challenge it answers is one this server remembers issuing
        req.session.passkeyRegistration = pending
        return {
          ok: true,
          registrationOptions
        }
      } catch (err: any) {
        rethrowAsBadRequest(err)
      }
    }
  )

  /**
   * FINISH REGISTERING A PASSKEY
   */
  app.post<{ Body: { name: string; registrationResponse: Record<string, any> } }>(
    '/profile/passkeys',
    {
      schema: {
        summary: 'Register the passkey an authenticator just created',
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['name', 'registrationResponse'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description: 'What to call it in the list, e.g. the device it lives on.'
            },
            registrationResponse: {
              type: 'object',
              additionalProperties: true,
              description: "The browser's WebAuthn registration response, JSON-encoded."
            }
          }
        },
        response: {
          200: {
            description: 'Passkey registered successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              passkey: { $ref: 'Passkey#' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const userId = sessionUserId(req)

      try {
        const passkey = await WIKI.models.passkeys.finalizeRegistration({
          userId,
          name: req.body.name,
          registrationResponse: req.body.registrationResponse as any,
          pending: req.session.passkeyRegistration
        })
        return {
          ok: true,
          passkey
        }
      } catch (err: any) {
        rethrowAsBadRequest(err)
      } finally {
        // -> Spent either way: a rejected response does not get a second go at the same challenge
        req.session.passkeyRegistration = undefined
      }
    }
  )

  /**
   * REMOVE A PASSKEY
   */
  app.delete<{ Params: { passkeyId: string } }>(
    '/profile/passkeys/:passkeyId',
    {
      schema: {
        summary: 'Remove one of the logged in user’s passkeys',
        description:
          'Only this instance forgets it — the credential itself lives on the user’s device and has to be deleted there too.',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            passkeyId: {
              type: 'string',
              description: 'The credential ID, as listed by `GET /users/profile/auth`.'
            }
          },
          required: ['passkeyId']
        },
        response: {
          204: {
            description: 'Passkey removed successfully'
          },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const userId = sessionUserId(req)
      if (!(await WIKI.models.passkeys.remove(userId, req.params.passkeyId))) {
        return reply.notFound('You have no passkey with this ID.')
      }
      return reply.code(204).send()
    }
  )
}

export default routes
