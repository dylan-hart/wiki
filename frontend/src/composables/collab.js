import { defineAsyncComponent, watch } from 'vue'

import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

import { i18n } from '@/boot/i18n'
import { dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { log } from '@/helpers/log'
import { useCollabStore } from '@/stores/collab'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useUserStore } from '@/stores/user'

/**
 * Live collaborative editing, browser side.
 *
 * A module singleton rather than a per-component composable — there is one editor open at a time.
 * The Yjs document, the websocket and the Monaco binding are held here, deliberately outside of
 * Vue's reactivity: a CRDT is a graph of mutable nodes and wrapping one in a proxy is both pointless
 * and slow. What components need is mirrored into `stores/collab.js`.
 *
 * Only the markdown source and the three fields in the page header are shared; on everything else
 * about a page the last save wins. Saving stays explicit — all this session does about it is listen,
 * so the editors that did not make the save stop calling themselves unsaved.
 */

/** How long to wait for the first sync before giving up and letting the author type offline. */
const SYNC_TIMEOUT = 5000

/**
 * Ceiling on `y-websocket`'s own reconnect backoff (`WebsocketProvider`'s `maxBackoffTime`), which
 * otherwise retries forever, doubling the delay each miss until it holds at the ceiling. This is the
 * library's own default, pinned so an upgrade changing that default cannot silently change how
 * quickly a real outage recovers. It keeps the worst case well under `SYNC_TIMEOUT`'s budget for the
 * *first* connection.
 */
const RECONNECT_MAX_BACKOFF = 2500

/**
 * Long enough to ride out the pause between two words, short enough that the indicator means "right
 * now" rather than "recently". Only the two transitions are broadcast, not each keystroke.
 */
const TYPING_IDLE = 2000

/**
 * Picked by hashing the user id, so one person is the same colour on everyone's screen and stays
 * that colour across sessions. Chosen to stay legible as a cursor label and as the background of an
 * avatar with white initials on it — hence no yellows or pastels.
 */
const USER_COLORS = [
  '#D32F2F',
  '#C2185B',
  '#7B1FA2',
  '#512DA8',
  '#303F9F',
  '#1976D2',
  '#0288D1',
  '#00796B',
  '#388E3C',
  '#E64A19',
  '#5D4037',
  '#455A64'
]

let doc = null
let provider = null
let binding = null
let styleEl = null
let syncTimer = null
let typing = false
let typingTimer = null
/** The page store watchers have no component to be bound to, so they are stopped by hand. */
let stopWatchers = []
/**
 * Set while a remote change is being written into the page store, so the watcher that mirrors that
 * store back into the document does not send it round again.
 */
let applyingRemote = false
/** A recovery draft is offered at most once per session, even across a reconnect's re-`sync`. */
let draftOffered = false

/**
 * Exported because an avatar with no picture behind it is drawn in the same colour as its owner's
 * cursor — the whole point being that the face in the header and the caret in the text read as the
 * same person.
 */
export function collabUserColor(userId) {
  let hash = 0
  for (let index = 0; index < userId.length; index++) {
    hash = (hash * 31 + userId.charCodeAt(index)) | 0
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

/**
 * Pure, and its own function, so the read-only guard can be tested without mounting the
 * Monaco-backed `EditorMarkdown.vue`. Only the very first sync is worth locking the editor for:
 * `hasSynced` keeps a reconnect's trip back through `connecting` — or any later status — from
 * locking it again.
 */
export function collabStatusEffects(status, hasSynced) {
  return {
    shouldBindEditor: status === 'connected',
    readOnly: !hasSynced && status === 'connecting',
    notifyDenied: status === 'denied'
  }
}

/**
 * Returns without waiting for the socket: the editor stays usable throughout, and the store's status
 * is what says whether anything is live yet.
 */
export function startCollabSession({ siteId, pageId }) {
  if (doc) {
    stopCollabSession()
  }
  draftOffered = false

  const collabStore = useCollabStore()
  const pageStore = usePageStore()
  const userStore = useUserStore()

  doc = new Y.Doc()
  const ytext = doc.getText('content')
  const yprops = doc.getMap('props')
  const ymeta = doc.getMap('meta')

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  provider = new WebsocketProvider(
    `${protocol}//${window.location.host}/_collab`,
    `${siteId}/${pageId}`,
    doc,
    { maxBackoffTime: RECONNECT_MAX_BACKOFF }
  )

  collabStore.$patch({
    status: 'connecting',
    hasSynced: false,
    participants: [],
    lastSave: null
  })

  provider.awareness.setLocalStateField('user', {
    id: userStore.id,
    name: userStore.name,
    hasAvatar: userStore.hasAvatar,
    avatarProviderUrl: userStore.avatarProviderUrl,
    color: collabUserColor(userStore.id)
  })

  provider.awareness.on('change', refreshParticipants)

  /*
    `transaction.local` is the whole test: an edit this browser made is local, one that arrived over
    the socket is not — so the typing indicator fires for the author's own edits (header fields
    included) and never for the changes they are merely receiving.
  */
  doc.on('update', (update, origin, updated, transaction) => {
    if (transaction?.local) {
      markTyping()
    }
  })

  provider.on('status', ({ status }) => {
    /*
      `connected` here means the socket is up, not that the session is live — `sync` below reports
      that, and is the only thing allowed to say `connected`. A refusal outranks both.
    */
    if (collabStore.status === 'denied' || status === 'connected') {
      return
    }
    collabStore.status = status === 'connecting' ? 'connecting' : 'disconnected'
  })

  provider.on('sync', (isSynced) => {
    if (!isSynced) {
      return
    }
    clearTimeout(syncTimer)
    collabStore.$patch({ status: 'connected', hasSynced: true })
    /*
      The room may hold header fields somebody else changed and has not saved: those are the current
      state of this edit, so they win over what this browser loaded from the API.
    */
    adoptProps()
    refreshParticipants()
    offerDraftRestore({ siteId, pageId })
  })

  provider.on('connection-close', (event) => {
    /*
      Codes in the 4000 range are the server's own (`controllers/collab.ts`) and all mean the same
      thing: this session is not allowed, and reconnecting would be refused just as fast. Anything
      else is an ordinary drop, which the provider is right to retry.
    */
    if (event?.code >= 4000) {
      collabStore.status = 'denied'
      provider.shouldConnect = false
      provider.disconnect()
    }
  })

  /*
    A websocket that cannot be established — a proxy that does not forward upgrades is the usual
    reason — must not leave the author staring at an editor they are not allowed to type in, so the
    session gives up and the editor carries on as a plain one.
  */
  syncTimer = setTimeout(() => {
    if (collabStore.status === 'connecting') {
      collabStore.status = 'disconnected'
    }
  }, SYNC_TIMEOUT)

  yprops.observe((event, transaction) => {
    if (!transaction.local) {
      adoptProps()
    }
  })

  // -> The server's word that the page has been saved -- `pageSaved` in `core/collab.ts`.
  ymeta.observe(() => {
    const info = ymeta.get('lastSave')
    if (info) {
      applySave(info)
    }
  })

  /*
    The other direction. Watched on the store rather than bound to the inputs because the title,
    description and icon are three separate contenteditable elements in the page header, and the
    store is the one place all three meet.
  */
  stopWatchers.push(
    watch(
      () => [pageStore.title, pageStore.description, pageStore.icon],
      ([title, description, icon]) => {
        if (applyingRemote || !doc) {
          return
        }
        doc.transact(() => {
          writeProp(yprops, 'title', title)
          writeProp(yprops, 'description', description)
          writeProp(yprops, 'icon', icon)
        })
      }
    )
  )

  ensureStyleElement()

  return { doc, ytext }
}

/**
 * Call once the document has synced, and not before: a binding built earlier would start by making
 * the editor say whatever an empty document says.
 *
 * Takes a factory rather than the editor itself because Monaco and TipTap bind to a Yjs document in
 * incompatible ways -- one through a constructor, the other as a self-installing extension owning
 * its own lifecycle. Both need the same two things, so `createBinding(ytext, awareness)` gets those
 * and returns whatever should be torn down when the session ends (anything with a `destroy()`), or
 * a falsy value if there is nothing left for this session to own.
 */
export function bindCollabEditor(createBinding) {
  if (!doc || binding) {
    return
  }
  binding = createBinding(doc.getText('content'), provider.awareness) || null
}

/**
 * Written into the live shared document rather than into `pageStore`, so one move reaches both
 * editors and the room: each editor is bound to this same `ytext`/`yprops`, so the change shows up
 * in whichever one is mounted and syncs to every other participant as if it had just been typed.
 */
export function applyRestoredDraft({ content, title, description, icon }) {
  if (!doc) {
    return
  }
  const ytext = doc.getText('content')
  const yprops = doc.getMap('props')
  doc.transact(() => {
    ytext.delete(0, ytext.length)
    if (content) {
      ytext.insert(0, content)
    }
    writeProp(yprops, 'title', title)
    writeProp(yprops, 'description', description)
    writeProp(yprops, 'icon', icon)
  })
  /*
    The body reaches the editor on its own -- both editors bind straight to `ytext` -- but the header
    fields only flow FROM `pageStore` into the doc, so this write has to be pulled into the store
    explicitly, the same way a REMOTE header edit is.
  */
  adoptProps()
}

export function stopCollabSession() {
  clearTimeout(syncTimer)
  syncTimer = null
  clearTimeout(typingTimer)
  typingTimer = null
  typing = false
  for (const stop of stopWatchers) {
    stop()
  }
  stopWatchers = []
  if (binding) {
    binding.destroy()
    binding = null
  }
  if (provider) {
    // -> Retract this editor's awareness state before the socket goes, so the others see the avatar
    //    leave immediately rather than when the server notices the connection is gone.
    provider.awareness.setLocalState(null)
    provider.destroy()
    provider = null
  }
  if (doc) {
    doc.destroy()
    doc = null
  }
  if (styleEl) {
    styleEl.remove()
    styleEl = null
  }
  applyingRemote = false
  draftOffered = false
  useCollabStore().reset()
}

/**
 * Carried as an awareness field of its own rather than folded into `user`, so that a burst of typing
 * does not republish the name, colour and avatar with every change. Two messages per burst: one when
 * it starts, one when it ends.
 */
function markTyping() {
  if (!provider) {
    return
  }
  if (!typing) {
    typing = true
    provider.awareness.setLocalStateField('typing', true)
  }
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => {
    typing = false
    provider?.awareness.setLocalStateField('typing', false)
  }, TYPING_IDLE)
}

function writeProp(yprops, key, value) {
  const next = value ?? ''
  if (yprops.get(key) !== next) {
    yprops.set(key, next)
  }
}

function adoptProps() {
  const pageStore = usePageStore()
  const yprops = doc.getMap('props')
  const patch = {}
  for (const key of ['title', 'description', 'icon']) {
    const value = yprops.get(key)
    // -> An icon is never legitimately empty: blanking one because the room was seeded from a page
    //    that had none would show up on every other screen.
    if (typeof value !== 'string' || (key === 'icon' && !value)) {
      continue
    }
    if (value !== pageStore[key]) {
      patch[key] = value
    }
  }
  if (Object.keys(patch).length < 1) {
    return
  }
  applyingRemote = true
  pageStore.$patch(patch)
  // -> The mirroring watcher is deferred, not `flush: 'sync'`, so the flag has to outlive the tick.
  queueMicrotask(() => {
    applyingRemote = false
  })
}

function applySave(info) {
  const collabStore = useCollabStore()
  const editorStore = useEditorStore()
  const pageStore = usePageStore()

  // -> Somebody else's save IS this editor's save as far as pending changes go.
  editorStore.markClean()
  pageStore.$patch({
    updatedAt: info.versionDate,
    authorId: info.authorId,
    authorName: info.authorName
  })
  collabStore.lastSave = info
}

/**
 * Hung off the room's first `sync` rather than run at session start: `pageStore.draft` is known
 * earlier, but is only worth asking about once there is a live document to restore it into. Never
 * awaited -- nothing in start-up waits on the reader's answer.
 */
async function offerDraftRestore({ siteId, pageId }) {
  if (draftOffered) {
    return
  }
  draftOffered = true

  const pageStore = usePageStore()
  const draftInfo = pageStore.draft
  pageStore.draft = null
  if (!draftInfo) {
    return
  }

  /*
    Fetched the moment the prompt opens, not once Restore is clicked: the dialog shows the draft
    against what the editor holds now, so it needs both halves in hand while it is up. The same
    request answers the restore itself, with no second round trip.

    The `catch(noop)` is not error handling -- the dialog and `onOk` both observe this promise -- but
    a reader who discards instead leaves the rejection with no other subscriber, and an
    unhandled-rejection report for a failure the dialog already showed would be noise.
  */
  const draftUrl = `sites/${siteId}/pages/${pageId}/draft`
  const draftRequest = API_CLIENT.get(draftUrl).json()
  draftRequest.catch(() => {})

  const { t } = i18n.global
  dialog({
    component: defineAsyncComponent(() => import('@/components/PageDraftRestoreDialog.vue')),
    componentProps: {
      authorName: draftInfo.authorName,
      // -> The room's live content, which is what a bound editor shows -- not the copy
      //    `pageStore.content` loaded from the API before the session started.
      currentContent: doc.getText('content').toString(),
      draftRequest
    }
  })
    .onOk(async () => {
      try {
        // -> A fetch that failed while the prompt was up is retried rather than treated as final:
        //    the draft is still on the server, and Restore was the reader's answer.
        const restored = await draftRequest.catch(() => API_CLIENT.get(draftUrl).json())
        applyRestoredDraft(restored)
        notify({ type: 'positive', message: t('editor.collab.draftRecovery.restored') })
      } catch (err) {
        log.warn('collab', 'could not restore the recovered draft', err)
        notify({ type: 'negative', message: t('editor.collab.draftRecovery.restoreFailed') })
      }
    })
    .onCancel(async () => {
      try {
        await API_CLIENT.delete(`sites/${siteId}/pages/${pageId}/draft`)
      } catch (err) {
        // -> Best-effort: worst case, the same draft is offered again next time this page is opened.
        log.warn('collab', 'could not discard the recovered draft', err)
      }
    })
}

/**
 * Asks the room's server-side coordinator (`core/collab.ts#claimWysiwygSeed`) whether this client
 * may seed its WYSIWYG field. Unlike the markdown field, the shared `Y.XmlFragment` TipTap binds to
 * has no server-side seed of its own, so two people opening a brand new room's WYSIWYG editor at the
 * same instant could otherwise both seed it from their own copy and duplicate its content. Only a
 * boolean crosses the wire, over an ordinary REST call rather than an addition to the y-websocket
 * protocol.
 *
 * Fails open on any error: seeding unconditionally is what an older or misconfigured backend without
 * this route gets anyway.
 */
export async function claimWysiwygSeed({ siteId, pageId }) {
  try {
    const { granted } = await API_CLIENT.post(
      `sites/${siteId}/pages/${pageId}/collab/wysiwyg-seed-claim`
    ).json()
    return granted
  } catch (err) {
    log.warn('collab', 'could not claim the WYSIWYG seed; seeding anyway', err)
    return true
  }
}

function refreshParticipants() {
  if (!provider || !doc) {
    return
  }
  const participants = []
  for (const [clientId, state] of provider.awareness.getStates()) {
    if (!state?.user?.id) {
      continue
    }
    participants.push({
      clientId,
      id: state.user.id,
      name: state.user.name || '',
      hasAvatar: Boolean(state.user.hasAvatar),
      avatarProviderUrl: state.user.avatarProviderUrl || null,
      color: state.user.color || collabUserColor(state.user.id),
      typing: Boolean(state.typing),
      isSelf: clientId === doc.clientID
    })
  }
  useCollabStore().participants = participants
  renderCursorStyles(participants)
}

function ensureStyleElement() {
  if (styleEl) {
    return
  }
  styleEl = document.createElement('style')
  styleEl.dataset.collabCursors = 'true'
  document.head.appendChild(styleEl)
}

/**
 * `composables/monacoYjsBinding.js` draws each remote selection as a decoration whose class carries
 * the client id and nothing else — `yRemoteSelection-42` — leaving what it looks like entirely to
 * CSS, hence one rule per participant. It is also the only way the name can appear beside the caret:
 * it is drawn as generated content, there being no element to put it in.
 */
function renderCursorStyles(participants) {
  ensureStyleElement()
  styleEl.textContent = participants
    .filter((participant) => !participant.isSelf)
    .map(
      (participant) => `
        .yRemoteSelection-${participant.clientId} {
          background-color: ${participant.color}44;
        }
        .yRemoteSelectionHead-${participant.clientId} {
          position: relative;
          border-left: 2px solid ${participant.color};
          border-top: 2px solid ${participant.color};
          border-bottom: 2px solid ${participant.color};
        }
        .yRemoteSelectionHead-${participant.clientId}::after {
          content: '${cssString(participant.name)}';
          position: absolute;
          top: -1.4em;
          left: -2px;
          padding: 0 4px;
          border-radius: 2px 2px 2px 0;
          background-color: ${participant.color};
          color: #fff;
          font-size: 0.7rem;
          line-height: 1.4em;
          white-space: nowrap;
          pointer-events: none;
          user-select: none;
        }`
    )
    .join('\n')
}

/** A user-supplied name, safe to sit inside a single-quoted CSS string. */
function cssString(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, ' ')
}
