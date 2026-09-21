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

// -> The driver returns an ltree path as its dotted text form
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

export const apiKeys = pgTable(
  'apiKeys',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull(),
    // -> Only the tail of the token, to tell keys apart in the admin list. The token itself is a
    //    signed JWT shown once at creation and never stored: verification needs the public key plus
    //    this row's state, not the token.
    keyShort: varchar({ length: 8 }).notNull(),
    // -> IDs of the groups whose permissions the key carries. Resolved on every request, so editing a
    //    group immediately affects the keys pointing at it.
    groups: uuid().array().notNull().default([]),
    // -> Permission allow-list narrowing the key, or null for the full union of its groups'
    //    permissions. Never widens: `resolvePermissions()` intersects it with what the groups grant.
    scope: jsonb().$type<string[] | null>().default(null),
    // -> Null means instance-wide. A non-null value pins the key to one site, enforced at the route
    //    layer by `helpers/apiKeySite.ts` and inside the permission engine by `AccessActor.siteId`
    //    (`models/groups.ts`).
    siteId: uuid().references(() => sites.id),
    // -> Allow-set of classification level ids, or null for unrestricted (levels added later
    //    included): the key is never granted a page permission on a page classified outside the set,
    //    checked in `groups.checkAccess()` before any rule. jsonb like `scope`, so no FK:
    //    `models/classificationLevels.ts#delete()`'s "in use" guard checks it with a containment query.
    allowedClassifications: jsonb().$type<string[] | null>().default(null),
    // -> Non-null makes this a personal access token acting as this user: `groups` is left `[]` and
    //    `models/apiKeys.ts`'s `verify()` resolves permissions live from the user's current group
    //    membership. Cascades, unlike the `set null` of `authorId`-shaped columns: a credential for
    //    acting as an account is not a record of something that happened, so it goes with its owner.
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

/**
 * Instance-wide, permission-affecting events, including an account's own security events
 * (register, password reset, 2FA and passkey enrol/remove, logout). Page content edits are
 * deliberately absent: `pageHistory` already records them per page, with the diff/restore
 * machinery this table lacks.
 *
 * Append-only: the only deletions are the retention job (`tasks/simple/clean-audit-log.ts`).
 */
export const auditLog = pgTable(
  'auditLog',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * `<subject>.<verb>`, e.g. `user.created`. A varchar rather than an enum so a new event kind
     * needs no migration; `models/auditLog.ts`'s `AUDIT_EVENTS` is the closed list.
     */
    event: varchar({ length: 64 }).notNull(),
    // -> Null once the account is gone, or for an event with no human actor (a scheduled job).
    //    `set null` so deleting a user is neither blocked by, nor takes down, the record of what
    //    they did.
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    // -> `actorName` and `actorEmail` are snapshotted at write time: a renamed or deleted account
    //    must not rewrite history.
    actorName: varchar({ length: 255 }).notNull().default(''),
    actorEmail: varchar({ length: 255 }).notNull().default(''),
    actorIp: varchar({ length: 64 }).notNull().default(''),
    // -> What the event happened to, and its id/label at the time. Not a foreign key: a deleted
    //    target's history is exactly what this table keeps.
    targetType: varchar({ length: 32 }).notNull().default(''),
    targetId: varchar({ length: 255 }).notNull().default(''),
    targetLabel: varchar({ length: 255 }).notNull().default(''),
    // -> What changed, shaped per event, e.g. `{ changedFields: [...] }`
    detail: jsonb().notNull().default({}),
    // -> Null for an event with no site context (user/group/apiKey management)
    siteId: uuid().references(() => sites.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> The admin list's default view, newest first
    index('auditLog_createdAt_idx').on(table.createdAt),
    // -> The admin list's filters
    index('auditLog_actorId_idx').on(table.actorId, table.createdAt),
    index('auditLog_event_idx').on(table.event, table.createdAt),
    index('auditLog_siteId_idx').on(table.siteId, table.createdAt)
  ]
)

/**
 * Which pages accept edit suggestions, who may submit them, and who reviews them. A page no rule
 * matches accepts none, so an empty table means the feature is off.
 */
export const approvalRules = pgTable(
  'approvalRules',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull().default(''),
    isEnabled: boolean().notNull().default(true),
    // -> A varchar rather than an enum so that adding a mode does not need a migration; the API
    //    schema is what rejects an unknown one.
    match: varchar({ length: 16 }).$type<ApprovalMatchMode>().notNull().default('START'),
    path: varchar({ length: 2048 }).notNull().default(''),
    // -> Group IDs, resolved on use rather than joined, so deleting a group takes effect at once
    submitterGroups: uuid().array().notNull().default([]),
    reviewerGroups: uuid().array().notNull().default([]),
    // -> Distinct reviewers who must approve before a submission is written to the page.
    //    `approveSubmission` counts them in `pageEditSubmissionApprovals` against the highest
    //    threshold among the enabled rules matching the page.
    minApprovals: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [index('approvalRules_siteId_idx').on(table.siteId)]
)

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

export const authentication = pgTable('authentication', {
  id: uuid().primaryKey().defaultRandom(),
  module: varchar({ length: 255 }).notNull(),
  isEnabled: boolean().notNull().default(false),
  displayName: varchar({ length: 255 }).notNull().default(''),
  config: jsonb().notNull().default({}),
  // -> Gated separately: a form-based module's self-registration form and a redirect-based
  //    provider's auto-provisioning of new accounts are independent choices.
  selfRegistration: boolean().notNull().default(false),
  autoProvision: boolean().notNull().default(false),
  allowedEmailRegex: varchar({ length: 255 }).notNull().default(''),
  // -> Domain-list alternative to `allowedEmailRegex`, stored normalized by
  //    `models/authentication.ts`; both may be set. Gates local self-registration only, unlike the
  //    regex, which also gates provider auto-provisioning -- see
  //    `models/login.ts#assertAllowedRegistrationDomain()`.
  allowedEmailDomains: text()
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  autoEnrollGroups: uuid().array().default([]),
  // -> A provider login claims an existing account only once this strategy is told to trust the
  //    address it reports. See `models/login.ts#findOrCreateProviderUser()`.
  trustEmailForLinking: boolean().notNull().default(false),
  // -> The groups a provider login may grant/revoke via `mapGroups`; empty means a login changes no
  //    memberships. See `models/login.ts#syncProviderGroups()`.
  mappableGroups: uuid().array().default([])
})

export const syncContentTypeEnum = pgEnum('syncContentType', ['page', 'asset'])
export const syncDirectionEnum = pgEnum('syncDirection', ['push', 'pull'])
/**
 * Where a sync run last left each (content item, storage target) pairing. A table rather than a
 * jsonb column keyed by target, which would need merge logic on every write to avoid clobbering the
 * other targets' entries. `contentId` is not a foreign key: it points at `pages.id` or `assets.id`
 * depending on `contentType`.
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
    // -> Of the most recent successful sync. Null until one has succeeded.
    lastDirection: syncDirectionEnum(),
    // -> Opaque here: whatever the target module needs to recognize what it last wrote (a git commit
    //    hash, an S3 etag, a structured `{ commit, branch }`).
    targetRef: jsonb(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    // -> From the most recent attempt, cleared when one succeeds: non-null beside a non-null
    //    `lastSyncedAt` means the item synced once but the latest attempt failed.
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> One row per content item per target. `targetId` leads, so this also covers the out-of-date
    //    query's "every state for this target".
    uniqueIndex('contentSyncState_target_content_idx').on(
      table.targetId,
      table.contentType,
      table.contentId
    ),
    // -> Covers "every target's state for this content item"
    index('contentSyncState_content_idx').on(table.contentType, table.contentId)
  ]
)

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
    // -> `props` and `template` describe a CUSTOM block only: a built-in's come from the compiled
    //    manifest, and its row leaves both at their defaults.
    // -> Same shape as `BlockDefinition.props`
    props: jsonb().notNull().default([]),
    // -> Body the editor writes between the opening and closing lines, for a block whose content is
    //    other blocks
    template: text().notNull().default(''),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [uniqueIndex('blocks_composite_idx').on(table.siteId, table.block)]
)

// -> One row per module per site, like `storage`. Unlike storage, at most one row per site is
//    enabled — enforced by `models/commentProviders.ts`, not by a db constraint.
export const commentProviders = pgTable(
  'commentProviders',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Directory name under `modules/comments`
    module: varchar({ length: 255 }).notNull(),
    isEnabled: boolean().notNull().default(false),
    // -> Values for the props the module declares in its `definition.yml`
    config: jsonb().notNull().default({}),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [uniqueIndex('commentProviders_composite_idx').on(table.siteId, table.module)]
)

// -> A custom block's compiled component code, one-to-one with its `blocks` row. Split out rather
//    than a column on `blocks`: `getSiteBlocks()` lists every block on a site for the editor's
//    picker and has no use for the bytes. The cascade is a safety net: `deleteCustomBlock()`
//    removes this row itself.
export const blockCode = pgTable('blockCode', {
  blockId: uuid()
    .primaryKey()
    .references(() => blocks.id, { onDelete: 'cascade' }),
  code: bytea().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

/**
 * A secret held server-side only, for a block whose props (embedded in a page's markdown, readable
 * by anyone holding `read:source`) must never carry the credential itself. A block prop stores this
 * row's `id` alone; `secret` is resolved server-side (`models/blockCredentials.ts`'s
 * `getCredentialForResolve()`) and never serialized into an API response.
 *
 * `allowedOrigins` is the deny-by-default list `models/liveData.ts#resolve()` checks a block's URL
 * against before attaching the secret. Each entry is a full origin plus an optional path prefix,
 * e.g. `https://api.example.com/v1` — not a bare hostname.
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

/**
 * The sensitivity levels a page may carry: seeded defaults an administrator may rename, reorder,
 * add to or remove. Instance-wide, not per-site, like `groups`.
 */
export const classificationLevels = pgTable(
  'classificationLevels',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull(),
    // -> Lower is more open. Both the floor-invariant ordering and the display order.
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex('classificationLevels_sortOrder_idx').on(table.sortOrder)]
)

export const groups = pgTable(
  'groups',
  {
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
  },
  // -> Same fold as `models/login.ts#syncProviderGroups` (`trim().toLowerCase()`), so one IdP claim
  //    can never match two groups. Keep the two in sync.
  (table) => [uniqueIndex('groups_name_normalized_idx').on(sql`lower(trim(${table.name}))`)]
)

/** `value` is cased as the admin typed it; for an acronym alias that casing (e.g. "USS") is its
 *  canonical DISPLAY casing. */
export interface GlossaryAliasRow {
  value: string
  isAcronym: boolean
}

export const glossaryTerms = pgTable(
  'glossaryTerms',
  {
    id: uuid().primaryKey().defaultRandom(),
    term: varchar({ length: 255 }).notNull(),
    definition: text().notNull(),
    // -> Alternate surface forms resolving to this term's `definition`/`pageId`. Uniqueness across
    //    this column combined with `term`, across rows, is enforced in `models/glossary.ts` -- no
    //    index can express it.
    aliases: jsonb().$type<GlossaryAliasRow[]>().notNull().default([]),
    // -> Marks the TERM ITSELF as an acronym (e.g. "USS"), with the same display-casing meaning as an
    //    alias's own `isAcronym`.
    isAcronym: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> `set null` rather than `cascade`: deleting the linked page unlinks the term, it does not
    //    delete the definition.
    pageId: uuid().references(() => pages.id, { onDelete: 'set null' })
  },
  (table) => [
    // -> One definition covers every casing variant of a term, so rows differing only by case are
    //    duplicates. Guards `term` only -- alias collisions are checked in `models/glossary.ts`.
    uniqueIndex('glossaryTerms_composite_idx').on(table.siteId, sql`lower(${table.term})`)
  ]
)

/**
 * One row per saved snapshot of a site's ENTIRE glossary term list -- not a per-term history like
 * `pageHistory`. Written by `models/glossary.ts`'s `saveVersion()`. Append-only and never pruned:
 * versions are few and human-triggered.
 */
export const glossaryVersions = pgTable(
  'glossaryVersions',
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> The `GlossaryExport` shape (`models/glossary.ts`), the same JSON export/import use, so a
    //    version restores through the same wholesale-replace path as an import.
    snapshot: jsonb().notNull(),
    termCount: integer().notNull(),
    // -> `set null` beside a snapshotted `actorName`, for the reasons `auditLog` gives
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    actorName: varchar({ length: 255 }).notNull().default(''),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index('glossaryVersions_siteId_createdAt_idx').on(table.siteId, table.createdAt)]
)

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
    // -> Sent verbatim as the Authorization header
    authHeader: text(),
    // -> Outcome of the most recent delivery
    state: hookStateEnum().notNull().default('pending'),
    lastErrorMessage: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // -> Null means "fires for every site". `set null` on delete: a hook is not site-owned content,
    //    so one scoped to a site that goes away reverts to firing instance-wide rather than going
    //    with the site or blocking its deletion.
    siteId: uuid().references(() => sites.id, { onDelete: 'set null' })
  },
  (table) => [index('hooks_siteId_idx').on(table.siteId)]
)

// -> An Iconify icon set, e.g. `mdi`. Adding one makes its icons searchable; an individual icon is
//    stored only once something references it.
export const iconSets = pgTable('iconSets', {
  // -> The Iconify prefix, which is what content references: `<prefix>:<name>`
  prefix: varchar({ length: 64 }).primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  isEnabled: boolean().notNull().default(true),
  // -> Iconify collection metadata as published by the upstream API, refreshed on demand
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
    // -> Whatever a task chose to hand back, e.g. `exportContent`'s `{ filePath, fileSize }`, set via
    //    `models/jobs.ts#setResult` — how a follow-up route finds what a background job produced.
    result: jsonb()
  },
  (table) => [
    // -> `models/hooks.ts#getDeliveryHistory()` filters by `task = 'dispatchWebhook'` and the `hookId`
    //    inside `payload`. A partial expression index scoped to that one task stays small and keeps
    //    `jobHistory` generic — no `hookId` column on a table every other task also writes to.
    index('jobHistory_dispatchWebhook_hookId_idx')
      .on(sql`(payload ->> 'hookId')`)
      .where(sql`${table.task} = 'dispatchWebhook'`),
    // -> Backs `core/scheduler.ts#reapStaleJobs`'s `WHERE state = 'active' AND startedAt < cutoff`.
    //    Partial on `startedAt` rather than a `(state, startedAt)` composite: no other `state` filter
    //    shares this predicate, and `active` rows are transient, so the index stays near-empty.
    index('jobHistory_active_idx')
      .on(table.startedAt)
      .where(sql`${table.state} = 'active'`)
  ]
)

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
    // Defence in depth behind `core/config.ts#ensureSeeded`'s advisory lock: a duplicate `task` is
    // rejected by the db rather than silently absorbed if the seed ever runs twice.
    uniqueIndex('jobSchedule_task_idx').on(table.task)
  ]
)

export const jobLock = pgTable('jobLock', {
  key: varchar({ length: 255 }).primaryKey(),
  lastCheckedBy: varchar({ length: 255 }),
  lastCheckedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

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
    // -> Backs `core/scheduler.ts#processJob`'s claim subquery, which orders by
    //    `waitUntil ASC NULLS FIRST, createdAt ASC` on every poll.
    index('jobs_waitUntil_createdAt_idx').on(table.waitUntil, table.createdAt)
  ]
)

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

// -> Where a menu's items come from: hand-authored (`static`), walked live off the tree (`auto`), or
//    the tree walk with hand-authored items layered on top (`mixed`).
export const treeNavigationSourceEnum = pgEnum('treeNavigationSource', ['static', 'auto', 'mixed'])
export const navigation = pgTable(
  'navigation',
  {
    id: uuid().primaryKey().defaultRandom(),
    items: jsonb().notNull().default([]),
    mode: treeNavigationSourceEnum('mode').notNull().default('auto'),
    // -> Set only for the site-wide default menu, where (siteId, locale) is the row's identity. Null
    //    for a tree entry override's row, which is addressed by id: a unique index treats every null
    //    as distinct, so any number of overrides share a site without colliding.
    locale: varchar({ length: 255 }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [uniqueIndex('navigation_siteId_locale_idx').on(table.siteId, table.locale)]
)

export const pagePublishStateEnum = pgEnum('pagePublishState', ['draft', 'published', 'scheduled'])
export const pages = pgTable(
  'pages',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> A BCP-47 code, matched only ever for equality. Not `ltree`: a hyphenated code is a single
    //    label to it, so `'pt-BR'::ltree <@ 'pt'` is false and the type buys no locale-family
    //    matching.
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
    // -> Internal-link target paths found in the rendered content by
    //    `models/rendering.ts#extractInternalLinks`. Derived, unlike the authored `relations`: fully
    //    overwritten on every save/re-render, never merged.
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
    autoTagPending: boolean().notNull().default(false),
    // -> A `bcrypt` verifier, never the cleartext, and never handed back to a caller
    password: varchar({ length: 255 }),
    // -> `{ jsLoad, jsUnload, css }`, flattened to/from `scriptJsLoad`/`scriptJsUnload`/`scriptCss` in
    //    `models/pages.ts`. Authoring is gated by `write:scripts`/`write:styles` at the route layer.
    scripts: jsonb().notNull().default({}),
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
    // -> No column default: `models/pages.ts#createPage` always supplies one, and a default would
    //    name a level row an administrator may delete. No `onDelete` either: the FK's default
    //    RESTRICT is what stops a level still in use being deleted.
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
    // -> Backs `search.suggestTitle()`'s `similarity(title, …)` "did you mean" fallback
    index('pages_title_trgm_idx').using('gin', table.title.op('gin_trgm_ops')),
    // -> "Path unique within (site, locale)", the invariant every probe in models/pages.ts assumes.
    //    On path, not hash: the hash is cyrb53 (53-bit, non-cryptographic), so two distinct paths
    //    may legitimately collide.
    uniqueIndex('pages_siteId_locale_path_idx').on(table.siteId, table.locale, table.path),
    // -> Backs getPage's hottest read (siteId + hash + locale equality). Plain, not unique — see above.
    index('pages_siteId_locale_hash_idx').on(table.siteId, table.locale, table.hash)
  ]
)

export const comments = pgTable(
  'comments',
  {
    id: uuid().primaryKey().defaultRandom(),
    content: text().notNull(),
    // -> Rendered HTML cached beside the source. Null when the site's provider renders nothing
    //    server-side (an embed-only one).
    render: text(),
    // -> Who sent it, for a guest with no account. Null for a logged in author.
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
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    replyTo: uuid().references((): AnyPgColumn => comments.id, { onDelete: 'cascade' })
  },
  (table) => [
    // -> The page-view list query: every comment on a page, oldest first.
    index('comments_pageId_idx').on(table.pageId, table.createdAt),
    // -> The admin moderation query: every comment on a site, newest first.
    index('comments_siteId_idx').on(table.siteId, table.createdAt),
    index('comments_authorId_idx').on(table.authorId),
    index('comments_replyTo_idx').on(table.replyTo)
  ]
)

/**
 * One row per run ("execution") of a `block-checklist`. Once every item named at start time is
 * checked, the execution completes and the next check on the same block starts a fresh one. A run
 * log — that someone performed the procedure — not editorial history.
 *
 * `blockKey` is the block's `runKey` prop (`blocks/block-checklist/component.js`), not a position in
 * the content, so a checklist keeps one run log across page edits and a page may carry several.
 *
 * `checklistExecutions_active_idx` allows at most one INCOMPLETE execution per `(pageId, blockKey)`:
 * `models/checklists.ts`'s `checkItem` relies on it to start an execution safely under concurrent
 * requests — the losing insert of a race reads the row the winner created.
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
    // -> Snapshotted at start: an author editing the checklist mid-run does not change what "every
    //    item" meant for a run already in progress.
    itemCount: integer().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
 * Who checked which item when. Never updated or deleted: re-checking an item is a no-op
 * (`checkItem`'s `onConflictDoNothing` targets `checklistItemChecks_execution_item_idx`), and there
 * is deliberately no "uncheck" — redoing a checklist means starting a new execution.
 */
export const checklistItemChecks = pgTable(
  'checklistItemChecks',
  {
    id: uuid().primaryKey().defaultRandom(),
    executionId: uuid()
      .notNull()
      .references(() => checklistExecutions.id, { onDelete: 'cascade' }),
    // -> The item's position in the block's rendered list at check time (`item-0`, `item-1`, ...),
    //    not its text, which can be edited without re-opening a run.
    itemKey: varchar({ length: 255 }).notNull(),
    checkedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex('checklistItemChecks_execution_item_idx').on(table.executionId, table.itemKey),
    index('checklistItemChecks_executionId_idx').on(table.executionId, table.checkedAt)
  ]
)

/**
 * One row per change to a page. Every row is a complete version rather than a delta, which keeps
 * comparing two versions, restoring one and recovering a deleted page straightforward: the `deleted`
 * row carries the page as it stood, which is all a recovery needs.
 *
 * The render is deliberately not kept: a restore can regenerate it from the content.
 */
export const pageHistory = pgTable(
  'pageHistory',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Not a foreign key: the history of a deleted page is exactly what recovering it needs, so it
    //    has to outlive the row it points at
    pageId: uuid().notNull(),
    /**
     * A varchar rather than an enum so that another kind of change needs no migration;
     * `models/pageHistory.ts`'s `pageHistoryActions` is the closed list.
     */
    action: varchar({ length: 16 }).notNull().default('updated'),
    /**
     * What made this change: the editor, or an MCP tool call. A varchar for the same reason as
     * `action`; `models/pageHistory.ts`'s `pageHistoryVia` is the closed list.
     */
    via: varchar({ length: 16 }).notNull().default('editor'),
    /** Which fields this change touched, so a history list can summarise it without diffing. */
    changedFields: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /*
      Columns rather than part of `meta` below: a history list shows these for every row, a page that
      has moved needs the path it had at the time, and looking a history up by where the page was —
      the only way in once the page itself is gone — means matching on the locale and the path.
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
    /** Null when the site does not prompt for a reason, or the prompt went unanswered. */
    reason: varchar({ length: 255 }),
    versionDate: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // -> `set null` rather than holding the account hostage: a history row records what happened to
    //    the page, and editing one page should not make an account undeletable for ever.
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  (table) => [
    index('pageHistory_pageId_idx').on(table.pageId, table.versionDate),
    // -> "What happened to the page at this path, in this locale" — how a deleted page is found
    //    again, there being no page row left to look its id up from. `siteId` leads, so this also
    //    serves the plain per-site queries.
    index('pageHistory_siteId_idx').on(table.siteId, table.locale, table.path, table.versionDate),
    index('pageHistory_authorId_idx').on(table.authorId)
  ]
)

export const submissionStatusEnum = pgEnum('submissionStatus', ['open', 'approved', 'declined'])

/**
 * An edit suggested by somebody who may read a page but not change it, waiting to be reviewed.
 *
 * Both the source and a patch are kept because they answer different questions. The patch is what a
 * reviewer merges — computed against the page as it stood at submission time, so two people editing
 * different parts of a page can both be accepted. The source is what the author resumes from, and it
 * cannot be reconstructed from the patch alone once the page has moved on.
 *
 * A resolved submission is retained rather than deleted, so its author can be shown what happened.
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
    // -> Who sent it, for a guest with no account. Null for a logged in author.
    guestName: varchar({ length: 255 }),
    guestEmail: varchar({ length: 255 }),
    status: submissionStatusEnum().notNull().default('open'),
    resolvedReason: text(),
    resolvedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    // -> Cascades, unlike `pageHistory.authorId`'s `set null`: a pending suggestion is not a record
    //    of something that already happened, so it goes with the author there is nobody left to
    //    review it against.
    authorId: uuid().references(() => users.id, { onDelete: 'cascade' })
  },
  (table) => [
    index('pageEditSubmissions_pageId_idx').on(table.pageId),
    index('pageEditSubmissions_siteId_idx').on(table.siteId),
    index('pageEditSubmissions_authorId_idx').on(table.authorId),
    // -> One OPEN suggestion per person per page: coming back to the button continues that one rather
    //    than starting a second. Guests are excluded because they are all the same nobody, and the
    //    `open` predicate is what lets a retained resolved submission not block the same author from
    //    suggesting again later.
    uniqueIndex('pageEditSubmissions_page_author_idx')
      .on(table.pageId, table.authorId)
      .where(sql`"authorId" IS NOT NULL AND "status" = 'open'`)
  ]
)

/**
 * One reviewer's sign-off on a submission, towards its rule's `minApprovals` threshold. A reviewer
 * approving twice does not count twice: the unique index is what `approveSubmission`'s
 * `onConflictDoNothing` relies on to stay idempotent.
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

/**
 * A page somebody asked to be told about, one row per person per page. Unwatching deletes the row
 * rather than flipping a flag, so the table reads directly as "everyone to notify about this page".
 * `siteId` is carried rather than reached through the page: every query here is scoped to one site.
 *
 * The four `notify*` columns are the delivery preference for THIS watch — per-watch, not per-user —
 * and are nullable with no default: null means the watcher never set it, not "off". The effective
 * default lives in code (`models/pageWatching.ts#DEFAULT_PREFERENCE`) so an instance can change its
 * mind about which delivery mode is safe without a migration.
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
    // -> Watching a page twice is watching it once, so the second attempt is a no-op rather than a row.
    //    `pageId` leading also serves every by-page lookup; there is deliberately no
    //    `(pageId, createdAt)` index for the rail's `ORDER BY createdAt`, one page's watcher set being
    //    small enough for a top-N sort. Revisit if a page accumulates watchers in the thousands.
    uniqueIndex('pageWatching_page_user_idx').on(table.pageId, table.userId)
  ]
)

/**
 * A notification owed to one watcher about one change, waiting to be delivered. A row is the unit of
 * "pending" rather than a boolean column, so an instance that never delivers a batch accumulates rows
 * instead of losing track of which watcher was owed what.
 *
 * `pageId` is `set null` on delete, and the choice is forced in both directions: the FK's default
 * RESTRICT would make `DELETE FROM pages` fail outright for any page with notification history, and
 * `cascade` would destroy the deletion notification before anything delivered it. Because a hard FK
 * requires the referenced `pages.id` to exist at INSERT time whatever `onDelete` says,
 * `models/pages.ts#notifyWatchers` records a `deleted` event's rows synchronously, before
 * `deletePage`/`deleteOrphaned` touch the `pages` row — moving that INSERT into the async job it
 * queues would silently break every deletion notification.
 *
 * `actorId`, `changedFields`, `pageTitle`, `pagePath` and `notifyMode` are captured at write time
 * rather than looked up at delivery: the page, its `pageHistory` row and its `pageWatching` row can
 * all be gone by then, and `pageTitle`/`pagePath` have nowhere else to be re-read from at all.
 *
 * `readAt` and `deliveredAt` are independent because they disagree in both directions: mail goes out
 * for rows nobody has opened, and the in-app inbox can mark one read while an `immediate` send is
 * still in flight or a `digest` row is up to a day from mailing.
 */
export const pageWatchEvents = pgTable(
  'pageWatchEvents',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `created` never appears here: nobody can watch a page before it exists. */
    action: varchar({ length: 16 }).notNull(),
    changedFields: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    pageId: uuid().references(() => pages.id, { onDelete: 'set null' }),
    pageTitle: text().notNull(),
    pagePath: text().notNull(),
    pageLocale: text().notNull().default('en'),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** `immediate` | `digest`. */
    notifyMode: varchar({ length: 16 }).notNull()
  },
  (table) => [
    // -> "This user's undelivered digest notifications, oldest first" -- the digest job's own query.
    //    `notifyMode` leads after `userId` since that job filters on it before ordering by age.
    index('pageWatchEvents_pending_idx')
      .on(table.userId, table.notifyMode, table.createdAt)
      .where(sql`"deliveredAt" IS NULL`),
    index('pageWatchEvents_pageId_idx').on(table.pageId),
    // -> The in-app inbox's own query (`pageWatchEvents.listForUser`): this user's unread
    //    notifications on one site, newest first.
    index('pageWatchEvents_unread_idx')
      .on(table.userId, table.siteId, table.createdAt)
      .where(sql`"readAt" IS NULL`)
  ]
)

/**
 * One row per page view -- a log, not a counter -- so DISTINCT visitors can be counted over any
 * trailing window rather than whatever a running total already collapsed away.
 *
 * `clientType` is a varchar rather than a real pg enum, same reasoning as `pageHistory.via`: a fourth
 * kind of caller should not need a migration. `models/pageviews.ts`'s `pageviewClientTypes` is the
 * closed list -- `browser` (session/cookie-identified), `api` (a bearer API key), `mcp` (the same
 * bearer-key mechanism, counted apart).
 *
 * `visitorHash` tells two visitors apart without identifying either: a browser view hashes the
 * session's own id, an `api`/`mcp` view the calling key's id. Keyed with
 * `CARDINAL.config.pageviews.hashKey` (`models/pageviews.ts#hashVisitor()`) rather than a bare digest
 * -- both preimages live unsecret in this same database, so an unkeyed hash would be trivially
 * reversible by anyone with read access rather than merely pseudonymous.
 *
 * `pageId` cascades, unlike `pageWatchEvents.pageId`'s `set null` or `pageHistory.pageId`'s absence of
 * an FK altogether: those exist to outlive the page they describe, but a view count for a page that
 * no longer exists has nothing left to measure.
 */
export const pageviews = pgTable(
  'pageviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    // -> Cascades, unlike most `siteId` columns in this schema: a pageview is a log entry, not content
    //    `models/sites.ts#deleteSite`'s up-front content check means to guard.
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** `browser` | `api` | `mcp`. */
    clientType: varchar({ length: 16 }).notNull(),
    /** A keyed HMAC-SHA256 hex digest, never the raw session id or API key id it came from. */
    visitorHash: text().notNull(),
    viewedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // -> Shaped for `countsForGraph()` (`models/pageviews.ts`), whose predicate is
    //    `WHERE siteId = ? GROUP BY pageId, clientType` with conditional aggregates over
    //    `viewedAt`/`visitorHash` -- not a `pageId` lookup, which nothing here does. Leading with
    //    `siteId` and carrying every column the aggregates touch lets the planner satisfy the whole
    //    query from the index instead of scanning the table.
    index('pageviews_siteId_pageId_clientType_viewedAt_visitorHash_idx').on(
      table.siteId,
      table.pageId,
      table.clientType,
      table.viewedAt,
      table.visitorHash
    ),
    // -> How the retention purge (`tasks/simple/purge-pageviews.ts`) finds rows old enough to drop.
    index('pageviews_viewedAt_idx').on(table.viewedAt)
  ]
)

/**
 * A page waiting for the server to render it, one row per page.
 *
 * The markdown pipeline lives in the frontend, so rendering a page here means driving a headless
 * browser — too heavy to hold a request open for, and ruinous to do several times at once. The
 * `renderPages` task drains the table one page at a time through a single browser
 * (`models/renderQueue.ts`).
 *
 * A row IS the request, so asking twice for the same page updates the row instead of adding a second;
 * what gets rendered is the content as it stands when the browser reaches it, and `createdAt` keeps
 * its place in the queue across repeats. The two permissions travel with the row because a render is
 * sanitized against what the person who asked for it may embed, and by the time the job runs there is
 * no session left to ask.
 */
export const pageRenderQueue = pgTable(
  'pageRenderQueue',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `write:scripts` as the requester held it: whether `<script>` and inline handlers survive. */
    allowScripts: boolean().notNull().default(false),
    /** `write:styles` as the requester held it: whether `<style>` and `style` attributes survive. */
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
  (table) => [index('pageRenderQueue_createdAt_idx').on(table.createdAt)]
)

/**
 * One row per page currently holding unsaved collaborative-editing content. `core/collab.ts`
 * debounce-persists a room's live Yjs state here as edits happen and prefers it over the stored
 * `pages` content whenever a room has to be built from scratch, which is what recovers a crash or
 * tab-close mid-edit without a separate periodic-save mechanism.
 *
 * `state` is a raw Yjs update (`Y.encodeStateAsUpdate(doc)`), not the plain markdown: restoring has to
 * reconstruct the whole shared document, not just a string. `authorId`/`authorName` are best-effort
 * attribution of whoever was last known to be editing — null once the account is gone, or for a guest
 * never resolved to one.
 *
 * The row is deleted, not merely made stale, once the content is committed
 * (`core/collab.ts#pageSaved()`); one surviving past that point would offer to restore content a save
 * has already superseded. A page abandoned mid-edit and never reopened is swept by
 * `models/pageDrafts.ts#purgeStale()`.
 */
export const pageDrafts = pgTable(
  'pageDrafts',
  {
    pageId: uuid()
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    state: bytea().notNull(),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    authorName: varchar({ length: 255 }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  // -> How the purge finds rows nothing has touched in a long while
  (table) => [index('pageDrafts_updatedAt_idx').on(table.updatedAt)]
)

/**
 * One counter per rate-limited client, and the ban it has earned itself.
 *
 * In the database rather than each instance's memory: a limit every instance enforces on its own is a
 * limit multiplied by however many are running, and a ban has to hold when the next attempt lands on
 * another one. Every read and write of a row happens in a single upserting statement
 * (`models/rateLimits.ts`), which is what makes concurrent attempts count exactly once.
 *
 * Rows are self-correcting — an expired window or ban is reset by the next attempt on that key — and
 * are only ever deleted to reclaim space.
 */
export const rateLimits = pgTable(
  'rateLimits',
  {
    /** What is being limited and who by, e.g. `auth:203.0.113.4`. */
    key: varchar({ length: 255 }).primaryKey(),
    hits: integer().notNull().default(0),
    windowStartedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** When the ban lifts. Null for a client that has not earned one. */
    bannedUntil: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  // -> How the purge finds rows nothing has touched in a long while
  (table) => [index('rateLimits_updatedAt_idx').on(table.updatedAt)]
)

export const settings = pgTable('settings', {
  key: varchar({ length: 255 }).notNull().primaryKey(),
  value: jsonb().notNull().default({})
})

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

export const sites = pgTable('sites', {
  id: uuid().primaryKey().defaultRandom(),
  hostname: varchar({ length: 255 }).notNull().unique(),
  isEnabled: boolean().notNull().default(false),
  config: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
})

/**
 * A `sites` row as read back through Drizzle -- what `CARDINAL.sites[id]` holds. `config` is left
 * `Record<string, any>` rather than `$type<>`-pinned: it is a large, evolving admin-settings tree
 * assembled the same way `CARDINAL.config` is, so pinning it here would mean re-deriving that whole
 * tree as a type.
 */
export type SiteRow = Omit<typeof sites.$inferSelect, 'config'> & { config: Record<string, any> }

// -> The images an administrator uploads for a site (logo, favicon, login background), one row per
//    kind. In the database rather than under `dataPath`, which is a cache: an instance that comes back
//    with an empty data directory must still look like itself. Whether a kind exists at all is
//    mirrored in the site's `config.assets`, so serving a site that uploaded nothing costs no query.
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
    // -> Read back against the module's (or the override's) schedule to decide whether a sync is due
    //    again -- see `models/storage.ts#tickScheduledSyncs()`. Never set for a push-only target.
    lastTickAt: timestamp({ withTimezone: true }),
    // -> Values for the props the module declares in its `definition.yml`
    config: jsonb().notNull().default({}),
    siteId: uuid()
      .notNull()
      .references(() => sites.id)
  },
  // -> Covers lookups by site as well, being the leading column
  (table) => [uniqueIndex('storage_composite_idx').on(table.siteId, table.module)]
)

export const tags = pgTable(
  'tags',
  {
    id: uuid().primaryKey().defaultRandom(),
    tag: varchar({ length: 255 }).notNull(),
    usageCount: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // -> Cascades, unlike most `siteId` columns in this schema: a tag row is derived data about which
    //    tags have been used, not content `models/sites.ts#deleteSite`'s content check means to guard.
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' })
  },
  (table) => [
    // -> Covers lookups by site alone as well, being the leading column
    uniqueIndex('tags_composite_idx').on(table.siteId, table.tag)
  ]
)

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
    sortOrder: integer(),
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
    //    <path>::ltree` — the concatenation, not the bare column, so neither index above ever matches
    //    it. Without this one postgres index-scans `tree_navigationMode_idx` and evaluates the ltree
    //    containment test row by row over every override/hide candidate; with it, a Bitmap AND of the
    //    two finds the match directly.
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
    // -> One page row per name per (site, locale, folder), and one non-page row: a page may share a
    //    name with a folder, but nothing else shares. The page<->asset cross-partition exclusion
    //    cannot be a unique index and stays enforced by `models/tree.ts`'s own probes.
    uniqueIndex('tree_composite_page_idx')
      .on(table.siteId, table.locale, table.folderPath, table.fileName)
      .where(sql`"tree" = 'page'`),
    uniqueIndex('tree_composite_nonpage_idx')
      .on(table.siteId, table.locale, table.folderPath, table.fileName)
      .where(sql`"tree" <> 'page'`)
  ]
)

// -> What `models/login.ts#loginTFA()` reads and writes to tell a returning device from a new one, so
//    it knows when to fire the new-device-login notice. There is no geoIP lookup anywhere in this
//    codebase, so "device" and "location" are not tracked separately: `fingerprint` hashes the client
//    IP plus its User-Agent, and a change in either is a new device. `ip`/`userAgent` are kept in the
//    clear only so a future admin-facing "known devices" view has something readable to show.
export const tfaKnownDevices = pgTable(
  'tfaKnownDevices',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // -> sha1 hex of `${ip}|${userAgent}`, computed only in `models/login.ts#tfaDeviceFingerprint`.
    //    Looked up by (userId, fingerprint) equality, never parsed.
    fingerprint: varchar({ length: 64 }).notNull(),
    ip: varchar({ length: 255 }),
    userAgent: text(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex('tfaKnownDevices_userId_fingerprint_idx').on(table.userId, table.fingerprint)
  ]
)

export const userAvatars = pgTable('userAvatars', {
  id: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  data: bytea().notNull(),
  // -> sha1 hex digest of `data`, kept in sync by every write path -- lets a conditional request
  //    (ETag) be answered without reading the blob back out of the database.
  hash: varchar({ length: 255 }).notNull()
})

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
    // -> Unique as documentation of intent: `models/userCredentials.ts` looks a row up by bare `token`
    //    equality and treats it as an identity.
    uniqueIndex('userKeys_token_idx').on(table.token)
  ]
)

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: varchar({ length: 255 }).notNull().unique(),
    // -> DERIVED from `firstName`/`lastName` on write by `models/users.ts#deriveDisplayName`, unless
    //    `nameLocallyEdited` says a human authored it outright.
    name: varchar({ length: 255 }).notNull(),
    // -> Separated rather than parsed out of `name` at render time because sorting a user list by
    //    surname, and addressing someone by first name in notification copy, both want the split
    //    stored. An empty string means "not set": a provider sign-in fills a half that is still empty
    //    and never overwrites one that is not.
    firstName: varchar({ length: 255 }).notNull().default(''),
    lastName: varchar({ length: 255 }).notNull().default(''),
    // -> "A human on this instance authored this account's name". Two consequences, both owned by
    //    `models/users.ts`: `name` stops being derived from the two halves above, and a provider
    //    re-login leaves all three fields alone. Stored rather than inferred by comparing a provider's
    //    claim against the current value.
    nameLocallyEdited: boolean().notNull().default(false),
    auth: jsonb().notNull().default({}),
    meta: jsonb().notNull().default({}),
    passkeys: jsonb().notNull().default({}),
    prefs: jsonb().notNull().default({}),
    hasAvatar: boolean().notNull().default(false),
    // -> The provider-reported avatar URL cached by `models/users.ts#syncAvatarFromProvider`, the one
    //    write path every provider integration syncs an avatar through. Applied ONLY while
    //    `hasAvatar` is false, and nothing in that path touches `hasAvatar`/`userAvatars` -- so a
    //    manual upload always wins, and `hasAvatar` keeps meaning "this user uploaded one themselves".
    avatarProviderUrl: text(),
    handle: varchar({ length: 32 }),
    isActive: boolean().notNull().default(false),
    isSystem: boolean().notNull().default(false),
    isVerified: boolean().notNull().default(false),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index('users_lastLoginAt_idx').on(table.lastLoginAt),
    uniqueIndex('users_handle_lower_idx').on(sql`lower(${table.handle})`)
  ]
)

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
    // -> `groupId` is the PK's non-leading column, so the PK's own index cannot serve a lookup on it
    //    alone -- which `sessions.clearSessionsForGroup`'s `WHERE groupId = ?` needs.
    index('userGroups_groupId_idx').on(table.groupId)
  ]
)
