import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * OpenProject #1644 (epic #1630, "Give the app a real heading hierarchy, a skip link and a `<nav>`
 * landmark on the primary sidebar"): before this, `skip-link|skip-to|skip to content` returned zero
 * hits repo-wide, so a keyboard user had to tab through every sidebar link on every navigation --
 * WCAG 2.4.1 Bypass Blocks (Level A), with no alternative mechanism.
 *
 * `MainLayout.vue` now renders a `.skip-link` as the very first child inside `<w-layout>` --
 * off-screen (`position: fixed; top: -3rem`) until it receives focus, at which point it slides into
 * view (`top: 0`) and, once activated, moves focus into `WPage`'s `<main id="main-content"
 * tabindex="-1">` via its `href="#main-content"`.
 */
test.describe('skip-to-content link', () => {
  test('is the first tabbable element, becomes visible on focus, and moves focus into <main> on activation', async ({
    page
  }) => {
    await loginAsAdmin(page)

    const path = `e2e-skip-link-${uniqueSlug()}`
    await createAndPublishPage(page, {
      path,
      title: 'Skip Link Test Page',
      body: 'Content for the skip-link e2e check.'
    })

    // -> Reload onto the published, reading (non-editor) view of the page, so the very first
    //    keyboard interaction on the page happens on the surface the audit finding is actually
    //    about, not on whatever the editor left focus on.
    await page.goto(`/${path}`)

    const skipLink = page.locator('a.skip-link')

    // -> Not yet focused: still off-screen. `toBeInViewport` is a layout assertion, so this is the
    //    part a component-level test (`MainLayout.test.js`) can't make -- only a real browser lays
    //    the fixed-positioned link out at `top: -3rem`, clipped above the viewport.
    await expect(skipLink).not.toBeInViewport()

    // -> First Tab press on a freshly loaded page: nothing has focus yet, so this lands on
    //    whichever element is first in the DOM's tab order -- proving the skip link really is
    //    first, not merely present somewhere on the page.
    await page.keyboard.press('Tab')
    await expect(skipLink).toBeFocused()
    await expect(skipLink).toBeInViewport()

    await page.keyboard.press('Enter')

    await expect(page.locator('#main-content')).toBeFocused()
  })
})
