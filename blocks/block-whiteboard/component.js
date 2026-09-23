import { LitElement, css, html, svg } from 'lit'

import { readFencedSource } from '../shared/body.js'
import { I18n } from '../shared/i18n.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import {
  DEFAULT_COLOR,
  DEFAULT_SIZE,
  PRESSURE_SCALE,
  appendStroke,
  clampNumber,
  exceedsCap,
  measureBody,
  parseBoard,
  serializeBoard,
  strokePath
} from './board.js'
import { MAX_BLOCK_BYTES, MAX_POINTS, MAX_STROKES } from './limits.js'

const EDITABLE_ANCESTOR = '.ProseMirror[contenteditable="true"]'

function capturePointer(el, pointerId) {
  try {
    el.setPointerCapture?.(pointerId)
    return true
  } catch {
    return false
  }
}

export class BlockWhiteboardElement extends LitElement {
  static definition = {
    block: 'whiteboard',
    name: 'Whiteboard',
    description:
      'Freehand ink with pen pressure. Drawn on in the editor, read-only on the published page.',
    icon: 'tabler:scribble',
    template: `\`\`\`whiteboard
{"v":2,"w":800,"h":450}
\`\`\``
  }

  static get styles() {
    return [
      errorBox,
      css`
        :host {
          display: block;
        }

        .board,
        .error {
          margin-bottom: 16px;
        }

        .board {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .sheet {
          box-sizing: border-box;
          width: 100%;
          border: 1px solid rgba(0, 0, 0, 0.1);
          border-radius: 5px;
          background-color: #fff;
          overflow: hidden;
        }
        :host([dark]) .sheet {
          border-color: rgba(255, 255, 255, 0.15);
        }

        .canvas {
          display: block;
          width: 100%;
          height: auto;
          user-select: none;
          -webkit-user-select: none;
        }

        .canvas.is-drawing {
          touch-action: none;
          cursor: crosshair;
        }
      `
    ]
  }

  static get properties() {
    return {
      _board: { state: true },
      _loadError: { state: true },
      _full: { state: true },
      _live: { state: true }
    }
  }

  constructor() {
    super()
    this._board = null
    this._dropped = 0
    this._loadError = null
    this._full = false
    this._live = null
    this._source = null
    this._lastDispatched = null
    this._lastDispatchedBoard = null
    this._activePointer = null
    this._pen = false
    this._paths = new WeakMap()
    this._observer = null
    this._darkMode = new DarkMode(this)
    this._i18n = new I18n(this)
  }

  connectedCallback() {
    super.connectedCallback()
    this._readBody()
    this._observer = new MutationObserver(() => this._readBody())
    this._observer.observe(this, { childList: true, subtree: true, characterData: true })
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._observer?.disconnect()
    this._observer = null
    this._activePointer = null
    this._live = null
  }

  get drawingMode() {
    return Boolean(this.closest(EDITABLE_ANCESTOR))
  }

  _readBody() {
    const { source } = readFencedSource(this)
    if (source === this._source) {
      return
    }
    this._source = source
    this._full = false
    if (source === this._lastDispatched && this._lastDispatchedBoard) {
      this._board = this._lastDispatchedBoard
      this._loadError = null
      return
    }
    const result = parseBoard(source)
    if (result.error) {
      this._board = null
      this._dropped = 0
      this._loadError = result
      return
    }
    this._board = result.board
    this._dropped = result.dropped
    this._loadError = null
  }

  _canvas() {
    return this.renderRoot?.querySelector?.('.canvas') ?? null
  }

  beginStroke(event) {
    if (!this._board || !this.drawingMode || this._activePointer !== null) {
      return false
    }
    const canvas = this._canvas()
    if (!canvas) {
      return false
    }
    if (this._board.s.length + this._dropped >= MAX_STROKES) {
      this._full = true
      return false
    }
    this._activePointer = event.pointerId
    this._pen = event.pointerType === 'pen'
    capturePointer(canvas, event.pointerId)
    this._live = { c: DEFAULT_COLOR, z: DEFAULT_SIZE, p: [] }
    this._addPoints([event])
    return true
  }

  _addPoints(events) {
    const canvas = this._canvas()
    if (!canvas || !this._live) {
      return
    }
    const { w, h } = this._board
    const rect = canvas.getBoundingClientRect()
    const scaleX = rect.width > 0 ? w / rect.width : 1
    const scaleY = rect.height > 0 ? h / rect.height : 1
    const p = [...this._live.p]
    for (const event of events) {
      const x = Math.round(clampNumber((event.clientX - rect.left) * scaleX, 0, w, 0))
      const y = Math.round(clampNumber((event.clientY - rect.top) * scaleY, 0, h, 0))
      const pressure = this._pen ? clampNumber(event.pressure, 0, 1, 0.5) : 0.5
      const pr = Math.round(pressure * PRESSURE_SCALE)
      const at = p.length
      if (at >= 3 && p[at - 3] === x && p[at - 2] === y) {
        p[at - 1] = Math.max(p[at - 1], pr)
        continue
      }
      p.push(x, y, pr)
    }
    this._live = { ...this._live, p }
  }

  _onPointerDown(event) {
    if (!this.drawingMode) {
      return
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    event.stopPropagation()
    event.preventDefault()
    this.beginStroke(event)
  }

  _onPointerMove(event) {
    if (event.pointerId !== this._activePointer) {
      return
    }
    event.stopPropagation()
    event.preventDefault()
    const coalesced = event.getCoalescedEvents?.() ?? []
    this._addPoints(coalesced.length > 0 ? coalesced : [event])
  }

  _onPointerUp(event) {
    if (event.pointerId !== this._activePointer) {
      return
    }
    event.stopPropagation()
    this._activePointer = null
    this._finishStroke()
  }

  _onPointerCancel(event) {
    if (event.pointerId !== this._activePointer) {
      return
    }
    this._activePointer = null
    this._live = null
  }

  _finishStroke() {
    const stroke = this._live
    this._live = null
    if (!stroke || stroke.p.length < 3 || !this._board) {
      return
    }
    const next = { ...this._board, s: [...this._board.s, stroke] }
    const base = this._board === this._lastDispatchedBoard ? this._lastDispatched : this._source
    const body = base ? appendStroke(base, stroke) : serializeBoard(next)
    if (exceedsCap(measureBody(body))) {
      this._full = true
      return
    }
    this._full = false
    this._board = next
    this._lastDispatched = body
    this._lastDispatchedBoard = next
    this.dispatchEvent(
      new CustomEvent('whiteboard-change', { bubbles: true, composed: true, detail: { body } })
    )
  }

  _pathFor(stroke) {
    let d = this._paths.get(stroke)
    if (d === undefined) {
      d = strokePath(stroke)
      this._paths.set(stroke, d)
    }
    return d
  }

  _limitText() {
    return this._i18n.t(
      'blocks.whiteboard.errors.limit',
      '{bytes} KiB, {strokes} strokes or {points} points',
      {
        bytes: MAX_BLOCK_BYTES / 1024,
        strokes: MAX_STROKES,
        points: MAX_POINTS
      }
    )
  }

  _loadErrorMessage() {
    const { error, version } = this._loadError
    if (error === 'tooLarge') {
      return this._i18n.t(
        'blocks.whiteboard.errors.tooLarge',
        'This whiteboard is over the size limit of {limit}, so it is not drawn. Nothing has been removed from it.',
        { limit: this._limitText() }
      )
    }
    if (error === 'version') {
      return this._i18n.t(
        'blocks.whiteboard.errors.version',
        'This whiteboard was saved in format version {version}, which this block cannot read.',
        { version }
      )
    }
    return this._i18n.t(
      'blocks.whiteboard.errors.invalid',
      'This whiteboard could not be read. Its body has to be the drawing data the editor writes, inside a ```whiteboard fence.'
    )
  }

  _fullMessage() {
    return this._i18n.t(
      'blocks.whiteboard.errors.full',
      'This whiteboard is full. That stroke would take it over the size limit of {limit}, so it was not added.',
      { limit: this._limitText() }
    )
  }

  _renderStroke(stroke, d) {
    return svg`<path d=${d} fill=${stroke.c}></path>`
  }

  render() {
    if (this._loadError) {
      return renderError(this._loadErrorMessage())
    }
    if (!this._board) {
      return null
    }
    const { w, h, s } = this._board
    const drawing = this.drawingMode
    const live = this._live
    return html`
      <div class="board" contenteditable="false">
        <div class="sheet" style="max-width: ${w + 2}px">
          <svg
            class="canvas ${drawing ? 'is-drawing' : ''}"
            viewBox="0 0 ${w} ${h}"
            role="img"
            aria-label="Whiteboard"
            @pointerdown=${this._onPointerDown}
            @pointermove=${this._onPointerMove}
            @pointerup=${this._onPointerUp}
            @pointercancel=${this._onPointerCancel}>
            ${s.map((stroke) => this._renderStroke(stroke, this._pathFor(stroke)))}
            ${live ? this._renderStroke(live, strokePath(live, { last: false })) : null}
          </svg>
        </div>
        ${this._full ? renderError(this._fullMessage()) : null}
      </div>
    `
  }
}

window.customElements.define('block-whiteboard', BlockWhiteboardElement)
