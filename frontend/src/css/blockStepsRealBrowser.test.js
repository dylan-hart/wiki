import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * `block-steps` is a light-DOM element, so its steps are drawn by `_page-contents.css`, not by a
 * shadow root. The block's own element writes `counter-reset: cardinal-step <start-1>` inline on an
 * `ol[start]`; the fixtures below write the same inline style so the stylesheet is tested against
 * the contract rather than against the component.
 */

const dir = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

function stepsBlock() {
  const start = source.indexOf('  block-steps {')
  if (start === -1) {
    throw new Error('block-steps rules not found in _page-contents.css -- moved or renamed?')
  }
  const next = source.indexOf('\n  li {', start)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('_page-contents.css block-steps source (OpenProject #3586)', () => {
  const block = stepsBlock()

  it('numbers each step from the cardinal-step counter on a ::before disc', () => {
    expect(block).toMatch(/counter-increment:\s*cardinal-step/)
    expect(block).toMatch(/content:\s*counter\(cardinal-step\)/)
    expect(block).toMatch(/background-color:\s*var\(--content-step-bg\)/)
    expect(block).toMatch(/color:\s*var\(--content-step-fg\)/)
  })

  it('derives the connecting line from the disc colour so the two cannot drift', () => {
    expect(block).toMatch(/color-mix\([^)]*var\(--content-step-bg\)/)
  })

  it('positions with logical properties only, so RTL mirrors', () => {
    expect(block).not.toMatch(/(?:^|[\s;])(?:left|right)\s*:/m)
    expect(block).not.toMatch(/(?:margin|padding)-(?:left|right)/)
    expect(block).toMatch(/inset-inline-start/)
    expect(block).toMatch(/padding-inline-start/)
  })

  it('introduces no hard-coded colour', () => {
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(block).not.toMatch(/\brgba?\(/)
  })

  it('defines the step tokens for Ledger light and Ledger dark as well as Cobalt', () => {
    const ledgerLight = source.slice(
      source.indexOf('.page-contents {'),
      source.indexOf('.body--dark & {')
    )
    expect(ledgerLight).toMatch(/--content-step-bg:/)
    expect(ledgerLight).toMatch(/--content-step-fg:/)
    const dark = source.slice(
      source.indexOf('.body--dark & {'),
      source.indexOf('body.body--cobalt & {')
    )
    expect(dark).toMatch(/--content-step-bg:/)
    expect(dark).toMatch(/--content-step-fg:/)
  })
})

let browser

describe('block-steps under real Chromium (OpenProject #3586)', { skip: !hasChromium() }, () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)

  afterAll(async () => {
    await browser?.close()
  })

  const STEPS = `
      <block-steps>
        <ol>
          <li><p>First</p></li>
          <li><p>Second</p><p>More on the second</p></li>
          <li><p>Third</p></li>
        </ol>
      </block-steps>`

  const STEPS_FROM_4 = `
      <block-steps>
        <ol start="4" style="counter-reset: cardinal-step 3">
          <li><p>Fourth</p></li>
          <li><p>Fifth</p></li>
          <li><p>Sixth</p></li>
        </ol>
      </block-steps>`

  const NESTED = `<ol><li>Outer<div>${STEPS}</div></li></ol>`

  async function measure(bodyClass, markup, dirAttr = 'ltr') {
    const appCss = await buildAppCss()
    const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
    const page = await browser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html dir="${dirAttr}"><head><style>${appCss}</style><style>${contentCss}</style></head>` +
          `<body class="${bodyClass}"><article class="page-contents">${markup}</article></body></html>`
      )
      const cdp = await page.context().newCDPSession(page)
      const { nodes } = await cdp.send('Accessibility.getFullAXTree')
      const numerals = nodes
        .filter((n) => n.role?.value === 'StaticText' && /^\d+$/.test(n.name?.value ?? ''))
        .map((n) => n.name.value)
      const measured = await page.evaluate(() => {
        const article = document.querySelector('.page-contents')
        const probe = document.createElement('i')
        probe.style.backgroundColor = 'var(--content-step-bg)'
        probe.style.color = 'var(--content-step-fg)'
        article.append(probe)
        const tokens = {
          bg: getComputedStyle(probe).backgroundColor,
          fg: getComputedStyle(probe).color
        }
        probe.remove()
        const items = [...article.querySelectorAll('block-steps > ol > li')].map((li) => {
          const before = getComputedStyle(li, '::before')
          const after = getComputedStyle(li, '::after')
          const liBox = li.getBoundingClientRect()
          const firstP = li.querySelector('p').getBoundingClientRect()
          return {
            content: before.content,
            width: before.width,
            height: before.height,
            background: before.backgroundColor,
            color: before.color,
            listStyle: getComputedStyle(li).listStyleType,
            lineContent: after.content,
            lineWidth: after.width,
            lineBackground: after.backgroundColor,
            lineHeight: after.height,
            liHeight: liBox.height,
            paragraphTopOffset: firstP.top - liBox.top
          }
        })
        return { tokens, items }
      })
      return { ...measured, numerals }
    } finally {
      await page.close()
    }
  }

  const CASES = [
    ['Ledger light', 'body--ledger body--light'],
    ['Ledger dark', 'body--ledger body--dark'],
    ['Cobalt light', 'body--cobalt body--light'],
    ['Cobalt dark', 'body--cobalt body--dark']
  ]

  for (const [name, bodyClass] of CASES) {
    describe(name, () => {
      it(
        'draws three discs numbered 1-3 with a line between them',
        async () => {
          const { tokens, items, numerals } = await measure(bodyClass, STEPS)
          expect(numerals).toEqual(['1', '2', '3'])
          for (const item of items) {
            expect(item.width).toBe('24px')
            expect(item.height).toBe('24px')
            expect(item.background).toBe(tokens.bg)
            expect(item.color).toBe(tokens.fg)
            expect(item.listStyle).toBe('none')
          }
          expect(tokens.bg).not.toBe('rgba(0, 0, 0, 0)')
          expect(items[0].lineContent).not.toBe('none')
          expect(items[1].lineContent).not.toBe('none')
          expect(items[0].lineWidth).toBe('2px')
          expect(items[0].lineBackground).not.toBe('rgba(0, 0, 0, 0)')
          expect(items[0].lineBackground).not.toBe(tokens.bg)
          expect(items[2].lineContent).toBe('none')
        },
        CHROMIUM_TIMEOUT
      )

      it(
        'starts at 4 for an ol[start=4]',
        async () => {
          const { numerals } = await measure(bodyClass, STEPS_FROM_4)
          expect(numerals).toEqual(['4', '5', '6'])
        },
        CHROMIUM_TIMEOUT
      )

      it(
        'keeps the numbering when the block sits inside another ordered list item',
        async () => {
          const { items, numerals } = await measure(bodyClass, NESTED)
          expect(numerals.slice(-3)).toEqual(['1', '2', '3'])
          expect(items.every((i) => i.width === '24px')).toBe(true)
        },
        CHROMIUM_TIMEOUT
      )

      it(
        'lines a loose step up with its disc and runs the line to the next disc',
        async () => {
          const { items } = await measure(bodyClass, STEPS)
          expect(items[0].paragraphTopOffset).toBe(0)
          expect(items[1].paragraphTopOffset).toBe(0)
          expect(Number.parseFloat(items[1].lineHeight)).toBeGreaterThan(items[1].liHeight - 40)
        },
        CHROMIUM_TIMEOUT
      )
    })
  }

  it(
    'mirrors the disc and line to the inline-start edge in RTL',
    async () => {
      const appCss = await buildAppCss()
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html dir="rtl"><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="body--ledger body--light"><article class="page-contents">${STEPS}</article></body></html>`
        )
        const result = await page.evaluate(() => {
          return {
            paddingRight: getComputedStyle(document.querySelector('block-steps > ol')).paddingRight,
            paddingLeft: getComputedStyle(document.querySelector('block-steps > ol')).paddingLeft
          }
        })
        expect(result.paddingRight).not.toBe('0px')
        expect(result.paddingLeft).toBe('0px')
      } finally {
        await page.close()
      }
    },
    CHROMIUM_TIMEOUT
  )
})
