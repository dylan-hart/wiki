import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

import HeaderSearch from './HeaderSearch.vue'

export async function mountForPreview() {
  const router = await createTestRouter(['/'])

  const { wrapper, siteStore } = mountWithApp(HeaderSearch, {
    router,
    stores: {
      site: (store) => {
        store.id = 'site1'
        store.features.search = true
        store.popularTagsLoaded = true
        store.popularTags = []
      }
    }
  })

  await wrapper.find('.header-search-input').trigger('focus')

  return { wrapper, siteStore }
}
