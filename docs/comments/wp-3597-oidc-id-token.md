# WP 3597 recommended comments

- `backend/models/authentication.ts`, `ProviderProfile.idToken`: "The OIDC ID token, kept only so logout can send it as `id_token_hint`. A session secret: never persisted to the database, audit log or logs."
- `backend/api/auth/provider.ts`, `finishProviderLogin`, above the `req.session.idpSession` write: "Must come after `loginWithProvider()`: `updateSession()` regenerates the session and would wipe an earlier write."
- `backend/types/fastify.d.ts`, `Session.idpSession`: "The provider login this session came through, so logout can end the provider's session too. Absent unless the provider issued an ID token."
