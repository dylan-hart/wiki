import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as sass from 'sass'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/*
  OpenProject #2717: `TagsBrowse.vue`'s "Browse by tags" band (`.w-section-header`) sat at the shared
  34px section-header height while `.sidebar-actions` (`MainLayout.vue`, `height: 38px`) beside it
  sits at the same vertical position -- so the two bands' bottom hairlines landed on different lines.
  Same class of defect as #2613 (the breadcrumb band vs. the same `.sidebar-actions` row), fixed the
  same way: a page-local `min-height: 38px` override rather than raising the shared class.

  Measured in a real headless Chromium, for the reason `test/realGridLayout.js` and #2613's own suite
  document at length: neither `jsdom` nor `happy-dom` runs a layout engine, so `getBoundingClientRect()`
  there comes back zeroed regardless of what the CSS says. The rules under test are compiled from the
  two SFCs' own `<style lang="scss">` text, not retyped as literals here, so a regression that moves
  the band back to 34px (or removes the local override) fails this test rather than passing it.
*/

const selfDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = dirname(dirname(selfDir))

async function compileStyleBlock(relativePath) {
  const source = await readFile(join(frontendRoot, relativePath), 'utf8')
  const block = source.match(/<style lang="scss">([\s\S]*?)<\/style>/)
  if (!block) {
    throw new Error(`No <style lang="scss"> block found in ${relativePath}`)
  }
  const themeDir = join(frontendRoot, 'src', 'css')
  const injected = `@use '${join(themeDir, '_theme.scss')}' as *; @use '${join(themeDir, '_palette.scss')}' as *;`
  const result = await sass.compileStringAsync(injected + block[1], {
    loadPaths: [join(frontendRoot, 'src')],
    silenceDeprecations: ['import', 'global-builtin', 'legacy-js-api', 'color-functions'],
    logger: sass.Logger.silent
  })
  return result.css
}

describe(
  'the tags-browse band height matches the sidebar action row — real layout',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let bands

    beforeAll(async () => {
      browser = await chromium.launch()

      /*
        `buildAppCss()` is the app's real `tailwind.css` -- needed for `.w-section-header`'s own
        rules (this page's override only adds `min-height`, it does not restate the band's fill,
        padding or border) as well as Tailwind's preflight (`box-sizing: border-box`, which is what
        keeps each band's 1px `border-bottom` inside its declared height rather than on top of it).
      */
      const [appCss, tagsCss, layoutCss] = await Promise.all([
        buildAppCss(),
        compileStyleBlock('src/pages/TagsBrowse.vue'),
        compileStyleBlock('src/layouts/MainLayout.vue')
      ])

      const page = await browser.newPage()
      try {
        /*
          The two bands as the app actually renders them: `.sidebar-actions` is the top strip of the
          sidebar column, `.tags-browse .w-section-header` the top strip of the content column beside
          it -- `align-items: flex-start` keeps each box at its own natural height instead of the row
          stretching both to the taller one, which would hide the very difference being measured.
        */
        await page.setContent(
          '<!doctype html><html><head><style>' +
            appCss +
            tagsCss +
            layoutCss +
            '</style></head><body class="body--light" style="margin:0">' +
            '<div style="display:flex;align-items:flex-start;width:1280px">' +
            '<div class="sidebar-actions flex flex-nowrap items-stretch" style="width:260px">' +
            '<button class="w-btn flex-1 px-2" type="button">en</button>' +
            '</div>' +
            '<main class="w-page tags-browse" style="flex:1">' +
            '<div class="w-section-header">Browse by tags</div>' +
            '</main>' +
            '</div></body></html>'
        )
        bands = await page.evaluate(() => {
          const read = (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect()
            return { top: rect.top, bottom: rect.bottom, height: rect.height }
          }
          return {
            sidebarActions: read('.sidebar-actions'),
            tagsBand: read('.tags-browse .w-section-header')
          }
        })
      } finally {
        await page.close()
      }
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('starts both bands at the same top edge, so their bottoms are comparable at all', () => {
      expect(bands.tagsBand.top).toBe(bands.sidebarActions.top)
    })

    it('rules both bands off on the same line', () => {
      expect(bands.tagsBand.bottom).toBe(bands.sidebarActions.bottom)
    })

    it('draws the tags-browse band at the sidebar action row height', () => {
      expect(bands.sidebarActions.height).toBe(38)
      expect(bands.tagsBand.height).toBe(38)
    })
  }
)
