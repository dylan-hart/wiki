import { defineStore } from 'pinia'

import { log } from '@/helpers/log'
import { useSiteStore } from './site'
import { useUserStore } from './user'

function withId(ids, pageId, present) {
  const without = ids.filter((id) => id !== pageId)
  return present ? [...without, pageId] : without
}

export const useUserPagesStore = defineStore('userPages', {
  state: () => ({
    loadedSiteId: '',
    favoriteIds: [],
    pinnedIds: [],
    lastVisitedId: ''
  }),
  getters: {
    isFavorite: (state) => (pageId) => state.favoriteIds.includes(pageId),
    isPinned: (state) => (pageId) => state.pinnedIds.includes(pageId)
  },
  actions: {
    async load() {
      const siteId = useSiteStore().id
      if (!useUserStore().authenticated || !siteId || this.loadedSiteId === siteId) {
        return
      }
      try {
        const lists = await API_CLIENT.get(`sites/${siteId}/user-pages`).json()
        this.$patch({
          loadedSiteId: siteId,
          favoriteIds: (lists?.favorites ?? []).map((entry) => entry.pageId),
          pinnedIds: (lists?.pinned ?? []).map((entry) => entry.pageId)
        })
      } catch (err) {
        log.warn('page', 'could not load the favorite and pinned pages', err)
      }
    },
    async recordVisit(pageId) {
      if (!useUserStore().authenticated || !pageId || pageId === this.lastVisitedId) {
        return
      }
      this.lastVisitedId = pageId
      try {
        await API_CLIENT.put(`sites/${useSiteStore().id}/pages/${pageId}/visit`).json()
      } catch (err) {
        this.lastVisitedId = ''
        log.warn('page', 'could not record the page visit', err)
      }
    },
    setFavorite(pageId, on) {
      return this.setMark(
        { listKey: 'favoriteIds', segment: 'favorite', flag: 'isFavorite' },
        pageId,
        on
      )
    },
    setPinned(pageId, on) {
      return this.setMark({ listKey: 'pinnedIds', segment: 'pin', flag: 'isPinned' }, pageId, on)
    },
    async setMark({ listKey, segment, flag }, pageId, on) {
      const wasOn = this[listKey].includes(pageId)
      this[listKey] = withId(this[listKey], pageId, on)
      try {
        const url = `sites/${useSiteStore().id}/pages/${pageId}/${segment}`
        const resp = await (on ? API_CLIENT.put(url) : API_CLIENT.delete(url)).json()
        this[listKey] = withId(this[listKey], pageId, resp?.[flag] ?? on)
      } catch (err) {
        this[listKey] = withId(this[listKey], pageId, wasOn)
        log.warn('page', `could not change the ${segment} state of this page`, err)
        throw err
      }
    }
  }
})
