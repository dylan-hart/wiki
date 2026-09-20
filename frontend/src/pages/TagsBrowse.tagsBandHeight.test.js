import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/*
  `TagsBrowse.vue`'s "Browse by tags" band carries a page-local `min-height` override rather than
  raising the shared `.w-section-header` height: it has to track `.sidebar-actions`
  (`MainLayout.vue`), which sits at the same vertical position, so the two bands' bottom hairlines
  land on one line.

  Measured in a real headless Chromium -- neither `jsdom` nor `happy-dom` runs a layout engine, so
  `getBoundingClientRect()` there comes back zeroed regardless of what the CSS says. Both rules are
  read from the SFCs' own `<style>` text rather than retyped as literals here.
*/

const selfDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = dirname(dirname(selfDir))

async function compileStyleBlock(relativePath) {
  const source = await readFile(join(frontendRoot, relativePath), 'utf8')
  const block = source.match(/<style>([\s\S]*?)<\/style>/)
  if (!block) {
    throw new Error(`No <style> block found in ${relativePath}`)
  }
  return block[1]
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
        The app's real `tailwind.css` is needed for `.w-section-header`'s own rules -- this page's
        override only adds `min-height` -- and for Tailwind's preflight `box-sizing: border-box`,
        which keeps each band's 1px `border-bottom` inside its declared height rather than on top.
      */
      const [appCss, tagsCss, layoutCss] = await Promise.all([
        buildAppCss(),
        compileStyleBlock('src/pages/TagsBrowse.vue'),
        compileStyleBlock('src/layouts/MainLayout.vue')
      ])

      const page = await browser.newPage()
      try {
        /*
          `align-items: flex-start` keeps each box at its own natural height: stretching both to the
          taller one would hide the very difference being measured.
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
      expect(bands.sidebarActions.height).toBe(41)
      expect(bands.tagsBand.height).toBe(41)
    })
  }
)
