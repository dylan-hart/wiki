import { vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PageActionsCol from './PageActionsCol.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Each mount helper exists because the rail gates a different control on a different permission, so
 * no one seed covers them all. `vi.mock('browser-fs-access', ...)` stays in each suite that needs
 * `fileSave`: `vi.mock` is hoisted per file and cannot be moved here.
 */
export const HOMEPAGE_GUARD_MESSAGES = {
  en: {
    pages: {
      homepageGuard: {
        deleteTitle: 'Delete the Home Page?',
        deleteMessage:
          "**{name}** is set as this site's home page. Deleting it will leave the site root with no page until another one takes its place at `home`.",
        moveTitle: 'Move the Home Page?',
        moveMessage:
          "**{name}** is set as this site's home page. Moving it away from `home` will leave the site root with no page until another one takes its place there.",
        proceed: 'Continue'
      }
    }
  }
}

/**
 * The rail's aria-labels and tooltips resolve through `t()`, so a mount needs the real `en.json`
 * strings present for its `[aria-label="…"]` selectors and `.w-item` label assertions to match
 * resolved output rather than a key.
 */
export const PAGE_ACTIONS_MESSAGES = {
  ...HOMEPAGE_GUARD_MESSAGES.en,
  common: {
    page: {
      properties: 'Page Properties',
      data: 'Page Data',
      history: 'Page History',
      duplicate: 'Duplicate Page',
      renameMove: 'Rename / Move Page',
      rerender: 'Rerender Page',
      convertEditor: 'Convert Editor',
      viewBacklinks: 'View Backlinks',
      delete: 'Delete Page'
    },
    pendingAssets: {
      title: 'Pending Asset Uploads',
      empty: 'There are no assets pending uploads.',
      newFileName: 'New file name',
      confirmRename: 'Confirm Rename',
      cancelRename: 'Cancel Rename',
      renameAsset: 'Rename Pending Asset',
      removeAsset: 'Remove Pending Asset',
      helpText:
        'Assets that are pasted or dropped onto this page will be held here until the page is saved.'
    }
  },
  pages: {
    ...HOMEPAGE_GUARD_MESSAGES.en.pages,
    export: {
      title: 'Export Page',
      markdown: 'Markdown',
      html: 'HTML',
      pdf: 'PDF'
    },
    copyContent: {
      success: 'Page content copied to the clipboard.',
      failed: 'Failed to copy the page content to the clipboard.'
    }
  }
}

export async function mountRailForGuard({
  path = 'home',
  permissions = ['delete:pages', 'manage:pages']
} = {}) {
  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore, userStore } = mountWithApp(PageActionsCol, {
    attachTo: document.body,
    router,
    messages: PAGE_ACTIONS_MESSAGES,
    stubs: {},
    stores: {
      page: {
        id: 'page-1',
        path,
        title: 'Welcome',
        editor: 'markdown',
        // -> `initializeStore(router)` wires this up at app boot; a bare pinia never runs it, and
        //    `pageMove` dereferences it for the page it just moved.
        router: { replace: vi.fn() }
      },
      site: { id: 'site-1' },
      user: { permissions }
    }
  })

  return { wrapper, pageStore, siteStore, userStore, router }
}

/**
 * `w-menu`'s panel is teleported to `document.body`, so once the trigger is clicked the panel has to
 * be queried off `document`, not off `wrapper` -- `wrapper.find` only ever searches the mounted
 * root's own subtree.
 */
export async function mountRail({ pdfExportAvailable = false } = {}) {
  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore } = mountWithApp(PageActionsCol, {
    attachTo: document.body,
    router,
    messages: PAGE_ACTIONS_MESSAGES,
    stubs: {},
    stores: {
      page: { id: 'page-1', path: 'docs/getting-started', editor: 'markdown' },
      site: { id: 'site-1', pdfExportAvailable }
    }
  })

  const trigger = wrapper.get('[aria-label="pageActions.exportPage"]')
  await trigger.trigger('click')
  await flushPromises()

  return { wrapper, pageStore, siteStore }
}

export function menuItemLabels() {
  return [...document.querySelectorAll('.w-menu .w-item')].map((el) => el.textContent.trim())
}

export async function openPageActionsMenu(wrapper) {
  await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
  await flushPromises()
}

export function clickMenuItem(label) {
  const item = [...document.querySelectorAll('.w-menu .w-item')].find((el) =>
    el.textContent.includes(label)
  )
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

export async function mountRailWithHistory({ pageId = 'page-1', creating = false } = {}) {
  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore, userStore } = mountWithApp(PageActionsCol, {
    attachTo: document.body,
    router,
    messages: PAGE_ACTIONS_MESSAGES,
    stubs: {},
    stores: {
      page: { id: pageId, path: 'docs/getting-started', editor: 'markdown' },
      site: { id: 'site-1' },
      user: { permissions: ['read:history'] },
      editor: creating ? { isActive: true, mode: 'create' } : {}
    }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

/** Pass `editor: 'redirect'` to prove the `!isRedirect` block, this button included, is absent. */
export async function mountRailWithCopyContent({
  editor = 'markdown',
  permissions = ['read:source']
} = {}) {
  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore, userStore } = mountWithApp(PageActionsCol, {
    attachTo: document.body,
    router,
    messages: PAGE_ACTIONS_MESSAGES,
    stubs: {},
    stores: {
      page: { id: 'page-1', path: 'docs/getting-started', editor },
      site: { id: 'site-1' },
      user: { permissions }
    }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

/**
 * Rerender Page is not gated on `write:pages` alone -- the backend also refuses when Puppeteer is
 * absent (which `siteStore.pdfExportAvailable` stands for) or the page's editor is not markdown.
 */
export async function mountRailWithPageActions({
  pdfExportAvailable = true,
  editor = 'markdown',
  canWritePages = true,
  // -> Which editors the site has active, gating Convert Editor. Both on by default, so the
  //    default `editor: 'markdown'` is convertible out of the box.
  editors = { markdown: true, wysiwyg: true }
} = {}) {
  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore, userStore } = mountWithApp(PageActionsCol, {
    attachTo: document.body,
    router,
    messages: PAGE_ACTIONS_MESSAGES,
    stubs: {},
    stores: {
      page: { id: 'page-1', path: 'docs/getting-started', editor },
      site: { id: 'site-1', pdfExportAvailable, editors },
      user: { permissions: canWritePages ? ['write:pages'] : [] }
    }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

export async function mountRailWithPendingAssets({ pendingAssets = [] } = {}) {
  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore, userStore, editorStore } = mountWithApp(PageActionsCol, {
    attachTo: document.body,
    router,
    messages: PAGE_ACTIONS_MESSAGES,
    stubs: {},
    stores: {
      page: { id: 'page-1', path: 'docs/getting-started', editor: 'markdown' },
      site: { id: 'site-1' },
      user: { permissions: ['write:pages'] },
      editor: { isActive: true, pendingAssets }
    }
  })

  await wrapper.get('[aria-label="pageActions.pendingAssetUploads"]').trigger('click')
  await flushPromises()

  return { wrapper, pageStore, siteStore, userStore, editorStore }
}

export function clickByLabel(label) {
  document
    .querySelector(`[aria-label="${label}"]`)
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

export function typeInto(inputEl, value) {
  inputEl.value = value
  inputEl.dispatchEvent(new Event('input', { bubbles: true }))
}
