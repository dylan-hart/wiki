import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useAdminStore } from '@/stores/admin'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { useGraphStore } from '@/stores/graph'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from './i18n.js'
import { buildTestRouter } from './router.js'

/**
 * A store is written to only when `stores` names it -- several suites deliberately assert against
 * an untouched store.
 *
 * Routing comes in two forms because navigation is async and mounting is not.
 * `routes`/`initialPath` build a router inline and the route settles by the test's first `await`;
 * a suite that branches on `route.params` before that awaits `createTestRouter()` itself and
 * passes the result as `router`.
 *
 * `stubs` defaults to `{ teleport: true }`, since a `<w-dialog>` teleports its body to
 * `document.body`, out of where `wrapper.find()` can see it. Pass `stubs: {}` to opt out.
 */
export function mountWithApp(Component, options = {}) {
  const {
    props,
    messages,
    routes,
    initialPath = '/',
    router: providedRouter,
    stores = {},
    stubs = { teleport: true },
    components,
    attachTo,
    global: globalOptions,
    ...mountOptions
  } = options

  setActivePinia(createPinia())

  const seeded = {
    siteStore: useSiteStore(),
    userStore: useUserStore(),
    pageStore: usePageStore(),
    adminStore: useAdminStore(),
    editorStore: useEditorStore(),
    flagsStore: useFlagsStore(),
    graphStore: useGraphStore()
  }
  const byKey = {
    site: seeded.siteStore,
    user: seeded.userStore,
    page: seeded.pageStore,
    admin: seeded.adminStore,
    editor: seeded.editorStore,
    flags: seeded.flagsStore,
    graph: seeded.graphStore
  }
  for (const [key, values] of Object.entries(stores)) {
    // -> A function is for seeds a plain `Object.assign` cannot express: a nested field
    //    (`siteStore.features.profile = true`), a `$patch`, or a value derived from current state.
    if (typeof values === 'function') {
      values(byKey[key])
    } else {
      Object.assign(byKey[key], values)
    }
  }

  const i18n = createTestI18n(messages)
  const router = providedRouter ?? (routes ? buildTestRouter(routes) : undefined)

  const wrapper = mount(Component, {
    ...(props ? { props } : {}),
    ...(attachTo ? { attachTo } : {}),
    ...mountOptions,
    global: {
      ...globalOptions,
      plugins: [...(router ? [router] : []), i18n, ...(globalOptions?.plugins ?? [])],
      stubs: { ...stubs, ...globalOptions?.stubs },
      components: { ...components, ...globalOptions?.components }
    }
  })

  if (router && !providedRouter && initialPath !== '/') {
    router.push(initialPath)
  }

  return { wrapper, router, i18n, ...seeded }
}
