import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * Two layers, because each catches what the other cannot:
 *   - source text of `_base.css`, so a header regression shows up with no browser needed;
 *   - the real compiled app CSS in real Chromium, on buttons carrying the inline `min-height`/
 *     `padding` styles `WBtn` writes, since the whole reason for the `!important`s and the
 *     `:has()` gap rule is a cascade fight that jsdom/happy-dom cannot resolve.
 */

const CSS_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(CSS_DIR, '..')
const baseCss = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')

function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  return match ? match[1] : null
}

describe('.flush-hover-btn rule shapes (source)', () => {
  it('squares the corners of every flush button except a cap', () => {
    const body = ruleBody(baseCss, '.w-btn.flush-hover-btn:not(.flush-hover-btn--cap)')
    expect(body).not.toBeNull()
    expect(body).toMatch(/border-radius:\s*0\s*!important/)
  })

  it('states no width, height or min-height of its own -- it is size-agnostic', () => {
    const bodies = [
      ruleBody(baseCss, '.w-btn.flush-hover-btn'),
      ruleBody(baseCss, '.w-btn.flush-hover-btn:not(.flush-hover-btn--cap)'),
      ruleBody(baseCss, '.w-btn.flush-hover-btn--square')
    ]
    for (const body of bodies) {
      expect(body).not.toBeNull()
      expect(body).not.toMatch(/(?<![-\w])(?:width|height|min-height|max-height)\s*:/)
    }
  })

  it('zeroes the inline padding only for the --square modifier', () => {
    expect(ruleBody(baseCss, '.w-btn.flush-hover-btn--square')).toMatch(/padding:\s*0\s*!important/)
    expect(ruleBody(baseCss, '.w-btn.flush-hover-btn')).not.toMatch(/padding/)
  })

  it('has no rule that squares a --cap button', () => {
    expect(baseCss).not.toMatch(/\.flush-hover-btn--cap\s*\{[^}]*border-radius:\s*0/)
  })

  it('draws the shared hover fill behind (hover: hover)', () => {
    const block = baseCss.match(
      /@media \(hover: hover\) \{\s*\.w-btn\.flush-hover-btn:hover \{([^}]*)\}/
    )
    expect(block).not.toBeNull()
    expect(block[1]).toMatch(/color-mix\(in srgb, currentcolor 16%, transparent\)/)
  })

  it('removes the Cobalt group gap for groups holding a flush button', () => {
    const body = ruleBody(baseCss, 'body.body--cobalt .w-btn-group:has(> .flush-hover-btn)')
    expect(body).toMatch(/gap:\s*0/)
  })

  it('puts no flush-hover rule in tailwind.css (owned by _base.css)', () => {
    const tailwind = readFileSync(resolve(CSS_DIR, 'tailwind.css'), 'utf-8')
    expect(tailwind).not.toMatch(/flush-hover-btn/)
  })
})

describe('header nav regression (source)', () => {
  it('keeps .header-nav-btn as the 64x64 box, unchanged', () => {
    const body = ruleBody(baseCss, '.w-btn.header-nav-btn')
    expect(body).toMatch(/min-height:\s*64px\s*!important/)
    expect(body).toMatch(/width:\s*64px\s*!important/)
    expect(body).toMatch(/padding:\s*0\s*!important/)
  })

  it('no longer carries its own hover fill or shape -- those come from .flush-hover-btn', () => {
    expect(baseCss).not.toMatch(/\.w-btn\.header-nav-btn:hover/)
    expect(ruleBody(baseCss, '.w-btn.header-nav-btn')).not.toMatch(/border-radius|margin/)
  })

  it.each([
    ['components/HeaderNav.vue', 8],
    ['layouts/AdminLayout.vue', 1],
    ['components/AccountMenu.vue', 1]
  ])('%s puts every header-nav-btn on the shared class too', (file, count) => {
    const source = readFileSync(resolve(SRC_DIR, file), 'utf-8')
    const withBoth = source.match(/class="[^"]*\bflush-hover-btn\b[^"]*\bheader-nav-btn\b[^"]*"/g)
    const withNav = source.match(/class="[^"]*\bheader-nav-btn\b[^"]*"/g)
    expect(withNav).toHaveLength(count)
    expect(withBoth).toHaveLength(count)
  })
})

let browser

describe('.flush-hover-btn under real Chromium', { skip: !hasChromium() }, () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)

  afterAll(async () => {
    await browser?.close()
  })

  // -> `buildAppCss()` compiles `tailwind.css` alone; `_base.css` is one of `app.css`'s own
  //    `@import`s, so it is appended by hand, after it, as the app loads it
  async function appCss() {
    return `${await buildAppCss()}\n${baseCss}`
  }

  // -> Inline styles copied from what WBtn's `styles` computed writes, so the cascade fight is real
  const INLINE = {
    plain: 'min-height:2.572em;padding:0 1.12em',
    dense: 'min-height:2.24em;padding:0 0.8em',
    round: 'min-width:3em;min-height:3em;padding:0'
  }

  async function measure(bodyClass, html) {
    const css = await appCss()
    const page = await browser.newPage()
    try {
      await page.setViewportSize({ width: 800, height: 400 })
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head>` +
          `<body class="${bodyClass}"><div id="root" style="width:600px;color:rgb(20,30,50)">${html}</div></body></html>`
      )
      return await page.evaluate(() => {
        const out = {}
        for (const el of document.querySelectorAll('[data-k]')) {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          out[el.dataset.k] = {
            w: Math.round(r.width * 100) / 100,
            h: Math.round(r.height * 100) / 100,
            left: Math.round(r.left * 100) / 100,
            right: Math.round(r.right * 100) / 100,
            radius: cs.borderTopLeftRadius,
            marginStart: cs.marginInlineStart
          }
        }
        return out
      })
    } finally {
      await page.close()
    }
  }

  async function hoverBackground(bodyClass, cls, inline) {
    const css = await appCss()
    const page = await browser.newPage({ hasTouch: false })
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head>` +
          `<body class="${bodyClass}"><button class="w-btn ${cls}" style="color:rgb(255,255,255);${inline}">x</button></body></html>`
      )
      await page.hover('.w-btn')
      return await page.evaluate(
        () => getComputedStyle(document.querySelector('.w-btn')).backgroundColor
      )
    } finally {
      await page.close()
    }
  }

  it(
    'squares round and rounded buttons and drops their margin, at any size',
    async () => {
      for (const bodyClass of ['body--ledger', 'body--cobalt', 'body--cobalt body--dark']) {
        const got = await measure(
          bodyClass,
          `<button data-k="round" class="w-btn flush-hover-btn rounded-full" style="${INLINE.round};margin-inline-start:8px">x</button>` +
            `<button data-k="pill" class="w-btn flush-hover-btn rounded-[28px]" style="${INLINE.plain}">x</button>` +
            `<button data-k="big" class="w-btn flush-hover-btn rounded-full" style="font-size:24px;${INLINE.round}">x</button>`
        )
        for (const k of ['round', 'pill', 'big']) {
          expect(got[k].radius, `${bodyClass} ${k}`).toBe('0px')
          expect(got[k].marginStart, `${bodyClass} ${k}`).toBe('0px')
        }
        // -> A round WBtn is already a square box; the class must not disturb it, at any size
        expect(got.round.w).toBe(got.round.h)
        expect(got.big.w).toBe(got.big.h)
        expect(got.big.h).toBeGreaterThan(got.round.h)
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    '--square makes an icon-only button a true square at default, dense and large sizes',
    async () => {
      const got = await measure(
        'body--ledger',
        `<button data-k="plain" class="w-btn flush-hover-btn flush-hover-btn--square" style="${INLINE.plain}">x</button>` +
          `<button data-k="dense" class="w-btn flush-hover-btn flush-hover-btn--square" style="${INLINE.dense}">x</button>` +
          `<button data-k="large" class="w-btn flush-hover-btn flush-hover-btn--square" style="font-size:24px;${INLINE.plain}">x</button>`
      )
      for (const k of ['plain', 'dense', 'large']) {
        expect(got[k].w, k).toBe(got[k].h)
      }
      expect(got.large.h).toBeGreaterThan(got.plain.h)
      expect(got.plain.h).toBeGreaterThan(got.dense.h)
    },
    CHROMIUM_TIMEOUT
  )

  it(
    '--cap keeps the button own rounded corners',
    async () => {
      const got = await measure(
        'body--cobalt',
        `<button data-k="cap" class="w-btn flush-hover-btn flush-hover-btn--cap rounded-full" style="${INLINE.round}">x</button>` +
          `<button data-k="pillcap" class="w-btn flush-hover-btn flush-hover-btn--cap rounded-[28px]" style="${INLINE.plain}">x</button>` +
          `<button data-k="flat" class="w-btn flush-hover-btn rounded-full" style="${INLINE.round}">x</button>`
      )
      expect(parseFloat(got.cap.radius)).toBeGreaterThan(10)
      expect(parseFloat(got.pillcap.radius)).toBeGreaterThan(10)
      expect(got.flat.radius).toBe('0px')
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'sits flush in a Cobalt group (no gap) but the group keeps its gap without a flush button',
    async () => {
      const flush = await measure(
        'body--cobalt',
        `<div class="w-btn-group inline-flex flex-nowrap">` +
          `<button data-k="a" class="w-btn flush-hover-btn rounded-full" style="${INLINE.round}">x</button>` +
          `<button data-k="b" class="w-btn flush-hover-btn rounded-full" style="${INLINE.round}">x</button></div>`
      )
      expect(flush.b.left).toBe(flush.a.right)

      const plain = await measure(
        'body--cobalt',
        `<div class="w-btn-group inline-flex flex-nowrap">` +
          `<button data-k="a" class="w-btn rounded-full" style="${INLINE.round}">x</button>` +
          `<button data-k="b" class="w-btn rounded-full" style="${INLINE.round}">x</button></div>`
      )
      expect(plain.b.left - plain.a.right).toBe(8)
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'fills the hover with the current text color at 16%, light and dark, on a cap too',
    async () => {
      for (const bodyClass of ['body--ledger', 'body--cobalt body--dark']) {
        for (const cls of ['flush-hover-btn', 'flush-hover-btn flush-hover-btn--cap']) {
          const bg = await hoverBackground(bodyClass, cls, INLINE.round)
          expect(bg, `${bodyClass} ${cls}`).toMatch(
            /^(?:rgba\(255, 255, 255, 0\.16\)|color\(srgb 1 1 1 \/ 0\.16\))$/
          )
        }
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'header nav buttons keep their exact 64x64 flush box',
    async () => {
      const got = await measure(
        'body--cobalt',
        `<div class="w-btn-group inline-flex flex-nowrap">` +
          `<button data-k="a" class="w-btn flush-hover-btn header-nav-btn" style="${INLINE.plain}">x</button>` +
          `<button data-k="b" class="w-btn flush-hover-btn header-nav-btn rounded-full" style="${INLINE.round}">x</button></div>`
      )
      for (const k of ['a', 'b']) {
        expect(got[k].w).toBe(64)
        expect(got[k].h).toBe(64)
        expect(got[k].radius).toBe('0px')
        expect(got[k].marginStart).toBe('0px')
      }
      expect(got.b.left).toBe(got.a.right)
    },
    CHROMIUM_TIMEOUT
  )
})
