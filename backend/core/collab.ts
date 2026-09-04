import { sql } from 'drizzle-orm'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

import { connectListener, createNotifier, type ListenerHandle } from '../helpers/pubsub.ts'

import type { PoolClient } from 'pg'
import type { WebSocket } from 'ws'

/**
 * Live collaborative editing.
 *
 * A room is one page being edited by more than one person at a time. It holds a Yjs document — the
 * markdown source as a `Y.Text`, the header fields as a `Y.Map` — and the awareness state that carries
 * everyone's cursor and identity. Clients speak the y-websocket protocol to it, which is why the
 * message framing below is byte-compatible with `y-websocket`'s client rather than something of our
 * own: the browser side is that library, unmodified.
 *
 * **A room is not page storage.** Nothing here is ever written back to `pages` — saving is still an
 * explicit act, `PATCH /pages/:id` as it always was. What a room adds is that the text survives *one*
 * participant leaving, because the others are still holding it; the in-memory room itself still goes
 * away the moment the last one does ({@link closeRoomIfEmpty}).
 *
 * ## Autosave draft
 *
 * A room's live state is also debounce-persisted to {@link WIKI.models.pageDrafts} as edits happen
 * ({@link scheduleDraftPersist}) — a *recovery* copy, separate from both the room and the stored page,
 * for exactly the case the paragraph above used to end on: every participant gone (a crash, a closed
 * tab) with nothing saved. {@link initRoom} prefers this draft over the stored page the next time a
 * room for that page has to be rebuilt from scratch, so reopening the page picks the in-progress text
 * back up rather than the last save. {@link pageSaved} clears it once a real save supersedes it, and it
 * is deleted, not versioned — see `db/schema.ts`'s `pageDrafts` table comment for the full design and
 * OpenProject #2454/#2455 for the split between persisting it (here) and the frontend's restore prompt.
 *
 * ## Across instances
 *
 * Rooms live in memory, so two people served by different instances would otherwise never meet. Their
 * updates are relayed over postgres LISTEN/NOTIFY on a channel of this module's own, separate from the
 * `wiki` channel that carries the general event bus: these are frequent, binary, and worthless a
 * second after they are sent, and none of that describes an event bus message.
 *
 * NOTIFY caps a payload at 8000 bytes, so a relayed message is base64'd and split into chunks that fit
 * — see {@link relay}. Chunks of one message arrive in order, postgres guaranteeing that much per
 * connection.
 *
 * ## Where a room's starting state comes from
 *
 * This is the one genuinely delicate part. A Yjs document cannot simply be seeded twice: two instances
 * that each insert the page's text into their own replica produce two *different* sets of operations
 * that both say "insert this text", and merging those replicas concatenates them — the document ends
 * up holding the page twice. So a room being created asks the cluster first ({@link peerState}), then
 * a persisted autosave draft if one exists (see "Autosave draft" above), and only falls back to the
 * stored page once neither of those answers.
 *
 * Two instances cold-starting the same room in the same instant would still both fall back, so that
 * seed is made *deterministic*: it is built in a scratch document pinned to client id 0, and two seeds
 * of identical text therefore produce byte-identical operations, which merge as one. That is also what
 * lets a client reconnect after a network blip and push back the edits it made while it was away — its
 * local copy of the seed is the same seed a freshly created room builds, and it is what makes it safe
 * for {@link receiveRelay}'s `state` case to merge a `peerState` reply that arrives after
 * {@link PEER_STATE_TIMEOUT} straight into an already-fallen-back room rather than discard it: the
 * seed portion of the peer's state is byte-identical to this instance's own, so `Y.applyUpdate` treats
 * it as already known and only the peer's genuinely new edits land.
 */

/** y-websocket message types. The values are that protocol's, not ours. */
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const NOTIFY_CHANNEL = 'wiki_collab'

/**
 * Base64 characters per NOTIFY payload. Postgres refuses a payload over 8000 bytes, and the JSON
 * envelope around the chunk fits comfortably in the slack this leaves.
 *
 * Checked against the worst case (task 478's load test): every optional field populated (`to`, `m`,
 * `c`, `n`), `i`/`to` at their real length (a 10-character `nanoid`, see `WIKI.INSTANCE_ID` in
 * `index.ts`), `r` a full 36-character page uuid, and `t` at its longest value (`'awareness'`, 9
 * characters) — `JSON.stringify` on that envelope costs ~140 bytes before `p` is even added, so a
 * 5000-character `p` lands the whole envelope at ~5140 bytes: **~2860 bytes of slack (36%) under the
 * 8000-byte cap**, room enough that this constant could grow to ~7860 before it would need revisiting.
 * No change made — the margin was already comfortable — but see `core/collab.test.ts` for a test that
 * pins this down, so a future field added to {@link RelayEnvelope} gets caught if it ever erodes it.
 * Exported for that test, which checks the real constant rather than a hardcoded copy of it.
 */
export const RELAY_CHUNK_SIZE = 5000

/**
 * How long a half-assembled relay message waits for the rest of its chunks before being dropped.
 * Exported for `core/collab.test.ts`, which verifies a partial's cleanup against the real constant
 * rather than a hardcoded copy of it.
 */
export const RELAY_REASSEMBLY_TIMEOUT = 10 * 1000

/**
 * How long a new room waits for a peer to hand over the state it already has, before seeding itself
 * from the stored page. Only paid when this instance does not already have the room open, and skipped
 * entirely when no other instance is running — which is the ordinary case.
 *
 * **Not reliably enough for a multi-megabyte document, and left that way on purpose.** Task 478's load
 * test measured a real `hello`/`state` round trip — three peers replying at once, each chunking a
 * ~3.6MB update over real (if same-box) postgres NOTIFY — at ~495ms even on an otherwise idle local
 * database, i.e. already at the edge of this budget with zero network latency between app and db and
 * no other load on either. Real deployments add both, so a sufficiently large page routinely misses
 * this window. Scaling the constant to cover it is not a good trade: this timeout is paid on *every*
 * cold room-open when a peer instance exists but does not happen to have this particular page open
 * already (the common case — most pages are not all being edited on every instance at once), so
 * lengthening it to comfortably fit a rare multi-megabyte document would add real, constant latency to
 * every ordinary page's editor opening.
 *
 * What makes this an accepted limitation rather than a data-loss bug is {@link receiveRelay}'s `state`
 * case: a peer's reply that arrives after this timeout has already fired and the room has fallen back
 * to {@link buildSeed} is not discarded, it is merged straight into the room the moment it lands — see
 * that function's doc comment for why that merge is safe. So a large document's cold start briefly
 * shows the stored copy while the peer's fuller state is still in flight, then catches up on its own;
 * nothing is permanently lost, only momentarily behind.
 */
export const PEER_STATE_TIMEOUT = 500

/** How long the "is anyone else running?" answer is trusted before it is looked up again. */
const PEER_PRESENCE_TTL = 15 * 1000

/**
 * How long a room waits for edits to settle before persisting its Yjs state as the page's autosave
 * draft ({@link WIKI.models.pageDrafts}) — see {@link scheduleDraftPersist}. Short enough that a
 * pause of ordinary typing (thinking, re-reading a sentence) is enough to flush, since a crash can
 * land at any moment and the whole point is not losing whatever came before it.
 */
export const DRAFT_PERSIST_DEBOUNCE = 4 * 1000

/**
 * Upper bound on how long edits may keep pushing the debounce back before a persist happens anyway —
 * otherwise someone typing continuously (no pause ever longer than {@link DRAFT_PERSIST_DEBOUNCE})
 * would never get flushed at all, and a crash mid-sentence would lose the entire session rather than
 * just the last few keystrokes.
 */
export const DRAFT_PERSIST_MAX_DELAY = 20 * 1000

/**
 * Per-user and per-address ceilings on concurrent collaboration sockets.
 *
 * Nothing else caps how many `Y.Doc` rooms one account (or one address) can pin in memory:
 * `room.conns` only tracks a room's own lifetime, and `/_collab` sits outside `/_api/`, so neither of
 * `index.ts`'s `onRequest` rate limiters ever sees this traffic. One authenticated account holding
 * `write:pages` could otherwise open arbitrarily many rooms just by opening arbitrarily many editors.
 *
 * Deliberately small relative to any real editing session (a handful of tabs/pages at once) rather
 * than tuned to a specific deployment's capacity — the goal is bounding an unbounded resource, not
 * modeling how many any legitimate user actually needs.
 */
export const MAX_CONNECTIONS_PER_USER = 8
export const MAX_CONNECTIONS_PER_ADDRESS = 32

/** Keepalive interval. An idle websocket is what a reverse proxy cuts first. */
const PING_INTERVAL = 30 * 1000

/**
 * Ceiling on `session.pending` — see {@link capture} — checked on both axes: entry count and total
 * bytes. The handshake it exists to preserve is one small y-websocket sync frame, so a few dozen
 * kilobytes and a handful of entries is ample; a socket that sends more than this before a room is
 * ever attached either isn't a real y-websocket client or is deliberately stalling, and gets
 * terminated rather than buffered further (OpenProject #2196, audit `09-dos-resource.md` §3).
 * Exported for `core/collab.test.ts`, which checks the real constants rather than hardcoded copies
 * of them.
 */
export const MAX_PENDING_FRAMES = 16

/** See {@link MAX_PENDING_FRAMES}. */
export const MAX_PENDING_BYTES = 64 * 1024

/**
 * How long a refused socket is given to complete the closing handshake it was just sent, before it
 * is cut off outright. `ws`'s own default ({@link https://github.com/websockets/ws} `CLOSE_TIMEOUT`,
 * 30s) is sized for an ordinary, cooperating peer that might be slow to answer — but
 * `controllers/collab.ts`'s refusal paths run before authentication or the site feature-flag check,
 * so a socket that never intends to complete the handshake still has this whole window in which
 * `capture`'s listener stays attached (bounded now by {@link MAX_PENDING_FRAMES}/
 * {@link MAX_PENDING_BYTES}, but still an open socket doing nothing legitimate). A real client
 * completes the handshake within one round trip; this is comfortably longer than that while being
 * far short of `ws`'s own 30s default. Exported for `core/collab.test.ts`.
 */
export const REFUSAL_GRACE_PERIOD = 2 * 1000

/**
 * Marks a document or awareness change as having arrived over the relay, so that applying it here does
 * not send it straight back out to the instance it came from.
 */
const RELAYED = Symbol('collabRelayed')

/** Who a socket belongs to, for the connection-cap bookkeeping in {@link join}/{@link onClose}. */
export interface ConnIdentity {
  userId: string
  address: string
}

interface CollabConn {
  /** Awareness client ids this socket is responsible for, so a disconnect can retract exactly those. */
  clients: Set<number>
  /** Answered the last keepalive ping. */
  alive: boolean
  /** Whose connection-cap slot this socket is holding — released once by {@link onClose}. */
  identity: ConnIdentity
}

interface CollabSession {
  /** The room this socket ended up in, or null while it is still being decided. */
  room: CollabRoom | null
  /** Frames that arrived before there was a room to hand them to. Capped — see {@link capture}. */
  pending: Uint8Array[]
  /** Running total of `pending`'s byte length, kept alongside it so the cap check is O(1) per frame. */
  pendingBytes: number
}

interface CollabRoom {
  pageId: string
  siteId: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<WebSocket, CollabConn>
  /** Resolves once the document holds its starting state and clients may be synced against it. */
  ready: Promise<void>
  /** Whether this room is still filling itself, i.e. has nothing worth handing to a peer yet. */
  provisional: boolean
  /** Debounced autosave-draft persistence bookkeeping — see {@link scheduleDraftPersist}. */
  draftPersist: DraftPersistState
  /**
   * Best-effort attribution for the next persisted draft (OpenProject #2455): the name of whoever was
   * last known to be editing, read off a departing connection's awareness state in {@link onClose}
   * before it is retracted (nothing else here tracks who typed what). Carried on the room rather than
   * threaded through every persist call, since {@link scheduleDraftPersist}'s debounce timer fires
   * well after the edit — and the connection — that triggered it. Null until some closing connection
   * has actually carried a name.
   */
  lastAuthorName: string | null
  /**
   * Whether some caller has already been granted (or is currently asking to be granted) the right
   * to seed this room's WYSIWYG (TipTap) field -- see {@link claimWysiwygSeed}. Starts `false` for
   * every freshly created room, including one seeded from a peer or an autosave draft that already
   * happens to carry WYSIWYG content: those cases never call {@link claimWysiwygSeed} at all (the
   * client's own `fragment.length === 0` check short-circuits first), so this flag only ever matters
   * for the genuinely ambiguous "nobody has written to it yet" case it exists to arbitrate.
   */
  wysiwygSeeded: boolean
}

interface DraftPersistState {
  /** The pending debounce timer, or null while nothing is scheduled. */
  timer: NodeJS.Timeout | null
  /** When the first not-yet-persisted edit in the current burst landed, for the max-delay cap — null
   * exactly when `timer` is. */
  pendingSince: number | null
}

interface SaveInfo {
  versionDate: string
  authorId: string
  authorName: string
}

interface RelayEnvelope {
  /** Instance the message came from. */
  i: string
  /** Room, i.e. page id. */
  r: string
  t: 'update' | 'awareness' | 'hello' | 'state' | 'saved' | 'wysiwyg-claim' | 'wysiwyg-claimed'
  /** Payload: base64 for the binary kinds, JSON for `saved`, absent for `hello`. */
  p?: string
  /** Instance this is addressed to, when it is a reply rather than a broadcast. */
  to?: string
  /** Chunking: message id, chunk index, chunk count. Absent on a message that fits in one. */
  m?: string
  c?: number
  n?: number
}

interface PartialRelay {
  parts: (string | undefined)[]
  remaining: number
  timer: NodeJS.Timeout
}

/**
 * A websocket frame as bytes, whatever shape `ws` handed it over in.
 *
 * A fragmented message arrives as an array of buffers, and a whole one as a single `Buffer` — which is
 * a view into a larger pool, so its offset and length matter. The result is a view over that same
 * memory and is only safe to read during the event that delivered it; anything held on to has to be
 * copied first.
 */
function toBytes(data: unknown): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data))
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return new Uint8Array(data as ArrayBuffer)
}

/**
 * The state a room starts from when it has to build one itself, as a Yjs update.
 *
 * Built in a scratch document whose client id is pinned to 0, so that the bytes depend on nothing but
 * the page — see the note at the top of this file on why that matters.
 */
export function buildSeed(page: {
  content?: string | null
  title?: string | null
  description?: string | null
  icon?: string | null
}): Uint8Array {
  const seed = new Y.Doc()
  seed.clientID = 0
  seed.transact(() => {
    seed.getText('content').insert(0, page.content ?? '')
    const props = seed.getMap('props')
    props.set('title', page.title ?? '')
    props.set('description', page.description ?? '')
    props.set('icon', page.icon ?? '')
  })
  const update = Y.encodeStateAsUpdate(seed)
  seed.destroy()
  return update
}

/**
 * Sends this instance's relay messages, one at a time.
 *
 * Every one of them starts in a Yjs handler that cannot wait for postgres, and a single edit can
 * produce several — see `publish`.
 */
const notifier = createNotifier(() => WIKI.collab.listenClient, 'collaboration relay')

export default {
  rooms: new Map<string, CollabRoom>(),
  listenClient: null as PoolClient | null,
  listenerHandle: null as ListenerHandle | null,
  /** Chunked relay messages still waiting for the rest of themselves, keyed by sender and message id. */
  partials: new Map<string, PartialRelay>(),
  /** Rooms this instance is waiting on a peer's state for, by page id. */
  awaitingState: new Map<string, (update: Uint8Array) => void>(),
  /**
   * Rooms this instance is waiting on a peer's WYSIWYG-seed-claim answer for, by page id -- see
   * {@link claimWysiwygSeed}. Same shape as {@link awaitingState}, kept separate because the two
   * questions ("what is this room's state" vs. "has anyone already claimed its WYSIWYG seed") are
   * asked at different times against the same room and must not resolve each other's waiters.
   */
  awaitingWysiwygClaim: new Map<string, () => void>(),
  /** Live connection counts per user id, for the {@link MAX_CONNECTIONS_PER_USER} ceiling. */
  userConnections: new Map<string, number>(),
  /** Live connection counts per address, for the {@link MAX_CONNECTIONS_PER_ADDRESS} ceiling. */
  addressConnections: new Map<string, number>(),
  relaySeq: 0,
  peerPresence: { known: false, checkedAt: 0 },
  pingTimer: null as NodeJS.Timeout | null,

  /**
   * Open the relay connection.
   *
   * A client of its own rather than the event bus's: these messages are far more frequent than events
   * are, and a slow consumer on one channel should not hold up the other.
   */
  async init(): Promise<void> {
    // -> `connectListener` attaches the 'error' handler this client needs (see helpers/pubsub.ts):
    //    on a dropped connection it re-connects and re-LISTENs on its own, rather than throwing on
    //    an unhandled 'error' and taking the process down with it.
    this.listenerHandle = await connectListener({
      pool: WIKI.dbManager.listenerPool!,
      applicationName: `Wiki.js - ${WIKI.INSTANCE_ID}:COLLAB`,
      channels: [NOTIFY_CHANNEL],
      label: 'collaboration relay',
      onNotification: (msg) => {
        if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) {
          return
        }
        try {
          this.receiveRelay(JSON.parse(msg.payload) as RelayEnvelope)
        } catch (err: any) {
          WIKI.logger.warn(`Malformed collaboration relay message: ${err.message}`)
        }
      },
      getClient: () => this.listenClient,
      setClient: (client) => {
        this.listenClient = client
      }
    })

    this.pingTimer = setInterval(() => {
      for (const room of this.rooms.values()) {
        for (const [conn, state] of room.conns) {
          // -> A socket whose peer stopped answering is dropped by the `close` handler that
          //    `terminate()` triggers, which is also what takes its cursor off everyone's screen
          if (!state.alive) {
            conn.terminate()
            continue
          }
          state.alive = false
          try {
            conn.ping()
          } catch {}
        }
      }
    }, PING_INTERVAL)

    WIKI.logger.info('Collaborative editing initialized successfully: [ OK ]')
  },

  async shutdown(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    for (const partial of this.partials.values()) {
      clearTimeout(partial.timer)
    }
    this.partials.clear()
    const pendingDraftFlushes: Promise<void>[] = []
    for (const room of this.rooms.values()) {
      for (const conn of room.conns.keys()) {
        conn.close(1001, 'Server is shutting down')
      }
      // -> Same reasoning as `closeRoomIfEmpty`: a graceful shutdown is not a saved page either, and
      //    the debounce timer this flushes will never get another chance to fire once the doc below
      //    is destroyed — awaited below, unlike every other caller of `flushDraftPersist`, because
      //    this is the one place where "the process is about to exit" makes that wait necessary.
      if (room.draftPersist.timer) {
        pendingDraftFlushes.push(this.flushDraftPersist(room))
      }
      room.awareness.destroy()
      room.doc.destroy()
    }
    this.rooms.clear()
    await Promise.all(pendingDraftFlushes)
    if (this.listenerHandle) {
      // -> Whatever is still on its way out goes out first: releasing the client from under a
      //    notification in flight would fail that one for no reason
      await notifier.drained()
      await this.listenerHandle.close()
      this.listenerHandle = null
    }
  },

  /**
   * Whether another instance is currently running.
   *
   * Asked so that the single-instance case — very much the common one — does not spend
   * {@link PEER_STATE_TIMEOUT} waiting for an answer that cannot come. Instances are not registered
   * anywhere, so this reads what the admin area's instance list reads: our own connections name
   * themselves in `pg_stat_activity`.
   */
  async hasPeers(): Promise<boolean> {
    const now = Date.now()
    if (now - this.peerPresence.checkedAt < PEER_PRESENCE_TTL) {
      return this.peerPresence.known
    }
    const ownName = `Wiki.js - ${WIKI.INSTANCE_ID}:COLLAB`
    try {
      const result = await WIKI.db.execute(
        sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND application_name LIKE 'Wiki.js - %:COLLAB'
              AND application_name <> ${ownName} LIMIT 1`
      )
      this.peerPresence = { known: result.rows.length > 0, checkedAt: now }
    } catch (err: any) {
      // -> Assume company: waiting 500ms is a far smaller mistake than duplicating a page's text
      WIKI.logger.warn(`Could not determine whether other instances are running: ${err.message}`)
      this.peerPresence = { known: true, checkedAt: now }
    }
    return this.peerPresence.known
  },

  /**
   * Start listening to a socket before anything is known about it.
   *
   * Called the instant the socket opens, and synchronously — the client does not wait to be welcomed.
   * y-websocket sends its first sync message immediately, while the route is still away asking the
   * database whether this user may edit this page at all, and an event nobody is listening for is
   * simply gone. That one message is the whole handshake: miss it and the client sits there holding an
   * empty document, because it is never going to ask twice.
   *
   * So the frames are collected here and replayed by {@link join} once there is a room to put them to.
   *
   * `pending` is capped on both axes ({@link MAX_PENDING_FRAMES}, {@link MAX_PENDING_BYTES}) because
   * this listener is live before either the session or the site's feature flag has been checked — a
   * request that never proves it may even open the door still gets to talk. Since a real handshake
   * fits comfortably inside the cap, the only way to hit it is a client that keeps writing well past
   * what a legitimate one ever would, and there is nothing worth buffering for that: it is hung up on
   * immediately, `terminate()` rather than `close()` so it gets no closing-handshake grace period
   * either.
   */
  capture(conn: WebSocket): CollabSession {
    const session: CollabSession = { room: null, pending: [], pendingBytes: 0 }
    conn.on('message', (data: unknown) => {
      if (session.room) {
        this.onMessage(session.room, conn, toBytes(data))
        return
      }
      // -> Copied, not referenced: `toBytes` hands back a view into a buffer `ws` owns, which is
      //    only good for the length of this event
      const bytes = new Uint8Array(toBytes(data))
      if (
        session.pending.length >= MAX_PENDING_FRAMES ||
        session.pendingBytes + bytes.byteLength > MAX_PENDING_BYTES
      ) {
        // -> No room has been attached yet, so there is nothing here to release — just stop
        //    buffering. `terminate()`, not `close()`: this socket has already sent more than a real
        //    y-websocket handshake ever does, so it does not get the closing handshake's grace period
        //    either.
        WIKI.logger.warn(
          'A collaboration socket exceeded the pre-auth frame buffer cap and was terminated.'
        )
        conn.terminate()
        return
      }
      session.pending.push(bytes)
      session.pendingBytes += bytes.byteLength
    })
    conn.on('close', () => {
      if (session.room) {
        this.onClose(session.room, conn)
      }
    })
    conn.on('error', (err: Error) => {
      WIKI.logger.debug(`Collaboration socket error: ${err.message}`)
    })
    return session
  },

  /**
   * Refuse a socket before it ever joins a room: send the close frame a well-behaved client (the
   * editor's own y-websocket provider, see `composables/collab.js`) needs to tell "you are not
   * allowed" apart from an ordinary drop and back off rather than reconnect, then cut the socket off
   * outright once {@link REFUSAL_GRACE_PERIOD} has passed rather than leaving it in `CLOSING` for
   * `ws`'s own far longer default. See `controllers/collab.ts`, whose five refusal points all call
   * this instead of `conn.close()` directly.
   */
  refuse(conn: WebSocket, code: number, reason: string): void {
    conn.close(code, reason)
    const timer = setTimeout(() => {
      if (conn.readyState !== conn.CLOSED) {
        conn.terminate()
      }
    }, REFUSAL_GRACE_PERIOD)
    // -> This timer alone must never be the reason the process stays alive (e.g. mid-shutdown)
    timer.unref?.()
  },

  /**
   * Who else has this page open, on this instance, right now.
   *
   * A cheap "someone else has this open" signal for before a collab session starts — read straight off
   * whatever room already exists for the page, with no new tracking of its own and no query. It is
   * deliberately a same-instance approximation rather than a cluster-wide headcount: two people on
   * different instances would each see only their own, since rooms are never listed across the relay
   * (only their edits and awareness are, once a room exists on both sides). That is an acceptable gap
   * for a hint shown before anyone has joined a room at all — the collab session itself, once started,
   * gets the real cross-instance participant list over the socket, from `awareness` directly.
   *
   * A page nobody has open on this instance, or with no room at all, answers empty rather than being
   * asked to distinguish the two — there is nothing a caller would do differently either way.
   */
  participantInfo(pageId: string): { count: number; names: string[] } {
    const room = this.rooms.get(pageId)
    if (!room) {
      return { count: 0, names: [] }
    }
    const states = room.awareness.getStates() as Map<number, { user?: { name?: string } }>
    const names = [...states.values()]
      .map((state) => state.user?.name)
      .filter((name): name is string => Boolean(name))
    return { count: states.size, names }
  },

  /**
   * Put a socket into a page's room, syncing it against whatever state that room holds.
   *
   * The caller is responsible for having decided that this user may edit this page — see
   * `controllers/collab.ts`. Nothing below re-checks it.
   *
   * A connection-cap slot is reserved for `identity` *before* {@link ensureRoom} ever runs, so a
   * refusal never allocates — or reuses — a room: past either ceiling the socket is simply closed
   * (code 4429) and `session.room` is left null. The slot is released by {@link onClose} once the
   * socket is actually registered in a room's `conns`, or right here if the socket went away (or the
   * cap was hit) before that ever happened.
   */
  async join(
    conn: WebSocket,
    page: { id: string; siteId: string },
    session: CollabSession,
    identity: ConnIdentity
  ): Promise<void> {
    if (!this.reserveSlot(identity)) {
      conn.close(4429, 'Too many concurrent collaboration connections')
      return
    }

    /*
      Asked for repeatedly, because a room can be dropped while this socket was waiting for it: another
      socket that gave up during the same setup takes the still-empty room down with it. Joining that
      one would put this editor in a room nothing else can find.
    */
    let room = await this.ensureRoom(page)
    for (let attempt = 0; this.rooms.get(page.id) !== room && attempt < 3; attempt++) {
      room = await this.ensureRoom(page)
    }

    // -> The socket may well have gone away while the room was being set up
    if (conn.readyState !== conn.OPEN) {
      this.releaseSlot(identity)
      this.closeRoomIfEmpty(room)
      return
    }

    const state: CollabConn = { clients: new Set(), alive: true, identity }
    room.conns.set(conn, state)
    conn.on('pong', () => {
      state.alive = true
    })
    session.room = room

    // -> Sync step 1: what this room has, so the client can say what it is missing
    const syncEncoder = encoding.createEncoder()
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(syncEncoder, room.doc)
    this.send(conn, encoding.toUint8Array(syncEncoder))

    // -> And everyone already in the room, so their cursors are there from the first frame
    const states = room.awareness.getStates()
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
      )
      this.send(conn, encoding.toUint8Array(awarenessEncoder))
    }

    for (const message of session.pending) {
      this.onMessage(room, conn, message)
    }
    session.pending = []
    session.pendingBytes = 0
  },

  /**
   * The room for a page, creating and populating it if this instance does not have it open.
   *
   * Concurrent joiners share one room *and one initialization*: the room goes into the map before it
   * has any state, and `ready` is what everything else waits on.
   */
  async ensureRoom(page: { id: string; siteId: string }): Promise<CollabRoom> {
    const existing = this.rooms.get(page.id)
    if (existing) {
      await existing.ready
      return existing
    }

    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    // -> The server is not a participant. Left as it comes, its own empty state would show up in the
    //    room as a cursor nobody owns, and be relayed to every other instance as one.
    awareness.setLocalState(null)

    const room: CollabRoom = {
      pageId: page.id,
      siteId: page.siteId,
      doc,
      awareness,
      conns: new Map(),
      ready: Promise.resolve(),
      provisional: true,
      draftPersist: { timer: null, pendingSince: null },
      lastAuthorName: null,
      wysiwygSeeded: false
    }
    this.rooms.set(page.id, room)

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      for (const conn of room.conns.keys()) {
        this.send(conn, message)
      }
      if (origin !== RELAYED) {
        this.relay({ r: room.pageId, t: 'update', p: Buffer.from(update).toString('base64') })
        // -> Not a genuinely new edit worth autosaving when it merely echoes a seed/peer/draft this
        //    room was just initialized with (those all apply via `RELAYED`, same as a relayed update
        //    from another instance) — only a real local edit schedules a persist.
        this.scheduleDraftPersist(room)
      }
    })

    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        const changed = [...added, ...updated, ...removed]
        // -> Remember whose cursors these are, so that a disconnect can retract exactly them
        const owner = room.conns.get(origin as WebSocket)
        if (owner) {
          for (const clientId of added) {
            owner.clients.add(clientId)
          }
          for (const clientId of removed) {
            owner.clients.delete(clientId)
          }
        }
        const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(encoder, update)
        const message = encoding.toUint8Array(encoder)
        for (const conn of room.conns.keys()) {
          this.send(conn, message)
        }
        if (origin !== RELAYED) {
          this.relay({
            r: room.pageId,
            t: 'awareness',
            p: Buffer.from(update).toString('base64')
          })
        }
      }
    )

    room.ready = this.initRoom(room)
    await room.ready
    return room
  },

  /**
   * Fill a newly created room with the state it should start from, in order of preference: a peer's
   * copy if the cluster already has this page open (the freshest possible truth), else a persisted
   * autosave draft (OpenProject #2454) if editing was left mid-flight and never saved, else the
   * stored page.
   *
   * The draft tier is what lets reopening a page after a crash/tab-close recover in-progress content
   * instead of the last saved copy: `doc.getMap('meta').set('draftRestored', …)` marks that this
   * happened, the same convention `pageSaved()` uses for `lastSave`, for the frontend to notice and
   * offer to keep or discard it (OpenProject #2455).
   */
  async initRoom(room: CollabRoom): Promise<void> {
    try {
      const fromPeer = (await this.hasPeers()) ? await this.peerState(room.pageId) : null
      if (fromPeer) {
        Y.applyUpdate(room.doc, fromPeer, RELAYED)
      } else {
        const draft = await WIKI.models.pageDrafts.get(room.pageId)
        if (draft) {
          Y.applyUpdate(room.doc, draft.state, RELAYED)
          room.doc.transact(() => {
            room.doc.getMap('meta').set('draftRestored', {
              at: draft.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
            })
          }, RELAYED)
        } else {
          const page = await WIKI.models.pages.getPage({
            siteId: room.siteId,
            id: room.pageId,
            withContent: true
          })
          // -> A page that went away between the permission check and here leaves an empty room,
          //    which the first disconnect clears away again
          Y.applyUpdate(room.doc, buildSeed(page ?? {}), RELAYED)
        }
      }
    } catch (err: any) {
      WIKI.logger.warn(
        `Failed to initialize the collaboration room for page ${room.pageId}: ${err.message}`
      )
    } finally {
      room.provisional = false
      this.awaitingState.delete(room.pageId)
    }
  },

  /** Ask the cluster for a room's current state, resolving to null if nobody answers in time. */
  peerState(pageId: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.awaitingState.delete(pageId)
        resolve(null)
      }, PEER_STATE_TIMEOUT)
      this.awaitingState.set(pageId, (update) => {
        clearTimeout(timer)
        this.awaitingState.delete(pageId)
        resolve(update)
      })
      this.relay({ r: pageId, t: 'hello' })
    })
  },

  /**
   * Grants at most one caller the right to seed a room's WYSIWYG (TipTap) field -- see
   * `EditorWysiwyg.vue#swapToCollabEditor` for the client side of this, and OpenProject #2516 for
   * why it exists: unlike the markdown field, the shared `Y.XmlFragment` TipTap binds to has no
   * server-side seed of its own ({@link buildSeed} never touches it), so two people opening a brand
   * new room's WYSIWYG editor at the same instant could otherwise both seed it from their own
   * locally-loaded copy of the page and duplicate its content. Deliberately schema-agnostic: only a
   * boolean ever crosses this method, never the actual ProseMirror JSON, which is what keeps the
   * backend out of the "understand TipTap's schema" business this WP explicitly rules out.
   *
   * Same-instance callers are decided exactly, with no residual race at all: the event loop
   * serializes two calls landing back to back, so the first to run sets
   * {@link CollabRoom.wysiwygSeeded} to `true` synchronously, before the second is ever evaluated.
   *
   * Cross-instance, this reuses {@link hasPeers}/{@link relay}/{@link receiveRelay} the same way
   * {@link peerState} already does for the markdown field's own seed: ask the cluster, wait up to
   * {@link PEER_STATE_TIMEOUT}, and grant locally if nobody answers in time -- the exact trade-off
   * {@link PEER_STATE_TIMEOUT}'s own doc comment already accepts, for the same reason. Two
   * cross-instance callers landing inside that same window can therefore still both come back
   * denied (each sees the other's room already marked `wysiwygSeeded` and answers "already
   * claimed"), leaving the fragment briefly unseeded rather than duplicated -- the "narrow, unlikely
   * race" this marker exists to shrink, not a guarantee to eliminate it outright (see OpenProject
   * #2516's own framing; a genuinely airtight guarantee would need the same byte-identical-seed
   * trick {@link buildSeed} uses, which is not available for a client's own ProseMirror JSON).
   *
   * Resolves `false` immediately, with no relay round trip at all, when this instance has no room
   * open for `pageId` -- the same "page went away between the permission check and here" case
   * {@link initRoom} already tolerates -- or when a claim has already been made on this instance.
   */
  async claimWysiwygSeed(pageId: string): Promise<boolean> {
    const room = this.rooms.get(pageId)
    if (!room || room.wysiwygSeeded) {
      return false
    }
    // -> Set before any `await`, so a second same-instance call arriving before this one resolves
    //    sees it above and returns false without ever reaching the cluster.
    room.wysiwygSeeded = true
    if (!(await this.hasPeers())) {
      return true
    }
    const alreadyClaimedElsewhere = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.awaitingWysiwygClaim.delete(pageId)
        resolve(false)
      }, PEER_STATE_TIMEOUT)
      this.awaitingWysiwygClaim.set(pageId, () => {
        clearTimeout(timer)
        this.awaitingWysiwygClaim.delete(pageId)
        resolve(true)
      })
      this.relay({ r: pageId, t: 'wysiwyg-claim' })
    })
    return !alreadyClaimedElsewhere
  },

  onMessage(room: CollabRoom, conn: WebSocket, message: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(message)
      const encoder = encoding.createEncoder()
      switch (decoding.readVarUint(decoder)) {
        case MESSAGE_SYNC: {
          encoding.writeVarUint(encoder, MESSAGE_SYNC)
          // -> The socket is the origin, which is how the awareness bookkeeping above knows whose
          //    cursors an update carries
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
          if (encoding.length(encoder) > 1) {
            this.send(conn, encoding.toUint8Array(encoder))
          }
          break
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            room.awareness,
            decoding.readVarUint8Array(decoder),
            conn
          )
          break
        }
      }
    } catch (err: any) {
      WIKI.logger.warn(
        `Failed to handle a collaboration message on page ${room.pageId}: ${err.message}`
      )
    }
  },

  onClose(room: CollabRoom, conn: WebSocket): void {
    const state = room.conns.get(conn)
    room.conns.delete(conn)
    if (state) {
      // -> `ws` delivers `terminate()` as a `close` event exactly like a graceful close, so this one
      //    site covers both paths: a legitimate reconnect loop can never exhaust its own ceiling.
      this.releaseSlot(state.identity)
      if (state.clients.size > 0) {
        // -> Best-effort attribution for the room's next persisted draft (OpenProject #2455) -- read
        //    off this connection's own awareness state before it is retracted below, since nothing
        //    else here tracks who typed what. Left as whatever it already was when no name is found
        //    (e.g. a socket that never set one), rather than clobbered to null.
        const states = room.awareness.getStates() as Map<number, { user?: { name?: string } }>
        for (const clientId of state.clients) {
          const name = states.get(clientId)?.user?.name
          if (name) {
            room.lastAuthorName = name
            break
          }
        }
        // -> Announced as an awareness change, which is what takes the avatar out of the header and
        //    the cursor out of the text for everyone else, here and on every other instance
        awarenessProtocol.removeAwarenessStates(room.awareness, [...state.clients], null)
      }
    }
    this.closeRoomIfEmpty(room)
  },

  /**
   * Reserve one connection-cap slot for `identity`, refusing once either ceiling is already at its
   * limit. Both counts are checked before either is incremented, so a refusal never partially reserves.
   */
  reserveSlot(identity: ConnIdentity): boolean {
    const userCount = this.userConnections.get(identity.userId) ?? 0
    const addressCount = this.addressConnections.get(identity.address) ?? 0
    if (userCount >= MAX_CONNECTIONS_PER_USER || addressCount >= MAX_CONNECTIONS_PER_ADDRESS) {
      return false
    }
    this.userConnections.set(identity.userId, userCount + 1)
    this.addressConnections.set(identity.address, addressCount + 1)
    return true
  },

  /** Release one connection-cap slot for `identity`, dropping the map entry once it reaches zero. */
  releaseSlot(identity: ConnIdentity): void {
    const userCount = this.userConnections.get(identity.userId) ?? 0
    if (userCount <= 1) {
      this.userConnections.delete(identity.userId)
    } else {
      this.userConnections.set(identity.userId, userCount - 1)
    }
    const addressCount = this.addressConnections.get(identity.address) ?? 0
    if (addressCount <= 1) {
      this.addressConnections.delete(identity.address)
    } else {
      this.addressConnections.set(identity.address, addressCount - 1)
    }
  },

  /**
   * Drop a room nobody on this instance is in.
   *
   * Immediately, with no grace period: a room outliving its last participant would quietly resurrect
   * it on the next visit. The in-memory room itself needs nothing of its own to discard here — the
   * socket closes and the doc goes with it — but any edit still waiting on the autosave debounce is
   * flushed first ({@link flushDraftPersist}), since this is exactly the "closed without saving" case
   * {@link WIKI.models.pageDrafts} exists to make recoverable rather than lost outright.
   *
   * Peers are not told. A room elsewhere is a replica in its own right whose participants are still
   * editing; this instance simply asks for their state again next time someone here opens the page.
   */
  closeRoomIfEmpty(room: CollabRoom): void {
    if (room.conns.size > 0 || this.rooms.get(room.pageId) !== room) {
      return
    }
    if (room.draftPersist.timer) {
      this.flushDraftPersist(room)
    }
    this.rooms.delete(room.pageId)
    room.awareness.destroy()
    room.doc.destroy()
  },

  /**
   * Schedule this room's current Yjs state to be written to {@link WIKI.models.pageDrafts} as the
   * page's autosave draft, debounced ({@link DRAFT_PERSIST_DEBOUNCE}, capped at
   * {@link DRAFT_PERSIST_MAX_DELAY}) so a burst of keystrokes persists once rather than on every one
   * of them. Called from every locally-originated doc update — a relayed one has already been (or is
   * about to be) persisted wherever it actually originated, so re-scheduling here would only repeat
   * the same write for no reason.
   */
  scheduleDraftPersist(room: CollabRoom): void {
    const state = room.draftPersist
    if (state.pendingSince === null) {
      state.pendingSince = Date.now()
    }
    if (state.timer) {
      clearTimeout(state.timer)
    }
    const elapsed = Date.now() - state.pendingSince
    const delay = Math.min(DRAFT_PERSIST_DEBOUNCE, Math.max(0, DRAFT_PERSIST_MAX_DELAY - elapsed))
    state.timer = setTimeout(() => this.flushDraftPersist(room), delay)
    // -> This timer alone must never be the reason the process stays alive
    state.timer.unref?.()
  },

  /**
   * Persist a room's current Yjs state right now, cancelling whatever debounce timer was still
   * pending — called by that timer firing on its own (result ignored — nothing there can usefully
   * wait on a database round trip, the same reasoning {@link publish} documents for the relay), by
   * {@link closeRoomIfEmpty} flushing one last time before the doc it reads is destroyed, and by
   * {@link shutdown}, which — unlike the other two — does await the returned promise, since it is the
   * one caller that genuinely needs the write to land before the process actually exits.
   *
   * A failure here means the next crash/tab-close on this page recovers a slightly older draft, not
   * that anything currently connected breaks.
   *
   * Carries {@link CollabRoom.lastAuthorName} along with the state on every flush (OpenProject #2455)
   * -- best-effort attribution of whoever was last known to be editing, for the recovery-restore
   * prompt to credit. Not resolved to a real `authorId`: nothing here has one to attach, only the
   * display name a departing connection's awareness state carried.
   */
  flushDraftPersist(room: CollabRoom): Promise<void> {
    if (room.draftPersist.timer) {
      clearTimeout(room.draftPersist.timer)
    }
    room.draftPersist.timer = null
    room.draftPersist.pendingSince = null
    return WIKI.models.pageDrafts
      .save(room.pageId, room.siteId, Y.encodeStateAsUpdate(room.doc), null, room.lastAuthorName)
      .catch((err: any) => {
        WIKI.logger.warn(
          `Failed to persist an autosave draft for page ${room.pageId}: ${err.message}`
        )
      })
  },

  /**
   * Tell everyone editing a page that it has just been saved.
   *
   * Written into the document rather than sent as a message of its own, so that it reaches the other
   * instances the way an edit does and a client joining a moment later sees the same thing. Nothing
   * about the text changes — this only tells the other editors that what they are looking at is now
   * what is stored, and their Save button can go quiet.
   *
   * The save does not necessarily land on an instance that has the room, so an instance without one
   * passes the news along instead.
   *
   * Also clears the page's persisted draft, regardless of whether this instance has the room open:
   * whatever was recoverable before is now superseded by a real, committed save, and a draft
   * surviving past this point would offer to restore content a save has already overtaken. The row
   * lives in postgres, not in memory, so whichever instance's `PATCH` handler called this is the one
   * that gets to clear it, room or no room.
   */
  pageSaved(pageId: string, info: SaveInfo): void {
    const room = this.rooms.get(pageId)
    if (room) {
      room.doc.getMap('meta').set('lastSave', info)
    } else {
      this.relay({ r: pageId, t: 'saved', p: JSON.stringify(info) })
    }
    WIKI.models.pageDrafts.clear(pageId).catch((err: any) => {
      WIKI.logger.warn(`Failed to clear the draft for page ${pageId}: ${err.message}`)
    })
  },

  // ----------------------------------------
  // Relay
  // ----------------------------------------

  /** Publish a message to the other instances, split into chunks postgres will accept. */
  relay(message: Omit<RelayEnvelope, 'i'>): void {
    if (!this.listenClient) {
      return
    }
    const envelope: RelayEnvelope = { ...message, i: WIKI.INSTANCE_ID }
    const payload = envelope.p
    if (!payload || payload.length <= RELAY_CHUNK_SIZE) {
      this.publish(envelope)
      return
    }
    const count = Math.ceil(payload.length / RELAY_CHUNK_SIZE)
    const messageId = `${this.relaySeq++}`
    for (let index = 0; index < count; index++) {
      this.publish({
        ...envelope,
        p: payload.slice(index * RELAY_CHUNK_SIZE, (index + 1) * RELAY_CHUNK_SIZE),
        m: messageId,
        c: index,
        n: count
      })
    }
  },

  /**
   * Send one envelope to the other instances, behind whatever is already going out.
   *
   * Never awaited — every caller is a Yjs handler reacting to an edit or a cursor moving, and a
   * keystroke cannot wait for a round trip to postgres. `helpers/pubsub.ts` is what makes that safe on
   * a single client, which a burst of updates or one chunked message would otherwise breach.
   */
  publish(envelope: RelayEnvelope): void {
    notifier.send(NOTIFY_CHANNEL, JSON.stringify(envelope))
  },

  receiveRelay(envelope: RelayEnvelope): void {
    if (envelope.i === WIKI.INSTANCE_ID) {
      return
    }
    if (envelope.to && envelope.to !== WIKI.INSTANCE_ID) {
      return
    }
    if (envelope.m !== undefined && envelope.n !== undefined) {
      const assembled = this.reassemble(envelope)
      if (assembled === null) {
        return
      }
      envelope.p = assembled
    }
    switch (envelope.t) {
      case 'hello': {
        // -> Somewhere else is opening this page and has nothing yet. Only a room that is past its own
        //    setup is worth answering with; one still filling itself would hand over an empty document.
        const room = this.rooms.get(envelope.r)
        if (!room || room.provisional) {
          return
        }
        this.relay({
          r: envelope.r,
          t: 'state',
          to: envelope.i,
          p: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64')
        })
        break
      }
      case 'state': {
        const waiting = this.awaitingState.get(envelope.r)
        if (waiting) {
          waiting(Buffer.from(envelope.p ?? '', 'base64'))
          break
        }
        /*
          Too late for peerState() to hand it to — that call already timed out and this instance's room,
          if it opened one, seeded itself from the stored page instead. That is not the end of the
          story: the peer's state can still be merged straight into the room, and doing so is safe
          rather than the duplication a naive merge of two independent seeds would risk, precisely
          because of the client-id-0 trick described at the top of this file — this instance's own
          buildSeed() output and the seed folded into the peer's state are byte-identical, so Y.applyUpdate
          treats that part as already-known and only the peer's genuinely new operations (edits this
          instance never saw while the handshake was still in flight) land. Skipped when there is no
          room to catch up: either this instance never opened one, or it already closed again, and
          either way there is nothing here for the update to join.
        */
        const room = this.rooms.get(envelope.r)
        if (room && envelope.p) {
          Y.applyUpdate(room.doc, Buffer.from(envelope.p, 'base64'), RELAYED)
        }
        break
      }
      case 'update': {
        const room = this.rooms.get(envelope.r)
        if (room) {
          Y.applyUpdate(room.doc, Buffer.from(envelope.p ?? '', 'base64'), RELAYED)
        }
        break
      }
      case 'awareness': {
        const room = this.rooms.get(envelope.r)
        if (room) {
          awarenessProtocol.applyAwarenessUpdate(
            room.awareness,
            Buffer.from(envelope.p ?? '', 'base64'),
            RELAYED
          )
        }
        break
      }
      case 'saved': {
        const room = this.rooms.get(envelope.r)
        if (room && envelope.p) {
          room.doc.getMap('meta').set('lastSave', JSON.parse(envelope.p) as SaveInfo)
        }
        break
      }
      case 'wysiwyg-claim': {
        // -> Someone elsewhere is asking whether this room's WYSIWYG seed is already spoken for.
        //    Only worth answering when it genuinely is -- silence, like `hello`'s own "no room, or
        //    still provisional" case, means "as far as I know, go ahead."
        const room = this.rooms.get(envelope.r)
        if (room?.wysiwygSeeded) {
          this.relay({ r: envelope.r, t: 'wysiwyg-claimed', to: envelope.i })
        }
        break
      }
      case 'wysiwyg-claimed': {
        /*
          Either a direct reply to this instance's own `claimWysiwygSeed` ask, or another instance
          proactively confirming a grant it just made -- either way, mark the room seeded so a future
          ask (ours or a third instance's `wysiwyg-claim`) is answered locally from here on, with no
          further round trip needed.
        */
        const room = this.rooms.get(envelope.r)
        if (room) {
          room.wysiwygSeeded = true
        }
        this.awaitingWysiwygClaim.get(envelope.r)?.()
        break
      }
    }
  },

  /** Collect a chunked message, returning the whole payload once the last chunk lands. */
  reassemble(envelope: RelayEnvelope): string | null {
    const key = `${envelope.i}:${envelope.m}`
    let partial = this.partials.get(key)
    if (!partial) {
      partial = {
        parts: Array.from({ length: envelope.n! }),
        remaining: envelope.n!,
        timer: setTimeout(() => {
          // -> An instance that died mid-message would otherwise leave its chunks here for good
          this.partials.delete(key)
        }, RELAY_REASSEMBLY_TIMEOUT)
      }
      this.partials.set(key, partial)
    }
    if (partial.parts[envelope.c!] !== undefined) {
      return null
    }
    partial.parts[envelope.c!] = envelope.p ?? ''
    partial.remaining--
    if (partial.remaining > 0) {
      return null
    }
    clearTimeout(partial.timer)
    this.partials.delete(key)
    return partial.parts.join('')
  },

  send(conn: WebSocket, message: Uint8Array): void {
    if (conn.readyState !== conn.OPEN) {
      return
    }
    try {
      conn.send(message)
    } catch {
      conn.close()
    }
  }
}
