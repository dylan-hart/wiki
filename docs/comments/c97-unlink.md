# Comment recommendations, sign-in method disconnect (Feature #2427 / #3816)

## `backend/models/userCredentials.ts`, `countAlternativeLogins` doc comment

**Replace** the four `FIXME:` lines (from `* FIXME: a local entry counts whenever it is unrestricted`
through `* provider.`) with:

```ts
 * A stored password counts only when `isPasswordKnown` is true: the random one written for an
 * account a provider provisioned (or the migration's fallback converter created) is no way in its
 * holder knows. A missing flag reads as unknown, so a writer that forgets it refuses a disconnect
 * rather than locking anyone out.
```

Reason: the defect the FIXME describes is fixed, so the FIXME is now false. What remains true, and
cannot be read off the filter, is why a missing flag counts as unknown (the fail-safe direction).

## `backend/api/users/profile.ts`, `canDisablePasswordLogin` / `canDisconnect` descriptions

No comment change. Both are OpenAPI `description:` strings, which are code. `canDisconnect`'s was
updated in the same commit as the fix to say that an unknown password is no way in.
`canDisablePasswordLogin`'s is still accurate (it is computed for the local entry itself, which the
count excludes), so it was left as it is.

## Checked, still accurate, no change

- `backend/models/login.ts#findOrCreateProviderUser`, the `// -> Nothing signs in with it` note
  above `password: randomToken(24)`.
- `backend/migration/importers/users-groups.ts#createProviderFallbackUserConverter` doc comment
  ("the provider-authenticated, no usable local password shape"): both writers now also record
  `isPasswordKnown: false`, so the comparison still holds.
- `backend/models/users.ts#localUserRow` doc comment (its three callers are unchanged).
