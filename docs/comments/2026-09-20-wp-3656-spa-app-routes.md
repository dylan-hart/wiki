# WP 3656: comments recommended for `backend/core/http/siteRouting.ts`

None were added in code; apply these if wanted.

Above `SPA_APP_ROUTES`:

```ts
/**
 * Frontend routes that are not pages, so the shell answers 200 for them without asking whether a
 * page lives there. Keep in step with the top-level entries of `frontend/src/router/routes.js`; the
 * drift test in `siteRouting.test.ts` reads that file. `/_admin` is a prefix because its children
 * carry their own parameterised routes.
 */
```

In `registerAppShellFallback`, above the status decision:

```ts
// -> Only a guest-readable page or an SPA route answers 200. A missing, private, unpublished or
//    password-locked page all come back null from the lookup and so answer identically.
```

At the lookup `catch`:

```ts
// -> Fail open: a DB error says nothing about whether the page exists, and a 404 would tell
//    crawlers to drop it.
```
