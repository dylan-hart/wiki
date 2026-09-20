import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium, hasChromium, buildAppCss } from '../../test/realGridLayout.js'

/*
  `.page-breadcrumbs` (`Index.vue`) and `.sidebar-actions` (`MainLayout.vue`) are two bands side by
  side at the same vertical position, each ruled off with its own 1px hairline, so their heights
  have to agree or the two rules miss each other and the grounds meet at a step.

  Measured in a real headless Chromium rather than the suite's default DOM emulator, which runs no
  layout engine: every `getBoundingClientRect()` there comes back zeroed whatever the CSS says.
*/

const selfDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = dirname(dirname(selfDir))

/*
  The rules under test are read from the SFCs' own `<style>` text rather than retyped here: a copy
  would go on passing after somebody changed a band's height, which is the regression this guards.
  No compile step -- both blocks are already plain, valid CSS.
*/
async function compileStyleBlock(relativePath) {
  const source = await readFile(join(frontendRoot, relativePath), 'utf8')
  const block = source.match(/<style>([\s\S]*?)<\/style>/)
  if (!block) {
    throw new Error(`No <style> block found in ${relativePath}`)
  }
  return block[1]
}

describe(
  'breadcrumb band height matches the sidebar action row — real layout',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let bands

    beforeAll(async () => {
      browser = await chromium.launch()

      /*
        The real `tailwind.css` is needed for its preflight as much as for the utilities the two
        bands carry: `box-sizing: border-box` is what makes each band's 1px `border-bottom` sit
        INSIDE its declared height rather than on top of it.
      */
      const [appCss, indexCss, layoutCss] = await Promise.all([
        buildAppCss(),
        compileStyleBlock('src/pages/Index.vue'),
        compileStyleBlock('src/layouts/MainLayout.vue')
      ])

      const page = await browser.newPage()
      try {
        /*
          The two bands as the app renders them, sharing a top edge. `align-items: flex-start` keeps
          each box at its own natural height: stretching both to the taller one would hide the very
          difference being measured.
        */
        await page.setContent(
          '<!doctype html><html><head><style>' +
            appCss +
            indexCss +
            layoutCss +
            '</style></head><body class="body--light" style="margin:0">' +
            '<div style="display:flex;align-items:flex-start;width:1280px">' +
            '<div class="sidebar-actions flex flex-nowrap items-stretch" style="width:260px">' +
            '<button class="w-btn flex-1 px-2" type="button">en</button>' +
            '</div>' +
            '<div class="page-breadcrumbs px-4 flex flex-wrap items-center" style="flex:1">' +
            '<div class="min-w-0 flex-1">Home / Docs / Getting started</div>' +
            '</div>' +
            '</div></body></html>'
        )
        bands = await page.evaluate(() => {
          const read = (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect()
            return { top: rect.top, bottom: rect.bottom, height: rect.height }
          }
          return {
            sidebarActions: read('.sidebar-actions'),
            breadcrumbs: read('.page-breadcrumbs')
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
      expect(bands.breadcrumbs.top).toBe(bands.sidebarActions.top)
    })

    it('rules both bands off on the same line', () => {
      expect(bands.breadcrumbs.bottom).toBe(bands.sidebarActions.bottom)
    })

    it('draws the breadcrumb band at the sidebar action row height', () => {
      expect(bands.sidebarActions.height).toBe(41)
      expect(bands.breadcrumbs.height).toBe(41)
    })
  }
)
