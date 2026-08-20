# Real-Time Discussion Channels — Design Spec (Stretch Goal, Unscoped)

**Date:** 2026-08-20
**Status:** Speculative — not scoped into any epic's near-term plan
**OpenProject:** #786 ("Stretch goal: real-time discussion channels editor (channel-style)")
**Scope of this document:** Design-only. No implementation. Written so a future implementation pass
has a starting point, and so the removed `EditorChannel.vue` mock doesn't get silently
rediscovered as a mystery component with no context.

## Why this document exists, and why it isn't code

WP 786's own description frames it as speculative and unscoped. Its origin is a 79-line
Options-API stub, `EditorChannel.vue`, that rendered a hardcoded channel list and a hardcoded
message pane against no real data — no schema, no API, no transport. It was deleted as dead code
during Task #492. Nothing in that stub is reusable beyond the rough UI shape it gestured at: a
channel list sidebar next to a message pane, Slack/Discord-style.

A real implementation is schema + REST API + a live transport (websocket or SSE) + a new editor
surface — a multi-week epic-sized effort with zero existing scaffolding elsewhere in the
codebase. That doesn't belong in a single pass alongside unrelated implementation items, so this
document stops at the design.

## What this is not

**Not the per-page Comments epic.** Comments (`backend/db/schema.ts` → `comments` table,
`feature/comments-data-model` / `feature/comments-rest-add` branches, Task 625's moderation
listing) are threaded, page-scoped, asynchronous annotations — a comment is a reply on *this
page*, read on next page load, no expectation of a live audience. Channels, as sketched by the
mock, are the opposite shape: a persistent, page-independent conversation space with an
expectation that other people are there *right now* and see messages appear without a reload.
Different data model (page-scoped tree vs. flat channel timeline), different UX contract (durable
annotation vs. live conversation), different technical requirements (comments need no push
transport at all; channels are pointless without one). They could theoretically share an
`authorId` / guest-attribution convention and little else. Do not attempt to unify the two tables
or route them through one API surface — keep them as separate feature areas that both incidentally
involve "message text a user submits."

**Not a page feature.** Nothing about the mock ties a channel to a specific page — it's closer to
a site-wide (or space-wide) chat facility that happens to be reachable from the editor area,
unlike comments which are inherently anchored to one page's content.

## Proposed schema (draft, for a future pass — not applied here)

Two new tables, `channels` and `channelMessages`, following this repo's existing schema
conventions (uuid PKs, `siteId` scoping, `Temporal`-compatible `timestamp` columns, cascade rules
matching `comments`' guest/account handling).

```ts
// CHANNELS -----------------------------
export const channels = pgTable(
  'channels',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: varchar({ length: 255 }).notNull(),
    description: text(),
    isPrivate: boolean().notNull().default(false),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    createdAt: timestamp().notNull().defaultNow(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp() // null = active; soft-archive rather than delete, so history survives
  },
  (table) => [
    uniqueIndex('channels_siteId_name_idx').on(table.siteId, table.name),
    index('channels_siteId_idx').on(table.siteId)
  ]
)

// CHANNEL MEMBERS -----------------------
// -> Only needed if isPrivate channels exist at all; otherwise membership is implicit (anyone with
//    read:pages-equivalent site access can read/post). Needed for private channels' access control
//    and for "which channels does this user see in their sidebar" without a site-wide scan.
export const channelMembers = pgTable(
  'channelMembers',
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp().notNull().defaultNow(),
    lastReadAt: timestamp() // drives unread-badge state; null = never opened
  },
  (table) => [
    uniqueIndex('channelMembers_composite_idx').on(table.channelId, table.userId),
    index('channelMembers_userId_idx').on(table.userId)
  ]
)

// CHANNEL MESSAGES -----------------------
export const channelMessages = pgTable(
  'channelMessages',
  {
    id: uuid().primaryKey().defaultRandom(),
    content: text().notNull(),
    render: text(), // rendered HTML/markdown-lite, cached alongside source, mirrors `comments.render`
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }), // null = deleted account
    replyTo: uuid().references((): AnyPgColumn => channelMessages.id, { onDelete: 'set null' }),
    editedAt: timestamp(), // null = never edited
    deletedAt: timestamp(), // soft delete: tombstone shown as "message removed", preserves thread ids
    createdAt: timestamp().notNull().defaultNow()
  },
  (table) => [
    // -> The live-pane query: latest N messages in a channel, and the poll/subscribe cursor.
    index('channelMessages_channelId_idx').on(table.channelId, table.createdAt),
    index('channelMessages_authorId_idx').on(table.authorId),
    index('channelMessages_replyTo_idx').on(table.replyTo)
  ]
)
```

Notes on the draft:

- No guest posting. Unlike `comments`, which explicitly supports anonymous authorship
  (`guestName`/`guestEmail`/`guestIp`), a channel implies an authenticated, identifiable
  participant — closer to how `manage:navigation`-gated features work than to public commenting.
  This should be revisited if the real requirement turns out to want public/anonymous channels.
- `replyTo` on `channelMessages` sets `set null` rather than `comments`' `cascade`: a channel
  timeline reads top-to-bottom continuously, so orphaning a reply's parent (leaving it visible as
  a reply to a deleted message) is less disruptive than cascading a delete through a live,
  possibly-long thread. This is a judgment call for the future implementer to confirm against
  actual UX, not a settled decision.
- `channelMembers.lastReadAt` is the minimum needed for unread badges; a "typing indicator" or
  "online presence" table is deliberately not sketched here — those are transport-layer ephemeral
  state (see below), not something that belongs in Postgres.

## Proposed REST API shape (draft)

Following this repo's `api/` conventions — one file (`api/channels.ts`), schema + permissions per
route, registered under `/_api`:

```
GET    /_api/sites/:siteId/channels                 list channels visible to the caller
POST   /_api/sites/:siteId/channels                 create a channel
GET    /_api/channels/:channelId                    channel metadata
PATCH  /_api/channels/:channelId                     rename/describe/archive
DELETE /_api/channels/:channelId                     delete (hard — archival is the soft path)

GET    /_api/channels/:channelId/messages            paginated history (cursor = createdAt + id)
POST   /_api/channels/:channelId/messages            post a message
PATCH  /_api/channels/:channelId/messages/:messageId  edit own message
DELETE /_api/channels/:channelId/messages/:messageId  soft-delete own message (or moderator)

POST   /_api/channels/:channelId/read                 mark read up to now (updates lastReadAt)
```

No route-level global permission fits page-rule-style per-channel access (mirrors the
`No route-level permissions:` pattern already used in `api/pages.ts`/`api/assets.ts`) — channel
read/write should be checked in-handler against `channelMembers` for private channels, or against
a to-be-decided site-wide "may use channels" gate for public ones. This needs a real permission-
model decision (a new global permission? reuse of existing ones?) that is out of scope for this
document to settle.

## Transport choice: recommendation

Three options, evaluated against what this codebase already has running:

| Option | Fit here |
| --- | --- |
| **Short polling** (`GET .../messages?since=`) | Trivial to build on the existing REST stack, no new infrastructure, works behind every proxy/LB unchanged. Costs latency (feels laggy at >2-3s intervals) and wasted requests when a channel is idle. |
| **SSE** (`EventSource`) | One-way (server→client) push, plain HTTP, no new protocol to reverse-proxy around, survives reconnects natively in the browser API. Fastify has no built-in helper but SSE is just a long-lived response with `text/event-stream` — cheap to hand-roll. Posting is still a normal `POST`. |
| **WebSocket** | Full duplex, lowest latency, but needs a stateful connection registry (which server instance holds which socket — relevant the moment this ever runs more than one backend process), reverse-proxy/timeout configuration, and a new dependency (`@fastify/websocket` or similar). Wiki.js already uses Postgres LISTEN/NOTIFY (`core/db.ts`) for pubsub, which pairs naturally with a websocket fan-out but adds real operational surface. |

**Recommendation: SSE for the read side, plain REST `POST` for the write side.** Reasoning:

- Channel messages are a **server-push, client-write** shape — nothing the client needs to push
  outside of the normal HTTP POST. Full-duplex websockets buy nothing here that SSE doesn't
  already cover; the complexity premium of a stateful socket registry isn't earning its keep for a
  single-tenant-instance wiki (this app has no existing multi-node fan-out story at all —
  `core/db.ts`'s LISTEN/NOTIFY is currently used for single-process cache invalidation, not
  cross-client push).
- SSE reuses the existing session-cookie auth (`EventSource` sends cookies same-origin, no new
  auth handshake), needs no new dependency, and degrades gracefully — a client that can't hold the
  connection open just polls `GET .../messages?since=` instead, using the exact same endpoint
  shape.
- If a future requirement genuinely needs bidirectional low-latency push (typing indicators,
  presence), that's the moment to reconsider websockets — but nothing in the current mock or WP
  786's description asks for that, so it would be scope creep to build for it now.
- Fan-out from Postgres write → connected SSE clients should go through `WIKI.events` (Emittery,
  already used for in-process pubsub per `core/db.ts`) for a single-instance deployment; a
  multi-instance deployment would need LISTEN/NOTIFY or equivalent to fan an event out across
  processes — noted here as a known gap, not solved by this document.

## Rough task breakdown (for a future implementation pass)

Sized as a rough planning aid only — not estimates, not commitments:

1. **Schema**: `channels`, `channelMembers`, `channelMessages` tables + migration (`db-generate`).
2. **Permission model decision**: does channel access need a new global permission
   (`manage:channels`?) plus per-channel membership, or does it piggyback on an existing page-rule
   permission? This blocks the API work and needs a real design conversation, not a guess.
3. **REST API**: `api/channels.ts` — CRUD + message list/post/edit/delete + read-receipt endpoint,
   per the shape above.
4. **SSE endpoint**: `GET /_api/channels/:channelId/stream` (or similar), backed by `WIKI.events`.
5. **Frontend**: a real `EditorChannel.vue` (or a non-editor-scoped `ChannelsView.vue`, pending the
   "is this an editor feature or a standalone area" question the old mock never actually
   answered) — channel list sidebar, message pane, composer, `EventSource` wiring, polling
   fallback.
6. **Moderation**: admin-side channel list/archive/delete, mirroring the `comments` moderation
   pattern in `api/comments.ts` (Task 625) once that lands.
7. **Notifications integration**: decide whether a channel message should ever produce an
   in-app/email notification (the existing `notifications`-adjacent tables referenced elsewhere in
   `schema.ts` are a precedent) — likely a "mentioned" case only, not every message.

Each of these is its own multi-day-to-multi-week task; none should be started opportunistically
inside an unrelated pass. This breakdown exists so a future epic-scoping conversation has a
starting inventory, not so item 1 gets picked up next week.
