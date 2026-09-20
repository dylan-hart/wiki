import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

const ALIASES = {
  '--block-border': '--color-hairline',
  '--block-radius': '--radius-card',
  '--block-tile-radius': '--radius-control',
  '--block-corner-marks': '--corner-marks',
  '--block-mark-color': '--color-slate-soft',
  '--block-tint-bg': '--color-tint',
  '--block-caption-fg': '--color-text-secondary',
  '--block-eyebrow-fg': '--color-text-caption',
  '--block-accent-fill': '--color-accent-fill',
  '--block-link-fg': '--color-accent-strong',
  '--block-error-bg': '--color-accent-wash',
  '--block-error-radius': '--radius-control'
}

let browser

describe('--block-* tokens under real Chromium, Cobalt light', { skip: !hasChromium() }, () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)

  afterAll(async () => {
    await browser?.close()
  })

  async function resolved(bodyClass) {
    const css = await buildAppCss()
    const page = await browser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head>` +
          `<body class="${bodyClass}"><div id="probe"></div></body></html>`
      )
      return await page.evaluate((aliases) => {
        const style = getComputedStyle(document.getElementById('probe'))
        const out = { aliases: {} }
        for (const [block, generic] of Object.entries(aliases)) {
          out.aliases[block] = {
            block: style.getPropertyValue(block).trim(),
            generic: style.getPropertyValue(generic).trim()
          }
        }
        out.errorBorder = style.getPropertyValue('--block-error-border').trim()
        out.accentFill = style.getPropertyValue('--color-accent-fill').trim()
        return out
      }, ALIASES)
    } finally {
      await page.close()
    }
  }

  it(
    'resolves --block-border to Cobalt’s hairline (#dfe5f5), not Ledger’s (#dbe1ec)',
    async () => {
      const { aliases } = await resolved('body--cobalt')

      expect(aliases['--block-border'].block).toBe('#dfe5f5')
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'resolves every --block-* alias to the generic token it names',
    async () => {
      const { aliases } = await resolved('body--cobalt')

      for (const [name, { block, generic }] of Object.entries(aliases)) {
        expect(block, name).toBe(generic)
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'draws the error border in Cobalt’s accent fill',
    async () => {
      const { errorBorder, accentFill } = await resolved('body--cobalt')

      expect(errorBorder).toBe(`1px dashed ${accentFill}`)
    },
    CHROMIUM_TIMEOUT
  )
})
