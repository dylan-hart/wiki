# WP 3603: recommended comments

`backend/api/auth/provider.ts`, the `GET /auth/:strategyId/metadata` route (comments are not added
in code; this is the one worth keeping).

Above `config: { publicAccess: true }` on the route:

```ts
// -> No `limitAuthAttempts`: it spends the same per-IP budget a login does, and this is neither a
//    credential check nor anything private
```

Why: the callback routes carry `onRequest: limitAuthAttempts`, so its absence here reads as an
oversight. The limiter's `auth:<ip>` bucket is shared with logins, so an identity provider or an
administrator fetching metadata from a shared address would spend, and could trip, the login budget.
