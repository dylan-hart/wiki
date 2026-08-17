import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminUtilities from './AdminUtilities.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'
import { useSiteStore } from '@/stores/site'
import { closeDialog, openDialogs } from '@/composables/dialog'

/**
 * The `import` utility used to be `disabled` with no handler at all (task 585). These tests cover the
 * two things it now does: picking a file opens the same destructive-action confirmation pattern as
 * `purgeHistory`/`invalidApiCertificates` (see `AdminUtilities.vue`'s other confirm() calls), and
 * confirming it uploads the file's raw bytes to `POST /_api/system/import`, scoped to the current
 * site — the same "body is the raw file, not a multipart form" shape `FileManager.vue` uses to upload
 * an asset.
 */

const messages = {
  en: {
    'admin.utilities.title': 'Utilities',
    'admin.utilities.subtitle': '',
    'admin.utilities.import': 'Import',
    'admin.utilities.importHint': '',
    'admin.utilities.importConfirm': "This will replace {site}'s content.",
    'admin.utilities.importConfirmWarn': 'This cannot be undone.',
    'admin.utilities.importSuccess': 'Content import queued successfully.',
    'admin.utilities.importFailed': 'Failed to queue the content import.',
    'common.actions.proceed': 'Proceed',
    'common.actions.viewDocs': 'View docs'
  }
}

async function mountUtilities() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'aaaaaaaa-0000-4000-8000-000000000001'
  siteStore.hostname = 'example.com'

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages })

  return mount(AdminUtilities, {
    global: {
      plugins: [router, i18n],
      components: { BlueprintIcon }
    }
  })
}

/** Picks a fake `.tar.gz` through the hidden file input, the way a real user's file picker would. */
async function pickFile(wrapper) {
  const file = new File(['fake tarball bytes'], 'export.tar.gz', { type: 'application/gzip' })
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  return file
}

describe('AdminUtilities import', () => {
  it('opens a destructive-action confirmation once a file is picked, before uploading anything', async () => {
    const wrapper = await mountUtilities()

    expect(openDialogs.length).toBe(0)
    await pickFile(wrapper)

    expect(openDialogs.length).toBe(1)
    expect(openDialogs[0].props.title).toBe('Import')
    expect(openDialogs[0].props.color).toBe('negative')
    expect(openDialogs[0].props.persistent).toBe(true)
    expect(API_CLIENT.post).not.toHaveBeenCalled()

    closeDialog(openDialogs[0].id, false)
  })

  it('uploads the picked file to the current site once confirmed', async () => {
    const wrapper = await mountUtilities()
    const file = await pickFile(wrapper)

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'job-1' })
    })

    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'system/import',
      expect.objectContaining({
        searchParams: { targetSiteId: 'aaaaaaaa-0000-4000-8000-000000000001' },
        body: file
      })
    )
  })

  it('does not upload when the confirmation is cancelled', async () => {
    const wrapper = await mountUtilities()
    await pickFile(wrapper)

    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })
})
