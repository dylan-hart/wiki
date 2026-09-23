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
 * A room is one page being edited by several people at once: a Yjs document — the markdown source
 * as a `Y.Text`, the header fields as a `Y.Map` — plus the awareness state carrying cursors and
 * identities. The message framing is byte-compatible with `y-websocket`, because the browser side
 * is that library, unmodified.
 *
 * **A room is not page storage.** Nothing here is written back to `pages` — saving stays an
 * explicit `PATCH /pages/:id`. The room goes away with its last participant
 * ({@link closeRoomIfEmpty}).
 *
 * ## Autosave draft
 *
 * Live state is debounce-persisted to {@link CARDINAL.models.pageDrafts} as a recovery copy, for
 * when every participant leaves with nothing saved. A room is never seeded from it
 * ({@link initRoom}): the frontend fetches the draft and applies it only once the reader confirms.
 * {@link pageSaved} clears it.
 *
 * ## Across instances
 *
 * Rooms live in memory, so updates are relayed over postgres LISTEN/NOTIFY, on a channel separate
 * from the event bus's: these messages are frequent, binary, and worthless a second later. One too
 * large for a NOTIFY payload is base64'd and chunked ({@link relay}).
 *
 * ## Where a room's starting state comes from
 *
 * A Yjs document cannot be seeded twice: two instances each inserting the page's text produce
 * *different* operations, and merging them leaves the document holding the page twice. So a new
 * room asks the cluster first ({@link peerState}) and falls back to the stored page only when
 * nobody answers.
 *
 * Two instances cold-starting the same room at once would both fall back, so the seed is
 * *deterministic*: built in a scratch document pinned to client id 0, identical text yields
 * byte-identical operations, which merge as one. That is also what lets a reconnecting client push
 * back edits made while it was away, and what makes a late `state` reply safe to merge into an
 * already-seeded room ({@link receiveRelay}).
 */

/** y-websocket message types. The values are that protocol's, not ours. */
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const NOTIFY_CHANNEL = 'wiki_collab'

/**
 * Base64 characters per NOTIFY payload. Postgres refuses a payload over 8000 bytes, which leaves
 * ample slack for the JSON envelope around a chunk; `core/collab.relay.test.ts` pins the worst
 * case, so a field added to {@link RelayEnvelope} cannot quietly erode it.
 */
export const RELAY_CHUNK_SIZE = 5000

export const RELAY_REASSEMBLY_TIMEOUT = 10 * 1000

/**
 * How long a new room waits for a peer's state before seeding itself from the stored page. Paid on
 * every cold room-open while another instance is running, so it stays short even though a
 * multi-megabyte document's reply can miss it: a late reply is still merged ({@link receiveRelay}'s
 * `state` case), leaving such a room momentarily behind rather than wrong.
 */
export const PEER_STATE_TIMEOUT = 500

const PEER_PRESENCE_TTL = 15 * 1000

/**
 * How long edits must settle before a room's state is persisted as the autosave draft. Short enough
 * that an ordinary pause in typing flushes, since a crash can land at any moment.
 */
export const DRAFT_PERSIST_DEBOUNCE = 4 * 1000

/** Cap on how long continuous typing may keep pushing the debounce back before a persist anyway. */
export const DRAFT_PERSIST_MAX_DELAY = 20 * 1000

/**
 * Ceilings on concurrent collaboration sockets. Nothing else bounds how many `Y.Doc` rooms one
 * account or address can pin in memory: `/_collab` sits outside `/_api/`, so the rate limiters
 * never see this traffic. Deliberately small — the goal is bounding the resource, not modelling
 * real usage.
 */
export const MAX_CONNECTIONS_PER_USER = 8
export const MAX_CONNECTIONS_PER_ADDRESS = 32

/** An idle websocket is what a reverse proxy cuts first. */
const PING_INTERVAL = 30 * 1000

/**
 * Ceilings on `session.pending` — see {@link capture} — by entry count and by total bytes. A real
 * y-websocket handshake is one small sync frame; a socket that sends more than this before a room
 * is attached is terminated rather than buffered further.
 */
export const MAX_PENDING_FRAMES = 16
export const MAX_PENDING_BYTES = 64 * 1024

/**
 * How long a refused socket gets to complete the closing handshake before it is cut off. `ws`'s own
 * 30s default is sized for a cooperating peer, but a refusal can precede authentication, and
 * `capture`'s listener stays attached for the whole window. A real client needs one round trip.
 */
export const REFUSAL_GRACE_PERIOD = 2 * 1000

/** Origin marking a change that arrived over the relay, so applying it does not send it back. */
const RELAYED = Symbol('collabRelayed')

export interface ConnIdentity {
  userId: string
  address: string
}

interface CollabConn {
  /** Awareness client ids this socket is responsible for, so a disconnect can retract exactly those. */
  clients: Set<number>
  alive: boolean
  /** Whose connection-cap slot this socket holds. */
  identity: ConnIdentity
}

interface CollabSession {
  /** Null until {@link join} attaches one. */
  room: CollabRoom | null
  /** Frames that arrived before there was a room to hand them to. Capped — see {@link capture}. */
  pending: Uint8Array[]
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
  draftPersist: DraftPersistState
  /**
   * Best-effort attribution for the next persisted draft: the name read off a departing
   * connection's awareness state in {@link onClose}, since nothing else here tracks who typed what
   * and the debounce timer fires well after the connection that triggered it. Null until one
   * carried a name.
   */
  lastAuthorName: string | null
  /**
   * Whether the right to seed this room's WYSIWYG (TipTap) field has been granted, or is being
   * asked for -- see {@link claimWysiwygSeed}. Stays `false` for a room whose peer state already
   * carries WYSIWYG content: a client only asks while its own fragment is empty.
   */
  wysiwygSeeded: boolean
}

interface DraftPersistState {
  timer: NodeJS.Timeout | null
  /** When the current burst's first unpersisted edit landed, for the max-delay cap. */
  pendingSince: number | null
  /**
   * The in-flight {@link flushDraftPersist} write, so {@link cancelPendingDraftPersist}'s callers
   * can order their `pageDrafts.clear()` after it rather than racing it.
   */
  inFlight: Promise<void> | null
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
 * A websocket frame as bytes, whatever shape `ws` handed it over in. A single `Buffer` is a view
 * into a larger pool, so its offset and length matter — and the result is a view over that same
 * memory, safe to read only during the event that delivered it; anything held on to has to be
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
 * The state a room starts from when it has to build one itself, as a Yjs update. Built in a scratch
 * document whose client id is pinned to 0, so that the bytes depend on nothing but the page — see
 * the note at the top of this file on why that matters.
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

const notifier = createNotifier(() => CARDINAL.collab.listenClient, 'collaboration relay')

/**
 * Cancels a room's pending draft-persist timer and resolves once any flush already in flight has
 * settled. Callers clear the persisted draft only after that, so a write started earlier cannot
 * land after their `pageDrafts.clear()` and resurrect the draft it just removed.
 */
function cancelPendingDraftPersist(room: CollabRoom): Promise<void> {
  if (room.draftPersist.timer) {
    clearTimeout(room.draftPersist.timer)
  }
  room.draftPersist.timer = null
  room.draftPersist.pendingSince = null
  return room.draftPersist.inFlight ?? Promise.resolve()
}

export default {
  rooms: new Map<string, CollabRoom>(),
  listenClient: null as PoolClient | null,
  listenerHandle: null as ListenerHandle | null,
  /** Chunked relay messages still waiting for the rest of themselves, keyed by sender and message id. */
  partials: new Map<string, PartialRelay>(),
  /** Rooms this instance is waiting on a peer's state for, by page id. */
  awaitingState: new Map<string, (update: Uint8Array) => void>(),
  /**
   * The same for a peer's answer to {@link claimWysiwygSeed}. Separate from {@link awaitingState}
   * so the two questions, asked of the same room at different times, never resolve each other's
   * waiters.
   */
  awaitingWysiwygClaim: new Map<string, () => void>(),
  userConnections: new Map<string, number>(),
  addressConnections: new Map<string, number>(),
  relaySeq: 0,
  peerPresence: { known: false, checkedAt: 0 },
  peerCheck: null as Promise<boolean> | null,
  peerGated: [] as Omit<RelayEnvelope, 'i'>[],
  pingTimer: null as NodeJS.Timeout | null,

  /**
   * Opens the relay connection: a client of its own rather than the event bus's, so that a slow
   * consumer on one channel does not hold up the other.
   */
  async init(): Promise<void> {
    this.listenerHandle = await connectListener({
      pool: CARDINAL.dbManager.listenerPool!,
      applicationName: `Cardinal.js - ${CARDINAL.INSTANCE_ID}:COLLAB`,
      channels: [NOTIFY_CHANNEL],
      label: 'collaboration relay',
      onNotification: (msg) => {
        if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) {
          return
        }
        try {
          this.receiveRelay(JSON.parse(msg.payload) as RelayEnvelope)
        } catch (err: any) {
          CARDINAL.logger.warn('collab', 'malformed relay message', { error: err })
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

    CARDINAL.logger.debug('collab', 'collaborative editing initialized')
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
      // -> As in `closeRoomIfEmpty`: a graceful shutdown is not a saved page either. Awaited below,
      //    unlike every other `flushDraftPersist` call, because the process is about to exit.
      if (room.draftPersist.timer) {
        pendingDraftFlushes.push(this.flushDraftPersist(room))
      }
      room.awareness.destroy()
      room.doc.destroy()
    }
    this.rooms.clear()
    await Promise.all(pendingDraftFlushes)
    if (this.peerCheck) {
      await this.peerCheck
    }
    if (this.listenerHandle) {
      // -> Whatever is still on its way out goes out first: releasing the client from under a
      //    notification in flight would fail that one for no reason
      await notifier.drained()
      await this.listenerHandle.close()
      this.listenerHandle = null
    }
  },

  /**
   * Whether another instance is currently running, asked so that the single-instance case — very
   * much the common one — does not spend {@link PEER_STATE_TIMEOUT} waiting for an answer that
   * cannot come. Instances are not registered anywhere: their relay connections name themselves in
   * `pg_stat_activity`.
   */
  async hasPeers(): Promise<boolean> {
    if (Date.now() - this.peerPresence.checkedAt < PEER_PRESENCE_TTL) {
      return this.peerPresence.known
    }
    return this.refreshPeers()
  },

  refreshPeers(): Promise<boolean> {
    this.peerCheck ??= this.checkPeers().finally(() => {
      this.peerCheck = null
    })
    return this.peerCheck
  },

  async checkPeers(): Promise<boolean> {
    const now = Date.now()
    const ownName = `Cardinal.js - ${CARDINAL.INSTANCE_ID}:COLLAB`
    try {
      const result = await CARDINAL.db.execute(
        sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND application_name LIKE 'Cardinal.js - %:COLLAB'
              AND application_name <> ${ownName} LIMIT 1`
      )
      if (!this.peerPresenceProvenSince(now)) {
        this.peerPresence = { known: result.rows.length > 0, checkedAt: Date.now() }
      }
    } catch (err: any) {
      // -> Assume company: a wasted timeout is a far smaller mistake than duplicating a page's text
      CARDINAL.logger.warn('collab', 'could not determine whether peer instances are running', {
        error: err
      })
      this.peerPresence = { known: true, checkedAt: Date.now() }
    }
    this.flushPeerGated()
    return this.peerPresence.known
  },

  peerPresenceProvenSince(since: number): boolean {
    return this.peerPresence.known && this.peerPresence.checkedAt >= since
  },

  flushPeerGated(): void {
    const held = this.peerGated
    this.peerGated = []
    if (!this.peerPresence.known) {
      return
    }
    for (const message of held) {
      this.relay(message)
    }
  },

  mayRelayToPeers(message: Omit<RelayEnvelope, 'i'>): boolean {
    const fresh = Date.now() - this.peerPresence.checkedAt < PEER_PRESENCE_TTL
    if (fresh && this.peerGated.length === 0) {
      return this.peerPresence.known
    }
    this.peerGated.push(message)
    void this.refreshPeers()
    return false
  },

  /**
   * Start listening to a socket before anything is known about it — synchronously, the instant it
   * opens. y-websocket sends its first sync message immediately, while the route is still asking
   * the database whether this user may edit this page, and never sends it twice: miss it and the
   * client sits there holding an empty document. So the frames are collected here and replayed by
   * {@link join}.
   *
   * `pending` is capped ({@link MAX_PENDING_FRAMES}, {@link MAX_PENDING_BYTES}) because this
   * listener is live before either the session or the site's feature flag has been checked.
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
        // -> `terminate()`, not `close()`: a socket that has already sent more than a real
        //    handshake ever does gets no closing-handshake grace period either
        CARDINAL.logger.warn(
          'collab',
          'socket exceeded the pre-auth frame buffer cap, terminated',
          {
            bytes: session.pendingBytes + bytes.byteLength
          }
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
      CARDINAL.logger.debug('collab', 'socket error', { error: err })
    })
    return session
  },

  /**
   * Refuse a socket before it ever joins a room. The close frame is what lets the editor's
   * y-websocket provider tell "you are not allowed" apart from an ordinary drop and back off rather
   * than reconnect; the socket is then cut off outright once {@link REFUSAL_GRACE_PERIOD} has
   * passed rather than left in `CLOSING` for `ws`'s own far longer default.
   */
  refuse(conn: WebSocket, code: number, reason: string): void {
    conn.close(code, reason)
    const timer = setTimeout(() => {
      if (conn.readyState !== conn.CLOSED) {
        conn.terminate()
      }
    }, REFUSAL_GRACE_PERIOD)
    timer.unref?.()
  },

  /**
   * Who else has this page open, on this instance, right now — read straight off whatever room
   * already exists, with no query. Deliberately a same-instance approximation: rooms are never
   * listed across the relay. That is an acceptable gap for a hint shown before anyone has joined; a
   * started session gets the real cross-instance participant list from `awareness`.
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
   * The caller (`controllers/collab.ts`) has already decided that this user may edit this page;
   * nothing below re-checks it.
   *
   * The connection-cap slot is reserved *before* {@link ensureRoom} runs, so a refusal never
   * allocates a room. It is released by {@link onClose} once the socket is registered in a room's
   * `conns`, or right here if the socket went away before that happened.
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
   * Concurrent joiners share one room *and one initialization*: the room goes into the map before
   * it has any state, and `ready` is what everything else waits on.
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
      draftPersist: { timer: null, pendingSince: null, inFlight: null },
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
        // -> The seed and a peer's state apply as `RELAYED` too, so only a local edit gets here
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
   * Fill a newly created room with the state it should start from: a peer's copy if the cluster
   * already has this page open, else the stored page. Deliberately never the persisted autosave
   * draft — seeding from it would leave the frontend nothing to diff the draft against, and would
   * make "Discard" silently do nothing, the draft already being live.
   */
  async initRoom(room: CollabRoom): Promise<void> {
    try {
      const fromPeer = (await this.hasPeers()) ? await this.peerState(room.pageId) : null
      if (fromPeer) {
        Y.applyUpdate(room.doc, fromPeer, RELAYED)
      } else {
        const page = await CARDINAL.models.pages.getPage({
          siteId: room.siteId,
          id: room.pageId,
          withContent: true
        })
        // -> A page that went away between the permission check and here leaves an empty room,
        //    which the first disconnect clears away again
        Y.applyUpdate(room.doc, buildSeed(page ?? {}), RELAYED)
      }
    } catch (err: any) {
      CARDINAL.logger.warn('collab', 'failed to initialize room', { page: room.pageId, error: err })
    } finally {
      room.provisional = false
      this.awaitingState.delete(room.pageId)
    }
  },

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
   * Grants at most one caller the right to seed a room's WYSIWYG (TipTap) field. The shared
   * `Y.XmlFragment` TipTap binds to has no server-side seed of its own ({@link buildSeed} never
   * touches it), so two people opening a brand new room's WYSIWYG editor at the same instant could
   * otherwise both seed it from their own copy of the page and duplicate its content. Deliberately
   * schema-agnostic: only a boolean ever crosses this method, never the ProseMirror JSON.
   *
   * Same-instance callers are decided exactly. Cross-instance, this asks the cluster and grants
   * locally if nobody answers within {@link PEER_STATE_TIMEOUT}; two instances asking inside that
   * window each answer the other "already claimed", so both come back denied and the fragment is
   * left briefly unseeded rather than duplicated. An airtight guarantee would need
   * {@link buildSeed}'s byte-identical-seed trick, which a client's ProseMirror JSON cannot use.
   */
  async claimWysiwygSeed(pageId: string): Promise<boolean> {
    const room = this.rooms.get(pageId)
    if (!room || room.wysiwygSeeded) {
      return false
    }
    // -> Set before any `await`, so a second same-instance call is refused above
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
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
          if (encoding.length(encoder) > 1) {
            this.send(conn, encoding.toUint8Array(encoder))
          }
          break
        }
        case MESSAGE_AWARENESS: {
          // -> The socket is the origin, which is how `ensureRoom`'s awareness handler knows whose
          //    cursors an update carries
          awarenessProtocol.applyAwarenessUpdate(
            room.awareness,
            decoding.readVarUint8Array(decoder),
            conn
          )
          break
        }
      }
    } catch (err: any) {
      CARDINAL.logger.warn('collab', 'failed to handle a message', {
        page: room.pageId,
        error: err
      })
    }
  },

  onClose(room: CollabRoom, conn: WebSocket): void {
    const state = room.conns.get(conn)
    room.conns.delete(conn)
    if (state) {
      // -> `ws` delivers `terminate()` as a `close` event exactly like a graceful close, so this
      //    one site covers both paths
      this.releaseSlot(state.identity)
      if (state.clients.size > 0) {
        // -> Read before the states are retracted below, and left as it was when no name is found
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

  /** Both counts are checked before either is incremented, so a refusal never half-reserves. */
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
   * Drop a room nobody on this instance is in — immediately, with no grace period: a room outliving
   * its last participant would quietly resurrect its unsaved text on the next visit. Any edit still
   * waiting on the autosave debounce is flushed first, since "closed without saving" is exactly the
   * case the draft exists to make recoverable.
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
   * Debounced ({@link DRAFT_PERSIST_DEBOUNCE}, capped at {@link DRAFT_PERSIST_MAX_DELAY}) so a
   * burst of keystrokes persists once. Only for locally-originated updates: a relayed one is
   * persisted wherever it originated.
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
    state.timer.unref?.()
  },

  /**
   * Only {@link shutdown} awaits the result. A failure means the next recovery sees a slightly
   * older draft, not that anything currently connected breaks.
   *
   * No `authorId` is passed: nothing here has one to attach, only the display name a departing
   * connection's awareness state carried ({@link CollabRoom.lastAuthorName}).
   */
  flushDraftPersist(room: CollabRoom): Promise<void> {
    if (room.draftPersist.timer) {
      clearTimeout(room.draftPersist.timer)
    }
    room.draftPersist.timer = null
    room.draftPersist.pendingSince = null
    const persisting: Promise<void> = CARDINAL.models.pageDrafts
      .save(room.pageId, room.siteId, Y.encodeStateAsUpdate(room.doc), null, room.lastAuthorName)
      .catch((err: any) => {
        CARDINAL.logger.warn('collab', 'failed to persist an autosave draft', {
          page: room.pageId,
          error: err
        })
      })
      .finally(() => {
        // -> A later flush may have started before this one settled; its promise is not this
        //    one's to clear
        if (room.draftPersist.inFlight === persisting) {
          room.draftPersist.inFlight = null
        }
      })
    room.draftPersist.inFlight = persisting
    return persisting
  },

  /**
   * Tell everyone editing a page that it has just been saved. Written into the document rather than
   * sent as a message of its own, so that it reaches the other instances the way an edit does and a
   * client joining a moment later sees the same thing. The save does not necessarily land on an
   * instance that has the room, so an instance without one passes the news along instead.
   *
   * Also clears the page's persisted draft, room or no room: the row lives in postgres, and a draft
   * surviving a committed save would offer to restore content that save has already overtaken. The
   * clear is ordered after any in-flight draft write ({@link cancelPendingDraftPersist}) inside
   * this promise chain, so the caller stays fire-and-forget.
   */
  pageSaved(pageId: string, info: SaveInfo): void {
    const room = this.rooms.get(pageId)
    let clearAfter: Promise<void> = Promise.resolve()
    if (room) {
      room.doc.getMap('meta').set('lastSave', info)
      clearAfter = cancelPendingDraftPersist(room)
    } else {
      this.relay({ r: pageId, t: 'saved', p: JSON.stringify(info) })
    }
    clearAfter
      .then(() => CARDINAL.models.pageDrafts.clear(pageId))
      .catch((err: any) => {
        CARDINAL.logger.warn('collab', 'failed to clear the draft', { page: pageId, error: err })
      })
  },

  /**
   * Discards a page's persisted recovery draft. Through {@link cancelPendingDraftPersist}: a
   * debounced autosave still pending at the moment of an explicit Cancel would otherwise flush when
   * the editor's own disconnect empties the room ({@link closeRoomIfEmpty}), silently resurrecting
   * the very draft the reader just asked to drop.
   */
  discardDraft(pageId: string): Promise<void> {
    const room = this.rooms.get(pageId)
    const clearAfter = room ? cancelPendingDraftPersist(room) : Promise.resolve()
    return clearAfter.then(() => CARDINAL.models.pageDrafts.clear(pageId))
  },

  /** Publish a message to the other instances, split into chunks postgres will accept. */
  relay(message: Omit<RelayEnvelope, 'i'>): void {
    if (!this.listenClient) {
      return
    }
    if ((message.t === 'update' || message.t === 'awareness') && !this.mayRelayToPeers(message)) {
      return
    }
    const envelope: RelayEnvelope = { ...message, i: CARDINAL.INSTANCE_ID }
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
   * Never awaited — every caller is a Yjs handler reacting to an edit or a cursor moving, and a
   * keystroke cannot wait for a round trip to postgres. The notifier (`helpers/pubsub.ts`) queues
   * sends, which is what makes that safe on a single client.
   */
  publish(envelope: RelayEnvelope): void {
    notifier.send(NOTIFY_CHANNEL, JSON.stringify(envelope))
  },

  receiveRelay(envelope: RelayEnvelope): void {
    if (envelope.i === CARDINAL.INSTANCE_ID) {
      return
    }
    this.peerPresence = { known: true, checkedAt: Date.now() }
    if (envelope.to && envelope.to !== CARDINAL.INSTANCE_ID) {
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
        // -> Only a room that is past its own setup is worth answering with; one still filling
        //    itself would hand over an empty document
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
          Too late for peerState() — that call timed out and this instance's room seeded itself from
          the stored page instead. Merging is still safe because of the client-id-0 trick described
          at the top of this file: this instance's own buildSeed() output and the seed folded into
          the peer's state are byte-identical, so only the peer's genuinely new operations land.
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
        // -> Answered only when the seed is already spoken for -- silence, as with `hello`, means
        //    "as far as I know, go ahead"
        const room = this.rooms.get(envelope.r)
        if (room?.wysiwygSeeded) {
          this.relay({ r: envelope.r, t: 'wysiwyg-claimed', to: envelope.i })
        }
        break
      }
      case 'wysiwyg-claimed': {
        // -> The reply to this instance's own `claimWysiwygSeed` ask
        const room = this.rooms.get(envelope.r)
        if (room) {
          room.wysiwygSeeded = true
        }
        this.awaitingWysiwygClaim.get(envelope.r)?.()
        break
      }
    }
  },

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
