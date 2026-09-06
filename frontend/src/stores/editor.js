import { defineStore } from 'pinia'

import { v4 as uuid } from 'uuid'

import { log } from '@/helpers/log'

import { useSiteStore } from './site'

const imgMimeExt = {
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tif'
}

export const useEditorStore = defineStore('editor', {
  state: () => ({
    isActive: false,
    editor: '',
    originPageId: '',
    mode: 'edit',
    hideSideNav: false,
    lastSaveTimestamp: null,
    lastChangeTimestamp: null,
    editors: {},
    configIsLoaded: false,
    /*
      Per-user editor preferences (Markdown's `previewShown` / `fontSize` today), keyed by editor.
      Deliberately its own slice rather than folded into `editors` above: that one is site-level
      config, the same for every user editing this site, where this is a single user's own choices.
    */
    userSettings: {},
    reasonForChange: '',
    ignoreRouteChange: false,
    pendingAssets: [],
    /**
     * A synchronous read-through into the mounted editor's own live content, set by the editor
     * component (`EditorMarkdown.vue`) on mount and cleared on unmount. Null whenever no editor is
     * mounted -- a scripted `pageSave()` call, for instance.
     *
     * `pageStore.pageSave()` calls this before building its save payload rather than trusting
     * `content`/`render` as this store already has them: the editor only syncs those in on a 500ms
     * debounce (see `EditorMarkdown.vue`'s `onDidChangeModelContent` handler), so a save issued right
     * after an edit -- pasting an image and saving immediately, before that debounce has fired, is what
     * surfaced this (OpenProject #806) -- could otherwise read a stale pair and send a dead `blob:` URL
     * to the server. Deliberately a bare function reference rather than an action: what it does is
     * entirely the mounted editor's own business, not this store's.
     */
    contentFlusher: null,
    /**
     * The page as the server now has it, when a save was refused because somebody else saved first.
     *
     * Set by `pageSave()` in `stores/page.js` on a 409 reply, whose body is `{ updatedAt, title,
     * content, authorName }` -- and read by `EditorMarkdown.vue`, which watches it to put up the
     * resolution dialog. Null the rest of the time, which is what the watcher gates on.
     */
    saveConflict: null,
    /**
     * The author's own pending content, stashed immediately before a save-conflict "Discard" choice
     * overwrites it with the server's snapshot (OpenProject #2073) -- a sibling of `saveConflict`
     * above: that field is the server's copy offered during the choice, this is the author's copy
     * discarded by it. `EditorMarkdown.vue` stashes it via `stashDiscardedContent()` right before the
     * overwrite, and offers it back through an "undo" action on the toast that follows -- restoring
     * it into both `pageStore.content` and the live Monaco model, then clearing it via
     * `clearDiscardedContent()`. Null whenever nothing is currently offered back.
     */
    discardedContent: null
  }),
  getters: {
    hasPendingChanges: (state) => {
      return state.lastSaveTimestamp && state.lastSaveTimestamp !== state.lastChangeTimestamp
    }
  },
  actions: {
    /**
     * Record that the editor holds nothing the reader has not saved.
     *
     * `hasPendingChanges` above is exactly "these two timestamps differ", so equalizing them IS the
     * editor being clean -- which is what starting a session (`pageLoad`, `pageCreate`,
     * `pageSuggest`) and finishing a save (`pageSave`) each mean by it. Every one of those has some
     * further patch of its own to make in the same breath, which `extra` carries so the session's
     * mode and the timestamps land together rather than as two renders.
     *
     * @param {object} [extra] Merged into the same `$patch`.
     */
    markClean(extra) {
      const curDate = Temporal.Now.instant()
      this.$patch({ lastChangeTimestamp: curDate, lastSaveTimestamp: curDate, ...extra })
    },
    /**
     * Record that the reader has changed something since the last save.
     *
     * The counterpart to `markClean`, and what every editor component calls when its own content,
     * title, tags or path changed -- rather than writing `lastChangeTimestamp` bare, which leaves
     * eight files each having to know which of the two timestamps means "dirty".
     */
    markDirty() {
      this.lastChangeTimestamp = Temporal.Now.instant()
    },
    /**
     * Fetch the editor configs unless they are already loaded.
     *
     * Every editor-session entry point in `stores/page.js` needs them and none of them wants a
     * second request for a site whose configs are already in hand.
     */
    async ensureConfigs() {
      if (!this.configIsLoaded) {
        await this.fetchConfigs()
      }
    },
    /**
     * `generateUniqueName` forces a fresh, collision-proof name even for a `File` instance whose own
     * `name` would otherwise be trusted verbatim.
     *
     * Needed for a pasted image specifically (OpenProject #806 follow-up): every browser hands a
     * clipboard-pasted image file the same literal name, "image.png", regardless of what it actually
     * is -- so trusting `data.name` there means every paste on every page uploads to the same asset
     * path, and the site's default overwrite conflict behavior makes each one clobber the last. A
     * dropped file's name IS meaningful user intent (e.g. "quarterly-report.pdf") and must still be
     * preserved, which is why this defaults to off and is opt-in per call rather than keyed off
     * `data instanceof File` the way `kind` already is.
     */
    addPendingAsset(data, { generateUniqueName = false } = {}) {
      const blobUrl = URL.createObjectURL(data)
      if (data instanceof File && !generateUniqueName) {
        this.pendingAssets.push({
          id: uuid(),
          kind: 'file',
          file: data,
          fileName: data.name,
          blobUrl
        })
      } else if (data instanceof File) {
        // -> Trust only the extension off the browser-supplied name (or fall back to the mime table,
        //    same as the blob branch below), mint a fresh unique name for everything else
        const dotIndex = data.name.lastIndexOf('.')
        const ext = dotIndex > 0 ? data.name.slice(dotIndex + 1) : imgMimeExt[data.type] || 'dat'
        const fileId = uuid()
        const fileName = `${fileId}.${ext}`
        this.pendingAssets.push({
          id: fileId,
          kind: 'file',
          file: data,
          fileName,
          blobUrl
        })
      } else {
        const fileId = uuid()
        const fileName = `${fileId}.${imgMimeExt[data.type] || 'dat'}`
        this.pendingAssets.push({
          id: fileId,
          kind: 'blob',
          // -> The `File` constructor takes an ITERABLE of BlobParts, not a bare `Blob` -- `data`
          //    wrapped in an array is what a raw Blob (e.g. canvas `toBlob` output) needs here;
          //    passing it directly threw `The "sources" argument must be a sequence`
          //    (OpenProject #952).
          file: new File([data], fileName, { type: data.type }),
          fileName,
          blobUrl
        })
      }
      return blobUrl
    },
    async fetchConfigs() {
      const siteStore = useSiteStore()
      try {
        if (!siteStore.id) {
          throw new Error('ERR_MISSING_SITE_ID')
        }
        // -> The editor configs are part of the site config, which is one request rather than a
        //    dedicated endpoint
        const siteInfo = await API_CLIENT.get(`sites/${siteStore.id}`).json()
        // -> The resolved glossary term list (OpenProject #870): folded into the markdown editor's own
        //    config bag rather than fetched separately at each `MarkdownRenderer` call site, since
        //    every one of those already reads `editorStore.editors.markdown` for its config.
        const glossaryTerms = await API_CLIENT.get(`sites/${siteStore.id}/glossary/terms`).json()
        this.$patch({
          editors: {
            asciidoc: siteInfo?.editors?.asciidoc?.config ?? {},
            markdown: {
              ...siteInfo?.editors?.markdown?.config,
              glossaryTerms: glossaryTerms ?? []
            },
            wysiwyg: siteInfo?.editors?.wysiwyg?.config ?? {}
          },
          configIsLoaded: true
        })
      } catch (err) {
        log.warn('editor', 'could not load the editor configuration', err)
        throw err
      }
    },
    /**
     * This user's saved preferences for one editor, e.g. Markdown's `previewShown` / `fontSize`.
     *
     * Session-scoped like the endpoint it calls: no site id to pass, and nothing to wait on before
     * asking, unlike `fetchConfigs()` above. An empty object is the correct answer for a user who has
     * never saved anything for this editor, so it patches in as-is rather than being special-cased.
     */
    async fetchUserSettings(editor = 'markdown') {
      try {
        const settings =
          (await API_CLIENT.get(`users/profile/editor-settings/${editor}`).json()) ?? {}
        this.$patch({
          userSettings: {
            ...this.userSettings,
            [editor]: settings
          }
        })
        return settings
      } catch (err) {
        log.warn('editor', `could not load this user's ${editor} editor settings`, err)
        throw err
      }
    },
    /**
     * Stashes the author's pending content before a save-conflict "Discard" choice overwrites it --
     * see `discardedContent` above. Overwrites any content already stashed: only the most recent
     * discard is ever offered back.
     */
    stashDiscardedContent(content) {
      this.discardedContent = content
    },
    /**
     * Clears the stashed content -- called once it has been restored via the undo action, or once a
     * fresh discard/save has made offering it back stale.
     */
    clearDiscardedContent() {
      this.discardedContent = null
    }
  }
})
