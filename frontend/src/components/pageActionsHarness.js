import { vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PageActionsCol from './PageActionsCol.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * The message sets, mount helpers and teleported-menu lookups `PageActionsCol.vue`'s four suites
 * share, lifted out of the single 877-line `PageActionsCol.test.js` when it was split by concern
 * (TEST-F14).
 *
 * A sibling module rather than a `*.test.js`, matching `graphFixtures.js` and
 * `editorMarkdownHarness.js`: `vitest.config.js` only collects `*.test.js`, so this is imported,
 * never run as a suite of its own. Each mount helper exists because the rail gates a different
 * control on a different permission, so no one seed covers them all.
 *
 * `vi.mock('browser-fs-access', ...)` stays in each suite that needs `fileSave` -- `vi.mock` is
 * hoisted per file and cannot be moved here.
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
 * WP #1610: the rail's aria-labels and tooltips now resolve through `t()` rather than carrying
 * hardcoded English literals, so every mount helper below needs the real `en.json` strings present
 * (not the empty `{ en: {} }` a pre-translation mount could get away with) for its `[aria-label="…"]`
 * selectors and `.w-item` label assertions to keep matching resolved output.
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
    }
  }
}

/**
 * WP #1149: extra confirmation before deleting or moving a site's homepage (the hardcoded `home` /
 * `''` path convention -- `pageStore.isHome`). Its own mount helper because it needs
 * `delete:pages`/`manage:pages`, which none of the other mount helpers below grant together.
 */
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
        // -> `initializeStore(router)` (stores/index.js) is what wires this up for real, at app
        //    boot; a bare pinia never runs it, and `pageMove` dereferences it for the page it just
        //    moved
        router: { replace: vi.fn() }
      },
      site: { id: 'site-1' },
      user: { permissions }
    }
  })

  return { wrapper, pageStore, siteStore, userStore, router }
}

/**
 * Task 502: the standalone "Page Source" rail button is retired in favour of a single "Export Page"
 * `w-menu` offering Markdown / HTML / PDF, matching the pattern the "..." Page Actions menu below it
 * already uses. `w-menu`'s panel is teleported to `document.body` (see `WMenu.vue`), so once the
 * trigger is clicked the panel has to be queried off `document`, not off `wrapper` -- `wrapper.find`
 * only ever searches the mounted root's own subtree.
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

export function clickMenuItem(label) {
  const item = [...document.querySelectorAll('.w-menu .w-item')].find((el) =>
    el.textContent.includes(label)
  )
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * OpenProject #811: an unsaved (never-saved) page has no `pageStore.id` yet, so clicking Page
 * History must not open the overlay -- there is nothing for it to fetch. Its own mount setup, since
 * the "Page History" button is gated on `read:history` (see PageActionsCol.vue), which `mountRail`
 * above never grants.
 */
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
      // -> The ticket's actual scenario: a brand-new, never-saved page, still open in the editor
      editor: creating ? { isActive: true, mode: 'create' } : {}
    }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

/**
 * OpenProject #1911: Page Data / Page Data Templates was decided OUT (#1890) rather than built out --
 * the rail's disabled "Page Data" button (behind `flagsStore.experimental`, with a hardcoded
 * `disable`) and its `togglePageData` handler are gone entirely, not just re-hidden.
 */

/**
 * OpenProject #858: Rerender Page can't just check `write:pages` -- the backend also refuses the
 * request when Puppeteer isn't installed (503) or the page's editor isn't markdown
 * (`renderUnsupportedEditor`). Mirrors the PDF export item's own availability gate above. Since
 * OpenProject #1917, `canRerenderPage` no longer decides whether the "..." Page Actions menu shows
 * at all -- View Backlinks is unconditional, so the trigger always renders; what varies here is only
 * whether Rerender Page itself appears inside it.
 */
export async function mountRailWithPageActions({
  pdfExportAvailable = true,
  editor = 'markdown',
  canWritePages = true
} = {}) {
  const router = await createTestRouter(['/'])

  const { wrapper, pageStore, siteStore, userStore } = mountWithApp(PageActionsCol, {
    attachTo: document.body,
    router,
    messages: PAGE_ACTIONS_MESSAGES,
    stubs: {},
    stores: {
      page: { id: 'page-1', path: 'docs/getting-started', editor },
      site: { id: 'site-1', pdfExportAvailable },
      user: { permissions: canWritePages ? ['write:pages'] : [] }
    }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

/**
 * OpenProject #878: renaming a pending (not-yet-uploaded) asset from the "Pending Asset Uploads"
 * pane. Its own mount setup -- `write:pages` (the whole pane is gated on it) plus an active,
 * non-redirect editor, which none of the mount helpers above grant together.
 */
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
