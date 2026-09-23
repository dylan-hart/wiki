import { afterEach, describe, expect, it, vi } from 'vitest'

const { i18nT, MockI18n } = vi.hoisted(() => {
  const i18nT = vi.fn((_key, fallback, params) =>
    fallback.replaceAll(/\{(\w+)\}/g, (match, name) =>
      params && name in params ? String(params[name]) : match
    )
  )
  class MockI18n {
    constructor(host) {
      this.host = host
      this.t = i18nT
    }
  }
  return { i18nT, MockI18n }
})
vi.mock('../shared/i18n.js', () => ({ I18n: MockI18n }))

import { BlockWhiteboardElement } from './component.js'
import { DEFAULT_COLOR, serializeBoard } from './board.js'
import { MAX_BLOCK_BYTES, MAX_STROKES } from './limits.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

const BOARD =
  '{"v":1,"w":400,"h":200,"s":[{"c":"#3366cc","z":4,"p":[10,20,50,60,80,50,120,40,50]}]}'
const EMPTY = '{"v":1,"w":800,"h":450,"s":[]}'

function editorRoot({ editable = true } = {}) {
  const root = document.createElement('div')
  root.className = 'ProseMirror'
  root.setAttribute('contenteditable', editable ? 'true' : 'false')
  document.body.appendChild(root)
  return root
}

function mountBoard(pre = BOARD, { editor = false, editable = true } = {}) {
  return mountBlock('block-whiteboard', {
    pre,
    parent: editor ? editorRoot({ editable }) : undefined
  })
}

function pointer(type, { pointerId = 1, pointerType = 'mouse', pressure = 0.5, ...rest } = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    composed: true,
    cancelable: true,
    button: 0,
    ...rest
  })
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    pressure: { value: pressure }
  })
  return event
}

const canvasOf = (el) => el.shadowRoot.querySelector('svg.canvas')
const pathsOf = (el) => [...el.shadowRoot.querySelectorAll('svg.canvas path')]
const errorOf = (el) => el.shadowRoot.querySelector('.error')

async function drawStroke(el, points, options = {}) {
  const canvas = canvasOf(el)
  const [first, ...rest] = points
  canvas.dispatchEvent(pointer('pointerdown', { clientX: first[0], clientY: first[1], ...options }))
  for (const [x, y] of rest) {
    canvas.dispatchEvent(pointer('pointermove', { clientX: x, clientY: y, ...options }))
  }
  canvas.dispatchEvent(pointer('pointerup', { ...options }))
  await el.updateComplete
}

function nextChange(el) {
  const events = []
  el.addEventListener('whiteboard-change', (event) => events.push(event))
  return events
}

describe('block-whiteboard', () => {
  afterEach(() => {
    resetBlockDom()
    i18nT.mockClear()
  })

  it('keeps static definition a plain literal carrying an empty board as its template', () => {
    const { definition } = BlockWhiteboardElement
    expect(definition.block).toBe('whiteboard')
    expect(definition.template).toBe(`\`\`\`whiteboard\n${EMPTY}\n\`\`\``)
  })

  describe('read-only view', () => {
    it('draws one filled path per stroke on a sheet the size of the board', async () => {
      const el = await mountBoard()

      expect(canvasOf(el).getAttribute('viewBox')).toBe('0 0 400 200')
      expect(pathsOf(el)).toHaveLength(1)
      expect(pathsOf(el)[0].getAttribute('fill')).toBe('#3366cc')
      expect(pathsOf(el)[0].getAttribute('d')).toMatch(/^M[0-9., QTLZ-]+Z$/)
      expect(errorOf(el)).toBeNull()
    })

    it('draws an empty board as an empty sheet, not an error', async () => {
      for (const pre of [EMPTY, '']) {
        const el = await mountBoard(pre)
        expect(canvasOf(el)).not.toBeNull()
        expect(pathsOf(el)).toHaveLength(0)
        expect(errorOf(el)).toBeNull()
      }
    })

    it('does not draw, capture or stop a pointer outside an editable ProseMirror', async () => {
      for (const options of [{}, { editor: true, editable: false }]) {
        const el = await mountBoard(BOARD, options)
        const changes = nextChange(el)
        const bubbled = vi.fn()
        document.body.addEventListener('pointerdown', bubbled)

        await drawStroke(el, [
          [5, 5],
          [50, 50]
        ])

        expect(el.drawingMode).toBe(false)
        expect(canvasOf(el).classList.contains('is-drawing')).toBe(false)
        expect(bubbled).toHaveBeenCalledTimes(1)
        expect(changes).toHaveLength(0)
        expect(pathsOf(el)).toHaveLength(1)
        document.body.removeEventListener('pointerdown', bubbled)
      }
    })

    it('reports a body it cannot read in the error box', async () => {
      const el = await mountBoard('{not json')

      expect(canvasOf(el)).toBeNull()
      expect(errorOf(el).textContent).toContain('could not be read')
      expect(i18nT).toHaveBeenCalledWith('blocks.whiteboard.errors.invalid', expect.any(String))
    })

    it('names the version of a board it cannot read', async () => {
      const el = await mountBoard('{"v":7,"s":[]}')

      expect(errorOf(el).textContent).toContain('format version 7')
    })

    it('refuses to draw a body over the size cap rather than drawing part of it', async () => {
      const strokes = Array.from({ length: MAX_STROKES + 1 }, () => ({
        c: '#000',
        z: 2,
        p: [1, 1, 1]
      }))
      const el = await mountBoard(JSON.stringify({ v: 1, w: 100, h: 100, s: strokes }))

      expect(canvasOf(el)).toBeNull()
      expect(errorOf(el).textContent).toContain('over the size limit of 256 KiB, 2000 strokes')
      expect(i18nT).toHaveBeenCalledWith(
        'blocks.whiteboard.errors.tooLarge',
        expect.any(String),
        expect.any(Object)
      )
    })

    it('renders hostile stroke data as inert, sanitised attributes', async () => {
      const hostile = JSON.stringify({
        v: 1,
        w: '<script>',
        h: Number.POSITIVE_INFINITY,
        s: [
          {
            c: '#fff" onload="alert(1)',
            z: '"><script>alert(1)</script>',
            p: [1e308, -1e308, 'x', 10, 10, 50, 20, 20, 50]
          },
          { c: 'javascript:alert(1)', z: 3, p: [5, 5, 5, 6, 6, 6] }
        ]
      })
      const el = await mountBoard(hostile)

      expect(el.shadowRoot.querySelector('script')).toBeNull()
      expect(el.shadowRoot.querySelector('[onload]')).toBeNull()
      expect(el.shadowRoot.querySelector('foreignObject')).toBeNull()
      expect(canvasOf(el).getAttribute('viewBox')).toBe('0 0 800 450')
      for (const path of pathsOf(el)) {
        expect(path.getAttribute('fill')).toBe(DEFAULT_COLOR)
        expect(path.getAttribute('d')).toMatch(/^[MQTLZ0-9., -]*$/)
        expect(path.getAttributeNames().sort()).toEqual(['d', 'fill'])
      }
    })
  })

  describe('drawing mode', () => {
    it('draws only inside an editable ProseMirror, with touch-action off', async () => {
      const el = await mountBoard(BOARD, { editor: true })

      expect(el.drawingMode).toBe(true)
      expect(canvasOf(el).classList.contains('is-drawing')).toBe(true)
    })

    it('dispatches the new body at stroke end and leaves its own light DOM alone', async () => {
      const el = await mountBoard(BOARD, { editor: true })
      const changes = nextChange(el)
      const outside = vi.fn()
      document.body.addEventListener('whiteboard-change', outside)

      await drawStroke(el, [
        [100, 100],
        [120, 110],
        [140, 130]
      ])

      expect(changes).toHaveLength(1)
      expect(changes[0].bubbles).toBe(true)
      expect(changes[0].composed).toBe(true)
      expect(outside).toHaveBeenCalledTimes(1)
      const written = JSON.parse(changes[0].detail.body)
      expect(Object.keys(written)).toEqual(['v', 'w', 'h', 's'])
      expect(written.s).toHaveLength(2)
      expect(written.s[1]).toEqual({
        c: DEFAULT_COLOR,
        z: 6,
        p: [100, 100, 50, 120, 110, 50, 140, 130, 50]
      })
      expect(el.querySelector('pre').textContent).toBe(BOARD)
      expect(pathsOf(el)).toHaveLength(2)
      document.body.removeEventListener('whiteboard-change', outside)
    })

    it('stops a drawing pointerdown from reaching the editor, and cancels its default', async () => {
      const el = await mountBoard(BOARD, { editor: true })
      const reached = vi.fn()
      el.parentElement.addEventListener('pointerdown', reached)
      const down = pointer('pointerdown', { clientX: 1, clientY: 1 })

      canvasOf(el).dispatchEvent(down)

      expect(reached).not.toHaveBeenCalled()
      expect(down.defaultPrevented).toBe(true)
    })

    it('ignores a secondary mouse button', async () => {
      const el = await mountBoard(BOARD, { editor: true })
      const changes = nextChange(el)

      await drawStroke(el, [[1, 1]], { button: 2 })

      expect(changes).toHaveLength(0)
    })

    it('records pen pressure, and a fixed mid pressure for mouse and touch', async () => {
      const el = await mountBoard(EMPTY, { editor: true })
      const changes = nextChange(el)

      await drawStroke(
        el,
        [
          [10, 10],
          [20, 20]
        ],
        { pointerType: 'pen', pressure: 0.83 }
      )
      await drawStroke(el, [[30, 30]], { pointerType: 'touch', pressure: 1, pointerId: 2 })

      const written = JSON.parse(changes[1].detail.body)
      expect(written.s[0].p).toEqual([10, 10, 83, 20, 20, 83])
      expect(written.s[1].p).toEqual([30, 30, 50])
    })

    it('clamps a pointer dragged off the sheet to the board edge', async () => {
      const el = await mountBoard('{"v":1,"w":100,"h":50,"s":[]}', { editor: true })
      const changes = nextChange(el)

      await drawStroke(el, [
        [-20, 10],
        [500, 900]
      ])

      expect(JSON.parse(changes[0].detail.body).s[0].p).toEqual([0, 10, 50, 100, 50, 50])
    })

    it('reads coalesced pointer events when the browser offers them', async () => {
      const el = await mountBoard(EMPTY, { editor: true })
      const changes = nextChange(el)
      const canvas = canvasOf(el)

      canvas.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }))
      const move = pointer('pointermove', { clientX: 30, clientY: 30 })
      move.getCoalescedEvents = () => [
        { clientX: 10, clientY: 10 },
        { clientX: 20, clientY: 20 },
        { clientX: 30, clientY: 30 }
      ]
      canvas.dispatchEvent(move)
      canvas.dispatchEvent(pointer('pointerup'))

      expect(JSON.parse(changes[0].detail.body).s[0].p).toEqual([
        0, 0, 50, 10, 10, 50, 20, 20, 50, 30, 30, 50
      ])
    })

    it('drops a stroke whose pointer is cancelled', async () => {
      const el = await mountBoard(BOARD, { editor: true })
      const changes = nextChange(el)
      const canvas = canvasOf(el)

      canvas.dispatchEvent(pointer('pointerdown', { clientX: 1, clientY: 1 }))
      canvas.dispatchEvent(pointer('pointermove', { clientX: 9, clientY: 9 }))
      canvas.dispatchEvent(pointer('pointercancel'))
      canvas.dispatchEvent(pointer('pointerup'))
      await el.updateComplete

      expect(changes).toHaveLength(0)
      expect(pathsOf(el)).toHaveLength(1)
    })

    it('ignores a second pointer while one stroke is in progress', async () => {
      const el = await mountBoard(EMPTY, { editor: true })
      const changes = nextChange(el)
      const canvas = canvasOf(el)

      canvas.dispatchEvent(pointer('pointerdown', { clientX: 1, clientY: 1 }))
      canvas.dispatchEvent(pointer('pointerdown', { clientX: 50, clientY: 50, pointerId: 2 }))
      canvas.dispatchEvent(pointer('pointermove', { clientX: 60, clientY: 60, pointerId: 2 }))
      canvas.dispatchEvent(pointer('pointerup', { pointerId: 2 }))
      canvas.dispatchEvent(pointer('pointerup'))

      expect(changes).toHaveLength(1)
      expect(JSON.parse(changes[0].detail.body).s[0].p).toEqual([1, 1, 50])
    })

    it('re-reads its body when the editor rewrites the fence, one undo step at a time', async () => {
      const el = await mountBoard(BOARD, { editor: true })
      const changes = nextChange(el)
      await drawStroke(el, [
        [100, 100],
        [150, 150]
      ])
      const drawn = changes[0].detail.body
      const pre = el.querySelector('pre')

      pre.textContent = drawn
      await Promise.resolve()
      await el.updateComplete
      expect(pathsOf(el)).toHaveLength(2)

      pre.textContent = BOARD
      await Promise.resolve()
      await el.updateComplete
      expect(pathsOf(el)).toHaveLength(1)

      pre.textContent = drawn
      await Promise.resolve()
      await el.updateComplete
      expect(pathsOf(el)).toHaveLength(2)

      pre.textContent = EMPTY
      await Promise.resolve()
      await el.updateComplete
      expect(pathsOf(el)).toHaveLength(0)
    })

    it('picks up a fence the editor adds after the element connected', async () => {
      const el = await mountBlock('block-whiteboard', { parent: editorRoot() })
      expect(pathsOf(el)).toHaveLength(0)

      const pre = document.createElement('pre')
      pre.textContent = BOARD
      el.appendChild(pre)
      await Promise.resolve()
      await el.updateComplete

      expect(pathsOf(el)).toHaveLength(1)
    })

    it('refuses a stroke that would take the body over the byte cap, keeping the board', async () => {
      const shell = serializeBoard({ w: 800, h: 450, s: [{ c: '#000000', z: 6, p: [] }] })
      const triples = Math.floor((MAX_BLOCK_BYTES - 100 - shell.length) / '100,100,50,'.length)
      const p = Array.from({ length: triples }, () => [100, 100, 50]).flat()
      const full = serializeBoard({ w: 800, h: 450, s: [{ c: '#000000', z: 6, p }] })
      expect(full.length).toBeLessThanOrEqual(MAX_BLOCK_BYTES)
      expect(full.length).toBeGreaterThan(MAX_BLOCK_BYTES - 150)
      const el = await mountBoard(full, { editor: true })
      const changes = nextChange(el)

      await drawStroke(el, [
        [10, 10],
        [20, 20],
        [30, 30],
        [40, 40],
        [50, 50],
        [60, 60],
        [70, 70],
        [80, 80],
        [90, 90],
        [110, 110],
        [120, 120],
        [130, 130],
        [140, 140],
        [150, 150],
        [160, 160],
        [170, 170],
        [180, 180],
        [190, 190],
        [200, 200]
      ])

      expect(changes).toHaveLength(0)
      expect(pathsOf(el)).toHaveLength(1)
      expect(errorOf(el).textContent).toContain('This whiteboard is full')
      expect(i18nT).toHaveBeenCalledWith(
        'blocks.whiteboard.errors.full',
        expect.any(String),
        expect.any(Object)
      )
    })

    it('refuses to start a stroke on a board already at the stroke cap', async () => {
      const strokes = Array.from({ length: MAX_STROKES }, () => ({ c: '#000', z: 2, p: [1, 1, 1] }))
      const el = await mountBoard(JSON.stringify({ v: 1, w: 100, h: 100, s: strokes }), {
        editor: true
      })
      const changes = nextChange(el)

      await drawStroke(el, [
        [10, 10],
        [20, 20]
      ])

      expect(changes).toHaveLength(0)
      expect(errorOf(el).textContent).toContain('This whiteboard is full')
      expect(canvasOf(el)).not.toBeNull()
    })
  })

  describe('beginStroke', () => {
    it('continues a pen press handed over by the editor, returning true', async () => {
      const el = await mountBoard(EMPTY, { editor: true })
      const changes = nextChange(el)
      await customElements.whenDefined('block-whiteboard')
      await el.updateComplete

      const started = el.beginStroke(
        pointer('pointerdown', {
          clientX: 40,
          clientY: 40,
          pointerType: 'pen',
          pressure: 0.4,
          pointerId: 9
        })
      )
      canvasOf(el).dispatchEvent(
        pointer('pointermove', {
          clientX: 60,
          clientY: 50,
          pointerType: 'pen',
          pressure: 0.6,
          pointerId: 9
        })
      )
      canvasOf(el).dispatchEvent(pointer('pointerup', { pointerType: 'pen', pointerId: 9 }))

      expect(started).toBe(true)
      expect(JSON.parse(changes[0].detail.body).s[0].p).toEqual([40, 40, 40, 60, 50, 60])
    })

    it('returns false outside drawing mode and on an unreadable body', async () => {
      const view = await mountBoard(EMPTY)
      const broken = await mountBoard('{nope', { editor: true })

      expect(view.beginStroke(pointer('pointerdown'))).toBe(false)
      expect(broken.beginStroke(pointer('pointerdown'))).toBe(false)
    })
  })

  describeDarkMode(() => mountBoard())
})
