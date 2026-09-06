import { defineStore } from 'pinia'

import { i18n } from '@/boot/i18n'
import { log } from '@/helpers/log'

export const useFlagsStore = defineStore('flags', {
  state: () => ({
    loaded: false,
    // -> Declared rather than left to `$patch` to create, so that anything reading a flag before the
    //    first load sees `false` instead of `undefined`
    experimental: false,
    authDebug: false,
    sqlLog: false
  }),
  getters: {},
  actions: {
    async load() {
      try {
        const systemFlags = await API_CLIENT.get('system/flags').json()
        if (!systemFlags) {
          throw new Error(i18n.global.t('admin.flags.loadFailed'))
        }
        this.apply(systemFlags)
      } catch (err) {
        log.warn('flags', 'could not load the system flags', err)
        throw err
      }
    },
    /**
     * Take in flags that arrived with something else — `bootstrap` hands them over with the site and
     * the session, which is how an app load gets them without a request of its own.
     */
    apply(systemFlags) {
      this.$patch({
        ...systemFlags,
        loaded: true
      })
    }
  }
})
