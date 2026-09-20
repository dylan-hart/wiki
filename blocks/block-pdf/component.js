import { LitElement, html } from 'lit'
import {
  getDocument,
  GlobalWorkerOptions,
  OutputScale,
  PasswordException,
  RenderingCancelledException,
  TextLayer
} from 'pdfjs-dist/build/pdf.mjs'

import { boolean } from '../shared/props.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { PAGE_GAP, textLayerStyles, viewerStyles } from './styles.js'
import { renderToolbar, ZOOM_LEVELS } from './toolbar.js'

/*
  `worker.js` compiles to `block-pdf.worker.js` beside this bundle, so the address is this file's own,
  one name over -- resolved from `import.meta.url` so nothing here has to agree with the server about
  a path. Unreachable, pdf.js falls back to parsing on the page's thread, which locks the wiki up for
  as long as a document takes to load.
*/
GlobalWorkerOptions.workerSrc = new URL('block-pdf.worker.js', import.meta.url).href

/*
  pdf.js fetches these for itself, and only once a document turns out to need one: the predefined CJK
  cmaps, the base 14 standard fonts, the JPEG 2000/JBIG2 decoder, and the CMYK profile. Files put
  beside the bundle by the build's `blockAssets` step rather than part of it; missing, each one is a
  silently half-drawn page.
*/
const DATA_URL = new URL('block-pdf/', import.meta.url).href

const MIN_SCALE = 0.1
const MAX_SCALE = 10

/**
 * Every drawn page is a canvas holding its own pixels, so a document read end to end would otherwise
 * accumulate all of them; a couple of pages of slack is what makes scrolling back a few lines free
 * rather than a redraw.
 */
const KEEP_PAGES = 2

/*
  pdf.js's own viewer defaults for what one page's canvas may cost. Past them a page is drawn at a
  lower resolution and scaled up by CSS -- a soft loss of sharpness, where asking a browser for a
  canvas larger than it will allocate is a hard failure, which 300% on a retina display already is.
*/
const MAX_CANVAS_PIXELS = 2 ** 25
const MAX_CANVAS_DIM = 32767

export class BlockPdfElement extends LitElement {
  /**
   * Read out of this source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'pdf',
    name: 'PDF Viewer',
    description: 'Displays a PDF document in a viewer, page by page.',
    icon: 'tabler:file-type-pdf',
    props: [
      {
        name: 'src',
        type: 'string',
        label: 'Document URL',
        hint: 'Path or URL of the PDF file to display.',
        required: true
      },
      {
        name: 'page',
        type: 'number',
        label: 'Opening Page',
        hint: 'Page to open the document at.',
        default: 1
      },
      {
        name: 'zoom',
        type: 'select',
        label: 'Zoom',
        options: ['page-width', 'page-fit', '50%', '75%', '100%', '125%', '150%', '200%', '300%'],
        hint: 'Size to draw the pages at. The reader can change it.',
        default: 'page-width'
      },
      {
        name: 'height',
        type: 'number',
        label: 'Height',
        hint: 'Height of the viewer in pixels. 0 lets it grow to the whole document instead.',
        default: 1024
      },
      {
        name: 'hide-toolbar',
        type: 'boolean',
        label: 'Hide Toolbar',
        hint: 'Leave out the page and zoom controls.',
        // -> Stated, so that a toggle switched on and then off again writes nothing into the page
        default: false
      }
    ]
  }

  static get styles() {
    return [errorBox, viewerStyles, textLayerStyles]
  }

  static get properties() {
    return {
      src: { type: String },
      page: { type: Number },
      zoom: { type: String },

      /** Pixels; 0 grows the viewer to the whole document instead of scrolling within a box. */
      height: { type: Number },

      /**
       * Explicit `attribute`: Lit's default lowercases the property name without inserting a dash,
       * so it would listen for `hidetoolbar` while the block picker writes `hide-toolbar`.
       */
      hideToolbar: { ...boolean, attribute: 'hide-toolbar' },

      _error: { state: true },
      _loading: { state: true },
      _progress: { state: true },
      _pageCount: { state: true },
      _currentPage: { state: true },
      _scale: { state: true },
      _zoom: { state: true }
    }
  }

  constructor() {
    super()
    this.src = ''
    this.page = 1
    this.zoom = 'page-width'
    this.height = 1024
    this.hideToolbar = false

    this._error = ''
    this._loading = false
    this._progress = 0
    this._pageCount = 0
    this._currentPage = 1
    this._scale = 1
    this._zoom = 'page-width'

    this._darkMode = new DarkMode(this)

    /** The address the loaded document was fetched from, so a re-render is not a reload. */
    this._loadedSrc = null
    this._loadingTask = null
    this._doc = null
    this._pages = []
    this._observer = null
    this._resizeObserver = null
    this._resizeFrame = null
  }

  get _scroller() {
    return this.renderRoot?.querySelector('.scroller') ?? null
  }

  get _pagesEl() {
    return this.renderRoot?.querySelector('.pages') ?? null
  }

  get _hasInnerScroll() {
    return this.height > 0
  }

  connectedCallback() {
    super.connectedCallback()
    /*
      A re-connection: disconnecting took the document and both observers with it, and the shadow
      tree they watched is still here. `hasUpdated` tells that from a first connection, where there
      is no shadow tree yet and `firstUpdated` does this instead.
    */
    if (this.hasUpdated) {
      this._setupObservers()
      this._load()
    }
  }

  firstUpdated() {
    this._zoom = this._parseZoom(this.zoom)
    this._setupObservers()
  }

  _setupObservers() {
    // -> The scroller is the scrolling ancestor to measure against, unless the block was told to
    //    grow to the document, in which case the page itself is.
    this._observer = new IntersectionObserver((entries) => this._onVisibility(entries), {
      root: this._hasInnerScroll ? this._scroller : null
    })
    this._resizeObserver = new ResizeObserver(() => this._onResize())
    if (this._scroller) {
      this._resizeObserver.observe(this._scroller)
    }
  }

  updated(changed) {
    if (changed.has('zoom') && this.zoom !== undefined) {
      const parsed = this._parseZoom(this.zoom)
      if (parsed !== this._zoom) {
        this._setZoom(parsed)
      }
    }
    if (changed.has('src')) {
      this._load()
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._teardown()
    this._observer?.disconnect()
    this._observer = null
    this._resizeObserver?.disconnect()
    this._resizeObserver = null
    cancelAnimationFrame(this._resizeFrame)
    this._resizeFrame = null
  }

  /**
   * A fitting mode or a percentage (`150%`, or `150` for an author who left the sign off). Anything
   * else falls back to the default rather than erroring: a viewer that will not open over its zoom
   * would be a poor trade.
   */
  _parseZoom(value) {
    const zoom = String(value ?? '').trim()
    if (zoom === 'page-fit') {
      return 'page-fit'
    }
    const percentage = Number.parseFloat(zoom)
    if (Number.isFinite(percentage) && percentage > 0) {
      return Math.min(Math.max(percentage / 100, MIN_SCALE), MAX_SCALE)
    }
    return 'page-width'
  }

  get _zoomValue() {
    return typeof this._zoom === 'number' ? `${Math.round(this._zoom * 100)}%` : this._zoom
  }

  /**
   * The address is resolved against the page it is written on, so a relative one means what an
   * author writing a link would expect. Fetching is left to pdf.js, which asks for ranges where the
   * server offers them and so can start showing a long document before all of it has arrived.
   */
  async _load() {
    const src = this.src?.trim()
    if (src === this._loadedSrc) {
      return
    }
    this._teardown()
    this._loadedSrc = src
    this._error = ''
    this._pageCount = 0
    this._currentPage = 1
    this._progress = 0

    if (!src) {
      this._error = 'This viewer needs the address of a PDF file.'
      return
    }

    let url
    try {
      url = new URL(src, window.location.href).href
    } catch {
      this._error = `${src} is not an address this viewer can open.`
      return
    }

    this._loading = true
    const task = getDocument({
      url,
      // -> pdf.js compiles some fonts and patterns with `eval` where it is allowed to; a wiki's CSP
      //    is the kind that turns that off, and the slower path draws the same thing.
      isEvalSupported: false,
      cMapUrl: `${DATA_URL}cmaps/`,
      standardFontDataUrl: `${DATA_URL}standard_fonts/`,
      wasmUrl: `${DATA_URL}wasm/`,
      iccUrl: `${DATA_URL}iccs/`
    })
    this._loadingTask = task
    task.onProgress = ({ loaded, total }) => {
      this._progress = total > 0 ? Math.min(loaded / total, 1) : 0
    }

    try {
      const doc = await task.promise
      // -> The block was detached, or asked for another document, while this one was being fetched
      if (this._loadingTask !== task) {
        doc.destroy()
        return
      }
      this._doc = doc
      this._pageCount = doc.numPages
      const first = await doc.getPage(1)
      this._baseSize = this._rawSize(first.getViewport({ scale: 1 }))
      this._loading = false
      await this.updateComplete
      this._buildPages()
      const opening = this._openingPage()
      // -> Page 1 is where the viewer already is, and a block grown to the whole document scrolls
      //    the wiki page itself to obey — dragging the reader past whatever is written above it.
      if (opening > 1) {
        this._goToPage(opening)
      }
    } catch (err) {
      if (this._loadingTask !== task) {
        return
      }
      this._loading = false
      this._error = this._explain(err, src)
    }
  }

  _openingPage() {
    const page = Number(this.page)
    if (!Number.isFinite(page)) {
      return 1
    }
    return Math.min(Math.max(Math.trunc(page), 1), this._pageCount)
  }

  _explain(err, src) {
    if (err instanceof PasswordException) {
      return 'This document is password-protected, and cannot be shown here.'
    }
    if (err?.name === 'InvalidPDFException') {
      return `The file at ${src} is not a PDF, or is damaged.`
    }
    // -> What pdf.js raises for a response it could not use, `missing` being its word for a 404
    if (err?.name === 'ResponseException') {
      return err.missing
        ? `No PDF was found at ${src}.`
        : `The server would not serve ${src} — ${err.message}`
    }
    return `This document could not be loaded from ${src} — ${err?.message ?? err}`
  }

  _rawSize(viewport) {
    const { pageWidth, pageHeight } = viewport.rawDims
    return { width: pageWidth, height: pageHeight, userUnit: viewport.userUnit || 1 }
  }

  /**
   * Every page gets its box straight away, so the scrollbar is the document's length from the first
   * moment. Sizes are the first page's guess until a page has been drawn and can say otherwise —
   * asking the worker for all of them up front is a round trip per page, and a document whose pages
   * differ in size is the rare one.
   *
   * Built by hand rather than from a template: each page holds a canvas that must survive every
   * re-render of the toolbar above it, and pdf.js writes into it and the text layer itself.
   */
  _buildPages() {
    const container = this._pagesEl
    if (!container) {
      return
    }
    container.replaceChildren()
    this._pages = []

    for (let num = 1; num <= this._pageCount; num++) {
      const el = document.createElement('div')
      el.className = 'page'
      el.dataset.page = String(num)

      const canvas = document.createElement('canvas')
      const textLayerEl = document.createElement('div')
      textLayerEl.className = 'textLayer'
      el.append(canvas, textLayerEl)
      container.append(el)

      this._pages.push({
        num,
        el,
        canvas,
        textLayerEl,
        raw: this._baseSize,
        visible: false,
        drawn: false,
        renderTask: null,
        textLayer: null,
        /*
          Bumped whenever the page is let go of, so a draw already in flight can tell that what it
          was drawing for is gone. Nothing else can stop it: the work up to the first `renderTask` is
          a request to the worker, with no handle to cancel.
        */
        epoch: 0
      })
    }

    this._scale = this._resolveScale()
    for (const entry of this._pages) {
      this._sizePage(entry)
      this._observer?.observe(entry.el)
    }
  }

  _sizePage(entry) {
    const total = this._scale * entry.raw.userUnit
    entry.el.style.setProperty('--scale-factor', this._scale)
    entry.el.style.setProperty('--user-unit', entry.raw.userUnit)
    entry.el.style.width = `${Math.floor(total * entry.raw.width)}px`
    entry.el.style.height = `${Math.floor(total * entry.raw.height)}px`
  }

  /**
   * The fitting modes are measured against the first page, which is what every page was laid out to
   * — fitting each page to itself would leave a document scrolling through a different size on every
   * page.
   */
  _resolveScale() {
    if (typeof this._zoom === 'number') {
      return this._zoom
    }
    const scroller = this._scroller
    const base = this._baseSize
    if (!scroller || !base) {
      return 1
    }
    const width = scroller.clientWidth - PAGE_GAP * 2
    if (width <= 0) {
      return 1
    }
    const scale =
      this._zoom === 'page-fit'
        ? Math.min(
            width / base.width,
            ((this._hasInnerScroll ? scroller.clientHeight : window.innerHeight) - PAGE_GAP * 2) /
              base.height
          )
        : width / base.width
    return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE)
  }

  /**
   * Everything drawn is thrown away rather than scaled: a canvas stretched to a new size is a
   * blurred page, and the text over it would be positioned for the old one.
   */
  _applyScale() {
    const scale = this._resolveScale()
    // -> A resize of a few pixels moves the scale by a few thousandths, not worth a redraw
    if (Math.abs(scale - this._scale) < 0.001) {
      return
    }
    const anchor = this._currentPage
    this._scale = scale
    for (const entry of this._pages) {
      this._releasePage(entry)
      this._sizePage(entry)
    }
    this._goToPage(anchor)
    this._syncRendering()
  }

  _setZoom(zoom) {
    this._zoom = zoom
    this._applyScale()
  }

  _stepZoom(direction) {
    const levels = direction > 0 ? ZOOM_LEVELS : [...ZOOM_LEVELS].reverse()
    const next = levels.find((level) =>
      direction > 0 ? level > this._scale + 0.001 : level < this._scale - 0.001
    )
    if (next) {
      this._setZoom(next)
    }
  }

  _onResize() {
    if (typeof this._zoom !== 'number') {
      // -> Coalesced: a drag of a window edge is a stream of these, and each one would redraw
      cancelAnimationFrame(this._resizeFrame)
      this._resizeFrame = requestAnimationFrame(() => this._applyScale())
    }
  }

  _onVisibility(entries) {
    for (const observed of entries) {
      const entry = this._pages[Number(observed.target.dataset.page) - 1]
      if (entry) {
        entry.visible = observed.isIntersecting
      }
    }
    this._trackCurrentPage()
    this._syncRendering()
  }

  /**
   * The page covering most of the viewport, not the topmost one showing: scrolled to the top of a
   * page, the page above is still intersecting by the sliver the gap leaves, and naming that one
   * would leave the counter a page behind all the way down.
   *
   * Measured here rather than from the observer's own rectangles, which arrive only for a page whose
   * intersecting-ness just changed — a page scrolled off behind another still carries the area it
   * had when it filled the screen, and would go on winning.
   */
  _trackCurrentPage() {
    const root = this._hasInnerScroll
      ? this._scroller?.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight }
    if (!root) {
      return
    }

    let showing = null
    let mostCovered = 0
    for (const entry of this._pages) {
      if (!entry.visible) {
        continue
      }
      const box = entry.el.getBoundingClientRect()
      // -> Height alone: the pages are in one column, so nothing is ever beside anything else
      const covered = Math.min(box.bottom, root.bottom) - Math.max(box.top, root.top)
      if (covered > mostCovered) {
        mostCovered = covered
        showing = entry
      }
    }
    if (showing) {
      this._currentPage = showing.num
    }
  }

  /**
   * The page either side of the visible run is drawn too, so scrolling on arrives at a page that is
   * already there rather than a blank one.
   */
  _syncRendering() {
    if (this._pages.length < 1) {
      return
    }
    const visible = this._pages.filter((entry) => entry.visible).map((entry) => entry.num)
    const anchor = visible.length > 0 ? visible : [this._currentPage]
    const from = Math.max(1, Math.min(...anchor) - 1)
    const to = Math.min(this._pageCount, Math.max(...anchor) + 1)

    for (const entry of this._pages) {
      if (entry.num >= from && entry.num <= to) {
        this._renderPage(entry)
      } else if (entry.num < from - KEEP_PAGES || entry.num > to + KEEP_PAGES) {
        this._releasePage(entry)
      }
    }
  }

  /**
   * The canvas is drawn at the device's pixel ratio and shown at the page's size, which is what
   * keeps a page sharp on a retina display — bounded by `limitCanvas`, pdf.js's own reckoning of
   * what a browser will actually allocate.
   */
  async _renderPage(entry) {
    const doc = this._doc
    if (entry.drawn || !doc) {
      return
    }
    const epoch = entry.epoch
    entry.drawn = true

    try {
      const page = await doc.getPage(entry.num)
      if (entry.epoch !== epoch) {
        return
      }

      const viewport = page.getViewport({ scale: this._scale })
      const raw = this._rawSize(viewport)
      // -> Now that the page itself has been read, its box can stop being the first page's guess
      if (raw.width !== entry.raw.width || raw.height !== entry.raw.height) {
        entry.raw = raw
        this._sizePage(entry)
      }

      const outputScale = new OutputScale()
      outputScale.limitCanvas(viewport.width, viewport.height, MAX_CANVAS_PIXELS, MAX_CANVAS_DIM)
      const canvas = entry.canvas
      canvas.width = Math.floor(viewport.width * outputScale.sx)
      canvas.height = Math.floor(viewport.height * outputScale.sy)

      const renderTask = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : null,
        background: '#ffffff'
      })
      entry.renderTask = renderTask
      await renderTask.promise
      entry.renderTask = null
      if (entry.epoch !== epoch) {
        return
      }

      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent({
          includeMarkedContent: true,
          disableNormalization: true
        }),
        container: entry.textLayerEl,
        viewport
      })
      entry.textLayer = textLayer
      await textLayer.render()
    } catch (err) {
      // -> A cancelled draw is the ordinary way a page in flight is abandoned, not a failure
      if (!(err instanceof RenderingCancelledException) && err?.name !== 'AbortException') {
        // oxlint-disable-next-line no-console -- one unrenderable page out of many is skipped silently on the page itself
        console.warn(`block-pdf: page ${entry.num} could not be drawn — ${err?.message ?? err}`)
      }
      entry.renderTask = null
      entry.drawn = false
    }
  }

  /** Leaves the page's box in place, so letting a page go does not shift the layout. */
  _releasePage(entry) {
    entry.epoch++
    entry.renderTask?.cancel()
    entry.renderTask = null
    entry.textLayer?.cancel()
    entry.textLayer = null
    entry.textLayerEl.replaceChildren()
    // -> Zeroing a canvas is what actually frees its pixels; clearing it only paints over them
    entry.canvas.width = 0
    entry.canvas.height = 0
    entry.drawn = false
  }

  _teardown() {
    for (const entry of this._pages) {
      this._releasePage(entry)
      this._observer?.unobserve(entry.el)
    }
    this._pages = []
    this._pagesEl?.replaceChildren()
    this._loadingTask?.destroy()
    this._loadingTask = null
    this._doc = null
    this._baseSize = null
    this._loading = false
    // -> So that opening the same address again is a reload rather than nothing at all
    this._loadedSrc = null
  }

  _goToPage(num) {
    const entry = this._pages[num - 1]
    if (!entry) {
      return
    }
    this._currentPage = entry.num
    if (this._hasInnerScroll) {
      this._scroller.scrollTop = entry.el.offsetTop - PAGE_GAP
    } else {
      entry.el.scrollIntoView({ block: 'start' })
    }
  }

  _onPageInput(ev) {
    const num = Number.parseInt(ev.target.value, 10)
    if (Number.isFinite(num) && num >= 1 && num <= this._pageCount) {
      this._goToPage(num)
    } else {
      ev.target.value = String(this._currentPage)
    }
  }

  _onZoomSelect(ev) {
    this._setZoom(this._parseZoom(ev.target.value))
  }

  _previousPage() {
    this._goToPage(Math.max(this._currentPage - 1, 1))
  }

  _nextPage() {
    this._goToPage(Math.min(this._currentPage + 1, this._pageCount))
  }

  _zoomIn() {
    this._stepZoom(1)
  }

  _zoomOut() {
    this._stepZoom(-1)
  }

  _renderToolbar() {
    return renderToolbar(
      {
        currentPage: this._currentPage,
        pageCount: this._pageCount,
        scale: this._scale,
        zoomValue: this._zoomValue,
        src: this.src
      },
      {
        onPreviousPage: this._previousPage,
        onNextPage: this._nextPage,
        onPageInput: this._onPageInput,
        onZoomOut: this._zoomOut,
        onZoomIn: this._zoomIn,
        onZoomSelect: this._onZoomSelect
      }
    )
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    return html`
      <div class="viewer">
        ${this.hideToolbar ? null : this._renderToolbar()}
        <div class="scroller" style=${this._hasInnerScroll ? `height: ${this.height}px` : ''}>
          <div class="pages"></div>
          ${
            this._loading
              ? html`
                  <div class="status">
                    Loading the
                    document${this._progress > 0 ? ` — ${Math.round(this._progress * 100)}%` : ''}…
                  </div>
                `
              : null
          }
        </div>
      </div>
    `
  }
}

window.customElements.define('block-pdf', BlockPdfElement)
