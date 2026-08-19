import { defineStore } from 'pinia'

import { v4 as uuid } from 'uuid'

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
    activeModal: '',
    activeModalData: null,
    hideSideNav: false,
    media: {
      folderTree: [],
      currentFolderId: 0,
      currentFileId: null
    },
    checkoutDateActive: '',
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
     * The page as the server now has it, when a save was refused because somebody else saved first.
     *
     * Set by `pageSave()` in `stores/page.js` on a 409 reply, whose body is `{ updatedAt, title,
     * content, authorName }` -- and read by `EditorMarkdown.vue`, which watches it to put up the
     * resolution dialog. Null the rest of the time, which is what the watcher gates on.
     */
    saveConflict: null
  }),
  getters: {
    hasPendingChanges: (state) => {
      return state.lastSaveTimestamp && state.lastSaveTimestamp !== state.lastChangeTimestamp
    }
  },
  actions: {
    addPendingAsset(data) {
      const blobUrl = URL.createObjectURL(data)
      if (data instanceof File) {
        this.pendingAssets.push({
          id: uuid(),
          kind: 'file',
          file: data,
          fileName: data.name,
          blobUrl
        })
      } else {
        const fileId = uuid()
        const fileName = `${fileId}.${imgMimeExt[data.type] || 'dat'}`
        this.pendingAssets.push({
          id: fileId,
          kind: 'blob',
          file: new File(data, fileName, { type: data.type }),
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
          throw new Error('Cannot fetch editors config: Missing Site ID')
        }
        // -> The editor configs are part of the site config, which is one request rather than a
        //    dedicated endpoint
        const siteInfo = await API_CLIENT.get(`sites/${siteStore.id}`).json()
        this.$patch({
          editors: {
            asciidoc: siteInfo?.editors?.asciidoc?.config ?? {},
            markdown: siteInfo?.editors?.markdown?.config ?? {},
            wysiwyg: siteInfo?.editors?.wysiwyg?.config ?? {}
          },
          configIsLoaded: true
        })
      } catch (err) {
        console.warn(err)
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
        console.warn(err)
        throw err
      }
    }
  }
})
