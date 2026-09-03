import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'

import { useAdminStore } from '@/stores/admin'
import { useAdminOverlayRoute } from './adminOverlayRoute.js'

const mockRoute = reactive({ params: {} })
const mockRouter = { push: vi.fn() }

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => mockRouter
}))

const OPTS = {
  overlay: 'UserEditOverlay',
  listPath: '/_admin/users'
}

/**
 * The composable registers `onMounted` / `onBeforeUnmount` hooks, so it needs a real component
 * instance rather than a bare `effectScope()`.
 */
function mountComposable(opts = {}) {
  return mount({
    setup() {
      useAdminOverlayRoute({ ...OPTS, ...opts })
      return () => null
    }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockRoute.params = {}
  mockRouter.push.mockClear()
})

describe('useAdminOverlayRoute()', () => {
  it('opens the overlay on mount when the route already carries an id', () => {
    mockRoute.params = { id: 'user-1' }
    const adminStore = useAdminStore()

    mountComposable()

    expect(adminStore.overlay).toBe('UserEditOverlay')
    expect(adminStore.overlayOpts).toEqual({ id: 'user-1' })
  })

  it('leaves the overlay closed on mount when the route carries no id', () => {
    const adminStore = useAdminStore()
    adminStore.overlay = 'SomethingElse'

    mountComposable()

    expect(adminStore.overlay).toBe('')
  })

  it('opens the overlay when an id appears in the route, and closes it when it goes away', async () => {
    const adminStore = useAdminStore()
    mountComposable()

    mockRoute.params = { id: 'user-2' }
    await nextTick()
    expect(adminStore.overlay).toBe('UserEditOverlay')
    expect(adminStore.overlayOpts).toEqual({ id: 'user-2' })

    mockRoute.params = {}
    await nextTick()
    expect(adminStore.overlay).toBe('')
  })

  it('returns to the list route and reloads once its own overlay closes', async () => {
    const onClosed = vi.fn()
    mockRoute.params = { id: 'user-1' }
    const adminStore = useAdminStore()
    mountComposable({ onClosed })
    // -> Let the mount's own open settle first: watchers batch, so closing in the same tick would
    //    be seen as a single null -> '' change and never look like this overlay closing.
    await nextTick()

    adminStore.overlay = ''
    await nextTick()

    expect(mockRouter.push).toHaveBeenCalledWith('/_admin/users')
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('ignores another overlay closing', async () => {
    const onClosed = vi.fn()
    const adminStore = useAdminStore()
    adminStore.overlay = 'GroupEditOverlay'
    mountComposable({ onClosed })
    adminStore.overlay = 'GroupEditOverlay'
    await nextTick()
    mockRouter.push.mockClear()

    adminStore.overlay = ''
    await nextTick()

    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('closes the overlay when the page unmounts, so it does not survive onto the next route', () => {
    mockRoute.params = { id: 'user-1' }
    const adminStore = useAdminStore()
    const wrapper = mountComposable()

    wrapper.unmount()

    expect(adminStore.overlay).toBe('')
  })
})
