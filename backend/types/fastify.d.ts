/**
 * Module augmentations for Fastify.
 *
 * `@fastify/session` exposes `interface Session` inside the `fastify` module as the extension point
 * for application session data; everything Cardinal.js stores on the session is declared here.
 */

import 'fastify'
import '@fastify/session'
import type { ApiKeyIdentity } from '../models/apiKeys.ts'
import type { PasskeyChallenge } from '../models/passkeys.ts'
import type { McpAuthContext } from '../mcp/auth.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the API key hook in `index.ts` when a request carries a valid bearer key. Null for
     * cookie-authenticated and anonymous requests.
     */
    apiKey?: ApiKeyIdentity | null
    /**
     * Set by the site-resolution hook in `index.ts` for a page/shell request whose hostname resolved
     * to a site — enabled or not, so a handler further down the same request can tell "disabled" from
     * "never resolved" without re-deriving it. Stays null for a request the hook didn't scope at all
     * (an `/_api`/`/_admin`/etc. route, or an exempt path like `/login`) and for one whose hostname
     * matched no site, since that case is redirected to `/_error/unknownsite` with nothing to attach.
     */
    site?: Record<string, any> | null
    /**
     * Set by the `onRequest` hook in `mcp/http.ts` once a request's bearer token verifies — the
     * identity every MCP tool call on this request is authorized against. Decorated locally by that
     * plugin (`/_mcp` only), unlike `apiKey`/`site` above which the root app decorates.
     */
    mcpCtx?: McpAuthContext | null
  }

  interface Session {
    /** Set by `models/users.ts` → `updateSession()` once a login completes. */
    authenticated?: boolean
    user?: {
      id: string
      email: string
      name: string
      hasAvatar?: boolean
      timezone?: string
      dateFormat?: string
      timeFormat?: string
      appearance?: string
      aesthetic?: string
      cvd?: string
      locale?: string
    }
    /** Flattened, de-duplicated permissions of every group the user belongs to. */
    permissions?: string[]
    /** Ids of the groups the user belongs to, which is what per-group visibility is checked against. */
    groups?: string[]
    /**
     * Ids of the password-protected pages this session has entered the password for. Written by the
     * unlock route in `api/pages/read.ts`, and the only thing that opens one for a reader who may not edit
     * it — the client is never trusted with that state.
     */
    unlockedPages?: string[]
    /**
     * The redirect login in progress, written when the browser is sent to an identity provider and
     * read when it comes back. It is what ties the two halves together: an answer whose `state` is not
     * the one this session sent is not this session's answer, and the PKCE verifier never leaves here.
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
       * provider's `InResponseTo` on the callback — see `AuthFlow.authnRequestId` in
       * `models/authentication.ts`.
       */
      authnRequestId?: string
      /** Where to send the browser once it is logged in. */
      redirect: string
      /** When this flow was started, as an ISO instant, so that a stale one can be refused. */
      startedAt: string
    }
    /**
     * The WebAuthn challenge a passkey ceremony is waiting on, written by the routes in `api/users/profile.ts`
     * (registration) and `api/auth/site.ts` (login) and consumed by the verification that
     * follows.
     *
     * It lives on the session because a login challenge belongs to nobody yet: a passkey identifies
     * the account it signs for, so the server has no idea who is signing in until the assertion comes
     * back. Two fields rather than one, so that neither ceremony can consume the other's challenge.
     */
    passkeyRegistration?: PasskeyChallenge
    passkeyLogin?: PasskeyChallenge
    /**
     * Set the first time a browser-side pageview is logged for this session (`api/pages/read.ts`'s
     * `recordPageview()`). The value itself is never read — writing anything at all is what marks the
     * session modified, which is what makes `@fastify/session` persist it (`saveUninitialized: false`
     * otherwise never would) so the same anonymous reader is recognizable as one visitor across
     * repeat page views instead of a fresh one on every request. Mirrors `unlockedPages`' own doc
     * comment: "unlocking a page is what first gives an anonymous reader a session" — viewing one is
     * now the same, for the same reason.
     */
    pageViewed?: boolean
  }

  interface FastifyContextConfig {
    /**
     * Permissions required to reach the route, enforced by the `preHandler` hook in `index.ts`.
     *
     * The outer array is OR-ed; a nested array is AND-ed. `manage:system` bypasses the check.
     */
    permissions?: (string | string[])[]
    /**
     * Whether this route genuinely serves everybody the same thing.
     *
     * Only affects the API documentation. A route with no `permissions` is not thereby public: most
     * of them answer according to who is asking — the caller's session, their groups' page rules, or
     * their own account — and the docs say so. This marks the few where a guest and an administrator
     * really do get the same reply, so that the difference is stated rather than assumed.
     */
    publicAccess?: boolean
  }
}
