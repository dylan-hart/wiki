import { defineStore } from 'pinia'

/**
 * The reactive face of `composables/collab.js`, which owns the Yjs document and the websocket and is
 * the only thing that writes here. Split off so that components can read the session without
 * touching any of that machinery.
 */
export const useCollabStore = defineStore('collab', {
  state: () => ({
    /**
     * - `off` — no session, or the site has the feature turned off
     * - `connecting` — the socket is up but the document has not been synced yet
     * - `connected` — live
     * - `disconnected` — dropped and being retried; edits are still safe locally
     * - `denied` — the server refused the session and retrying will not help
     */
    status: 'off',
    /**
     * Only the FIRST sync is worth waiting for. A reconnection goes back through `connecting`, but
     * the editor must not lock itself again over it: there is already a document in front of the
     * author, and edits made while the socket is down are merged when it comes back.
     */
    hasSynced: false,
    /** One entry per open editor, so the same person in two tabs appears twice. */
    participants: [],
    /**
     * Set only for a save that ARRIVES during the session — the value a joining editor inherits from
     * the room is history, not news.
     */
    lastSave: null
  }),
  getters: {
    isLive: (state) => state.status === 'connected',
    /**
     * One entry per person rather than per editor: two tabs are one face, and that face is typing if
     * either of them is. Yourself first, as Google Docs and friends do.
     */
    people: (state) => {
      const seen = new Map()
      for (const participant of state.participants) {
        const existing = seen.get(participant.id)
        if (existing) {
          existing.typing = existing.typing || participant.typing
        } else {
          // -> Copied, since the merge above would otherwise write into the awareness snapshot
          seen.set(participant.id, { ...participant })
        }
      }
      return [...seen.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf))
    }
  },
  actions: {
    reset() {
      this.$patch({ status: 'off', hasSynced: false, participants: [], lastSave: null })
    }
  }
})
