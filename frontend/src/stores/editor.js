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
      Keyed by editor. Its own slice rather than folded into `editors` above: that one is site-level
      config, the same for every user editing this site, where this is one user's own choices.
    */
    userSettings: {},
    reasonForChange: '',
    ignoreRouteChange: false,
    pendingAssets: [],
    /**
     * A synchronous read-through into the mounted editor's live content, set by the editor component
     * on mount and cleared on unmount. Null whenever no editor is mounted.
     *
     * `pageStore.pageSave()` calls it before building its payload rather than trusting
     * `content`/`render` as this store has them: the editor only syncs those in on a 500ms debounce,
     * so a save issued right after an edit could otherwise send a dead `blob:` URL to the server.
     * A bare function reference rather than an action -- what it does is the editor's own business.
     */
    contentFlusher: null,
    /**
     * The server's copy of the page, set on a 409 save reply (body: `{ updatedAt, title, content,
     * authorName }`) and watched by `EditorMarkdown.vue` to raise the resolution dialog. Null the
     * rest of the time, which is what that watcher gates on.
     */
    saveConflict: null,
    /**
     * Sibling of `saveConflict`: that is the server's copy offered during a save conflict, this is
     * the author's copy a "Discard" choice overwrote, held so the follow-up toast can offer an undo.
     * Null whenever nothing is on offer.
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
     * `hasPendingChanges` is exactly "these two timestamps differ", so equalizing them IS the editor
     * being clean.
     *
     * @param {object} [extra] Merged into the same `$patch`, so a caller's own state change lands
     *   with the timestamps in one render rather than two.
     */
    markClean(extra) {
      const curDate = Temporal.Now.instant()
      this.$patch({ lastChangeTimestamp: curDate, lastSaveTimestamp: curDate, ...extra })
    },
    /**
     * What an editor component calls when content, title, tags or path changed -- rather than
     * writing `lastChangeTimestamp` bare, which would spread "which timestamp means dirty" around.
     */
    markDirty() {
      this.lastChangeTimestamp = Temporal.Now.instant()
    },
    /**
     * `configIsLoaded` deliberately gates only the editor config proper (tab width, quote style,
     * ...), which rarely changes. The glossary term list refreshes on every call regardless: a term
     * added or edited mid-session has to show up the next time an editor opens, not only after a
     * full page reload.
     */
    async ensureConfigs() {
      if (!this.configIsLoaded) {
        await this.fetchConfigs()
      } else {
        await this.refreshGlossaryTerms()
      }
    },
    /**
     * `generateUniqueName` overrides a `File`'s own `name`, which is otherwise trusted verbatim.
     * Browsers name every clipboard-pasted image "image.png", so trusting that name would upload
     * every paste in the wiki to one asset path, each clobbering the last. It is opt-in per call
     * rather than keyed off `data instanceof File`, because a DROPPED file's name is real user
     * intent and must be preserved.
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
        // -> Only the extension is taken from the browser-supplied name; the rest is minted fresh
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
          // -> The `File` constructor takes an ITERABLE of BlobParts: passing a bare `Blob` throws
          //    `The "sources" argument must be a sequence`
          file: new File([data], fileName, { type: data.type }),
          fileName,
          blobUrl
        })
      }
      return blobUrl
    },
    clearPendingAssets() {
      for (const asset of this.pendingAssets) {
        URL.revokeObjectURL(asset.blobUrl)
      }
      this.pendingAssets = []
    },
    async fetchConfigs() {
      const siteStore = useSiteStore()
      try {
        if (!siteStore.id) {
          throw new Error('ERR_MISSING_SITE_ID')
        }
        // -> The editor configs come back inside the site config; there is no dedicated endpoint
        const siteInfo = await API_CLIENT.get(`sites/${siteStore.id}`).json()
        this.$patch({
          editors: {
            asciidoc: siteInfo?.editors?.asciidoc?.config ?? {},
            markdown: { ...siteInfo?.editors?.markdown?.config },
            wysiwyg: siteInfo?.editors?.wysiwyg?.config ?? {}
          },
          configIsLoaded: true
        })
        await this.refreshGlossaryTerms()
      } catch (err) {
        log.warn('editor', 'could not load the editor configuration', err)
        throw err
      }
    },
    /**
     * Folded into the markdown editor's config bag, because every renderer call site already reads
     * that for its config. The route behind it is cached server-side and invalidated on each
     * glossary write, so calling this on every editor open is cheap rather than a full re-read.
     */
    async refreshGlossaryTerms() {
      const siteStore = useSiteStore()
      if (!siteStore.id) {
        return
      }
      try {
        const glossaryTerms = await API_CLIENT.get(`sites/${siteStore.id}/glossary/terms`).json()
        this.editors.markdown = {
          ...this.editors.markdown,
          glossaryTerms: glossaryTerms ?? []
        }
      } catch (err) {
        // -> Not fatal to opening the editor: the term list stays whatever this session already had,
        //    which degrades to plain text exactly as an empty glossary does
        log.warn('editor', 'could not refresh the glossary term list', err)
      }
    },
    /**
     * Session-scoped like the endpoint it calls: no site id to pass and nothing to wait on, unlike
     * `fetchConfigs()`. An empty object is the right answer for a user who has saved nothing for
     * this editor, so it patches in as-is.
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
    /** Overwrites anything already stashed: only the most recent discard is ever offered back. */
    stashDiscardedContent(content) {
      this.discardedContent = content
    },
    clearDiscardedContent() {
      this.discardedContent = null
    }
  }
})
