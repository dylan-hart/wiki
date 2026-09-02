import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { queue as notifyQueue } from '@/composables/notify'
import { useApiKeyCreateForm } from './apiKeyCreateForm.js'

/*
  `dialog()` is the boundary this composable hands the one-time secret across -- the real one mounts
  `ApiKeyCopyDialog` into the app's dialog host, which a unit test has nowhere to put. Only that one
  export is replaced: `ApiKeyCopyDialog.vue` is imported by the composable and reaches for
  `dialogComponentEmits`/`useDialogComponent` from the same module at import time, so a wholesale
  mock takes the suite down before a single test runs.
*/
const dialogs = vi.hoisted(() => ({ dialog: vi.fn() }))

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: dialogs.dialog
}))

const ADMIN = { endpoint: 'api-keys', i18nPrefix: 'admin.api' }
const LEVELS = [
  { id: 'level-public', name: 'Public' },
  { id: 'level-restricted', name: 'Restricted' }
]

/** Echoes the key, so an assertion can name the vocabulary a string came from. */
const t = (key) => key

/**
 * Runs the composable inside a component instance -- it registers an `onMounted` hook, which is
 * where the site list and the classification levels are fetched from.
 *
 * @param {object} [options] Merged over the admin form's own options.
 * @param {object} [form] Stands in for the enclosing `WForm`; `validate` is what `create()` calls.
 */
async function mountForm(options = {}, form = { validate: vi.fn().mockResolvedValue(true) }) {
  let api = null
  const wrapper = mount({
    setup() {
      api = useApiKeyCreateForm({ ...ADMIN, form: () => form, onOk: onOk, t, ...options })
      return () => null
    }
  })
  await flushPromises()
  return { api, wrapper, form }
}

const onOk = vi.fn()

/** The dismiss handler `create()` registers, so a test can close the copy dialog itself. */
function dismissCopyDialog() {
  const handler = dialogs.dialog.mock.results.at(-1).value.onDismiss.mock.calls[0][0]
  handler()
}

beforeEach(() => {
  setActivePinia(createPinia())
  notifyQueue.splice(0)
  onOk.mockReset()
  dialogs.dialog.mockReset()
  dialogs.dialog.mockImplementation(() => ({ onDismiss: vi.fn() }))
  // -> `GET classification-levels` (the admin store's own fetch) and `GET sites`, in mount order
  API_CLIENT.get.mockImplementation((url) => ({
    json: () =>
      Promise.resolve(url === 'classification-levels' ? LEVELS : [{ id: 'site-1', title: 'Docs' }])
  }))
  API_CLIENT.post.mockImplementation(() => ({
    json: () => Promise.resolve({ key: 'the-secret-token' })
  }))
})

describe('useApiKeyCreateForm — site picker', () => {
  it('prepends an "All Sites" entry to the fetched sites, under the caller’s own vocabulary', async () => {
    const { api } = await mountForm()

    expect(api.siteOptions.value).toEqual([
      { id: null, title: 'admin.api.newKeySiteAllSites' },
      { id: 'site-1', title: 'Docs' }
    ])
  })

  it('names the lifetimes and the name rules under that same prefix', async () => {
    const { api } = await mountForm({ i18nPrefix: 'profile.api' })

    expect(api.expirations.map((e) => e.text)).toEqual([
      'profile.api.expiration30d',
      'profile.api.expiration90d',
      'profile.api.expiration180d',
      'profile.api.expiration1y',
      'profile.api.expiration3y'
    ])
    expect(api.keyNameValidation[0]('')).toBe('profile.api.nameMissing')
    expect(api.keyNameValidation[1]('a<b')).toBe('profile.api.nameInvalidChars')
  })
})

describe('useApiKeyCreateForm — allowedClassifications', () => {
  it('checks every level once they are known', async () => {
    const { api } = await mountForm()

    expect(api.state.keyClassifications).toEqual(['level-public', 'level-restricted'])
  })

  /*
    OpenProject #1205: all-checked has to mean "unrestricted", not "these two ids" -- otherwise a
    level added later would silently be excluded from every key issued before it existed.
  */
  it('sends null while every level is still checked', async () => {
    const { api } = await mountForm()

    expect(api.allowedClassifications.value).toBe(null)
  })

  it('sends the explicit checked ids once a level is unchecked', async () => {
    const { api } = await mountForm()

    api.state.keyClassifications = ['level-public']

    expect(api.allowedClassifications.value).toEqual(['level-public'])
  })

  it('sends the narrowed list on the create request too', async () => {
    const { api } = await mountForm()
    api.state.keyClassifications = ['level-restricted']

    await api.create()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({
        json: expect.objectContaining({ allowedClassifications: ['level-restricted'] })
      })
    )
  })
})

describe('useApiKeyCreateForm — extraState / extraJson', () => {
  it('merges extraState into the form’s own state', async () => {
    const { api } = await mountForm({ extraState: { keyGroups: ['group-1'], groups: [] } })

    expect(api.state.keyGroups).toEqual(['group-1'])
  })

  it('reaches the POST body with the state as it is at send time, not at setup time', async () => {
    const { api } = await mountForm({
      extraState: { keyGroups: [] },
      extraJson: (state) => ({ groups: state.keyGroups })
    })

    api.state.keyGroups = ['group-2']
    await api.create()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({ json: expect.objectContaining({ groups: ['group-2'] }) })
    )
  })

  it('sends no such field for a form that declares none -- the self-service token', async () => {
    const { api } = await mountForm({ endpoint: 'users/profile/api-keys' })

    await api.create()

    const [url, options] = API_CLIENT.post.mock.calls[0]
    expect(url).toBe('users/profile/api-keys')
    expect(Object.keys(options.json).sort()).toEqual([
      'allowedClassifications',
      'expiration',
      'name',
      'scope',
      'siteId'
    ])
  })
})

describe('useApiKeyCreateForm — loadSites failure', () => {
  /*
    `GET /sites` needs `read:sites`/`access:admin`, which an ordinary self-service user does not hold
    -- so failing there is the expected common case for the profile form's actual audience, not an
    error worth alarming them with.
  */
  it('says nothing and leaves an empty site list when told to fail soft', async () => {
    API_CLIENT.get.mockImplementation((url) => ({
      json: () => (url === 'sites' ? Promise.reject(new Error('403')) : Promise.resolve(LEVELS))
    }))

    const { api } = await mountForm({ silentLoadErrors: true })

    expect(notifyQueue).toEqual([])
    expect(api.state.sites).toEqual([])
    expect(api.state.loadingSites).toBe(false)
    expect(api.state.loading).toBe(0)
  })

  it('raises a load-failed toast for the admin form, which is entitled to that endpoint', async () => {
    API_CLIENT.get.mockImplementation((url) => ({
      json: () => (url === 'sites' ? Promise.reject(new Error('boom')) : Promise.resolve(LEVELS))
    }))

    await mountForm()

    expect(notifyQueue).toContainEqual(
      expect.objectContaining({
        type: 'negative',
        message: 'admin.api.loadFailed',
        caption: 'boom'
      })
    )
  })

  it('still offers "All Sites", so a token is creatable with no site list at all', async () => {
    API_CLIENT.get.mockImplementation((url) => ({
      json: () => (url === 'sites' ? Promise.reject(new Error('403')) : Promise.resolve(LEVELS))
    }))

    const { api } = await mountForm({ silentLoadErrors: true })

    expect(api.siteOptions.value).toEqual([{ id: null, title: 'admin.api.newKeySiteAllSites' }])
  })
})

describe('useApiKeyCreateForm — create round trip', () => {
  it('hands the one-time secret to the copy dialog, in the caller’s own vocabulary', async () => {
    const { api } = await mountForm({ i18nPrefix: 'profile.api' })

    await api.create()

    expect(dialogs.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: { keyValue: 'the-secret-token', labelPrefix: 'profile.api' }
      })
    )
  })

  it('resolves the form only once the copy dialog is dismissed', async () => {
    const { api } = await mountForm()

    await api.create()
    expect(onOk).not.toHaveBeenCalled()

    dismissCopyDialog()
    expect(onOk).toHaveBeenCalledTimes(1)
  })

  it('reports success and drops the loading gauge back to zero', async () => {
    const { api } = await mountForm()

    await api.create()

    expect(notifyQueue).toContainEqual(
      expect.objectContaining({ type: 'positive', message: 'admin.api.createSuccess' })
    )
    expect(api.state.loading).toBe(0)
  })

  it('sends nothing at all when the form does not validate', async () => {
    const form = { validate: vi.fn().mockResolvedValue(false) }
    const { api } = await mountForm({}, form)

    await api.create()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(dialogs.dialog).not.toHaveBeenCalled()
    expect(notifyQueue).toContainEqual(
      expect.objectContaining({ type: 'negative', message: 'admin.api.createInvalidData' })
    )
  })

  it('refuses a reply carrying no key rather than opening an empty copy dialog', async () => {
    API_CLIENT.post.mockImplementation(() => ({ json: () => Promise.resolve({}) }))
    const { api } = await mountForm()

    await api.create()

    expect(dialogs.dialog).not.toHaveBeenCalled()
    expect(notifyQueue).toContainEqual(expect.objectContaining({ type: 'negative' }))
  })

  it('reports a rejected request and leaves the form usable', async () => {
    API_CLIENT.post.mockImplementation(() => {
      throw new Error('network')
    })
    const { api } = await mountForm()

    await api.create()

    expect(notifyQueue).toContainEqual(
      expect.objectContaining({ type: 'negative', message: 'network' })
    )
    expect(api.state.loading).toBe(0)
  })
})
