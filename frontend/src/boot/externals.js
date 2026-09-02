import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

export function initializeExternals(router, store) {
  window.WIKI_STATE = {
    page: usePageStore(store),
    site: useSiteStore(store),
    user: useUserStore(store)
  }
  window.WIKI_ROUTER = router
}
