import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MarkdownRenderer } from '../renderers/markdown.js'
import {
  CHROMIUM_TIMEOUT,
  buildAppCss,
  buildRenderedContentScript,
  chromium,
  hasChromium
} from '../../test/realGridLayout.js'

const contentCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '_page-contents.css'),
  'utf-8'
)

const CODE = [
  'const a = true',
  'const b = false',
  'const c = null // ' + 'a very long line '.repeat(30),
  'const d = undefined'
].join('\n')

const md = new MarkdownRenderer({})
const startedAndHighlighted = md.render(`\`\`\`js linesStart=30 linesHighlight=32\n${CODE}\n\`\`\``)
const plain = md.render(`\`\`\`js\n${CODE}\n\`\`\``)
const highlightedOnly = md.render(`\`\`\`js linesHighlight=3\n${CODE}\n\`\`\``)
const singleLineHighlighted = md.render('```js linesHighlight=1\nconst a = true\n```')

const titled = `<div class="codeblock-titled hljs"><div class="codeblock-title">deploy.js</div>${plain}</div>`

const PAGE = `
  <div class="page-contents">
    <div id="titled">${titled}</div>
    <div id="started">${startedAndHighlighted}</div>
    <div id="plain">${plain}</div>
    <div id="highlighted">${highlightedOnly}</div>
    <div id="single">${singleLineHighlighted}</div>
  </div>
`

const AESTHETICS = [
  { name: 'Ledger light', body: 'body--ledger body--light', radius: '0px' },
  { name: 'Ledger dark', body: 'body--ledger body--dark', radius: '0px' },
  { name: 'Cobalt light', body: 'body--cobalt body--light', radius: '8px' },
  { name: 'Cobalt dark', body: 'body--cobalt body--dark', radius: '8px' }
]

function parseColor(value) {
  const srgb = /^color\(srgb ([^)]+)\)$/.exec(value)
  if (srgb) {
    const [r, g, b, a = 1] = srgb[1].split(/[ /]+/).filter(Boolean).map(Number)
    return { r: r * 255, g: g * 255, b: b * 255, a }
  }
  const match = /rgba?\(([^)]+)\)/.exec(value)
  const [r, g, b, a = 1] = match[1]
    .split(/[ ,/]+/)
    .filter(Boolean)
    .map(Number)
  return { r, g, b, a }
}

function luminance({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function over(top, bottom) {
  const a = top.a
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1
  }
}

describe(
  'code-fence title bar, highlighted lines and start number under real Chromium (OpenProject #3588)',
  {
    skip: !hasChromium()
  },
  () => {
    let browser
    let appCss
    let renderedContentScript

    beforeAll(async () => {
      browser = await chromium.launch()
      appCss = await buildAppCss()
      renderedContentScript = await buildRenderedContentScript()
    }, CHROMIUM_TIMEOUT)

    afterAll(async () => {
      await browser?.close()
    })

    async function withPage(bodyClass, run) {
      const page = await browser.newPage({ viewport: { width: 700, height: 800 } })
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${bodyClass}">${PAGE}<script>${renderedContentScript}</script></body></html>`
        )
        await page.evaluate(() =>
          window.RenderedContent.enhanceRenderedContent(
            document.querySelector('.page-contents'),
            (key) => key
          )
        )
        return await run(page)
      } finally {
        await page.close()
      }
    }

    describe.each(AESTHETICS)('$name', ({ body, radius }) => {
      it(
        'draws the title bar flush above the panel, matched to it and carrying the aesthetic radius',
        async () => {
          const measured = await withPage(body, (page) =>
            page.evaluate(() => {
              const wrapper = document.querySelector('.codeblock-titled')
              const bar = wrapper.querySelector('.codeblock-title')
              const pre = wrapper.querySelector('pre')
              const barBox = bar.getBoundingClientRect()
              const preBox = pre.getBoundingClientRect()
              const barStyle = getComputedStyle(bar)
              const preStyle = getComputedStyle(pre)
              return {
                gap: preBox.top - barBox.bottom,
                leftDelta: preBox.left - barBox.left,
                widthDelta: preBox.width - barBox.width,
                barBackground: barStyle.backgroundColor,
                preBackground: preStyle.backgroundColor,
                barTopLeft: barStyle.borderTopLeftRadius,
                barTopRight: barStyle.borderTopRightRadius,
                barBottomLeft: barStyle.borderBottomLeftRadius,
                preTopLeft: preStyle.borderTopLeftRadius,
                preBottomLeft: preStyle.borderBottomLeftRadius,
                barText: bar.textContent
              }
            })
          )

          expect(measured.barText).toBe('deploy.js')
          expect(Math.abs(measured.gap)).toBeLessThan(1)
          expect(measured.leftDelta).toBe(0)
          expect(measured.widthDelta).toBe(0)
          expect(measured.barBackground).toBe(measured.preBackground)
          expect(measured.barBackground).not.toBe('rgba(0, 0, 0, 0)')
          expect(measured.barTopLeft).toBe(radius)
          expect(measured.barTopRight).toBe(radius)
          expect(measured.barBottomLeft).toBe('0px')
          expect(measured.preTopLeft).toBe('0px')
          expect(measured.preBottomLeft).toBe(radius)
        },
        CHROMIUM_TIMEOUT
      )

      it(
        'paints a legible wash on exactly the highlighted row, behind the text, without growing the scroll width',
        async () => {
          const measured = await withPage(body, (page) =>
            page.evaluate(() => {
              const pre = document.querySelector('#started pre')
              const code = pre.querySelector('code')
              const rows = [...pre.querySelectorAll('.line-numbers-rows > span')]
              const lineHeight = rows[1].getBoundingClientRect().height
              const codeTop = code.getBoundingClientRect().top
              const highlighted = rows.filter((row) => row.classList.contains('is-highlighted'))
              const rowStyle = (row) => getComputedStyle(row)
              return {
                rowCount: rows.length,
                highlightedCount: highlighted.length,
                highlightedIndex: rows.indexOf(highlighted[0]),
                highlightedOffset: highlighted[0].getBoundingClientRect().top - codeTop,
                lineHeight,
                washBackground: rowStyle(highlighted[0]).backgroundColor,
                washShadow: rowStyle(highlighted[0]).boxShadow,
                plainRowBackground: rowStyle(rows[0]).backgroundColor,
                rowsZIndex: getComputedStyle(pre.querySelector('.line-numbers-rows')).zIndex,
                ink: getComputedStyle(pre).color,
                ground: getComputedStyle(pre).backgroundColor,
                scrollWidthHighlighted: pre.scrollWidth,
                scrollWidthPlain: document.querySelector('#plain pre').scrollWidth
              }
            })
          )

          expect(measured.rowCount).toBe(4)
          expect(measured.highlightedCount).toBe(1)
          expect(measured.highlightedIndex).toBe(2)
          expect(measured.highlightedOffset).toBeCloseTo(2 * measured.lineHeight, 0)
          expect(measured.plainRowBackground).toBe('rgba(0, 0, 0, 0)')
          expect(measured.washBackground).not.toBe('rgba(0, 0, 0, 0)')
          expect(measured.washShadow).not.toBe('none')
          expect(measured.rowsZIndex).toBe('-1')
          expect(measured.scrollWidthHighlighted).toBe(measured.scrollWidthPlain)

          const wash = parseColor(measured.washBackground)
          const ground = parseColor(measured.ground)
          expect(wash.a).toBeGreaterThan(0.1)
          expect(wash.a).toBeLessThan(0.3)
          expect(contrast(parseColor(measured.ink), over(wash, ground))).toBeGreaterThanOrEqual(4.5)
        },
        CHROMIUM_TIMEOUT
      )

      it(
        'washes a highlighted row in a block with no gutter, over the full width and without adding height',
        async () => {
          const measured = await withPage(body, (page) =>
            page.evaluate(() => {
              const pre = document.querySelector('#single pre')
              const row = pre.querySelector('.line-numbers-rows > span.is-highlighted')
              const code = pre.querySelector('code')
              const rowBox = row.getBoundingClientRect()
              const codeBox = code.getBoundingClientRect()
              return {
                numbered: pre.classList.contains('line-numbers'),
                rowHeight: rowBox.height,
                rowWidth: rowBox.width,
                codeWidth: codeBox.width,
                codeHeight: codeBox.height,
                washBackground: getComputedStyle(row).backgroundColor
              }
            })
          )

          expect(measured.numbered).toBe(false)
          expect(measured.rowHeight).toBeGreaterThan(10)
          expect(measured.codeHeight).toBeCloseTo(measured.rowHeight, 0)
          expect(measured.rowWidth).toBeCloseTo(measured.codeWidth, 0)
          expect(measured.washBackground).not.toBe('rgba(0, 0, 0, 0)')
        },
        CHROMIUM_TIMEOUT
      )

      it(
        'numbers the gutter from the fence linesStart, and from 1 for a fence without one',
        async () => {
          const numbers = await withPage(body, async (page) => {
            await page.evaluate(() => {
              for (const rows of document.querySelectorAll('.line-numbers-rows')) {
                rows.removeAttribute('aria-hidden')
              }
            })
            const client = await page.context().newCDPSession(page)
            await client.send('Accessibility.enable')
            const { nodes } = await client.send('Accessibility.getFullAXTree')
            const gutterNumbers = nodes
              .filter((node) => node.role?.value === 'StaticText' && /^\d+$/.test(node.name?.value))
              .map((node) => node.name.value)
            return gutterNumbers
          })

          expect(numbers).toEqual([
            '1',
            '2',
            '3',
            '4',
            '30',
            '31',
            '32',
            '33',
            '1',
            '2',
            '3',
            '4',
            '1',
            '2',
            '3',
            '4'
          ])
        },
        CHROMIUM_TIMEOUT
      )
    })
  }
)
