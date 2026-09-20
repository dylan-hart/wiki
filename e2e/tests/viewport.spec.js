import { expect, test } from '@playwright/test'

/**
 * Playwright merges `use` blocks shallowly per key, so the `chromium` project's
 * `devices['Desktop Chrome']` -- which carries its own 1280x720 `viewport` -- silently beats a pin
 * placed in `playwright.config.js`'s top-level `use`. Asserted against a live page so the pin
 * landing in the wrong block, or a device descriptor overriding it, fails a test rather than
 * drifting unnoticed.
 */
test('effective viewport is pinned to 1280x800, not the device default', async ({ page }) => {
  await page.goto('/e2e-viewport-check')
  expect(page.viewportSize()).toEqual({ width: 1280, height: 800 })
})
