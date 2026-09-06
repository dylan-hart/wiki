import crypto from 'node:crypto'
import {
  apiKeys as apiKeysTable,
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { flatten, uniq } from 'es-toolkit/array'
import { epochSeconds, signJwt, verifyJwt } from '../helpers/jwt.ts'
import type { AuditActor } from './auditLog.ts'

/**
 * The `aud` claim every key carries, and the one value `verify()` accepts.
 *
 * Fixed rather than configurable: the wiki is both the issuer and the only audience of these tokens,
 * so there is nothing for an operator to point it at. It was a setting until the admin area's JWT
 * section went — a section whose other two fields nothing read — and all changing it ever did was
 * invalidate every key already issued.
 */
const TOKEN_AUDIENCE = 'urn:cardinal.js'

/** An API key signing keypair, with the passphrase its private half is encrypted under. */
interface SigningCertificates {
  /** Protects the private key at rest. Belongs to the keypair, and is rotated with it. */
  passphrase: string
  /**
   * When this keypair came into being, as an RFC 3339 instant.
   *
   * Kept because it is the only thing that can explain a key which is neither revoked nor expired
   * and still does not work: a key issued before this moment was signed by a keypair that no longer
   * exists. See {@link ApiKeys.getKeys}.
   */
  generatedAt: string
  public: string
  private: string
}

/**
 * A fresh signing keypair.
 *
 * Called twice: once at install, to seed `auth.certs` (`models/settings.ts`), and again whenever an
 * administrator invalidates the certificates. Both go through here so that a rotated keypair is
 * generated exactly like the original one.
 *
 * The passphrase is generated with the keypair rather than taken from anywhere else. It used to be
 * `auth.secret` — the same value @fastify/session signs cookies with — which tied two unrelated
 * secrets together: rotating the session secret would have left the private key undecryptable, and
 * replacing the keypair meant logging everybody out.
 */
export function generateSigningCertificates(): SigningCertificates {
  const passphrase = crypto.randomBytes(32).toString('hex')
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'pkcs1',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase
    }
  })
  return {
    passphrase,
    generatedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
    public: pair.publicKey,
    private: pair.privateKey
  }
}

/** The lifetimes the admin area offers, as durations the API accepts. */
export const KEY_EXPIRATIONS = {
  '30d': { days: 30 },
  '90d': { days: 90 },
  '180d': { days: 180 },
  '1y': { years: 1 },
  '3y': { years: 3 }
} as const

export type KeyExpiration = keyof typeof KEY_EXPIRATIONS

/** An API key as exposed by the API. Never includes the token itself, which is not stored. */
export type ApiKey = typeof apiKeysTable.$inferSelect

/**
 * A key as the admin area lists it: the row, plus whether the certificates have moved on without it.
 *
 * `isInvalidated` is not stored anywhere. It is the row's age compared against the keypair's, which
 * is the whole of what makes a key stop working when the certificates are regenerated.
 */
export interface ApiKeyListEntry extends ApiKey {
  isInvalidated: boolean
}

/**
 * What a verified key grants, resolved at request time.
 *
 * For an admin-issued key, `groupIds` is the `groups` the key was created with (signed into the
 * token's `grp` claim) and `permissions` is their union, narrowed to `scope`. For a personal access
 * token (`userId` set), both are instead resolved LIVE from the owning user's CURRENT group
 * membership — see `verify()` and this module's own doc comment for why.
 */
export interface ApiKeyIdentity {
  id: string
  permissions: string[]
  // -> The groups this identity speaks for. A page permission (`read:pages` and the rest of
  //    `PAGE_PERMISSIONS`) is granted by a group's RULES, not by its group-wide `permissions` column
  //    that `permissions` above is resolved from — so page-rule-checking code (`groups.checkAccess()`
  //    via `groups.groupIdsForRequest()`) pools THESE groups' rules exactly the way it pools a
  //    session's `req.session.groups`. Without this, an API-key-authenticated request fell back to the
  //    guests group's rules for every page permission, regardless of what the key's own groups (or, for
  //    a personal token, its owner's current groups) actually granted.
  groupIds: string[]
  // -> The key's own scope narrowing (the stored `ApiKey.scope`), unnarrowed by anything above:
  //    `permissions` is already the intersection against it (`narrowToScope()`), but `groupIds` is
  //    still the identity's full, unnarrowed group membership. `models/groups.ts`'s `AccessActor`
  //    carries this through so `checkAccess()`/`mayHoldPermissionSomewhere()`/`checkSiteAccess()` can
  //    intersect a page/site permission against it too before pooling rules from those groups --
  //    without this, a key scoped to `['read:pages']` still held every page permission its groups'
  //    rules granted, since scope was never consulted on the rule-pooling path (OpenProject #930).
  scope: string[] | null
  // -> Per-level allow-set (OpenProject #1205), or null for unrestricted. Carried straight through
  //    from the row -- unlike `groupIds`/`permissions`, this is never resolved live from anything, so
  //    there is nothing to differ between an admin-issued key and a personal token here.
  allowedClassifications: string[] | null
  // -> The user this key acts as, or null for an admin-issued key with no identity of its own — see
  //    the `userId` column comment in `db/schema.ts`.
  userId: string | null
  // -> The site this key is pinned to, taken from the token's `site` claim, or null for
  //    instance-wide (every site). Enforced by the global `apiKeySitePinHook`
  //    (`helpers/apiKeySite.ts`, registered in `index.ts`) against every `/sites/:siteId/...`
  //    route's own `:siteId`, and by `models/groups.ts`'s `AccessActor.siteId` inside
  //    `checkAccess()`/`checkSiteAccess()` themselves (OpenProject #2189).
  siteId: string | null
}

/** Raised by `verify()` when a token is not usable, with a reason safe to return to the caller. */
export class ApiKeyError extends Error {}

/**
 * Narrow a group-derived permission set down to a key's stored scope.
 *
 * A scope can only take permissions away, never grant one the groups didn't already hold — so this
 * is an intersection, not a replacement. `null` means the key was issued unscoped: the full
 * group-derived set passes through untouched, which is also what makes every key issued before this
 * feature existed keep working exactly as it did.
 */
export function narrowToScope(permissions: string[], scope: string[] | null): string[] {
  if (scope === null) {
    return permissions
  }
  const allowed = new Set(scope)
  return permissions.filter((permission) => allowed.has(permission))
}

/**
 * API Keys model
 *
 * A key is an RS256 JWT signed with the installation keypair, carrying the key row's ID and (for an
 * admin-issued key) the groups it draws permissions from. The token is shown once at creation and
 * never stored: the signature proves authenticity, and the row is consulted for revocation, expiry
 * and — for a personal token — ownership. Permissions are resolved on every request rather than
 * baked into the token, so changing a group takes effect immediately.
 *
 * DESIGN DECISION (Feature/OpenProject #788, "who a key acts as"): a personal access token's
 * permissions are the owning user's CURRENT permissions, revalidated live on every request — the same
 * question a session answers, not a subset chosen once at creation. Two things this rules out
 * deliberately: (1) a snapshot taken at issue time, which would let a token quietly outlive the access
 * it was minted with — demote a user, or deactivate them outright, and every token they ever issued
 * would go on working exactly as before until somebody thought to revoke it by hand; (2) an
 * admin-style `groups` selection on the token itself, which would let a user grant a bearer token MORE
 * than their own account currently holds, or let it survive being removed from a group. Both would be
 * a real escalation path a stolen laptop turns into a real incident. Living with a permission change
 * exactly when it happens, with no separate "and now go revoke the tokens too" step, is the whole
 * point — it is exactly the guarantee `groups.reloadCache()`'s own doc comment already promises for a
 * session ("a revoked permission that waits for a logout is not revoked"); a personal token keeps that
 * promise rather than becoming the one credential type it doesn't apply to. `scope` (Feature 395) still
 * narrows a personal token exactly like an admin one — the live-resolved set is what gets intersected.
 */
class ApiKeys {
  /**
   * The signing key, built from the passphrase-protected PEM in `config.auth.certs`
   */
  private privateKey(): crypto.KeyObject {
    return crypto.createPrivateKey({
      key: WIKI.config.auth.certs.private,
      passphrase: WIKI.config.auth.certs.passphrase
    })
  }

  /**
   * Replace the signing keypair and its passphrase, invalidating every key ever issued.
   *
   * A key is only a signature over its claims, so this is what takes back keys that have escaped:
   * the rows stay, and every token signed by the old key stops verifying on the next request. The
   * rows are not marked revoked — revocation is a decision an administrator made about one key, and
   * saying that about all of them would lose the distinction. Minting a key from the same row is not
   * possible either, so the count returned is what an administrator has to reissue.
   *
   * Session cookies are untouched: they are signed with `auth.secret`, which this does not go near.
   *
   * @returns How many keys were still usable and no longer are, or null if the settings failed to save
   */
  async regenerateCertificates(): Promise<number | null> {
    const previousAuth = WIKI.config.auth
    const usable = await WIKI.db.$count(
      apiKeysTable,
      and(eq(apiKeysTable.isRevoked, false), gt(apiKeysTable.expiration, sql`now()`))
    )

    WIKI.config.auth = { ...previousAuth, certs: generateSigningCertificates() }
    // -> Propagates as `reloadConfig`, which is how the other instances pick up the new public key
    //    rather than going on trusting tokens this one has just disowned. `verify()` below reads
    //    `WIKI.config.auth.certs.public` fresh on every call rather than a value handed to a plugin at
    //    boot, so `reloadConfig`'s `loadFromDb()` is enough on its own — no restart needed. The session
    //    secret rotation in `models/sessions.ts#rotateSecret()` now works the same way
    //    (`helpers/authSecretSigner.ts`, OpenProject #2172). Verified live across a real two-instance
    //    setup for task 589 — a second instance picked up the new `generatedAt` within a second of this
    //    call, with no restart.
    if (!(await WIKI.configSvc.saveToDb(['auth']))) {
      WIKI.config.auth = previousAuth
      return null
    }

    WIKI.logger.info('auth', 'regenerated the API key certificates', { invalidated: usable })
    return usable
  }

  /**
   * Every key, newest first. Revoked and expired keys are kept: the admin list shows their state.
   *
   * Each one is marked against the age of the signing keypair. A key issued before the certificates
   * were last regenerated was signed by a keypair that is gone, so it fails verification on its
   * signature and there is nothing about the row itself to explain why — which is exactly the state
   * an administrator needs pointed out, and the one thing distinguishing it from a key somebody
   * chose to revoke.
   */
  async getKeys(): Promise<ApiKeyListEntry[]> {
    const results = await WIKI.db.select().from(apiKeysTable).orderBy(desc(apiKeysTable.createdAt))
    const generatedAt = Temporal.Instant.from(WIKI.config.auth.certs.generatedAt)
    return results.map((key) => ({
      ...key,
      isInvalidated: Temporal.Instant.compare(key.createdAt.toTemporalInstant(), generatedAt) < 0
    }))
  }

  /** When the keypair keys are signed with came into being. */
  certificatesGeneratedAt(): string {
    return WIKI.config.auth.certs.generatedAt
  }

  /**
   * A single user's own personal access tokens, newest first — the self-service counterpart to
   * `getKeys()`, which lists every key on the instance and is admin-only. Same `isInvalidated` marking.
   */
  async listKeysForUser(userId: string): Promise<ApiKeyListEntry[]> {
    const results = await WIKI.db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.userId, userId))
      .orderBy(desc(apiKeysTable.createdAt))
    const generatedAt = Temporal.Instant.from(WIKI.config.auth.certs.generatedAt)
    return results.map((key) => ({
      ...key,
      isInvalidated: Temporal.Instant.compare(key.createdAt.toTemporalInstant(), generatedAt) < 0
    }))
  }

  /**
   * Mint a new key.
   *
   * `groups` names an admin-issued key's permission source and is meaningless for a personal token
   * (`userId` set) — left `[]` for those rows, since `verify()` never reads it once `userId` is
   * present. The `grp` claim is still signed as `[]` in that case for the same reason: it is inert,
   * not consulted.
   *
   * @returns The key row plus the token, which is the only time it exists outside the client
   */
  async createKey({
    name,
    expiration,
    groups = [],
    scope = null,
    allowedClassifications = null,
    siteId = null,
    userId = null
  }: {
    name: string
    expiration: KeyExpiration
    /** Groups an admin-issued key draws its permissions from. Ignored (and stored empty) when `userId` is set. */
    groups?: string[]
    /** An explicit permission allow-list to narrow the key to, or null for no narrowing. */
    scope?: string[] | null
    /** A per-level classification allow-set (OpenProject #1205), or null for unrestricted. */
    allowedClassifications?: string[] | null
    /** The single site to pin the key to, or null for instance-wide (every site). */
    siteId?: string | null
    /** The user this is a personal access token for, or null for an admin-issued key. */
    userId?: string | null
  }): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID()
    const expiresAt = Temporal.Now.zonedDateTimeISO('UTC')
      .add(KEY_EXPIRATIONS[expiration])
      .toInstant()
    const effectiveGroups = userId ? [] : groups

    const key = signJwt(
      {
        id,
        grp: effectiveGroups,
        site: siteId,
        aud: TOKEN_AUDIENCE,
        iat: epochSeconds(),
        exp: epochSeconds(expiresAt)
      },
      this.privateKey()
    )

    await WIKI.db.insert(apiKeysTable).values({
      id,
      name,
      keyShort: key.slice(-8),
      groups: effectiveGroups,
      scope,
      allowedClassifications,
      siteId,
      userId,
      expiration: new Date(expiresAt.epochMilliseconds),
      isRevoked: false
    })

    return { id, key }
  }

  /**
   * A single key, or null if there is no such key
   */
  async getKeyById(id: string): Promise<ApiKey | null> {
    const results = await WIKI.db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, id))
      .limit(1)
    return results[0] ?? null
  }

  /**
   * Revoke a key, permanently. Tokens already handed out stop working on the next request.
   *
   * @returns Whether a key was revoked
   */
  async revokeKey(id: string): Promise<boolean> {
    const result = await WIKI.db
      .update(apiKeysTable)
      .set({ isRevoked: true, updatedAt: sql`now()` })
      .where(eq(apiKeysTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Revoke a key, but only if it belongs to this user — the self-service counterpart to `revokeKey()`.
   *
   * Scoping the `WHERE` to `userId` rather than checking ownership as a separate step is what makes
   * this safe to call directly from a route with no earlier lookup: a keyId belonging to someone else,
   * or to an admin-issued key with no owner at all, updates zero rows and comes back `false` exactly
   * like a keyId that does not exist — the caller cannot tell the two apart, which is the point.
   *
   * @returns Whether a key owned by this user was revoked
   */
  async revokeKeyForUser(id: string, userId: string): Promise<boolean> {
    const result = await WIKI.db
      .update(apiKeysTable)
      .set({ isRevoked: true, updatedAt: sql`now()` })
      .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.userId, userId)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Delete every revoked key.
   *
   * Housekeeping, not a security measure: a revoked key already authenticates nothing, and this only
   * takes its row out of the admin list. What it costs is the record that the key ever existed, which
   * is why nothing does it automatically.
   *
   * Invalidated keys are left alone. One of those is still a key somebody issued and has not decided
   * anything about — it stopped working because the certificates moved, and the row is what tells its
   * owner they have to reissue it. A key that is both revoked and invalidated goes: revoking is the
   * decision, and this deletes what was decided about.
   *
   * Needs none of `core/maintenance.ts`'s HA handling either, for the same reason `pageHistory.purge`
   * doesn't: nothing here lives outside the row, so a `DELETE` is immediately the same fact on every
   * instance's next query. Verified against a real two-instance setup for task 589.
   *
   * @returns How many keys were deleted
   */
  async purgeRevoked(): Promise<number> {
    const result = await WIKI.db.delete(apiKeysTable).where(eq(apiKeysTable.isRevoked, true))
    const purged = result.rowCount ?? 0
    // -> Silent at `info` when there was nothing to purge; this runs from a scheduled job.
    if (purged > 0) {
      WIKI.logger.info('auth', 'purged revoked API keys', { keys: purged })
    } else {
      WIKI.logger.debug('auth', 'no revoked API keys to purge')
    }
    return purged
  }

  /**
   * The union of the permissions held by the given groups, narrowed to the key's stored scope.
   *
   * A group that no longer exists simply contributes nothing, so deleting a group narrows the keys
   * pointing at it instead of breaking them. `scope` narrows the same way from the other direction —
   * see `narrowToScope()` — and a key issued before scoping existed passes `null`, which is a no-op.
   */
  async resolvePermissions(groupIds: string[], scope: string[] | null = null): Promise<string[]> {
    if (groupIds.length < 1) {
      return []
    }
    const rows = await WIKI.db
      .select({ permissions: groupsTable.permissions })
      .from(groupsTable)
      .where(inArray(groupsTable.id, groupIds))
    const permissions = uniq(flatten(rows.map((r: any) => (r.permissions ?? []) as string[])))
    return narrowToScope(permissions, scope)
  }

  /**
   * A personal token's owner as of right now: whether the account is still usable, and which groups it
   * currently belongs to — the live lookup `verify()` runs instead of trusting anything baked into the
   * token or the key row. `null` when the account is gone outright (the row's `onDelete: 'cascade'`
   * makes that the same moment the key row itself disappears, but a request already holding `req.apiKey`
   * from before that instant should not be trusted either).
   */
  private async resolveOwner(
    userId: string
  ): Promise<{ isActive: boolean; groupIds: string[]; permissions: string[] } | null> {
    const rows = await WIKI.db
      .select({
        isActive: usersTable.isActive,
        groupId: userGroupsTable.groupId,
        permissions: groupsTable.permissions
      })
      .from(usersTable)
      .leftJoin(userGroupsTable, eq(userGroupsTable.userId, usersTable.id))
      .leftJoin(groupsTable, eq(groupsTable.id, userGroupsTable.groupId))
      .where(eq(usersTable.id, userId))
    if (rows.length < 1) {
      return null
    }
    const groupIds = uniq(
      rows.map((r: any) => r.groupId).filter((g: any): g is string => g != null)
    )
    const permissions = uniq(flatten(rows.map((r: any) => (r.permissions ?? []) as string[])))
    return { isActive: rows[0]!.isActive as boolean, groupIds, permissions }
  }

  /**
   * Verify a bearer token and resolve what it grants.
   *
   * @throws ApiKeyError with a reason suitable for a 401 response
   */
  async verify(token: string): Promise<ApiKeyIdentity> {
    if (WIKI.config.api.isEnabled !== true) {
      throw new ApiKeyError('The API is disabled.')
    }

    let claims
    try {
      claims = verifyJwt(token, WIKI.config.auth.certs.public, {
        audience: TOKEN_AUDIENCE
      })
    } catch (err: any) {
      throw new ApiKeyError(err.message)
    }

    // -> A token this keypair signed but which names no key. There is nothing else it could be —
    //    logins are sessions, and this keypair signs nothing but API keys.
    if (typeof claims.id !== 'string') {
      throw new ApiKeyError('Token is not an API key.')
    }

    const key = await this.getKeyById(claims.id)
    if (!key) {
      throw new ApiKeyError('API key does not exist.')
    }
    if (key.isRevoked) {
      throw new ApiKeyError('API key has been revoked.')
    }
    // -> The token carries its own expiry, but the row is what the admin area shows; a mismatch
    //    should fail closed rather than trust the token
    if (Temporal.Instant.compare(key.expiration.toTemporalInstant(), Temporal.Now.instant()) <= 0) {
      throw new ApiKeyError('API key has expired.')
    }

    const siteId = typeof claims.site === 'string' ? claims.site : null

    // -> A personal access token: ignore whatever `groups`/`grp` the row and token carry (always `[]`,
    //    see `createKey()`) and resolve live from the owner's CURRENT membership instead — the design
    //    decision this module's own doc comment explains.
    if (key.userId) {
      const owner = await this.resolveOwner(key.userId)
      if (!owner) {
        throw new ApiKeyError('The user this token belongs to no longer exists.')
      }
      if (!owner.isActive) {
        throw new ApiKeyError('The user this token belongs to is no longer active.')
      }
      return {
        id: key.id,
        userId: key.userId,
        groupIds: owner.groupIds,
        permissions: narrowToScope(owner.permissions, key.scope),
        scope: key.scope,
        allowedClassifications: key.allowedClassifications,
        siteId
      }
    }

    const groupIds = Array.isArray(claims.grp) ? (claims.grp as string[]) : []
    return {
      id: key.id,
      userId: null,
      groupIds,
      permissions: await this.resolvePermissions(groupIds, key.scope),
      scope: key.scope,
      allowedClassifications: key.allowedClassifications,
      siteId
    }
  }
}

export const apiKeys = new ApiKeys()

/** The fields both key-creation routes accept and validate the same way. */
export interface ApiKeyCreateInput {
  name: string
  siteId?: string | null
  allowedClassifications?: string[] | null
}

/**
 * Check what an admin-issued key and a personal access token are checked for identically: a name
 * with no markup characters in it, a `siteId` that names a real site (or null for instance-wide),
 * and an `allowedClassifications` list naming only real levels (or null for unrestricted).
 *
 * Both routes wrote all three out; only the noun in the name message differed, which is the one
 * thing passed in. Admin-issued keys additionally validate their `groups`, which has no counterpart
 * on the personal side and so stays at that route (see `hasUnknownGroupIds` on `models/groups.ts`).
 *
 * @param label What the route calls the thing being created, for the name message: `Key`/`Token`
 * @returns The message to answer `400` with, or null when the input is acceptable
 */
export function validateApiKeyInput(body: ApiKeyCreateInput, label: string): string | null {
  if (!/^[^<>"]+$/.test(body.name)) {
    return `${label} name contains invalid characters.`
  }
  // -> null pins nothing (instance-wide, today's only behavior); any other value must name a real
  //    site, the same way every entry in an admin key's `groups` must name a real group
  if (body.siteId != null && !WIKI.sites[body.siteId]) {
    return 'This site does not exist.'
  }
  // -> null is unrestricted; any other value must be a list naming only real classification levels
  if (
    body.allowedClassifications != null &&
    body.allowedClassifications.some((id) => !WIKI.models.classificationLevels.byId(id))
  ) {
    return 'One of the classification levels does not exist.'
  }
  return null
}

/**
 * Mint a key and record that it was issued, which is one act rather than two: a key that exists with
 * no audit trail is exactly what the audit log is there to make impossible (OpenProject #989). The
 * `detail` differs between the two routes — an admin key names the groups it draws permissions from,
 * a personal token says only that it is personal — so it is passed in rather than derived.
 *
 * A plain function rather than a method on the model: it composes two models (`apiKeys`,
 * `auditLog`), and neither owns the other.
 */
export async function issueKey(
  input: Parameters<ApiKeys['createKey']>[0],
  audit: { actor: AuditActor; detail: Record<string, unknown> }
): Promise<{ id: string; key: string }> {
  const { id, key } = await WIKI.models.apiKeys.createKey(input)
  await WIKI.models.auditLog.record({
    event: 'apiKey.issued',
    actor: audit.actor,
    targetType: 'apiKey',
    targetId: id,
    targetLabel: input.name,
    detail: audit.detail
  })
  return { id, key }
}
