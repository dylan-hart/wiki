import { sql } from 'drizzle-orm'
import type { ApprovalMatchMode } from '../helpers/approvalMatch.ts'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  bytea,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core'

// == CUSTOM TYPES =====================

// -> Typed as a string: an ltree path comes back from the driver as its dotted text form, and every
//    caller treats it as one
const ltree = customType<{ data: string }>({
  dataType() {
    return 'ltree'
  }
})
const tsvector = customType({
  dataType() {
    return 'tsvector'
  }
})

// == TABLES ===========================

// API KEYS ----------------------------
export const apiKeys = pgTable(
  'apiKeys',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull(),
    // -> Only the tail of the token, to tell keys apart in the admin list. The token itself is a
    //    signed JWT shown once at creation and never stored: it is a bearer credential, and
    //    verification needs the public key plus this row's state, not the token.
    keyShort: varchar({ length: 8 }).notNull(),
    // -> IDs of the groups whose permissions the key carries. Resolved on every request, so editing a
    //    group immediately affects the keys pointing at it.
    groups: uuid().array().notNull().default([]),
    // -> An explicit permission allow-list the key is narrowed to, or null for no narrowing at all
    //    (the key carries the full union of its groups' permissions). Never widens:
    //    `resolvePermissions()` intersects this against what the groups actually grant, so editing a
    //    group can only take permissions away from a scoped key, never hand it one its scope doesn't
    //    list.
    scope: jsonb().$type<string[] | null>().default(null),
    // -> Deliberately nullable, unlike every other siteId column in this schema: null means the key
    //    is instance-wide (every site), which is today's only behavior and stays the default. A
    //    non-null value pins the key to one site, enforced two ways (OpenProject #2189): a global
    //    `preHandler` (`helpers/apiKeySite.ts#apiKeySitePinHook`, registered in `index.ts`) refuses
    //    every `/sites/:siteId/...` REST call whose param disagrees with the pin, and the permission
    //    engine itself refuses it too — `models/groups.ts`'s `AccessActor.siteId`, carried onto every
    //    actor built from a pinned key, is checked by `checkAccess()`/`checkSiteAccess()` before any
    //    rule is even resolved. A hostname- or body-resolved site (no `:siteId` path param for the
    //    hook to see) calls `enforceApiKeySite()` directly instead — see that helper's doc comment.
    siteId: uuid().references(() => sites.id),
    // -> A per-level allow-set (OpenProject #1205, replacing the earlier #1055 single-value
    //    "ceiling"): null means unrestricted (today's only behavior, and the default, and stays
    //    unrestricted against any level added later), an array of level ids means this key/token may
    //    never be granted a page permission on a page whose classification is not IN this set --
    //    checked in `groups.checkAccess()` alongside `scope` above, before any rule is even
    //    consulted. `jsonb` rather than a uuid column with an FK, same shape as `scope` above -- a
    //    free allow-set has no single value left for a column-level FK to reference.
    //    `models/classificationLevels.ts#delete()`'s "in use" guard checks this column with a jsonb
    //    containment query instead, for the same reason it still checks `pages`.
    allowedClassifications: jsonb().$type<string[] | null>().default(null),
    // -> Non-null makes this a personal access token: created by and acting as this user, rather than
    //    an admin-issued key carrying `groups` above. A personal token's permissions are never read
    //    from `groups` (left `[]` for these rows) or snapshotted at creation — `models/apiKeys.ts`'s
    //    `verify()` resolves them live from the user's CURRENT group membership on every request, the
    //    same "no waiting for a re-login" guarantee a session already gets (see `groups.reloadCache`'s
    //    own comment). `onDelete: 'cascade'`, unlike every other `authorId`-shaped column in this
    //    schema that goes `set null`: a personal token has no meaning once its owner is gone -- it is a
    //    credential for acting AS that account, not a record of something that already happened, so
    //    there is no audit trail reason to keep the row around orphaned.
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    expiration: timestamp({ withTimezone: true }).notNull().defaultNow(),
    isRevoked: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index('apiKeys_siteId_idx').on(table.siteId),
    index('apiKeys_userId_idx').on(table.userId)
  ]
)

// AUDIT LOG ----------------------------
/**
 * One row per instance-wide, permission-affecting event: user/group/permission changes, API key
 * issuance and revocation, site settings edits, storage-target changes, and login history.
 *
 * Deliberately narrower than page history (`pageHistory` below) -- page content edits are already
 * covered there, per page, and repeating them here would be a second copy of the same events with
 * none of the diffing/restore machinery that makes the page-scoped table useful. This table answers
 * "what happened on this wiki" instead of "what happened to this page".
 *
 * Append-only: nothing ever updates a row, and the only deletions are the retention job
 * (`tasks/simple/clean-audit-log.ts`) trimming rows older than the configured window.
 */
export const auditLog = pgTable(
  'auditLog',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * `<subject>.<verb>`, e.g. `user.created`, `group.permissionsChanged`, `apiKey.issued`,
     * `login.success`. A varchar rather than an enum, same reasoning as `pageHistory.action`: a new
     * event kind should not need a migration. `models/auditLog.ts`'s `AUDIT_EVENTS` is the closed
     * list callers are expected to use.
     */
    event: varchar({ length: 64 }).notNull(),
    // -> Null once the account is gone, or for an event with no human actor (a scheduled job).
    //    `set null` rather than `restrict`/`cascade`: a log entry survives its actor exactly the way
    //    `pageHistory.authorId` does, for the same reason -- deleting a user must not be blocked by,
    //    or take down, the record of what they once did.
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    // -> Snapshotted at write time, same reasoning as `pageHistory` keeping `locale`/`path`/`title`
    //    as columns rather than joining live: a renamed or deleted account must not rewrite history
    //    that already happened under the old name.
    actorName: varchar({ length: 255 }).notNull().default(''),
    actorIp: varchar({ length: 64 }).notNull().default(''),
    // -> What kind of thing the event happened to -- `user`, `group`, `apiKey`, `site`,
    //    `storageTarget` -- and its id/label at the time. Not a foreign key: several of those
    //    target tables (`groups`, `apiKeys`, ...) have no stable reason to keep a row alive just
    //    because it once appeared in a log, and a deleted group's history is exactly the case this
    //    table exists to keep.
    targetType: varchar({ length: 32 }).notNull().default(''),
    targetId: varchar({ length: 255 }).notNull().default(''),
    targetLabel: varchar({ length: 255 }).notNull().default(''),
    // -> What changed, shaped per event -- e.g. `{ changedFields: [...] }` for an update, `{ groups:
    //    [...] }` for a key issuance. Free-form the same way `pageHistory.meta` is, for the same
    //    reason: a field added to the thing being logged should not need this table's shape to change.
    detail: jsonb().notNull().default({}),
    // -> Null for an event with no site context (user/group/apiKey management). Site settings and
    //    storage-target changes are per-site, and a login happens against the site it was attempted
    //    on, so those rows carry it.
    siteId: uuid().references(() => sites.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> The admin list's default view: newest first, across the whole instance
    index('auditLog_createdAt_idx').on(table.createdAt),
    // -> Filtering by actor or by event, the other two filters the admin list offers
    index('auditLog_actorId_idx').on(table.actorId, table.createdAt),
    index('auditLog_event_idx').on(table.event, table.createdAt),
    index('auditLog_siteId_idx').on(table.siteId, table.createdAt)
  ]
)

// APPROVAL RULES ----------------------
/**
 * Which pages accept edit suggestions, who may submit them, and who reviews them.
 *
 * Per site, and matched the way group page rules are: a mode plus a pattern. A page no rule matches
 * accepts no suggestions at all, so this table being empty means the feature is off.
 */
export const approvalRules = pgTable(
  'approvalRules',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull().default(''),
    // -> A rule can be turned off without losing what it says, which is how an administrator suspends
    //    suggestions on a section without having to write the rule again afterwards.
    isEnabled: boolean().notNull().default(true),
    // -> One of START / EXACT / END / REGEX / TAG / TAGALL, the same set group page rules use. A
    //    varchar rather than an enum so that adding a mode does not need a migration; the API schema
    //    is what rejects an unknown one.
    match: varchar({ length: 16 }).$type<ApprovalMatchMode>().notNull().default('START'),
    path: varchar({ length: 2048 }).notNull().default(''),
    // -> Group IDs. Resolved on use rather than joined, so deleting a group takes effect at once, the
    //    way `apiKeys.groups` works.
    submitterGroups: uuid().array().notNull().default([]),
    reviewerGroups: uuid().array().notNull().default([]),
    // -> How many distinct reviewers have to approve a submission this rule covers before it is
    //    finalized (written to the page). 1 keeps today's single-approver sign-off as the default; a
    //    rule wanting multiple sign-offs raises it. Enforced in `approveSubmission`, which counts
    //    distinct approvers recorded in `pageEditSubmissionApprovals` against the highest threshold of
    //    every enabled rule currently matching the page -- see the doc comment there.
    minApprovals: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [index('approvalRules_siteId_idx').on(table.siteId)]
)

// ASSETS ------------------------------
export const assetKindEnum = pgEnum('assetKind', ['document', 'image', 'other'])
export const assets = pgTable(
  'assets',
  {
    id: uuid().primaryKey().defaultRandom(),
    fileName: varchar({ length: 255 }).notNull(),
    fileExt: varchar({ length: 255 }).notNull(),
    isSystem: boolean().notNull().default(false),
    kind: assetKindEnum().notNull().default('other'),
    mimeType: varchar({ length: 255 }).notNull().default('application/octet-stream'),
    fileSize: bigint({ mode: 'number' }), // in bytes
    meta: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    data: bytea(),
    preview: bytea(),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [index('assets_siteId_idx').on(table.siteId)]
)

// AUTHENTICATION ----------------------
export const authentication = pgTable('authentication', {
  id: uuid().primaryKey().defaultRandom(),
  module: varchar({ length: 255 }).notNull(),
  isEnabled: boolean().notNull().default(false),
  displayName: varchar({ length: 255 }).notNull().default(''),
  config: jsonb().notNull().default({}),
  // -> Split from a single `registration` column: a form-based module's own self-registration form
  //    and a redirect-based provider's auto-provisioning of new accounts are gated separately, since
  //    an administrator may want one without the other (WP #2130).
  selfRegistration: boolean().notNull().default(false),
  autoProvision: boolean().notNull().default(false),
  allowedEmailRegex: varchar({ length: 255 }).notNull().default(''),
  autoEnrollGroups: uuid().array().default([]),
  // -> Off by default: an existing account is only ever claimed by a provider login once this
  //    strategy is explicitly told to trust the address it reports. See
  //    `models/users.ts#findOrCreateProviderUser()`.
  trustEmailForLinking: boolean().notNull().default(false),
  // -> Admin-chosen subset of groups a provider login is allowed to grant/revoke via `mapGroups`.
  //    Empty by default, meaning a login changes no group memberships. See
  //    `models/users.ts#syncProviderGroups()`.
  mappableGroups: uuid().array().default([])
})

// CONTENT SYNC STATE -------------------
export const syncContentTypeEnum = pgEnum('syncContentType', ['page', 'asset'])
export const syncDirectionEnum = pgEnum('syncDirection', ['push', 'pull'])
/**
 * One row per (content item, storage target): where a sync run last left that pairing.
 *
 * A page or asset can have several enabled targets at once, so this cannot be a jsonb column on
 * `pages`/`assets` keyed by target -- that would need hand-rolled merge logic on every write to avoid
 * clobbering the other targets' entries. `contentId` is deliberately not a foreign key: it points at
 * `pages.id` or `assets.id` depending on `contentType`, and no single column can reference two tables.
 */
export const contentSyncState = pgTable(
  'contentSyncState',
  {
    id: uuid().primaryKey().defaultRandom(),
    contentType: syncContentTypeEnum().notNull(),
    contentId: uuid().notNull(),
    targetId: uuid()
      .notNull()
      .references(() => storage.id, { onDelete: 'cascade' }),
    // -> Direction of the most recent *successful* sync. Null until one has ever succeeded.
    lastDirection: syncDirectionEnum(),
    // -> Opaque to this table: a git commit hash, an S3 object key/etag, whatever the target module
    //    that owns `targetId` needs to recognize what it last wrote. jsonb so a module can store a
    //    structured ref (e.g. `{ commit, branch }`) without a schema change.
    targetRef: jsonb(),
    // -> Completion time of the most recent successful sync. Null until one has ever succeeded; read
    //    back with `.toTemporalInstant()`, per this repo's Temporal convention.
    lastSyncedAt: timestamp({ withTimezone: true }),
    // -> Message from the most recent attempt, cleared to null the moment an attempt succeeds. A
    //    non-null value here alongside a non-null `lastSyncedAt` means the item synced successfully at
    //    some point but the *latest* attempt since then failed.
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> Enforces one row per content item per target, and covers "every state for this target" --
    //    the out-of-date query's access pattern -- being the leading column.
    uniqueIndex('contentSyncState_target_content_idx').on(
      table.targetId,
      table.contentType,
      table.contentId
    ),
    // -> Covers "every target's state for this content item"
    index('contentSyncState_content_idx').on(table.contentType, table.contentId)
  ]
)

// BLOCKS ------------------------------
export const blocks = pgTable(
  'blocks',
  {
    id: uuid().primaryKey().defaultRandom(),
    block: varchar({ length: 255 }).notNull(),
    name: varchar({ length: 255 }).notNull(),
    description: varchar({ length: 255 }).notNull(),
    icon: varchar({ length: 255 }).notNull(),
    isEnabled: boolean().notNull().default(false),
    isCustom: boolean().notNull().default(false),
    config: jsonb().notNull().default({}),
    // -> The rest of this row is what makes a CUSTOM block self-describing — a built-in one has no
    //    use for any of it, since its props/template come from the compiled manifest and it always
    //    renders as `block-{block}`. Left at their defaults for a built-in row.
    // -> The component's authorable attributes, in the same shape `BlockDefinition.props` uses for a
    //    built-in — read instead of the manifest by `models/blocks.ts#getSiteBlocks()` when isCustom.
    props: jsonb().notNull().default([]),
    // -> Body the editor writes between the opening and closing lines, for a custom block whose
    //    content is other blocks. Empty for one that takes none.
    template: text().notNull().default(''),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  // -> Covers lookups by site as well, being the leading column
  (table) => [uniqueIndex('blocks_composite_idx').on(table.siteId, table.block)]
)

// COMMENT PROVIDERS --------------------
// -> Which comment provider is active for a site, and what it is configured with. Mirrors the shape
//    of `storage` below: one row per module per site, `config` holding the values for the props that
//    module's `definition.yml` (under `modules/comments/`) declares. Unlike storage, only ever one
//    row per site has `isEnabled` true — comments have a single active provider, not several
//    simultaneous targets — enforced by `models/commentProviders.ts`, not by a db constraint.
export const commentProviders = pgTable(
  'commentProviders',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Directory name under `modules/comments`, one row per module per site
    module: varchar({ length: 255 }).notNull(),
    isEnabled: boolean().notNull().default(false),
    // -> Values for the props the module declares in its `definition.yml`
    config: jsonb().notNull().default({}),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  // -> Covers lookups by site as well, being the leading column
  (table) => [uniqueIndex('commentProviders_composite_idx').on(table.siteId, table.module)]
)

// -> The compiled component code for a custom block, one-to-one with its `blocks` row. Split out
//    rather than a column on `blocks` itself: `getSiteBlocks()` lists every block on a site on every
//    call the editor's picker makes, and that listing has no use for the bytes — only the new serving
//    route (fetching a single block's code by id) does. `onDelete: 'cascade'` is a safety net, not the
//    only mechanism — `deleteCustomBlock()` removes this row itself so the deletion does not depend on
//    it.
export const blockCode = pgTable('blockCode', {
  blockId: uuid()
    .primaryKey()
    .references(() => blocks.id, { onDelete: 'cascade' }),
  code: bytea().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

// BLOCK CREDENTIALS --------------------
/**
 * A secret held server-side only, for a block whose props (embedded in a page's own markdown, plainly
 * readable by anyone holding `read:source`) must never carry the credential itself — `block-live-data`
 * (OpenProject #868) is the first, and so far only, consumer. A block prop stores this row's `id`
 * alone; resolving `secret` happens entirely server-side (`models/blockCredentials.ts`'s
 * `getCredentialForResolve()`) and it is never serialized back into an API response — see that
 * model's header comment.
 * `allowedOrigins` is the deny-by-default scoping list `models/liveData.ts#resolve()` checks a
 * block's configured URL against before ever attaching the secret — see that file's header comment.
 * Each entry is a full origin (scheme + host + optional port) plus an optional path prefix, e.g.
 * `https://api.example.com/v1` — not a bare hostname, and never `http:` in practice since a
 * credentialed resolve refuses any request whose own scheme isn't `https:` regardless of what an
 * entry names.
 */
export const blockCredentials = pgTable(
  'blockCredentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    name: varchar({ length: 255 }).notNull(),
    secret: text().notNull(),
    allowedOrigins: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index('blockCredentials_siteId_idx').on(table.siteId)]
)

// CLASSIFICATION LEVELS -----------------
/**
 * The admin-configurable sensitivity levels a page may carry (OpenProject #1079), same pattern as
 * `groups`: seeded with three defaults (`public` / `internal` / `restricted`, at the fixed
 * `systemIds` below) that an administrator may rename, reorder, add to, or remove -- no pluggable
 * external classification provider, plain Wiki.js data.
 *
 * Instance-wide, not per-site, mirroring `groups` itself.
 */
export const classificationLevels = pgTable(
  'classificationLevels',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull(),
    // -> Lower is more open. This is the floor-invariant ordering (#1080) and the display order --
    //    independent of insertion order or id, both of which an admin cannot rearrange by renaming.
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex('classificationLevels_sortOrder_idx').on(table.sortOrder)]
)

// GROUPS ------------------------------
export const groups = pgTable('groups', {
  id: uuid().primaryKey().defaultRandom(),
  name: varchar({ length: 255 }).notNull(),
  permissions: jsonb().notNull(),
  rules: jsonb().notNull(),
  redirectOnLogin: varchar({ length: 255 }).notNull().default(''),
  redirectOnFirstLogin: varchar({ length: 255 }).notNull().default(''),
  redirectOnLogout: varchar({ length: 255 }).notNull().default(''),
  isSystem: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

// GLOSSARY TERMS -----------------------
export const glossaryTerms = pgTable(
  'glossaryTerms',
  {
    id: uuid().primaryKey().defaultRandom(),
    term: varchar({ length: 255 }).notNull(),
    definition: text().notNull(),
    // -> Alternate surface forms (acronyms, alternate names) that resolve to this same term's
    //    `definition`/`pageId` -- no per-alias override (OpenProject #1110). Uniqueness across this
    //    column combined with `term`, and across rows, is enforced at the application level in
    //    `models/glossary.ts` -- a plain index cannot express "unique across an array column + a
    //    scalar column, combined, across every row".
    aliases: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> The term's canonical page, optional. `set null` rather than `cascade`: deleting the linked
    //    page should unlink the term, not delete the definition itself.
    pageId: uuid().references(() => pages.id, { onDelete: 'set null' })
  },
  (table) => [
    // -> One definition covers every casing variant of a term (OpenProject #870), so two rows that
    //    differ only by case are a duplicate, not two distinct terms. This only guards `term` itself --
    //    alias collisions (with another row's term OR aliases) are checked in `models/glossary.ts`.
    //    Covers lookups by site alone as well, being the leading column.
    uniqueIndex('glossaryTerms_composite_idx').on(table.siteId, sql`lower(${table.term})`)
  ]
)

// GLOSSARY VERSIONS --------------------
/**
 * One row per saved snapshot of a site's ENTIRE glossary term list (OpenProject #1113) -- not a
 * per-term history mirroring `pageHistory`. Written whenever the admin staged-edit workflow saves,
 * an import replaces the glossary, or a version is restored, each of which goes through
 * `models/glossary.ts`'s `saveVersion()`. Append-only: nothing ever updates a row; nothing currently
 * prunes them either, unlike `auditLog`'s retention job -- a glossary's version count is small and
 * human-triggered, not one row per API call.
 */
export const glossaryVersions = pgTable(
  'glossaryVersions',
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> The GlossaryExport shape (`models/glossary.ts`) -- the SAME JSON representation
    //    export/import use (OpenProject #1114), so a version can be exported or restored through the
    //    exact same wholesale-replace path as an import.
    snapshot: jsonb().notNull(),
    termCount: integer().notNull(),
    // -> Same reasoning as `auditLog.actorId`/`actorName`: `set null` so a log entry survives its
    //    actor, `actorName` snapshotted at write time so a renamed/deleted account doesn't rewrite
    //    history that already happened under the old name.
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    actorName: varchar({ length: 255 }).notNull().default(''),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> Covers lookups by site alone as well, being the leading column
    index('glossaryVersions_siteId_createdAt_idx').on(table.siteId, table.createdAt)
  ]
)

// HOOKS -------------------------------
export const hookStateEnum = pgEnum('hookState', ['pending', 'success', 'error'])
export const hooks = pgTable(
  'hooks',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull(),
    // -> Event keys such as `page:create`, matched against what the server emits
    events: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    url: text().notNull(),
    includeMetadata: boolean().notNull().default(true),
    includeContent: boolean().notNull().default(false),
    acceptUntrusted: boolean().notNull().default(false),
    // -> Sent verbatim as the Authorization header, so it holds whatever secret the remote expects
    authHeader: text(),
    // -> Outcome of the most recent delivery, which is what the admin list shows
    state: hookStateEnum().notNull().default('pending'),
    lastErrorMessage: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // -> Null means "fires for every site" -- today's behavior, and what every hook created before
    //    this column existed keeps meaning with no backfill. `set null` on delete rather than
    //    restricting it or cascading: a webhook scoped to a site that goes away reverts to firing
    //    instance-wide instead of taking the row down with the site or blocking the site's deletion —
    //    unlike `blocks`/`storage`/`siteAssets`/content, which `sites.deleteSite()` cleans up
    //    explicitly (or, for content, deliberately blocks the delete on), a hook is not site-owned
    //    content and has no reason to disappear or block anything just because its scope did.
    siteId: uuid().references(() => sites.id, { onDelete: 'set null' })
  },
  (table) => [index('hooks_siteId_idx').on(table.siteId)]
)

// ICONS -------------------------------
// -> An Iconify icon set the wiki draws icons from, e.g. `mdi`. Adding one makes its icons
//    searchable; individual icons are only stored once something references them.
export const iconSets = pgTable('iconSets', {
  // -> The Iconify prefix, which is what content references: `<prefix>:<name>`
  prefix: varchar({ length: 64 }).primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  isEnabled: boolean().notNull().default(true),
  // -> Iconify collection metadata (author, license, total, palette, samples, ...) as published by
  //    the upstream API, refreshed on demand rather than being authored here
  info: jsonb().notNull().default({}),
  refreshedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

// -> The permanent home of every icon the wiki has ever served. Fetched from the Iconify API on first
//    use, then never fetched again: the disk cache is derived from these rows and may be empty.
export const icons = pgTable(
  'icons',
  {
    prefix: varchar({ length: 64 })
      .notNull()
      .references(() => iconSets.prefix),
    name: varchar({ length: 255 }).notNull(),
    // -> The SVG markup inside the `<svg>` element, with `currentColor` left as-is
    body: text().notNull(),
    // -> Resolved Iconify icon properties: the viewBox is `left top width height`, and the transform
    //    flags apply on top of it. Aliases are resolved before storing, so a row is self-contained.
    width: integer().notNull().default(16),
    height: integer().notNull().default(16),
    left: integer().notNull().default(0),
    top: integer().notNull().default(0),
    rotate: integer().notNull().default(0),
    hFlip: boolean().notNull().default(false),
    vFlip: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.prefix, table.name] })]
)

// JOB HISTORY -------------------------
export const jobHistoryStateEnum = pgEnum('jobHistoryState', [
  'active',
  'completed',
  'failed',
  'interrupted'
])
export const jobHistory = pgTable(
  'jobHistory',
  {
    id: uuid().primaryKey().defaultRandom(),
    task: varchar({ length: 255 }).notNull(),
    state: jobHistoryStateEnum().notNull(),
    useWorker: boolean().notNull().default(false),
    wasScheduled: boolean().notNull().default(false),
    payload: jsonb(),
    attempt: integer().notNull().default(1),
    maxRetries: integer().notNull().default(0),
    lastErrorMessage: text(),
    executedBy: varchar({ length: 255 }),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
    // -> Whatever a task chose to hand back, e.g. `exportContent`'s `{ filePath, fileSize }` — set via
    //    `models/jobs.ts#setResult`, which is how a follow-up route (the export download) finds what a
    //    background job produced without the two coupling to anything more specific than a job id.
    result: jsonb()
  },
  (table) => [
    // -> `models/hooks.ts#getDeliveryHistory()` filters this generic table by
    //    `task = 'dispatchWebhook'` and the `hookId` embedded in `payload`, which has no usable index
    //    today: a plain btree on `payload` covers containment queries, not a `->>'hookId'` text
    //    extraction, and indexing every row's payload would size the index to the whole table for a
    //    lookup only one task ever makes. A partial expression index scoped to that one task keeps it
    //    small and keeps `jobHistory` itself generic — no `hookId` column on a table every other task
    //    also writes to.
    index('jobHistory_dispatchWebhook_hookId_idx')
      .on(sql`(payload ->> 'hookId')`)
      .where(sql`${table.task} = 'dispatchWebhook'`),
    // -> Backs `core/scheduler.ts#reapStaleJobs`'s `WHERE state = 'active' AND startedAt < cutoff`.
    //    Partial and scoped to `startedAt` alone rather than a `(state, startedAt)` composite: the
    //    other two `state` filters (the admin Scheduler listing's `state IN (...)`, and
    //    `models/jobs.ts#cleanHistory`'s `state != 'active'`) don't share this predicate --
    //    `cleanHistory`'s is a negation a btree leading on `state` wouldn't use selectively anyway --
    //    and `active` rows are transient, so this index stays near-empty no matter how large the
    //    (bounded, `historyExpiration`-pruned) table itself grows.
    index('jobHistory_active_idx')
      .on(table.startedAt)
      .where(sql`${table.state} = 'active'`)
  ]
)

// JOB SCHEDULE ------------------------
export const jobSchedule = pgTable(
  'jobSchedule',
  {
    id: uuid().primaryKey().defaultRandom(),
    task: varchar({ length: 255 }).notNull(),
    cron: varchar({ length: 255 }).notNull(),
    type: varchar({ length: 255 }).notNull().default('system'),
    payload: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // Defence in depth behind the boot-time advisory lock (see
    // `core/scheduler.ts`'s cron-seeding path): a duplicate `task` value must be rejected at the
    // db, not merely absorbed silently if the lock is ever bypassed or a seed runs twice.
    uniqueIndex('jobSchedule_task_idx').on(table.task)
  ]
)

// JOB LOCK ----------------------------
export const jobLock = pgTable('jobLock', {
  key: varchar({ length: 255 }).primaryKey(),
  lastCheckedBy: varchar({ length: 255 }),
  lastCheckedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

// JOBS --------------------------------
export const jobs = pgTable(
  'jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    task: varchar({ length: 255 }).notNull(),
    useWorker: boolean().notNull().default(false),
    payload: jsonb(),
    retries: integer().notNull().default(0),
    maxRetries: integer().notNull().default(0),
    waitUntil: timestamp({ withTimezone: true }),
    isScheduled: boolean().notNull().default(false),
    createdBy: varchar({ length: 255 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> Supports `core/scheduler.ts#processJob`'s claim subquery, which orders by
    //    `waitUntil ASC NULLS FIRST, createdAt ASC` under `FOR UPDATE SKIP LOCKED` (matching
    //    `models/jobs.ts#getUpcoming()`) rather than by `id` -- this table previously carried no
    //    index beyond the primary key, which otherwise sorts a sequential scan on every poll.
    index('jobs_waitUntil_createdAt_idx').on(table.waitUntil, table.createdAt)
  ]
)

// LOCALES -----------------------------
export const locales = pgTable(
  'locales',
  {
    code: varchar({ length: 255 }).primaryKey(),
    name: varchar({ length: 255 }).notNull(),
    nativeName: varchar({ length: 255 }).notNull(),
    language: varchar({ length: 8 }).notNull(), // Unicode language subtag
    region: varchar({ length: 3 }).notNull(), // Unicode region subtag
    script: varchar({ length: 4 }).notNull(), // Unicode script subtag
    isRTL: boolean().notNull().default(false),
    strings: jsonb().notNull().default([]),
    completeness: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index('locales_language_idx').on(table.language)]
)

// NAVIGATION --------------------------
// -> Where a menu's items come from: hand-authored (`static`, the only mode there has ever been),
//    walked live off the tree (`auto`), or the tree walk with hand-authored items layered on top
//    (`mixed`). Landed ahead of the walk itself -- every existing row defaults to `static`, so this
//    column changes nothing about how a menu resolves until something later actually reads it.
export const treeNavigationSourceEnum = pgEnum('treeNavigationSource', ['static', 'auto', 'mixed'])
export const navigation = pgTable(
  'navigation',
  {
    id: uuid().primaryKey().defaultRandom(),
    items: jsonb().notNull().default([]),
    mode: treeNavigationSourceEnum('mode').notNull().default('static'),
    // -> Set only for the site-wide default menu, where it is what makes (siteId, locale) that row's
    //    identity -- see the unique index below. Null for a row belonging to a tree entry override,
    //    which is addressed by that entry's own id instead and has no locale of its own to record: a
    //    unique index treats every null as distinct, so any number of overrides can share a site and
    //    locale without colliding on this constraint.
    locale: varchar({ length: 255 }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [
    // -> Covers lookups by site as well, being the leading column
    uniqueIndex('navigation_siteId_locale_idx').on(table.siteId, table.locale)
  ]
)

// PAGES ------------------------------
export const pagePublishStateEnum = pgEnum('pagePublishState', ['draft', 'published', 'scheduled'])
export const pages = pgTable(
  'pages',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> A BCP-47 code, matched only ever for equality. Not `ltree`: a hyphenated code is a single
    //    label to it, so `'pt-BR'::ltree <@ 'pt'` is false and the type buys no locale-family
    //    matching -- see the note on `pageHistory.locale`.
    locale: varchar({ length: 255 }).notNull(),
    path: varchar({ length: 255 }).notNull(),
    hash: varchar({ length: 255 }).notNull(),
    alias: varchar({ length: 255 }),
    title: varchar({ length: 255 }).notNull(),
    description: varchar({ length: 255 }),
    icon: varchar({ length: 255 }),
    publishState: pagePublishStateEnum('publishState').notNull().default('draft'),
    publishStartDate: timestamp({ withTimezone: true }),
    publishEndDate: timestamp({ withTimezone: true }),
    config: jsonb().notNull().default({}),
    relations: jsonb().notNull().default([]),
    // -> Internal-link target page paths found in the rendered content, resolved at save time by
    //    `models/rendering.ts#extractInternalLinks` (OpenProject #881). Unlike `relations` (authored,
    //    explicit) this is derived and gets fully overwritten on every save/re-render — never
    //    hand-edited, and never merged with a prior value.
    links: jsonb().notNull().default([]),
    content: text(),
    render: text(),
    searchContent: text(),
    ts: tsvector('ts'),
    tags: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    toc: jsonb(),
    editor: varchar({ length: 255 }).notNull(),
    contentType: varchar({ length: 255 }).notNull(),
    isBrowsable: boolean().notNull().default(true),
    isSearchable: boolean().notNull().default(true),
    // -> A `bcrypt` verifier, never the cleartext (OpenProject #2232) -- `models/pages.ts` hashes it
    //    on write and checks a guess against it with `bcrypt.compare` on read; nothing reads this
    //    column back as a value to hand to a caller.
    password: varchar({ length: 255 }),
    historyData: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    creatorId: uuid()
      .notNull()
      .references(() => users.id),
    ownerId: uuid()
      .notNull()
      .references(() => users.id),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> Every page always has a classification -- there is no unclassified state (OpenProject
    //    #1079). `models/pages.ts#createPage` always resolves and supplies one explicitly (the
    //    floor-invariant value against the parent, or the most-open level) on every real insert, so
    //    this column carries no default -- the one-time backfill that justified defaulting to the
    //    fixed `classificationPublicId` system row (`base.yml`) has already run, and a bare column
    //    default would otherwise keep naming that row even after an administrator deletes it (nothing
    //    in `models/classificationLevels.ts#delete` checks whether a column default points at the
    //    level being removed), silently pointing new rows at a level that no longer exists instead of
    //    failing loudly on whatever inserted without supplying one.
    //    No `onDelete` clause, so the FK's default RESTRICT is what stops an administrator deleting a
    //    level still in use -- see `models/classificationLevels.ts#delete`.
    classification: uuid()
      .notNull()
      .references(() => classificationLevels.id)
  },
  (table) => [
    index('pages_authorId_idx').on(table.authorId),
    index('pages_creatorId_idx').on(table.creatorId),
    index('pages_ownerId_idx').on(table.ownerId),
    index('pages_classification_idx').on(table.classification),
    index('pages_ts_idx').using('gin', table.ts),
    index('pages_tags_idx').using('gin', table.tags),
    // -> Backs `search.suggestTitle()`'s `similarity(title, …)` "did you mean" fallback, which runs
    //    only when full-text search found nothing — `pg_trgm` is already a required extension (see
    //    `core/db.ts`), this is the first index that actually uses it.
    index('pages_title_trgm_idx').using('gin', table.title.op('gin_trgm_ops')),
    // -> The invariant every probe in models/pages.ts assumes ("path unique within (site, locale)"),
    //    finally held by the database itself. On path, not hash: the hash is cyrb53 (53-bit,
    //    non-cryptographic), so two distinct paths may legitimately collide. Covers lookups by site
    //    alone as well, being the leading column -- no separate `pages_siteId_idx` needed.
    uniqueIndex('pages_siteId_locale_path_idx').on(table.siteId, table.locale, table.path),
    // -> Backs getPage's hottest read (siteId + hash + locale equality). Plain, not unique — see above.
    //    Also covers lookups by site alone, being the leading column.
    index('pages_siteId_locale_hash_idx').on(table.siteId, table.locale, table.hash)
  ]
)

// PAGE DRAFTS --------------------------
/**
 * The last unsaved edit a page's collaboration room was holding when it emptied out without a save
 * (OpenProject #2455) -- what `core/collab.ts#closeRoomIfEmpty` persists here, and what `viewer.draft`
 * on `GET .../pages/:pageIdOrHash` (and the `GET`/`DELETE .../pages/:pageId/draft` routes) let the
 * editor offer to restore on reopening after a crash or a closed tab.
 *
 * One row per page (`pageId` is the primary key, not merely a foreign key): collaborative editing is
 * a shared room, not a personal draft, so there is one "what was left unsaved" per page, not one per
 * user. Replaced wholesale on every persist (`onConflictDoUpdate`) and deleted the moment the page is
 * actually saved (`WIKI.collab.pageSaved`) or the reader chooses to discard it — this table never
 * accumulates history, it only ever holds the single most recent unsaved snapshot.
 */
export const pageDrafts = pgTable('pageDrafts', {
  pageId: uuid()
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  content: text().notNull(),
  title: varchar({ length: 255 }).notNull(),
  description: varchar({ length: 255 }).notNull(),
  icon: varchar({ length: 255 }).notNull(),
  // -> Null once the account is gone, rather than holding the account hostage. Mirrors
  //    `comments.authorId`.
  authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
  authorName: varchar({ length: 255 }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

// COMMENTS -----------------------------
/**
 * One row per comment (or reply) posted on a page.
 *
 * NOTE ON PROVENANCE: this table's shape is deliberately identical to the one independently designed
 * on the sibling `feature/comments-data-model` branch (Feature 389), inspected read-only per this
 * run's cross-branch rules — not merged, cherry-picked, or copied via git. That branch, and the
 * page-scoped comment CRUD REST API built on top of it (`feature/comments-rest-api`, Feature 391),
 * are not yet merged into this branch, but Task 625 (the admin moderation listing/deletion endpoint
 * below, in `api/comments.ts`) has nothing to list or delete without a `comments` table to query.
 * Matching the independently-designed shape field-for-field is meant to make reconciliation (likely a
 * migration squash, keeping whichever table-creation migration lands first) as painless as possible
 * when those branches merge — see the note left in `models/comments.ts` and `api/comments.ts` for
 * what this task deliberately did NOT build (page-scoped list/create/update, self-authorship policy,
 * webhook emission — all Feature 391's own job).
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid().primaryKey().defaultRandom(),
    content: text().notNull(),
    // -> Rendered HTML, cached alongside the source. Left null here — nothing on this branch
    //    populates or reads it; that is Feature 390's default-provider job.
    render: text(),
    // -> A guest has no account to attribute the comment to, so it says who sent it. Null for a
    //    logged in author, whose name is on `authorId` instead. Mirrors `pageEditSubmissions`.
    guestName: varchar({ length: 255 }),
    guestEmail: varchar({ length: 255 }),
    // -> Long enough for an IPv6 address in its longest textual form.
    guestIp: varchar({ length: 45 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> Null once the account is gone, rather than holding the account hostage. Mirrors
    //    `pageHistory.authorId`.
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    // -> Self-referencing: the parent comment this is a reply to, or null for a top-level comment.
    //    Cascades so deleting a parent takes its replies with it rather than orphaning them.
    replyTo: uuid().references((): AnyPgColumn => comments.id, { onDelete: 'cascade' })
  },
  (table) => [
    // -> The page-view list query: every comment on a page, oldest first.
    index('comments_pageId_idx').on(table.pageId, table.createdAt),
    // -> The admin moderation query (Task 625): every comment on a site, newest first, filtered to
    //    an accessible-pages set built separately — see `api/comments.ts`.
    index('comments_siteId_idx').on(table.siteId, table.createdAt),
    index('comments_authorId_idx').on(table.authorId),
    index('comments_replyTo_idx').on(table.replyTo)
  ]
)

// CHECKLIST RUN LOG --------------------
/**
 * One row per run ("execution") of a `block-checklist`. An item is checked off inside one execution;
 * once every item named at start time is checked, that execution completes automatically and the
 * next check on the same block starts a fresh one — the operational equivalent of a runbook resetting
 * for the next shift, with no separate scheduler needed to make that happen.
 *
 * This is a run log, not editorial history: distinct from `pageHistory` (content revisions) and from
 * `pageEditSubmissions`/`pageEditSubmissionApprovals` (the Approvals publish workflow) above — it
 * records that someone actually performed the procedure, not that a page's content changed.
 *
 * `blockKey` is the block's own `runKey` prop (see `blocks/block-checklist/component.js`), not a
 * position in the page's content — it is what lets the same checklist keep one run log across
 * ordinary page edits, and what lets a page carry more than one independent checklist.
 *
 * At most one INCOMPLETE execution may exist per `(pageId, blockKey)` at a time — enforced by
 * `checklistExecutions_active_idx`, a unique index scoped to `completedAt IS NULL` rows. This is the
 * database-level guarantee `models/checklists.ts`'s `checkItem` relies on to start a new execution
 * safely under concurrent requests: the losing insert of a race falls back to reading the row the
 * winner created, rather than either creating two active runs or needing an application-level lock.
 */
export const checklistExecutions = pgTable(
  'checklistExecutions',
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    blockKey: varchar({ length: 255 }).notNull(),
    // -> Snapshotted at start from the block's own item count, not recomputed later — an author
    //    editing the checklist mid-run does not retroactively change what "every item" meant for a
    //    run already in progress.
    itemCount: integer().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // -> Null once the account is gone, rather than holding the account hostage. Mirrors
    //    `comments.authorId`.
    startedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp({ withTimezone: true }),
    completedBy: uuid().references(() => users.id, { onDelete: 'set null' })
  },
  (table) => [
    // -> The history/latest-execution queries: every run of one checklist, most recent first.
    index('checklistExecutions_pageId_blockKey_idx').on(
      table.pageId,
      table.blockKey,
      table.startedAt
    ),
    uniqueIndex('checklistExecutions_active_idx')
      .on(table.pageId, table.blockKey)
      .where(sql`"completedAt" IS NULL`)
  ]
)

/**
 * One row per item checked off within one execution — the actual "who checked which item when" the
 * feature exists to record. Never updated or deleted: checking an already-checked item again is a
 * no-op (`checklistItemChecks_execution_item_idx` is what `checkItem`'s `onConflictDoNothing` targets),
 * and there is deliberately no "uncheck" — undoing an entry is exactly what a run log should not do.
 * Redoing a checklist means starting a new execution instead.
 */
export const checklistItemChecks = pgTable(
  'checklistItemChecks',
  {
    id: uuid().primaryKey().defaultRandom(),
    executionId: uuid()
      .notNull()
      .references(() => checklistExecutions.id, { onDelete: 'cascade' }),
    // -> The item's position in the block's rendered list at check time (`item-0`, `item-1`, ...) --
    //    see `blocks/block-checklist/component.js`. Not the item's text, which can be edited without
    //    the item having changed in any way that should re-open a run.
    itemKey: varchar({ length: 255 }).notNull(),
    checkedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex('checklistItemChecks_execution_item_idx').on(table.executionId, table.itemKey),
    index('checklistItemChecks_executionId_idx').on(table.executionId, table.checkedAt)
  ]
)

// PAGE HISTORY ------------------------
/**
 * One row per change to a page: what it looked like afterwards, who made it, and what kind of change
 * it was.
 *
 * Every row is a complete version rather than a delta, which is what makes the three things this
 * exists for straightforward: comparing any two versions, putting a page back to one of them, and
 * recovering a page that was deleted. The deletion itself is recorded the same way, carrying the page
 * as it stood when it went — that row is the whole of what a recovery needs.
 *
 * The render is deliberately not kept. It is derived from the content by a pipeline that lives in the
 * frontend, and storing a second copy of every page's HTML for every version is a great deal of space
 * for something a restore can regenerate.
 */
export const pageHistory = pgTable(
  'pageHistory',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Not a foreign key: the history of a deleted page is exactly what recovering it needs, so it
    //    has to outlive the row it points at
    pageId: uuid().notNull(),
    /**
     * `created`, `updated`, `moved` or `deleted`. A varchar rather than an enum so that naming another
     * kind of change later does not need a migration.
     */
    action: varchar({ length: 16 }).notNull().default('updated'),
    /**
     * What actually made this change: the standard editor, or an MCP tool call (`create_page`/
     * `update_page`, OpenProject #1119). A varchar rather than an enum, same reasoning as `action`
     * above -- a new source should not need a migration. `models/pageHistory.ts`'s `pageHistoryVia`
     * is the closed list callers are expected to use today.
     */
    via: varchar({ length: 16 }).notNull().default('editor'),
    /** Which fields this change touched, so a history list can summarise it without diffing. */
    changedFields: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /*
      Columns rather than part of `meta` below: a history list shows these for every row, a page that
      has moved needs the path it had at the time rather than the one it has now, and looking a history
      up by where the page was — the only way in once the page itself is gone — means matching on the
      locale and the path together.

      A locale code is BCP-47 with hyphens (`pt-BR`), and every comparison anywhere is an equality
      one. `locales.code`, which these values come from, is a varchar too.
    */
    locale: varchar({ length: 255 }).notNull(),
    path: varchar({ length: 255 }).notNull(),
    title: varchar({ length: 255 }).notNull(),
    content: text(),
    /**
     * The rest of the page as it stood: description, icon, tags, publish state and dates, relations,
     * config, editor and content type. Kept whole rather than as columns of its own so that a field
     * added to a page does not have to be added here too.
     */
    meta: jsonb().notNull().default({}),
    /**
     * Why the change was made, in the author's words, as the editor's reason-for-change prompt
     * collected it. Null when the site does not ask for one, or asks and is not answered.
     */
    reason: varchar({ length: 255 }),
    versionDate: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // -> Null once the account is gone, rather than holding the account hostage: a history row is a
    //    record of what happened to the page, and requiring its author to exist for ever would mean
    //    that editing a page once made an account undeletable — even after the page itself was gone.
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [
    index('pageHistory_pageId_idx').on(table.pageId, table.versionDate),
    // -> "What happened to the page at this path, in this locale", which is how a deleted page is
    //    found again: there is no page row left to look its ID up from. Leading with `siteId` means
    //    this also serves the plain per-site queries.
    index('pageHistory_siteId_idx').on(table.siteId, table.locale, table.path, table.versionDate),
    index('pageHistory_authorId_idx').on(table.authorId)
  ]
)

/**
 * Where a suggestion stands: `open` while it awaits review, `approved`/`declined` once a reviewer has
 * resolved it. Resolved rows are retained (see `pageEditSubmissions` below) rather than deleted, so
 * this is what every "still pending" query filters on.
 */
export const submissionStatusEnum = pgEnum('submissionStatus', ['open', 'approved', 'declined'])

// PAGE EDIT SUBMISSIONS ---------------
/**
 * An edit suggested by somebody who may read a page but not change it, waiting to be reviewed.
 *
 * Both the resulting source and a patch are kept, because they answer different questions. The patch
 * is what a reviewer merges — it is computed against the page as it stood at submission time, so two
 * people suggesting edits to different parts of a page can both be accepted. The source is what the
 * author resumes from and what a review screen shows, and it cannot be reconstructed from the patch
 * alone once the page has moved on.
 *
 * A resolved submission (`approved` or `declined`) is retained rather than deleted, so its author can
 * be shown what happened and why: `resolvedReason` carries the reviewer's optional decline note (or is
 * null for an approval, or while still `open`), and `resolvedBy` is who resolved it.
 */
export const pageEditSubmissions = pgTable(
  'pageEditSubmissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    content: text().notNull(),
    /** Unified diff, from the page content this was based on to `content`. */
    patch: text().notNull(),
    /** SHA-256 of that base content, so a reviewer can tell the page has changed underneath. */
    baseHash: varchar({ length: 64 }).notNull(),
    // -> A guest has no account to attribute the suggestion to, so it says who sent it. Null for a
    //    logged in author, whose name is on `authorId` instead.
    guestName: varchar({ length: 255 }),
    guestEmail: varchar({ length: 255 }),
    status: submissionStatusEnum().notNull().default('open'),
    /** The reviewer's note on why an `approved`/`declined` submission was resolved that way. */
    resolvedReason: text(),
    /** Who approved or declined this submission. Null while `open`. */
    resolvedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> A pending suggestion has no meaning once its author is gone -- there is nobody left to
    //    review it against, and no audit trail reason to keep it around orphaned. Matches
    //    `apiKeys.userId`'s reasoning, not `pageHistory.authorId`'s `set null`: a suggestion isn't a
    //    record of something that already happened the way a merged history entry is.
    authorId: uuid().references(() => users.id, { onDelete: 'cascade' })
  },
  (table) => [
    index('pageEditSubmissions_pageId_idx').on(table.pageId),
    index('pageEditSubmissions_siteId_idx').on(table.siteId),
    index('pageEditSubmissions_authorId_idx').on(table.authorId),
    // -> One OPEN suggestion per person per page: coming back to the button continues that one rather
    //    than starting a second. Guests are excluded because they are all the same nobody. Scoped to
    //    `status = 'open'` rather than every row for the pair, so a resolved submission -- retained now
    //    rather than deleted -- does not block the same author from suggesting again later.
    uniqueIndex('pageEditSubmissions_page_author_idx')
      .on(table.pageId, table.authorId)
      .where(sql`"authorId" IS NOT NULL AND "status" = 'open'`)
  ]
)

// PAGE EDIT SUBMISSION APPROVALS -------
/**
 * One reviewer's sign-off on a submission, towards its rule's `minApprovals` threshold.
 *
 * A row per (submission, reviewer): a reviewer approving twice does not count twice, which is what the
 * unique index enforces and `approveSubmission`'s `onConflictDoNothing` relies on to stay idempotent.
 * Deleted by cascade the moment the submission itself is -- finalized (accepted) or rejected -- so this
 * never outlives the thing it was counting towards.
 */
export const pageEditSubmissionApprovals = pgTable(
  'pageEditSubmissionApprovals',
  {
    id: uuid().primaryKey().defaultRandom(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    submissionId: uuid()
      .notNull()
      .references(() => pageEditSubmissions.id, { onDelete: 'cascade' }),
    reviewerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
  },
  // -> Covers lookups by submissionId alone as well, being the leading column
  (table) => [
    uniqueIndex('pageEditSubmissionApprovals_submission_reviewer_idx').on(
      table.submissionId,
      table.reviewerId
    )
  ]
)

// PAGE WATCHING -----------------------
/**
 * A page somebody asked to be told about, one row per person per page.
 *
 * A row IS the watch: there is no `isEnabled` to turn off, because unwatching a page is not a state a
 * page keeps — it is the absence of interest, and the row goes. Which is also why the whole table can
 * be read as "everyone to notify about this page" when notifications are built on top of it.
 *
 * `siteId` is carried alongside `pageId` rather than reached through the page, since every query here
 * is scoped to one site: the watch list belongs to an inbox, and an inbox belongs to a site.
 *
 * The four `notify*` columns are the delivery preference for THIS watch, and every one of them is
 * nullable with no default: null means "this watcher never set it," not "off." That distinction
 * matters because the effective default lives in code (`models/pageWatching.ts#DEFAULT_PREFERENCE`),
 * documented once in `api/watching.ts`'s schema, rather than duplicated as a column default here —
 * a column default can only be revisited with a migration, a code default can be revisited by
 * changing an instance's mind about which delivery mode is safe before mail is even configured.
 * Per-watch rather than a single per-user row: nothing about wanting an immediate ping on the page
 * one's job depends on says anything about wanting the same for a page glanced at once, so the
 * preference travels with the watch, not the person.
 */
export const pageWatching = pgTable(
  'pageWatching',
  {
    id: uuid().primaryKey().defaultRandom(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `immediate` | `digest`, or null for "use the instance default." */
    notifyMode: varchar({ length: 16 }),
    notifyOnEdited: boolean(),
    notifyOnMoved: boolean(),
    notifyOnDeleted: boolean()
  },
  (table) => [
    // -> Covers the site scoping too, being the leading column: this is the inbox's own query
    index('pageWatching_user_site_idx').on(table.userId, table.siteId),
    // -> Watching a page twice is watching it once, so the second attempt is a no-op rather than a row
    uniqueIndex('pageWatching_page_user_idx').on(table.pageId, table.userId)
  ]
)

// PAGE WATCH EVENTS -------------------
/**
 * A notification owed to one watcher about one change, waiting to be delivered.
 *
 * Written by the background job `notifyPageWatchers` queues after a page save, move or delete (see
 * `models/pages.ts#notifyWatchers`) — never inline in the request, so a page with many watchers costs
 * the save nothing beyond the one job it queues. `deliveredAt` is null until whatever eventually sends
 * the notification (mail, in the first instance) marks it done; a row is the unit of "pending" rather
 * than a boolean column, so a wiki that never delivers a batch simply accumulates rows instead of
 * losing track of which watcher was owed what.
 *
 * `pageId` is not a foreign key, for the same reason `pageHistory.pageId` isn't: the job that writes
 * this row runs after the request that queued it, and for a delete that request has by then already
 * removed the page — and with it, through `pageWatching.pageId`'s cascade, the very watch list this
 * row was resolved from. The row has to be able to outlive both.
 *
 * OpenProject #1689 considered adding this FK back (`siteId`/`userId`/`actorId` all have one). Ruled
 * out for the reason above: `models/pages.ts#deletePage` queues `notifyPageWatchers` as an async
 * scheduler job *before* deleting the `pages` row, but that job's `recordMany()` INSERT — the only
 * writer of this table — runs later, after the row is already gone. A hard FK requires the referenced
 * `pages.id` to exist at INSERT time no matter what `onDelete` says, so every deletion notification for
 * a watched page would fail to record. Fixing that for real would mean recording these rows
 * synchronously before the page delete instead of in the deferred job — a larger change than #1689's
 * scope; see `docs/variances.md`.
 *
 * `actorId`, `changedFields`, `pageTitle` and `pagePath` are captured at write time rather than
 * looked up when a notification is finally sent, for the same reason `pageId` isn't a foreign key:
 * the page (and, for a delete, the `pageHistory` row it might otherwise be read from) can already be
 * gone by the time delivery happens, whether that's this task's immediate send or the digest job's
 * later one — and unlike `actorId`/`changedFields`, `pageTitle`/`pagePath` have nowhere else to be
 * re-read from at all once that happens, since a deleted page's row is gone, not merely unreachable
 * through a broken foreign key. `actorId` is nullable and `set null` on account deletion, matching
 * `pageHistory.authorId` — a notification about who changed a page should not be the reason that
 * account can never be deleted.
 *
 * `notifyMode` is likewise captured here rather than re-read from `pageWatching` at delivery time:
 * that table is exactly what a delete's cascade removes (see above), so the digest job has no row
 * left to ask "was this one digest or immediate?" by the time it runs — the answer `listWatchers`
 * already resolved when this row was written is the only copy that survives.
 *
 * `readAt` (task 535) is deliberately a second, independent nullable timestamp rather than a repurposed
 * `deliveredAt`: they answer different questions that can disagree in either direction. `deliveredAt`
 * means "mail went out for this row" — set by `notify-page-watchers.ts` / `send-watch-digests.ts` and
 * read by the digest job to decide what still needs sending — and is set on a row nobody has looked at
 * in the app yet. `readAt` means "this user has seen it in the in-app inbox," which can happen before
 * any mail goes out at all (an `immediate` send that is still in flight, or a `digest` row that will
 * not mail for up to a day) or might never happen even after mail sends successfully. Collapsing the two
 * would make the in-app inbox mark something delivered without ever sending it (`send-watch-digests.ts`
 * would then skip a real email for a row a reader only glanced at) or leave the inbox unable to
 * distinguish "not sent yet" from "sent but not read" — both of which are genuinely different states a
 * future admin view might one day want to tell apart.
 */
export const pageWatchEvents = pgTable(
  'pageWatchEvents',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `created` never appears here — see `notifyWatchers`: nobody can watch a page before it exists. */
    action: varchar({ length: 16 }).notNull(),
    /** Which fields the change touched, for the same reason `pageHistory.changedFields` records it. */
    changedFields: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ withTimezone: true }),
    /** When the recipient saw this in the in-app inbox — null until then. See this table's own comment. */
    readAt: timestamp({ withTimezone: true }),
    pageId: uuid().notNull(),
    /** The page's title as of this change — see this table's own doc comment for why it's captured here. */
    pageTitle: text().notNull(),
    /** The page's path as of this change, for the same reason `pageTitle` is captured here. */
    pagePath: text().notNull(),
    /** The page's locale as of this change, for the same reason `pagePath` is captured here. */
    pageLocale: text().notNull().default('en'),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** `immediate` | `digest`, resolved and captured at write time — see this table's doc comment. */
    notifyMode: varchar({ length: 16 }).notNull()
  },
  (table) => [
    // -> "This user's undelivered digest notifications, oldest first" -- the digest job's own query.
    //    `notifyMode` leads after `userId` since that job filters on it before ordering by age.
    index('pageWatchEvents_pending_idx')
      .on(table.userId, table.notifyMode, table.createdAt)
      .where(sql`"deliveredAt" IS NULL`),
    index('pageWatchEvents_pageId_idx').on(table.pageId),
    // -> "This user's unread in-app notifications, newest first" -- the in-app inbox's own query
    //    (`pageWatchEvents.listForUser`), scoped to a site the same way `pageWatching_user_site_idx` is.
    index('pageWatchEvents_unread_idx')
      .on(table.userId, table.siteId, table.createdAt)
      .where(sql`"readAt" IS NULL`)
  ]
)

// PAGEVIEWS ----------------------------
/**
 * One row per page view -- a log, not a counter -- so that a reader (OpenProject #1140, the knowledge
 * graph sizing nodes by visit volume) can count DISTINCT visitors over any trailing window it likes
 * (30 days / 6 months / 2 years) rather than being stuck with whatever a running total already
 * collapsed away. `models/pageviews.ts#record()` is the only writer, called best-effort from both
 * places a page is actually read -- `GET /sites/:siteId/pages/:pageIdOrHash` (`api/pages/read.ts`) and the
 * MCP `get_page` tool (`mcp/tools/getPage.ts`) -- so `clientType` genuinely distinguishes the two,
 * rather than being a column only one call site ever set.
 *
 * `clientType` is a varchar rather than a real pg enum, same reasoning as `pageHistory.via`: a fourth
 * kind of caller should not need a migration. `models/pageviews.ts`'s `pageviewClientTypes` is the
 * closed list callers are expected to use today -- `browser` (session/cookie-identified), `api` (a
 * bearer API key), `mcp` (an MCP tool call, which is the same bearer-key mechanism under the hood but
 * counted apart per #1140's explicit "web browser vs. API/MCP access" breakdown).
 *
 * `visitorHash` is a pseudonymised HMAC, never the raw session id or API key id it was computed from --
 * unique-visitor counting needs to tell two visitors apart, not know who either one is. A browser view
 * hashes the session's own id (so two views in the same session/cookie are one visitor); an `api`/`mcp`
 * view hashes the calling key's id (so two calls on the same key are one visitor, and a different key
 * is a different one, regardless of which human or agent is actually holding it). Keyed with
 * `WIKI.config.pageviews.hashKey` (`models/pageviews.ts#hashVisitor()`) rather than a bare digest --
 * both preimages (`sessions.id`, an API key's UUID) live unsecret in this same database, so without
 * that key the column would be trivially reversible by anyone with read access, not merely pseudonymous.
 *
 * `pageId` IS a foreign key here, unlike `pageHistory.pageId`/`pageWatchEvents.pageId`: those exist to
 * outlive the page they describe (recovering or notifying about one that's gone), but a view count for
 * a page that no longer exists has nothing left to size in the graph -- so it cascades away with the
 * page, the same way `pageWatching.pageId` and `pageRenderQueue.pageId` do.
 */
export const pageviews = pgTable(
  'pageviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Cascades, unlike most `siteId` columns in this schema: a pageview is a log entry about a
    //    visit, not content the site-delete route means to guard -- see `models/sites.ts#deleteSite`'s
    //    up-front content check, which counts pages and assets but deliberately not this table.
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** `browser` | `api` | `mcp` -- see this table's own doc comment. */
    clientType: varchar({ length: 16 }).notNull(),
    /** A keyed HMAC-SHA256 hex digest, never the raw session id or API key id it was computed from --
     *  see this table's own doc comment for why a keyed hash, not a bare one, is what makes it
     *  actually pseudonymous. */
    visitorHash: text().notNull(),
    viewedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> `countsForGraph()` (`models/pageviews.ts`, this table's only reader besides the purge below)
    //    is the one query this table exists for (#1140's graph sizing), and its actual predicate is
    //    `WHERE siteId = ? GROUP BY pageId, clientType` with six conditional aggregates over
    //    `viewedAt`/`visitorHash` -- not a `pageId` lookup, which nothing here does. Leading with
    //    `siteId` and carrying every column the aggregates touch is what lets the planner satisfy the
    //    whole query from the index instead of scanning the table.
    index('pageviews_siteId_pageId_clientType_viewedAt_visitorHash_idx').on(
      table.siteId,
      table.pageId,
      table.clientType,
      table.viewedAt,
      table.visitorHash
    ),
    // -> How the retention purge (`tasks/simple/purge-pageviews.ts`) finds rows older than 2 years,
    //    mirroring `rateLimits_updatedAt_idx`'s same purge-by-timestamp shape.
    index('pageviews_viewedAt_idx').on(table.viewedAt)
  ]
)

// PAGE RENDER QUEUE -------------------
/**
 * A page waiting for the server to render it, one row per page.
 *
 * The markdown pipeline lives in the frontend, so rendering a page here means driving a headless
 * browser — too heavy to hold a request open for, and ruinous to do several times at once. A row is a
 * request for a render, and the `renderPages` task drains the table one page at a time through a
 * single browser (`models/renderQueue.ts`).
 *
 * A row IS the request, so asking twice for the same page updates the row instead of adding a second:
 * what gets rendered is the content as it stands when the browser reaches it, and rendering it twice
 * would produce the same HTML. `createdAt` keeps its place in the queue across those repeats.
 *
 * The two permissions travel with the row because a render is sanitized against what the person who
 * asked for it may embed, and by the time the job runs there is no session left to ask.
 */
export const pageRenderQueue = pgTable(
  'pageRenderQueue',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `write:scripts` — whether this render may keep `<script>` and inline handlers. */
    allowScripts: boolean().notNull().default(false),
    /** `write:styles` — whether this render may keep `<style>` and inline `style` attributes. */
    allowStyles: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    pageId: uuid()
      .notNull()
      .unique()
      .references(() => pages.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> Only ever logged, and a deleted account is no reason to drop a render somebody is waiting for
    requestedById: uuid().references(() => users.id, { onDelete: 'set null' })
  },
  // -> How the drain picks what to render next
  (table) => [index('pageRenderQueue_createdAt_idx').on(table.createdAt)]
)

// RATE LIMITS -------------------------
/**
 * One counter per rate-limited client, and the ban it has earned itself.
 *
 * In the database rather than in each instance's memory because a limit every instance enforces on
 * its own is a limit multiplied by however many are running — and because a ban has to hold when the
 * next attempt lands on another one. Every read and write of a row happens in a single upserting
 * statement (`models/rateLimits.ts`), which is what makes concurrent attempts count exactly once.
 *
 * Rows are self-correcting: an expired window or ban is reset by the next attempt on that key. They
 * are only ever deleted to reclaim space — see the `purgeRateLimits` task.
 */
export const rateLimits = pgTable(
  'rateLimits',
  {
    /** What is being limited and who by, e.g. `auth:203.0.113.4`. */
    key: varchar({ length: 255 }).primaryKey(),
    /** Attempts made inside the current window. */
    hits: integer().notNull().default(0),
    windowStartedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** When the ban lifts. Null for a client that has not earned one. */
    bannedUntil: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  // -> How the purge finds rows nothing has touched in a long while
  (table) => [index('rateLimits_updatedAt_idx').on(table.updatedAt)]
)

// SETTINGS ----------------------------
export const settings = pgTable('settings', {
  key: varchar({ length: 255 }).notNull().primaryKey(),
  value: jsonb().notNull().default({})
})

// SESSIONS ----------------------------
export const sessions = pgTable(
  'sessions',
  {
    id: varchar({ length: 255 }).primaryKey(),
    userId: uuid().references(() => users.id),
    data: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index('sessions_userId_idx').on(table.userId)]
)

// SITES -------------------------------
export const sites = pgTable('sites', {
  id: uuid().primaryKey().defaultRandom(),
  hostname: varchar({ length: 255 }).notNull().unique(),
  isEnabled: boolean().notNull().default(false),
  config: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

// -> The images an administrator uploads for a site — its logo, favicon and login background — one row
//    per kind. Held in the database rather than under `dataPath`, which is a cache: an instance that
//    comes back with an empty data directory must still look like itself. Whether a kind has been
//    uploaded at all is mirrored in the site's `config.assets`, so serving a site that has uploaded
//    nothing costs no query here.
export const siteAssets = pgTable(
  'siteAssets',
  {
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    kind: varchar({ length: 255 }).notNull(),
    data: bytea().notNull(),
    // -> sha1 hex digest of `data`, kept in sync by every write path -- lets a conditional request
    //    (ETag) be answered without reading the blob back out of the database.
    hash: varchar({ length: 255 }).notNull()
  },
  (table) => [primaryKey({ columns: [table.siteId, table.kind] })]
)

// STORAGE -----------------------------
export const storage = pgTable(
  'storage',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Directory name under `modules/storage`, one row per module per site
    module: varchar({ length: 255 }).notNull(),
    isEnabled: boolean().notNull().default(false),
    // -> `{ activeTypes: string[], largeThreshold: string }`
    contentTypes: jsonb().notNull().default({}),
    // -> `{ streaming: boolean, directAccess: boolean }`
    assetDelivery: jsonb().notNull().default({}),
    // -> `{ enabled: boolean }`
    versioning: jsonb().notNull().default({}),
    // -> One of the module's declared `supportedModes`, e.g. `sync` / `push` / `pull`
    syncMode: varchar({ length: 32 }).notNull().default('push'),
    // -> ISO-8601 duration overriding the module's declared `schedule`, or null to trust it
    scheduleOverride: varchar({ length: 32 }),
    // -> When `storageSyncTick` last queued a scheduled sync for this target, or null if it never
    //    has. Read back against the module's (or the override's) schedule to decide whether it's due
    //    again -- see `models/storage.ts`'s `tickScheduledSyncs()`. Irrelevant to a push-only target,
    //    which is never ticked at all.
    lastTickAt: timestamp({ withTimezone: true }),
    // -> Values for the props the module declares in its `definition.yml`
    config: jsonb().notNull().default({}),
    // -> Currently unused: the setup-wizard states this once held (`{ setup: 'notconfigured' |
    //    'pendinginstall' | 'configured' }`) were removed with the feature they tracked. Kept as a
    //    column rather than dropped because doing so needs a migration, not because anything still
    //    reads or writes it.
    state: jsonb().notNull().default({}),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  // -> Covers lookups by site as well, being the leading column
  (table) => [uniqueIndex('storage_composite_idx').on(table.siteId, table.module)]
)

// TAGS --------------------------------
export const tags = pgTable(
  'tags',
  {
    id: uuid().primaryKey().defaultRandom(),
    tag: varchar({ length: 255 }).notNull(),
    usageCount: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // -> Cascades, unlike most `siteId` columns in this schema: a tag row is derived data about which
    //    tags have ever been used, not content the site-delete route means to guard -- see
    //    `models/sites.ts#deleteSite`'s up-front content check, which deliberately excludes this table.
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' })
  },
  (table) => [
    // -> Covers lookups by site alone as well, being the leading column
    uniqueIndex('tags_composite_idx').on(table.siteId, table.tag)
  ]
)

// TREE --------------------------------
export const treeTypeEnum = pgEnum('treeType', ['folder', 'page', 'asset'])
export const treeNavigationModeEnum = pgEnum('treeNavigationMode', [
  'inherit',
  'override',
  'overrideExact',
  'hide',
  'hideExact'
])
export const tree = pgTable(
  'tree',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Genuinely hierarchical, and queried as such with `<@`, `@>` and lquery: this is what ltree is
    //    for. The locale beside it is not, and is a plain string.
    folderPath: ltree('folderPath').notNull().default(''),
    fileName: varchar({ length: 255 }).notNull(),
    type: treeTypeEnum('tree').notNull(),
    locale: varchar({ length: 255 }).notNull(),
    title: varchar({ length: 255 }).notNull(),
    navigationMode: treeNavigationModeEnum('navigationMode').notNull().default('inherit'),
    // -> `set null` on delete: a tree row whose menu was deleted falls back to the site menu at
    //    render (see `models/navigation.ts`), so there is no reason to block or cascade the delete.
    navigationId: uuid().references(() => navigation.id, { onDelete: 'set null' }),
    tags: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    meta: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [
    index('tree_folderpath_idx').on(table.folderPath),
    index('tree_folderpath_gist_idx').using('gist', table.folderPath),
    // -> `models/navigation.ts#ancestorNavId` filters on `("folderPath" || "fileName") @>
    //    <path>::ltree` — the concatenation, not the bare column, so the two indexes above never
    //    match it. EXPLAIN (ANALYZE, BUFFERS) against a 280k-row tree with ~1,700
    //    override/hide entries measured a ~10x execution-time drop (1.71ms -> 0.18ms) and a
    //    ~230x buffer-read drop (1602 -> 7): without this index, postgres index-scans
    //    `tree_navigationMode_idx` and evaluates the ltree containment test as a row-by-row
    //    filter over every override/hide candidate; with it, a Bitmap AND against this index
    //    and `tree_navigationMode_idx` finds the match directly. See work package #1823 for the
    //    full before/after EXPLAIN output.
    index('tree_folderpath_filename_gist_idx').using('gist', sql`("folderPath" || "fileName")`),
    index('tree_fileName_idx').on(table.fileName),
    index('tree_type_idx').on(table.type),
    // -> A plain btree: the locale is a string compared for equality, and GiST — which is what an
    //    ltree column wanted — has no operator class for varchar at all
    index('tree_locale_idx').on(table.locale),
    index('tree_navigationMode_idx').on(table.navigationMode),
    index('tree_navigationId_idx').on(table.navigationId),
    index('tree_tags_idx').using('gin', table.tags),
    index('tree_siteId_idx').on(table.siteId),
    // -> One page row per name per (site, locale, folder), and one non-page row: the app rule is that
    //    a page may share a name with a folder but nothing else shares (see the probes in
    //    models/tree.ts). The page<->asset cross-partition exclusion cannot be a unique index and
    //    stays enforced by those probes.
    uniqueIndex('tree_composite_page_idx')
      .on(table.siteId, table.locale, table.folderPath, table.fileName)
      .where(sql`"tree" = 'page'`),
    uniqueIndex('tree_composite_nonpage_idx')
      .on(table.siteId, table.locale, table.folderPath, table.fileName)
      .where(sql`"tree" <> 'page'`)
  ]
)

// USER AVATARS ------------------------
export const userAvatars = pgTable('userAvatars', {
  id: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  data: bytea().notNull(),
  // -> sha1 hex digest of `data`, kept in sync by every write path -- lets a conditional request
  //    (ETag) be answered without reading the blob back out of the database.
  hash: varchar({ length: 255 }).notNull()
})

// USER KEYS ---------------------------
export const userKeys = pgTable(
  'userKeys',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: varchar({ length: 255 }).notNull(),
    token: varchar({ length: 255 }).notNull(),
    meta: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id)
  },
  (table) => [
    index('userKeys_userId_idx').on(table.userId),
    // -> Unique as documentation of intent: `countTfaFailure()`, `validateToken()` and
    //    `destroyToken()` (models/users.ts) all look a row up by bare `token` equality and treat it
    //    as an identity. Was previously unindexed, forcing a sequential scan on every 2FA attempt,
    //    password reset and email verification.
    uniqueIndex('userKeys_token_idx').on(table.token)
  ]
)

// USERS -------------------------------
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: varchar({ length: 255 }).notNull().unique(),
    name: varchar({ length: 255 }).notNull(),
    auth: jsonb().notNull().default({}),
    meta: jsonb().notNull().default({}),
    passkeys: jsonb().notNull().default({}),
    prefs: jsonb().notNull().default({}),
    hasAvatar: boolean().notNull().default(false),
    isActive: boolean().notNull().default(false),
    isSystem: boolean().notNull().default(false),
    isVerified: boolean().notNull().default(false),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index('users_lastLoginAt_idx').on(table.lastLoginAt)]
)

// == RELATION TABLES ==================

// USER GROUPS -------------------------
export const userGroups = pgTable(
  'userGroups',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid()
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' })
  },
  (table) => [
    // -> Covers lookups by userId alone as well, being the leading column of the PK itself
    primaryKey({ columns: [table.userId, table.groupId] }),
    // -> `userId` alone is already covered by the primary key's own index, being its leading column,
    //    and a plain `(userId, groupId)` composite would be byte-for-byte identical to the PK's index
    //    -- both dropped as redundant. `groupId` is kept: it's the PK's non-leading column, and the
    //    PK's index cannot serve a lookup on it alone. Genuinely needed by
    //    `sessions.clearSessionsForGroup`'s `WHERE groupId = ?`.
    index('userGroups_groupId_idx').on(table.groupId)
  ]
)
