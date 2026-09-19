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
 * The `aud` claim every key carries, and the one value `verify()` accepts. Fixed rather than
 * configurable: the wiki is both the issuer and the only audience, and changing it would invalidate
 * every key already issued.
 */
const TOKEN_AUDIENCE = 'urn:cardinal.js'

interface SigningCertificates {
  passphrase: string
  /**
   * When this keypair came into being, as an RFC 3339 instant. The only thing that can explain a key
   * which is neither revoked nor expired and still does not work: it was signed by a keypair that no
   * longer exists.
   */
  generatedAt: string
  public: string
  private: string
}

/**
 * A fresh signing keypair, generated the same way at install and on every rotation.
 *
 * The passphrase belongs to the keypair rather than being `auth.secret`, which @fastify/session
 * signs cookies with: sharing one secret would mean rotating it left the private key undecryptable,
 * and replacing the keypair logged everybody out.
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

export const KEY_EXPIRATIONS = {
  '30d': { days: 30 },
  '90d': { days: 90 },
  '180d': { days: 180 },
  '1y': { years: 1 },
  '3y': { years: 3 }
} as const

export type KeyExpiration = keyof typeof KEY_EXPIRATIONS

/** The token itself is never stored, so no row carries it. */
export type ApiKey = typeof apiKeysTable.$inferSelect

/**
 * `isInvalidated` is not stored: it is the row's age against the keypair's, which is the whole of
 * what makes a key stop working once the certificates are regenerated.
 */
export interface ApiKeyListEntry extends ApiKey {
  isInvalidated: boolean
}

/**
 * What a verified key grants, resolved at request time. For an admin-issued key `groupIds` is the
 * token's `grp` claim and `permissions` their union narrowed to `scope`; for a personal token
 * (`userId` set) both come live from the owner's current group membership instead.
 */
export interface ApiKeyIdentity {
  id: string
  permissions: string[]
  // -> A page permission is granted by a group's RULES, not by the group-wide `permissions` column
  //    `permissions` above is resolved from, so `groups.groupIdsForRequest()` pools THESE groups'
  //    rules the way it pools a session's. Without them an API-key request falls back to guests.
  groupIds: string[]
  // -> The stored scope, unnarrowed: `permissions` is already the intersection against it, but
  //    `groupIds` is still full membership. `models/groups.ts`'s `AccessActor` carries this so the
  //    rule-pooling paths can intersect a page/site permission against it too.
  scope: string[] | null
  // -> Per-level allow-set, or null for unrestricted. Straight from the row — never resolved live,
  //    so an admin-issued key and a personal token behave alike here.
  allowedClassifications: string[] | null
  // -> The user this key acts as, or null for an admin-issued key with no identity of its own.
  userId: string | null
  // -> The site this key is pinned to, or null for instance-wide. Enforced by
  //    `helpers/apiKeySite.ts`'s pin hook against a route's own `:siteId`, and by
  //    `models/groups.ts`'s `AccessActor.siteId` inside `checkAccess()`/`checkSiteAccess()`.
  siteId: string | null
}

/** Its message is returned to the caller on a 401, so it must stay safe to disclose. */
export class ApiKeyError extends Error {}

/**
 * An intersection, not a replacement: a scope can only take permissions away, never grant one the
 * groups did not already hold. `null` is an unscoped key — everything passes through.
 */
export function narrowToScope(permissions: string[], scope: string[] | null): string[] {
  if (scope === null) {
    return permissions
  }
  const allowed = new Set(scope)
  return permissions.filter((permission) => allowed.has(permission))
}

/**
 * A key is an RS256 JWT signed with the installation keypair, shown once at creation and never
 * stored: the signature proves authenticity, and the row is consulted for revocation, expiry and —
 * for a personal token — ownership. Permissions are resolved on every request rather than baked into
 * the token, so a group change takes effect immediately.
 *
 * A personal access token therefore holds its owner's CURRENT permissions, deliberately ruling out
 * two alternatives: a snapshot taken at issue time would let a token outlive the access it was
 * minted with (demote or deactivate the user and every token they ever issued keeps working until
 * somebody revokes it by hand), and an admin-style `groups` selection on the token itself would let
 * a user mint a bearer token holding more than their own account does. `scope` still narrows a
 * personal token exactly like an admin one, over the live-resolved set.
 */
class ApiKeys {
  private privateKey(): crypto.KeyObject {
    return crypto.createPrivateKey({
      key: CARDINAL.config.auth.certs.private,
      passphrase: CARDINAL.config.auth.certs.passphrase
    })
  }

  /**
   * Replace the signing keypair and its passphrase, invalidating every key ever issued — a key is
   * only a signature over its claims, so this is what takes back keys that have escaped. The rows
   * stay and are NOT marked revoked: revocation is a decision about one key, and saying it about all
   * of them would lose the distinction. Session cookies are untouched, being signed with
   * `auth.secret` instead.
   *
   * @returns How many keys were still usable and no longer are, or null if the settings failed to save
   */
  async regenerateCertificates(): Promise<number | null> {
    const previousAuth = CARDINAL.config.auth
    const usable = await CARDINAL.db.$count(
      apiKeysTable,
      and(eq(apiKeysTable.isRevoked, false), gt(apiKeysTable.expiration, sql`now()`))
    )

    CARDINAL.config.auth = { ...previousAuth, certs: generateSigningCertificates() }
    // -> Propagates as `reloadConfig`, which is how other instances stop trusting the tokens this
    //    one has just disowned. `verify()` reads `certs.public` fresh per call rather than off a
    //    value handed to a plugin at boot, so no restart is needed anywhere.
    if (!(await CARDINAL.configSvc.saveToDb(['auth']))) {
      CARDINAL.config.auth = previousAuth
      return null
    }

    CARDINAL.logger.info('auth', 'regenerated the API key certificates', { invalidated: usable })
    return usable
  }

  /**
   * Every key, newest first — revoked and expired ones included, since the admin list shows state.
   *
   * A key issued before the certificates were last regenerated fails on its signature with nothing
   * on the row to explain why, so each is marked against the keypair's age.
   */
  async getKeys(): Promise<ApiKeyListEntry[]> {
    const results = await CARDINAL.db
      .select()
      .from(apiKeysTable)
      .orderBy(desc(apiKeysTable.createdAt))
    const generatedAt = Temporal.Instant.from(CARDINAL.config.auth.certs.generatedAt)
    return results.map((key) => ({
      ...key,
      isInvalidated: Temporal.Instant.compare(key.createdAt.toTemporalInstant(), generatedAt) < 0
    }))
  }

  certificatesGeneratedAt(): string {
    return CARDINAL.config.auth.certs.generatedAt
  }

  /** The self-service counterpart to the admin-only `getKeys()`. */
  async listKeysForUser(userId: string): Promise<ApiKeyListEntry[]> {
    const results = await CARDINAL.db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.userId, userId))
      .orderBy(desc(apiKeysTable.createdAt))
    const generatedAt = Temporal.Instant.from(CARDINAL.config.auth.certs.generatedAt)
    return results.map((key) => ({
      ...key,
      isInvalidated: Temporal.Instant.compare(key.createdAt.toTemporalInstant(), generatedAt) < 0
    }))
  }

  /**
   * Mint a new key. The returned token is the only time it exists outside the client.
   *
   * `groups` is meaningless for a personal token (`userId` set) and is stored — and signed into
   * `grp` — as `[]` for those, since `verify()` never reads it once `userId` is present.
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
    groups?: string[]
    scope?: string[] | null
    /** A per-level classification allow-set, or null for unrestricted. */
    allowedClassifications?: string[] | null
    /** The single site to pin the key to, or null for instance-wide. */
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

    await CARDINAL.db.insert(apiKeysTable).values({
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

  async getKeyById(id: string): Promise<ApiKey | null> {
    const results = await CARDINAL.db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, id))
      .limit(1)
    return results[0] ?? null
  }

  /** Permanent: a token already handed out stops working on its next request. */
  async revokeKey(id: string): Promise<boolean> {
    const result = await CARDINAL.db
      .update(apiKeysTable)
      .set({ isRevoked: true, updatedAt: sql`now()` })
      .where(eq(apiKeysTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Ownership lives in the `WHERE` rather than in a separate check, which is what makes this safe to
   * call straight from a route: someone else's key, or an ownerless admin-issued one, updates zero
   * rows and answers `false` exactly like a key that does not exist, so the two cannot be told apart.
   */
  async revokeKeyForUser(id: string, userId: string): Promise<boolean> {
    const result = await CARDINAL.db
      .update(apiKeysTable)
      .set({ isRevoked: true, updatedAt: sql`now()` })
      .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.userId, userId)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Housekeeping, not a security measure: a revoked key already authenticates nothing, and this only
   * takes its row out of the admin list. It costs the record that the key ever existed, which is why
   * nothing does it automatically.
   *
   * Invalidated-but-not-revoked keys are left alone — nobody decided anything about those, and the
   * row is what tells the owner to reissue. Revoking is the decision this deletes the record of.
   */
  async purgeRevoked(): Promise<number> {
    const result = await CARDINAL.db.delete(apiKeysTable).where(eq(apiKeysTable.isRevoked, true))
    const purged = result.rowCount ?? 0
    // -> Runs from a scheduled job, so a tick that found nothing stays off `info`.
    if (purged > 0) {
      CARDINAL.logger.info('auth', 'purged revoked API keys', { keys: purged })
    } else {
      CARDINAL.logger.debug('auth', 'no revoked API keys to purge')
    }
    return purged
  }

  /**
   * A group that no longer exists contributes nothing, so deleting a group narrows the keys pointing
   * at it rather than breaking them.
   */
  async resolvePermissions(groupIds: string[], scope: string[] | null = null): Promise<string[]> {
    if (groupIds.length < 1) {
      return []
    }
    const rows = await CARDINAL.db
      .select({ permissions: groupsTable.permissions })
      .from(groupsTable)
      .where(inArray(groupsTable.id, groupIds))
    const permissions = uniq(flatten(rows.map((r: any) => (r.permissions ?? []) as string[])))
    return narrowToScope(permissions, scope)
  }

  /**
   * The live lookup `verify()` runs instead of trusting anything baked into the token or the key
   * row. `null` when the account is gone: `onDelete: 'cascade'` takes the key row with it, but a
   * request already holding `req.apiKey` from before that instant must not be trusted either.
   */
  private async resolveOwner(
    userId: string
  ): Promise<{ isActive: boolean; groupIds: string[]; permissions: string[] } | null> {
    const rows = await CARDINAL.db
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

  /** @throws ApiKeyError with a reason suitable for a 401 response */
  async verify(token: string): Promise<ApiKeyIdentity> {
    if (CARDINAL.config.api.isEnabled !== true) {
      throw new ApiKeyError('The API is disabled.')
    }

    let claims
    try {
      claims = verifyJwt(token, CARDINAL.config.auth.certs.public, {
        audience: TOKEN_AUDIENCE
      })
    } catch (err: any) {
      throw new ApiKeyError(err.message)
    }

    // -> A token this keypair signed that names no key: logins are sessions, and this keypair signs
    //    nothing but API keys, so there is nothing else it could be.
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
    // -> Re-checked against the row even though the token carries its own `exp`: the row is what the
    //    admin area shows, so a mismatch fails closed rather than trusting the token.
    if (Temporal.Instant.compare(key.expiration.toTemporalInstant(), Temporal.Now.instant()) <= 0) {
      throw new ApiKeyError('API key has expired.')
    }

    const siteId = typeof claims.site === 'string' ? claims.site : null

    // -> A personal access token: `groups`/`grp` are inert here (always `[]`), so membership is
    //    resolved live from the owner instead.
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

export interface ApiKeyCreateInput {
  name: string
  siteId?: string | null
  allowedClassifications?: string[] | null
}

/**
 * What both key-creation routes check identically. An admin-issued key additionally validates its
 * `groups`, which has no personal-token counterpart and so stays at that route.
 *
 * @param label What the route calls the thing being created, for the name message: `Key`/`Token`
 * @returns The message to answer `400` with, or null when the input is acceptable
 */
export function validateApiKeyInput(body: ApiKeyCreateInput, label: string): string | null {
  if (!/^[^<>"]+$/.test(body.name)) {
    return `${label} name contains invalid characters.`
  }
  if (body.siteId != null && !CARDINAL.sites[body.siteId]) {
    return 'This site does not exist.'
  }
  if (
    body.allowedClassifications != null &&
    body.allowedClassifications.some((id) => !CARDINAL.models.classificationLevels.byId(id))
  ) {
    return 'One of the classification levels does not exist.'
  }
  return null
}

/**
 * Minting and recording are one act rather than two: a key that exists with no audit trail is what
 * the audit log is there to make impossible. `detail` differs between the two routes, so it is
 * passed in. A plain function because it composes two models and neither owns the other.
 */
export async function issueKey(
  input: Parameters<ApiKeys['createKey']>[0],
  audit: { actor: AuditActor; detail: Record<string, unknown> }
): Promise<{ id: string; key: string }> {
  const { id, key } = await CARDINAL.models.apiKeys.createKey(input)
  await CARDINAL.models.auditLog.record({
    event: 'apiKey.issued',
    actor: audit.actor,
    targetType: 'apiKey',
    targetId: id,
    targetLabel: input.name,
    detail: audit.detail
  })
  return { id, key }
}
