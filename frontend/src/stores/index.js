import { createPinia } from 'pinia'
import { markRaw } from 'vue'

export function initializeStore(router) {
  const pinia = createPinia()

  pinia.use(({ store }) => {
    store.router = markRaw(router)
  })

  return pinia
}
