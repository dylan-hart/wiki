/**
 * `@fastify/session` exposes `interface Session` inside the `fastify` module as the extension point
 * for application session data, which is why it is augmented here rather than on that module.
 */

import 'fastify'
import '@fastify/session'
import type { ApiKeyIdentity } from '../models/apiKeys.ts'
import type { PasskeyChallenge } from '../models/passkeys.ts'
import type { McpAuthContext } from '../mcp/auth.ts'
import type { SearchFilter } from '../helpers/searchFilters.ts'
import type { GraphPrefs, IconPickerPrefs } from '../models/users.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Null for cookie-authenticated and anonymous requests (`core/http/authHooks.ts`). */
    apiKey?: ApiKeyIdentity | null
    /**
     * Set by `core/http/siteRouting.ts` for a page/shell request whose hostname resolved to a site —
     * enabled or not, so a handler further down the same request can tell "disabled" from "never
     * resolved" without re-deriving it. Null both for a request the hook didn't scope at all (an
     * `/_api`/`/_admin`/etc. route, an exempt path like `/login`) and for a hostname that matched no
     * site, which is redirected to `/_error/unknownsite` with nothing to attach.
     */
    site?: Record<string, any> | null
    /**
     * The identity every MCP tool call on this request is authorized against. Decorated locally by
     * `mcp/http.ts` (`/_mcp` only), unlike `apiKey`/`site` above which the root app decorates.
     */
    mcpCtx?: McpAuthContext | null
  }

  interface Session {
    authenticated?: boolean
    user?: {
      id: string
      email: string
      name: string
      hasAvatar?: boolean
      avatarProviderUrl?: string | null
      timezone?: string
      dateFormat?: string
      timeFormat?: string
      appearance?: string
      aesthetic?: string
      contentWidth?: string
      cvd?: string
      locale?: string
      graph?: GraphPrefs
      iconPicker?: IconPickerPrefs
      searchFilters?: SearchFilter[]
    }
    /** Flattened, de-duplicated permissions of every group the user belongs to. */
    permissions?: string[]
    /** Ids, not names, of the groups the user belongs to. */
    groups?: string[]
    /**
     * Ids of the password-protected pages this session has entered the password for — the only thing
     * that opens one for a reader who may not edit it, since the client is never trusted with that
     * state.
     */
    unlockedPages?: string[]
    /**
     * The redirect login in progress: an answer whose `state` is not the one this session sent is
     * not this session's answer, and the PKCE verifier never leaves here.
     *
     * One at a time, deliberately — a second attempt replaces the first rather than leaving a set of
     * open states to be matched against.
     */
    authFlow?: {
      strategyId: string
      siteId: string
      state: string
      nonce: string
      codeVerifier: string
      /**
       * SAML only: the outbound `AuthnRequest`'s own `ID`, checked back against the identity
       * provider's `InResponseTo` on the callback.
       */
      authnRequestId?: string
      redirect: string
      /** An ISO instant, so that a stale flow can be refused. */
      startedAt: string
    }
    idpSession?: {
      strategyId: string
      idToken: string
    }
    /**
     * The WebAuthn challenge a passkey ceremony is waiting on. It lives on the session because a
     * login challenge belongs to nobody yet: a passkey identifies the account it signs for, so the
     * server has no idea who is signing in until the assertion comes back. Two fields rather than
     * one, so that neither ceremony can consume the other's challenge.
     */
    passkeyRegistration?: PasskeyChallenge
    passkeyLogin?: PasskeyChallenge
    /**
     * The value itself is never read — writing anything at all is what marks the session modified,
     * which is what makes `@fastify/session` persist it (`saveUninitialized: false` otherwise never
     * would) so the same anonymous reader is recognizable as one visitor across repeat page views
     * instead of a fresh one on every request.
     */
    pageViewed?: boolean
  }

  interface FastifyContextConfig {
    /**
     * Enforced by `core/http/authHooks.ts#permissionPreHandler`. The outer array is OR-ed; a nested
     * array is AND-ed. `manage:system` bypasses the check.
     */
    permissions?: (string | string[])[]
    /**
     * Only affects the API documentation. A route with no `permissions` is not thereby public: most
     * of them answer according to who is asking — the caller's session, their groups' page rules, or
     * their own account. This marks the few where a guest and an administrator really do get the
     * same reply, so that the difference is stated rather than assumed.
     */
    publicAccess?: boolean
  }
}
