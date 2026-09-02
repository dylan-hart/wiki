import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

import HeaderSearch from './HeaderSearch.vue'

/**
 * The mount `HeaderSearch.vue`'s preview and suggest suites share, lifted out when the single
 * 799-line `HeaderSearch.test.js` was split by concern (TEST-F14) -- both shards carried a
 * byte-identical copy of it.
 *
 * A sibling module rather than a `*.test.js`, matching `graphFixtures.js`,
 * `editorMarkdownHarness.js` and `pageActionsHarness.js`: `vitest.config.js` collects only
 * `*.test.js`, so this is imported and never run as a suite of its own.
 *
 * The debounced live-preview fetch this seeds for: typing into the focused field, once the query
 * reaches the 2-character floor `searchHint`'s copy already promises, should fetch a handful of
 * matching pages from `sites/:id/pages/search` and land them in `state.previewResults` -- without
 * ever letting a slower, earlier request clobber a faster, later one, and without leaving a request
 * in flight past `clearSearch()` or unmount.
 */
export async function mountForPreview() {
  const router = await createTestRouter(['/'])

  const { wrapper, siteStore } = mountWithApp(HeaderSearch, {
    router,
    stores: {
      site: (store) => {
        store.id = 'site1'
        store.features.search = true
        store.tagsLoaded = true
        store.tags = []
      }
    }
  })

  await wrapper.find('.header-search-input').trigger('focus')

  return { wrapper, siteStore }
}
