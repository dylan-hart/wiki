# Variances

Genuine, justified deviations from spec — never a place to excuse a fixable lint/type error. An
entry is deleted the moment the gap it describes closes; this file must never accumulate resolved
changelog prose.

---

## 2.5.x → 3.0 settings/authentication/storage migration (Feature 420)

Two permanent import-time gaps confirmed by
[`docs/migration/2.5x-settings-auth-storage-field-mapping.md`](migration/2.5x-settings-auth-storage-field-mapping.md)
(task 763) and exercised directly by
[`backend/migration/mappers/fixtures.test.ts`](../backend/migration/mappers/fixtures.test.ts) (task
768). Both are **confirmed NO DESTINATION on 3.0 as it exists today**, not bugs in the mapper code —
`mapStorageRow`/`mapAuthenticationRow` (tasks 765/767) already handle each case explicitly (a
reported dropped field, a reported `unsupported` row) rather than silently losing data. The importer
cannot close either gap on its own; only new 3.0 capability can.

### 2.5.x storage `mode`/`syncInterval` have no 3.0 destination

2.5.x's `storage` table carries `mode` (`'sync'|'push'|'pull'`) and `syncInterval`, describing sync
direction and schedule. 3.0's `storage` table (`backend/db/schema.ts`) has no column for either, and
no shipped `backend/modules/storage/*/definition.yml` declares an equivalent prop — the `git`
module's own definition says so directly: "Synchronization (direction and schedule) is not modelled
yet."

`mapStorageRow` (`backend/migration/mappers/storage.ts`) reports this on every `'updated'` result as
`droppedFields: { mode, syncInterval }` with the real source values, rather than discarding them
unremarked — so a migration report can surface "this target used to sync every 15 minutes, pushed
only, and neither fact carried over" to the administrator. There is nothing further an importer can
do: no 3.0 column or module prop exists to hold either value.

**Closes when**: Epic 6 (storage) ships a sync-direction/schedule concept on the `storage` table or a
module prop. At that point `mapStorageRow` should gain a real mapping for `mode`/`syncInterval`
instead of reporting them dropped, and this entry should be deleted (not left as historical
changelog prose).

### 2.5.x auth providers 3.0 does not yet implement

2.5.x ships 21 authentication provider modules; 3.0 ships 4 (`github`, `google`, `local`, `oidc`).
The other 17 — `auth0`, `azure`, `cas`, `discord`, `dropbox`, `facebook`, `firebase`, `gitlab`,
`keycloak`, `ldap`, `microsoft`, `oauth2`, `okta`, `rocketchat`, `saml`, `slack`, `twitch` — have no
matching `backend/modules/authentication/<key>/` directory at all, confirmed by a live
`readdirSync` cross-check in `backend/migration/mappers/authentication.test.ts` and
`fixtures.test.ts`. A 2.5.x `authentication` row configured for any of these has nowhere to land: not
just its `config` (a remap target that would exist if the module did), but the row itself, and by
extension every `users.auth[authModuleId]` entry that depended on it.

`mapAuthenticationRow` (`backend/migration/mappers/authentication.ts`) reports this as
`status: 'unsupported'` with the source key and module named, rather than silently skipping the row —
mirroring Feature 414's provider-fallback precedent for source _users_ on an unimplemented provider.
There is nothing further an importer can do until the module itself exists: no 3.0 prop schema to
remap the 2.x config onto.

**Closes when**: Epic 5 (authentication) ships a `backend/modules/authentication/<key>/` directory
for one of the 17 listed providers. At that point `mapAuthenticationRow` starts resolving that key
through the normal `resolver.getModule()` path with no code change required — only this entry (and
the corresponding line in the field-mapping doc's no-destination list) needs deleting, one provider
at a time, as each lands.
