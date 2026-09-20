import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LightboxController, scrollerOf } from './lightbox.js'

/**
 * jsdom does not implement `HTMLDialogElement#showModal` (a real `<dialog>` throws `TypeError:
 * showModal is not a function`), so the controller is driven against stand-ins for its host and its
 * dialog rather than against a real block.
 */

function makeFakeDialog() {
  return {
    showModal: vi.fn(),
    close: vi.fn()
  }
}

class FakeHost {
  constructor({ dialog = makeFakeDialog() } = {}) {
    this.dialog = dialog
    this.updateComplete = Promise.resolve()
    this.updateRequests = 0
    this.renderRoot = { querySelector: () => this.dialog }
  }

  addController() {
    // -> Only has to be callable; the controller keeps no reference back.
  }

  requestUpdate() {
    this.updateRequests += 1
  }
}

describe('shared/lightbox.js: scrollerOf()', () => {
  let outer
  let inner
  let leaf

  beforeEach(() => {
    outer = document.createElement('div')
    inner = document.createElement('div')
    leaf = document.createElement('div')
    outer.appendChild(inner)
    inner.appendChild(leaf)
    document.body.appendChild(outer)
  })

  afterEach(() => {
    outer.remove()
  })

  /** jsdom never runs layout, so scrollHeight/clientHeight are stubbed rather than real. */
  function makeScrollable(el, { scrollHeight = 400, clientHeight = 200 } = {}) {
    el.style.overflowY = 'auto'
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  }

  it('finds the nearest ancestor that both allows overflow and has something to overflow', () => {
    makeScrollable(inner)

    expect(scrollerOf(leaf)).toBe(inner)
  })

  it('skips an ancestor whose overflow allows scrolling but has nothing to scroll', () => {
    inner.style.overflowY = 'auto'
    Object.defineProperty(inner, 'scrollHeight', { value: 200, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 200, configurable: true })
    makeScrollable(outer)

    expect(scrollerOf(leaf)).toBe(outer)
  })

  it('skips an ancestor with something to overflow but overflow: visible', () => {
    inner.style.overflowY = 'visible'
    Object.defineProperty(inner, 'scrollHeight', { value: 400, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 200, configurable: true })
    makeScrollable(outer)

    expect(scrollerOf(leaf)).toBe(outer)
  })

  it('falls back to the document scrolling element when no ancestor scrolls', () => {
    expect(scrollerOf(leaf)).toBe(document.scrollingElement ?? document.documentElement)
  })
})

describe('shared/lightbox.js: LightboxController', () => {
  it('registers itself as a controller on the host', () => {
    const host = new FakeHost()
    const addController = vi.spyOn(host, 'addController')

    const lightbox = new LightboxController(host, { count: () => 3 })

    expect(addController).toHaveBeenCalledWith(lightbox)
  })

  it('starts closed', () => {
    const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })

    expect(lightbox.index).toBe(-1)
  })

  describe('wrap()', () => {
    it('brings an out-of-range index back into range, wrapping past the end to the start', () => {
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })

      expect(lightbox.wrap(3)).toBe(0)
      expect(lightbox.wrap(4)).toBe(1)
    })

    it('wraps a negative index to the end', () => {
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })

      expect(lightbox.wrap(-1)).toBe(2)
    })
  })

  describe('open()', () => {
    it('sets the index, requests an update, shows the dialog only once the update has landed, and holds the page', async () => {
      const order = []
      const host = new FakeHost()
      host.requestUpdate = () => order.push('requestUpdate')
      host.updateComplete = Promise.resolve().then(() => order.push('updateComplete'))
      host.dialog.showModal = vi.fn(() => order.push('showModal'))
      const lightbox = new LightboxController(host, { count: () => 3 })

      await lightbox.open(1)

      expect(lightbox.index).toBe(1)
      expect(order).toEqual(['requestUpdate', 'updateComplete', 'showModal'])
    })

    it('calls onIndexChange with the opened index, after requestUpdate()', async () => {
      const order = []
      const host = new FakeHost()
      host.requestUpdate = () => order.push('requestUpdate')
      const onIndexChange = (index) => order.push(`onIndexChange:${index}`)
      const lightbox = new LightboxController(host, { count: () => 3, onIndexChange })

      await lightbox.open(2)

      expect(order).toEqual(['requestUpdate', 'onIndexChange:2'])
    })

    it('locks the page scroll position while open', async () => {
      document.documentElement.style.overflow = ''
      document.documentElement.scrollTop = 50
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })

      await lightbox.open(0)

      expect(document.documentElement.style.overflow).toBe('hidden')
    })
  })

  describe('previous() / next() / step()', () => {
    it('steps forward and wraps past the end', () => {
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })
      lightbox.index = 2

      lightbox.next()

      expect(lightbox.index).toBe(0)
    })

    it('steps backward and wraps past the start', () => {
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })
      lightbox.index = 0

      lightbox.previous()

      expect(lightbox.index).toBe(2)
    })

    it('reads the count fresh on every step, so a list that changed size still wraps correctly', () => {
      let count = 3
      const lightbox = new LightboxController(new FakeHost(), { count: () => count })
      lightbox.index = 2

      count = 2
      lightbox.next()

      // -> wrap(3) against a count of 2 is 1; a count cached at construction would have given 0.
      expect(lightbox.index).toBe(1)
    })

    it('calls onIndexChange with the new index', () => {
      const onIndexChange = vi.fn()
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3, onIndexChange })
      lightbox.index = 0

      lightbox.next()

      expect(onIndexChange).toHaveBeenCalledWith(1)
    })
  })

  describe('close()', () => {
    it('closes the dialog without touching the index directly', () => {
      const host = new FakeHost()
      const lightbox = new LightboxController(host, { count: () => 3 })
      lightbox.index = 1

      lightbox.close()

      expect(host.dialog.close).toHaveBeenCalled()
      // -> The index is cleared by onClose(), fired by the dialog's `close` event, not by close().
      expect(lightbox.index).toBe(1)
    })
  })

  describe('onClose()', () => {
    it('clears the index, releases the page hold, and notifies with -1', async () => {
      document.documentElement.style.overflow = ''
      document.documentElement.scrollTop = 50
      const onIndexChange = vi.fn()
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3, onIndexChange })
      await lightbox.open(1)
      onIndexChange.mockClear()

      lightbox.onClose()

      expect(lightbox.index).toBe(-1)
      expect(document.documentElement.style.overflow).toBe('')
      expect(onIndexChange).toHaveBeenCalledWith(-1)
    })
  })

  describe('onKeydown()', () => {
    it('steps to the previous item on ArrowLeft, preventing the default', () => {
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })
      lightbox.index = 1
      const ev = { key: 'ArrowLeft', preventDefault: vi.fn() }

      lightbox.onKeydown(ev)

      expect(ev.preventDefault).toHaveBeenCalled()
      expect(lightbox.index).toBe(0)
    })

    it('steps to the next item on ArrowRight, preventing the default', () => {
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })
      lightbox.index = 1
      const ev = { key: 'ArrowRight', preventDefault: vi.fn() }

      lightbox.onKeydown(ev)

      expect(ev.preventDefault).toHaveBeenCalled()
      expect(lightbox.index).toBe(2)
    })

    it("leaves every other key alone -- Escape included, which is the dialog's own to handle", () => {
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })
      lightbox.index = 1
      const ev = { key: 'Escape', preventDefault: vi.fn() }

      lightbox.onKeydown(ev)

      expect(ev.preventDefault).not.toHaveBeenCalled()
      expect(lightbox.index).toBe(1)
    })
  })

  describe('onStageClick()', () => {
    it('closes on a click directly on the dialog (target === currentTarget)', () => {
      const host = new FakeHost()
      const lightbox = new LightboxController(host, { count: () => 3 })
      const dialogEl = {}

      lightbox.onStageClick({
        target: dialogEl,
        currentTarget: dialogEl,
        classList: { contains: () => false }
      })

      expect(host.dialog.close).toHaveBeenCalled()
    })

    it('closes on a click on the stage element itself', () => {
      const host = new FakeHost()
      const lightbox = new LightboxController(host, { count: () => 3 })
      const stage = { classList: { contains: (name) => name === 'stage' } }

      lightbox.onStageClick({ target: stage, currentTarget: {} })

      expect(host.dialog.close).toHaveBeenCalled()
    })

    it('leaves the lightbox open on a click on content drawn over the stage', () => {
      const host = new FakeHost()
      const lightbox = new LightboxController(host, { count: () => 3 })
      const button = { classList: { contains: () => false } }

      lightbox.onStageClick({ target: button, currentTarget: {} })

      expect(host.dialog.close).not.toHaveBeenCalled()
    })

    it('honors a custom stageClass', () => {
      const host = new FakeHost()
      const lightbox = new LightboxController(host, { count: () => 3, stageClass: 'frame' })
      const frame = { classList: { contains: (name) => name === 'frame' } }

      lightbox.onStageClick({ target: frame, currentTarget: {} })

      expect(host.dialog.close).toHaveBeenCalled()
    })
  })

  describe('hostDisconnected()', () => {
    it('releases the page hold if the host is removed while the lightbox is still open', async () => {
      document.documentElement.style.overflow = ''
      document.documentElement.scrollTop = 75
      const lightbox = new LightboxController(new FakeHost(), { count: () => 3 })
      await lightbox.open(0)
      expect(document.documentElement.style.overflow).toBe('hidden')

      lightbox.hostDisconnected()

      expect(document.documentElement.style.overflow).toBe('')
    })
  })

  describe('dialogSelector option', () => {
    it('looks up the dialog through a custom selector', () => {
      const dialog = makeFakeDialog()
      const host = new FakeHost({ dialog })
      host.renderRoot = { querySelector: vi.fn(() => dialog) }
      const lightbox = new LightboxController(host, {
        count: () => 3,
        dialogSelector: '.my-dialog'
      })

      expect(lightbox.dialog).toBe(dialog)
      expect(host.renderRoot.querySelector).toHaveBeenCalledWith('.my-dialog')
    })
  })

  describe('bound methods', () => {
    it('every public method keeps its `this` when detached, so a Lit template needs no arrow wrapper', () => {
      const host = new FakeHost()
      const lightbox = new LightboxController(host, { count: () => 3 })
      const { previous, next, close, onClose, onKeydown, onStageClick } = lightbox

      expect(() => previous()).not.toThrow()
      expect(() => next()).not.toThrow()
      expect(() => close()).not.toThrow()
      expect(() => onClose()).not.toThrow()
      expect(() => onKeydown({ key: 'Escape' })).not.toThrow()
      expect(() =>
        onStageClick({ target: { classList: { contains: () => false } }, currentTarget: {} })
      ).not.toThrow()
    })
  })
})
