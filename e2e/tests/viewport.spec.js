import { expect, test } from '@playwright/test'

/**
 * Task 2026: the pinned viewport used to live in `playwright.config.js`'s top-level `use`, where
 * the `chromium` project's own `use: { ...devices['Desktop Chrome'] }` silently won the shallow
 * per-key merge Playwright does (`devices['Desktop Chrome']` carries its own `viewport`, 1280x720)
 * -- so the effective viewport was never the pinned 1280x800 the config claimed. This asserts the
 * effective viewport directly, against a live page, so a future regression of the same kind (the
 * pin moved back to the wrong `use` block, or a future device descriptor override) fails a test
 * instead of drifting unnoticed again.
 */
test('effective viewport is pinned to 1280x800, not the device default', async ({ page }) => {
  await page.goto('/e2e-viewport-check')
  expect(page.viewportSize()).toEqual({ width: 1280, height: 800 })
})
