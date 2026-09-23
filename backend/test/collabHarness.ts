import { EventEmitter } from 'node:events'
import { after, afterEach, beforeEach, mock } from 'node:test'
import collab from '../core/collab.ts'
import { installTestWiki } from './mocks.ts'

/**
 * Shared collab test scaffolding. Deliberately NOT in `test/collabWorker.ts`, the other
 * collab-shaped file under `test/`: that one is a worker-thread ENTRY POINT — it destructures
 * `workerData` and calls `boot()` at import time — so importing from it would boot a second collab
 * instance in this thread.
 */

/**
 * Enough of `ws`'s `WebSocket` for the code under test: a real `EventEmitter`, so production
 * listeners work unmodified, plus recorded `close()`/`terminate()` calls to tell the two apart.
 */
export class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 1
  closeCalls: { code: number; reason: string }[] = []
  terminated = false

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = this.CLOSING
  }

  terminate(): void {
    this.terminated = true
    this.readyState = this.CLOSED
    this.emit('close')
  }
}

/**
 * A standalone clone of the `collab` singleton: "two instances" are two clones with the same
 * methods and independent state, not two processes. Relay and room bookkeeping have no SQL in them,
 * so a real two-process harness would re-prove the same logic slower and flakier.
 */

export function makeInstance(id: string): any {
  return {
    ...collab,
    __id: id,
    rooms: new Map(),
    partials: new Map(),
    awaitingState: new Map(),
    awaitingWysiwygClaim: new Map(),
    // -> Fresh per instance: `{ ...collab }` copies only the *reference* to the singleton's maps,
    //    and sharing them would let one test's connection-cap bookkeeping bleed into another's.
    userConnections: new Map(),
    addressConnections: new Map(),
    listenClient: {},
    relaySeq: 0,
    peerPresence: { known: false, checkedAt: 0 },
    peerCheck: null,
    peerGated: []
  }
}

/**
 * `CARDINAL.INSTANCE_ID` is toggled to whichever side is "currently running" for the length of each
 * synchronous hop, so the receiving clone sees what a NOTIFY delivery from a second process would.
 */
export function wire(a: any, b: any): void {
  const byId: Record<string, any> = { [a.__id]: a, [b.__id]: b }
  for (const inst of [a, b]) {
    inst.publish = (envelope: any) => {
      for (const target of Object.values(byId)) {
        if (target.__id === envelope.i) {
          continue
        }
        const previous = (globalThis as any).CARDINAL.INSTANCE_ID
        ;(globalThis as any).CARDINAL.INSTANCE_ID = target.__id
        try {
          target.receiveRelay(envelope)
        } finally {
          ;(globalThis as any).CARDINAL.INSTANCE_ID = previous
        }
      }
    }
  }
}

export const STORED_PAGE = {
  content: 'STORED PAGE CONTENT',
  title: 'Stored title',
  description: 'Stored description',
  icon: 'stored-icon'
}

export interface CollabHarness {
  /** Opens a room and registers it for teardown. */
  openRoom(inst: any, page: { id: string; siteId: string }): Promise<any>
  /** Registers a room a test opened by other means, so the same teardown applies. */
  trackRoom(room: any): void
  getPage(): any
  pageDrafts(): { get: any; save: any; clear: any }
}

/**
 * Call once at the top level of a suite file: the hooks it registers are root hooks, so they apply
 * to every test in that file.
 */
export function installCollabHarness(): CollabHarness {
  let wikiHandle: { restore(): void }
  let getPageMock: any
  let pageDraftsMocks: { get: any; save: any; clear: any }
  /**
   * `awarenessProtocol.Awareness` starts a real `setInterval` to expire stale states, and only a
   * room emptying out clears it. Every tracked room is torn down the way `closeRoomIfEmpty` does in
   * production, or that interval outlives the test and the process never exits.
   */
  let createdRooms: any[] = []

  beforeEach(() => {
    getPageMock = mock.fn(async () => ({ ...STORED_PAGE }))
    // -> `initRoom()` never reads `get` — a persisted draft is never a room-seeding source — but
    //    the debounced-persist/pageSaved/discardDraft paths do exercise `save`/`clear`.
    pageDraftsMocks = {
      get: mock.fn(async () => undefined),
      save: mock.fn(async () => {}),
      clear: mock.fn(async () => {})
    }
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'unset',
      models: {
        pages: { getPage: getPageMock },
        pageDrafts: pageDraftsMocks
      }
    })
    // -> Preset for a suite that opens rooms on the real singleton: it keeps `hasPeers()` on its
    //    cache instead of querying the stub's absent `CARDINAL.db` and then waiting out
    //    `PEER_STATE_TIMEOUT` for every room.
    collab.peerPresence = { known: false, checkedAt: Date.now() }
    createdRooms = []
  })

  afterEach(() => {
    for (const room of createdRooms) {
      clearTimeout(room.relayOutbox?.updateTimer)
      clearTimeout(room.relayOutbox?.awarenessTimer)
      room.awareness.destroy()
      room.doc.destroy()
    }
  })

  after(() => {
    wikiHandle.restore()
  })

  return {
    async openRoom(inst, page) {
      const room = await inst.ensureRoom(page)
      createdRooms.push(room)
      return room
    },
    trackRoom(room) {
      createdRooms.push(room)
    },
    getPage: () => getPageMock,
    pageDrafts: () => pageDraftsMocks
  }
}
