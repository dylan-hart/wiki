import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * AUTH LOGIN RESULT - Where a login attempt got to, and what the client must do next
   */
  app.addSchema({
    $id: 'AuthLoginResult',
    type: 'object',
    properties: {
      ok: {
        type: 'boolean'
      },
      authenticated: {
        type: 'boolean',
        description: 'Present, and true, only once the session is actually logged in.'
      },
      nextAction: {
        type: 'string',
        enum: ['redirect', 'changePassword', 'provideTfa', 'setupTfa', 'verify'],
        description:
          'What the client has to do to finish. Anything other than `redirect` means the attempt is not a login yet. `verify` means a confirmation email was sent instead of a `continuationToken` — nothing to continue until that link is followed.'
      },
      continuationToken: {
        type: 'string',
        description: 'Stands for this half-finished login. Sent back with whatever it asked for.'
      },
      tfaQRImage: {
        type: 'string',
        description:
          'For `setupTfa` only: the `otpauth://` URI as an SVG QR code, to be rendered as-is.'
      },
      recoveryCodes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Present only when this login just activated 2FA: the fresh recovery codes in plaintext. Shown once — only hashes are kept afterwards.'
      },
      redirect: {
        type: 'string',
        description: 'Where to send the user once logged in. A path within this wiki, or a URL.'
      }
    }
  })

  /**
   * AUTH FORGOT PASSWORD RESULT - Always the same generic success, whatever `forgotPassword()` did or
   * didn't do behind it. See `POST /sites/:siteId/auth/forgotPassword`'s description for why.
   */
  app.addSchema({
    $id: 'AuthForgotPasswordResult',
    type: 'object',
    properties: {
      ok: {
        type: 'boolean'
      },
      message: {
        type: 'string'
      }
    }
  })

  /**
   * AUTH MODULE - An authentication module as found on disk
   */
  app.addSchema({
    $id: 'AuthModule',
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Directory name under `modules/authentication`.'
      },
      title: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      logo: {
        type: 'string'
      },
      icon: {
        type: 'string'
      },
      color: {
        type: 'string'
      },
      vendor: {
        type: 'string'
      },
      website: {
        type: 'string'
      },
      isAvailable: {
        type: 'boolean'
      },
      useForm: {
        type: 'boolean',
        description: 'Whether logging in through it means submitting a username and password.'
      },
      usernameType: {
        type: 'string'
      },
      // Deliberately loose: keys and value types come from each module's own `definition.yml` on
      // disk, so the shape genuinely differs per authentication module (local, OIDC, LDAP, …).
      props: {
        type: 'object',
        additionalProperties: true,
        description:
          'The module configuration, declared in its `definition.yml`: each entry carries a `type`, `title`, `hint`, `default` and the display hints the admin area renders a control from. A `readOnly` prop is shown but cannot be changed, and is silently kept at its stored value when written to.'
      },
      // Deliberately loose: same reason as `props` above — which refs a module exposes, and their
      // keys, are declared per module.
      refs: {
        type: 'object',
        additionalProperties: true,
        description:
          'Read-only values the administrator needs to configure the other side, such as a callback URL. `{host}` and `{id}` are placeholders for the wiki origin and the strategy ID.'
      }
    }
  })

  /**
   * AUTH STRATEGY - A configured instance of a module
   */
  app.addSchema({
    $id: 'AuthStrategy',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      module: {
        type: 'string',
        description: 'Key of the module this strategy is an instance of.'
      },
      displayName: {
        type: 'string'
      },
      isEnabled: {
        type: 'boolean'
      },
      selfRegistration: {
        type: 'boolean',
        description:
          'Whether a visitor may create their own account through this form-based module.'
      },
      autoProvision: {
        type: 'boolean',
        description:
          'Whether an account is created automatically for somebody this redirect-based provider signs in for the first time.'
      },
      allowedEmailRegex: {
        type: 'string'
      },
      allowedEmailDomains: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Case-insensitive allow-list of email domains a local self-registration may use. Empty means unrestricted. Unlike `allowedEmailRegex`, this only ever gates self-registration, not provider auto-provisioning.'
      },
      autoEnrollGroups: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        }
      },
      trustEmailForLinking: {
        type: 'boolean',
        description:
          'Off by default. When on, a provider login for an address matching an existing, still-unlinked account is bound to it automatically; when off, that login is refused with ERR_ACCOUNT_NOT_LINKED instead.'
      },
      mappableGroups: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        },
        description:
          'Admin-chosen allow-list of groups a provider login may grant or revoke via `mapGroups`. Empty by default, meaning a login changes no group memberships. A group carrying `manage:system`, or the root administrators group, is never mapped regardless of this list.'
      },
      // Deliberately loose: values for whatever `props` the module (see `AuthModule` above)
      // declares — a different set of keys per module.
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the module props, completed with the module defaults for any prop that has none stored yet.'
      }
    }
  })

  /**
   * AUTH STRATEGY INPUT - Used both ways: to create a strategy, and as a partial update
   */
  app.addSchema({
    $id: 'AuthStrategyInput',
    type: 'object',
    properties: {
      module: {
        type: 'string',
        maxLength: 255,
        description:
          'Only on create, and only a module that exists on disk. Cannot be changed after.'
      },
      displayName: {
        type: 'string',
        maxLength: 255,
        description: 'Defaults to the module title on create.'
      },
      isEnabled: {
        type: 'boolean'
      },
      selfRegistration: {
        type: 'boolean',
        description:
          "Whether a visitor may create their own account through this strategy's form. Enforced only for a form-based module (e.g. Local, LDAP) — refused for any other module regardless of this flag, since only a form-based module verifies the credentials it registers."
      },
      autoProvision: {
        type: 'boolean',
        description:
          'Whether an account is created automatically for somebody signing in for the first time. Enforced only for a redirect-based provider (OpenID Connect, Google, GitHub, ...) — a form-based module has `selfRegistration` instead.'
      },
      allowedEmailRegex: {
        type: 'string',
        maxLength: 255,
        description:
          'Must be a valid regular expression. Limits which addresses an account may be created for, and applies wherever `selfRegistration` or `autoProvision` does — a pattern that will not compile allows nobody.'
      },
      allowedEmailDomains: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Case-insensitive allow-list of email domains (e.g. `example.com`) a local self-registration may use. Empty by default, meaning unrestricted. Only applies to self-registration through this strategy's own form, not to provider auto-provisioning — use `allowedEmailRegex` for that."
      },
      autoEnrollGroups: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        },
        description:
          'Groups a new self-registered or auto-provisioned user would join. The guests group is refused.'
      },
      trustEmailForLinking: {
        type: 'boolean',
        description:
          "Off by default. Turning it on tells this strategy that an address it reports may be trusted to claim an existing, unlinked account by email match alone — appropriate only for a provider whose email is verified. Leave off for a provider that will assert any address it's told to."
      },
      mappableGroups: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        },
        description:
          'Allow-list of groups this strategy is permitted to grant/revoke on login via `mapGroups`. The guests group is refused. Empty by default, meaning no group memberships are changed. A group carrying `manage:system`, or the root administrators group, is never mapped regardless of this list.'
      },
      // Deliberately loose: same reason as `AuthStrategy.config` above.
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the module props. Validated against what the module declares: an unknown key is dropped, a wrong type is refused, and a read-only prop keeps its stored value.'
      }
    }
  })
}
