import { EventEmitter } from 'node:events'
import { after, afterEach, beforeEach, mock } from 'node:test'
import collab from '../core/collab.ts'
import { installTestWiki } from './mocks.ts'

/**
 * What more than one `core/collab.*.test.ts` needs to stand a collab instance up (TEST-F14).
 *
 * The four suites `core/collab.test.ts` was split into share two things: a socket stand-in, and the
 * "two instances without two processes" technique below. Neither belongs to any one of them, and a
 * copy per file is exactly the drift this consolidation exists to remove.
 *
 * Deliberately NOT in `test/collabWorker.ts`, the other collab-shaped file under `test/`: that one is
 * a worker-thread ENTRY POINT — it destructures `workerData` and calls `boot()` at import time — so a
 * test file importing from it would try to boot a second collab instance in the main thread.
 */

/**
 * A minimal stand-in for `ws`'s `WebSocket`, just enough of its surface for `capture()` and
 * `refuse()`: `on`/`emit` (real, via `EventEmitter`, so `capture`'s own listeners work unmodified),
 * the three `readyState` constants and the field they set, and `close()`/`terminate()` recorded so a
 * test can assert which one a given path called.
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
 * A standalone clone of the `collab` singleton, for a test that needs two "instances" of it.
 *
 * No database and no second `node backend` process: `hasPeers()`'s one query is bypassed by presetting
 * its cache, and "two instances" are two independent clones of the exported object (same methods,
 * independent `rooms`/`partials`/`awaitingState`) wired together by overriding `publish` to hand the
 * envelope straight to the other clone's `receiveRelay` — toggling the module-global `WIKI.INSTANCE_ID`
 * around each hop exactly as two real processes would each carry their own id. This is relay/room
 * bookkeeping with no SQL in it, so a real two-process harness (as built for task 704's scheduler work)
 * would mostly be re-proving the same logic slower and flakier, per CLAUDE.md's guidance to prefer a
 * unit test wherever a mock would not just be re-describing SQL.
 */

export function makeInstance(id: string): any {
  return {
    ...collab,
    __id: id,
    rooms: new Map(),
    partials: new Map(),
    awaitingState: new Map(),
    // -> Fresh per instance, like every other mutable collection above: `{ ...collab }` only copies
    //    the *reference* to the real singleton's maps, and sharing them across "instances" would let
    //    one test's connection-cap bookkeeping bleed into another's.
    userConnections: new Map(),
    addressConnections: new Map(),
    listenClient: {},
    relaySeq: 0,
    peerPresence: { known: false, checkedAt: 0 }
  }
}

/**
 * Wire two instance clones' relay together: a publish from one hands the envelope straight to the
 * other's `receiveRelay`, toggling `WIKI.INSTANCE_ID` to whichever side is "currently running" for the
 * length of that one synchronous call — mirroring what a real NOTIFY delivery would look like from a
 * second process with its own instance id, without needing one.
 */
export function wire(a: any, b: any): void {
  const byId: Record<string, any> = { [a.__id]: a, [b.__id]: b }
  for (const inst of [a, b]) {
    inst.publish = (envelope: any) => {
      for (const target of Object.values(byId)) {
        if (target.__id === envelope.i) {
          continue
        }
        const previous = (globalThis as any).WIKI.INSTANCE_ID
        ;(globalThis as any).WIKI.INSTANCE_ID = target.__id
        try {
          target.receiveRelay(envelope)
        } finally {
          ;(globalThis as any).WIKI.INSTANCE_ID = previous
        }
      }
    }
  }
}

/** The page row `WIKI.models.pages.getPage` answers with, when a room has to fall back to storage. */
export const STORED_PAGE = {
  content: 'STORED PAGE CONTENT',
  title: 'Stored title',
  description: 'Stored description',
  icon: 'stored-icon'
}

/** What {@link installCollabHarness} hands back: the room bookkeeping its hooks own. */
export interface CollabHarness {
  /** Open a room on an instance and register it for teardown. */
  openRoom(inst: any, page: { id: string; siteId: string }): Promise<any>
  /** Register a room a test opened by other means, so the same teardown applies. */
  trackRoom(room: any): void
  /** This test's `WIKI.models.pages.getPage` mock, rebuilt fresh before every test. */
  getPage(): any
  /**
   * This test's `WIKI.models.pageDrafts.save`/`clear` mocks (OpenProject #2455), rebuilt fresh before
   * every test. Resolve to `undefined` and record nothing more than the calls made to them -- a suite
   * that cares asserts on `.mock.calls` directly, the same way {@link getPage} is used elsewhere.
   */
  getPageDraftsSave(): any
  getPageDraftsClear(): any
}

/**
 * Register the per-test `WIKI` install and room teardown every collab suite below the participant
 * accessor needs, and hand back the room bookkeeping.
 *
 * Call once at the top level of a suite file: the hooks it registers are root hooks, so they apply to
 * every test in that file, exactly as they did when all four suites shared one.
 */
export function installCollabHarness(): CollabHarness {
  let wikiHandle: { restore(): void }
  let getPageMock: any
  let pageDraftsSaveMock: any
  let pageDraftsClearMock: any
  /**
   * `awarenessProtocol.Awareness` (a room's cursor/presence tracker) starts a real `setInterval` of
   * its own to expire stale states - nothing above ever cleans it up on the happy path except a room
   * emptying out. Every room a test creates via {@link CollabHarness.openRoom} is torn down the same
   * way `closeRoomIfEmpty` does in production, or the interval outlives the test and the process
   * never exits.
   */
  let createdRooms: any[] = []

  beforeEach(() => {
    getPageMock = mock.fn(async () => ({ ...STORED_PAGE }))
    pageDraftsSaveMock = mock.fn(async () => {})
    pageDraftsClearMock = mock.fn(async () => {})
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'unset',
      models: {
        pages: { getPage: getPageMock },
        pageDrafts: { save: pageDraftsSaveMock, clear: pageDraftsClearMock }
      }
    })
    createdRooms = []
  })

  afterEach(() => {
    for (const room of createdRooms) {
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
    getPageDraftsSave: () => pageDraftsSaveMock,
    getPageDraftsClear: () => pageDraftsClearMock
  }
}
