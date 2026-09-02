import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useAdminStore } from '@/stores/admin'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from './i18n.js'
import { buildTestRouter } from './router.js'

/**
 * The one mount every component and page suite goes through.
 *
 * 76 per-file `mountDialog` / `mountPage` / `mountOverlay` / `mountEditor` helpers used to spell out
 * the same four steps: `setActivePinia(createPinia())`, a `createI18n`, an optional `createRouter`,
 * and a `mount()` wiring both into `global.plugins`. 189 `setActivePinia` calls across 117 files;
 * 20 mounts passing exactly `plugins: [i18n]` and 17 exactly `[router, i18n]`.
 *
 * Store seeding stays OPT-IN at the call. `test/setup.js` deliberately seeds nothing (several suites
 * assert against an untouched store -- `pages/ProfileInfo.test.js` is the clearest), and this keeps
 * that property: a store is written to only when `stores` names it, and every store is returned
 * either way so a test can seed after the fact or assert on what the component wrote.
 *
 * Routing comes in two forms because navigation is async and mounting is not. `routes`/`initialPath`
 * build a router inline for the suites whose original code never awaited `isReady()` -- the route is
 * settled by the first `await` the test performs. A suite that DID await it before mounting (most of
 * them: a component branching on `route.params` renders the wrong branch otherwise) awaits
 * `createTestRouter()` itself and passes the result as `router`.
 *
 * `stubs` defaults to `{ teleport: true }`, which is what 14 call sites set by hand: a `<w-dialog>`
 * teleports its body to `document.body`, out of the wrapper, where `wrapper.find()` cannot see it.
 * Pass `stubs: {}` to opt out. Anything else in the options object (`slots`, `shallow`, `global`
 * additions, ...) is forwarded to `mount()` untouched.
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
    flagsStore: useFlagsStore()
  }
  const byKey = {
    site: seeded.siteStore,
    user: seeded.userStore,
    page: seeded.pageStore,
    admin: seeded.adminStore,
    editor: seeded.editorStore,
    flags: seeded.flagsStore
  }
  for (const [key, values] of Object.entries(stores)) {
    Object.assign(byKey[key], values)
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
