# WP 3600 — Discord role mapping: recommended comment changes

Not applied, per the comments rule.

## `backend/modules/authentication/discord/authentication.ts`

- Class docblock: after "the optional guild (server) restriction needs the raw access token", add that
  `profile()` also reads the member's roles with the bot token (not the user's token) when `mapGroups`
  is on. The sentence currently describes only the guild restriction.
- `mapProfile` override: add why the inherited `groups` is dropped — stock Discord has no group claim,
  so the base claim mapping would report `[]` and `profile()` replaces it with the bot lookup.
- `fetchRoleNames`: a 404 on the member call is "not in the guild" (`[]`); every other failure throws
  so `syncProviderGroups` never sees an outage as "no roles" and revokes mapped groups.

## `backend/modules/authentication/discord/authentication.test.ts`

- The comment that preceded the removed `groupsClaim` test ("Stock Discord reports no roles field on
  `/users/@me`...") was deleted with that test; nothing to restore.
