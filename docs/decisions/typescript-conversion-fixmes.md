# Decision Record: Preserving Pre-existing Bugs During the TypeScript Conversion

**Status:** Resolved — all flagged bugs fixed, no `FIXME:` markers remain
**Author:** the backend TypeScript conversion effort

## The rule

While converting `backend/` to TypeScript, the type checker routinely exposed code that was already
broken. The rule adopted for the conversion: leave that behavior identical, behind a narrow cast plus
a `FIXME:` comment explaining the real fix, so the migration itself would not silently change runtime
behavior. Preserve behavior, cast narrowly, document the real fix — don't fix it inline as a drive-by
of the type conversion.

This is the pattern to reach for any time a future migration or refactor turns up a pre-existing bug
outside its own scope.

## What it flagged, and how each was resolved

Four bugs were originally flagged by this convention during the conversion itself:

- `sites.ts`'s `req.querystring.strict`
- `config.ts`'s `Promise.trim()`
- Two in `scheduler.ts`'s `addScheduled()`/`addJob()`

All four have since been fixed, and their `FIXME:` comments removed with them.

A fifth `FIXME:`, unrelated to the TS conversion, was `index.ts`'s note by the session/cookie plugin
registration: `WIKI.config.auth.secret` was captured by value instead of re-read per request, so a
live secret rotation (`models/sessions.ts#rotateSecret()`) did not actually stop a still-running
instance from signing new cookies with the invalidated secret until that instance restarted. This was
fixed too (OpenProject #2172): both `@fastify/cookie` and `@fastify/session` are now handed
`helpers/authSecretSigner.ts`, an object that reads `WIKI.config.auth.secret` at call time instead of
a value captured once at registration, so rotation takes effect on every instance immediately, no
restart needed.

No `FIXME:` markers remain from the TypeScript conversion, or from anywhere else in `backend/`.
