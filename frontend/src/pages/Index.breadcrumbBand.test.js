import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as sass from 'sass'
import { chromium, hasChromium, buildAppCss } from '../../test/realGridLayout.js'

/*
  OpenProject #2613: the breadcrumb trail and the sidebar's action row are two bands at the same
  vertical position, side by side, each ruled off with its own 1px hairline -- so their heights have
  to agree, or the two rules do not line up and the grounds meet at a step. `.page-breadcrumbs`
  (`Index.vue`) was 34px against `.sidebar-actions`' (`MainLayout.vue`) 38px.

  Measured in a real headless Chromium rather than the suite's default `happy-dom`, for the reason
  `test/realGridLayout.js` documents at length: no DOM emulator runs a layout engine, so every
  `getBoundingClientRect()` there comes back zeroed no matter what the CSS says, and this project has
  already been caught once (PR #43's overlay defect) trusting CSS reasoning over a real browser. The
  measurement is written inline here rather than added to `realGridLayout.js` -- that module's
  existing export is classification-grid-specific, and several sibling work packages are pointing at
  it in the same round.
*/

const selfDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = dirname(dirname(selfDir))

/*
  The rules under test are compiled from the SFCs' own `<style lang="scss">` text, not retyped as
  literals here: a copy would keep passing after somebody moved `.page-breadcrumbs` back to 34px,
  which is precisely the regression this guards. `vitest.config.js`'s `additionalData` injection is
  reproduced because both blocks reach for bare `$hairline` / `$surface` / `$slate`, exactly as the
  app build hands them.
*/
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
  'breadcrumb band height matches the sidebar action row — real layout',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let bands

    beforeAll(async () => {
      browser = await chromium.launch()

      /*
        `buildAppCss()` is the app's real `tailwind.css` through the same pipeline the build uses --
        needed here for Tailwind's preflight (`box-sizing: border-box`, which is what makes each
        band's 1px `border-bottom` sit INSIDE its declared height rather than on top of it) as well
        as for the `px-4 flex flex-wrap items-center` / `flex flex-nowrap items-stretch` utilities
        both bands carry in their own markup.
      */
      const [appCss, indexCss, layoutCss] = await Promise.all([
        buildAppCss(),
        compileStyleBlock('src/pages/Index.vue'),
        compileStyleBlock('src/layouts/MainLayout.vue')
      ])

      const page = await browser.newPage()
      try {
        /*
          The two bands as the app actually renders them: `.sidebar-actions` is the top strip of the
          sidebar column and `.page-breadcrumbs` the top strip of the content column beside it, so
          they share a top edge. `align-items: flex-start` keeps each box at its own natural height
          instead of the row stretching both to the taller one, which would hide the very difference
          being measured.
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
      expect(bands.sidebarActions.height).toBe(38)
      expect(bands.breadcrumbs.height).toBe(38)
    })
  }
)
