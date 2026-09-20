import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { fetchIcon } from '../shared/icons.js'
import { DarkMode } from '../shared/theme.js'

/**
 * Asked of a block that might be hiding the element the event was dispatched on: the app sends it
 * at a heading before scrolling to it (`frontend/src/helpers/anchors.js`). Matched by name only, so
 * a block answers it or ignores it and neither side has to know about the other.
 */
const REVEAL_EVENT = 'block-reveal'

export class BlockTabsElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * has to stay a plain literal.
   *
   * `template` is the body the picker writes into the page. A block that has one is fenced with
   * `:::`, so the `::block-tab` children inside it read as blocks of their own rather than as the
   * end of this one.
   */
  static definition = {
    block: 'tabs',
    name: 'Tabs',
    description: 'Groups content into tabbed panels.',
    icon: 'tabler:tabs',
    template: `::block-tab{label="First tab"}
Content of the first tab.
::

::block-tab{label="Second tab"}
Content of the second tab.
::`,
    props: [
      {
        name: 'active',
        type: 'number',
        label: 'Open Panel',
        hint: 'Which panel is open when the page loads, zero-based.',
        default: 0
      }
    ]
  }

  static get styles() {
    return css`
      :host {
        display: block;
      }

      /* -> The marks sit outside .tabs' own box, so they need this to position against. */
      .tabs-wrap {
        position: relative;
        margin-bottom: 16px;
      }

      /*
        Clipping to the radius is what rounds the strip's top corners and the panel's bottom ones
        without either of them having to know where it sits.
      */
      .tabs {
        border: 1px solid var(--tabs-border);
        border-radius: var(--tabs-radius);
        overflow: hidden;
        box-shadow: var(--tabs-shadow);
      }

      /*
        Four gradients draw the two opposite corner marks; the aesthetic decides display. A
        sibling of .tabs rather than a child: .tabs clips its own content to round its corners, and
        a mark drawn outside that frame would be clipped away with it.
      */
      .tabs-marks {
        display: var(--tabs-corner-marks);
        position: absolute;
        inset: -5px;
        pointer-events: none;
        background:
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 7px 1px no-repeat,
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 1px 7px no-repeat,
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 7px 1px
            no-repeat,
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 1px 7px
            no-repeat;
      }

      /*
        The bottom rule is the panel's top edge; the tabs are pulled down onto it so the active one
        can paint over its own stretch and open the seam into the panel. gap does double duty in a
        wrapping flex row: between tabs on one line AND between wrapped lines.
      */
      .strip {
        display: flex;
        flex-wrap: wrap;
        gap: var(--tabs-strip-gap);
        margin: 0;
        padding: var(--tabs-strip-padding);
        border-bottom: var(--tabs-strip-rule);
        background-color: var(--tabs-strip-bg);
      }

      .tab {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-bottom: -1px;
        padding: var(--tabs-tab-padding);
        border: 0;
        border-right: var(--tabs-tab-rule);
        border-bottom: 1px solid transparent;
        border-radius: var(--tabs-tab-radius);
        background-color: transparent;
        color: var(--tabs-inactive-fg);
        font: inherit;
        font-size: 13.5px;
        font-weight: 500;
        line-height: 1.4;
        cursor: pointer;
        transition:
          background-color 0.15s ease,
          color 0.15s ease;
      }
      .tab svg {
        width: 1.15em;
        height: 1.15em;
        flex-shrink: 0;
        color: var(--tabs-inactive-icon);
      }
      .tab:hover:not(.is-active) {
        background-color: var(--tabs-hover-bg);
        color: var(--tabs-hover-fg);
      }
      .tab:hover:not(.is-active) svg {
        color: var(--tabs-hover-fg);
      }
      /* -> Inset shadow rather than an outline, so the ring follows the tab's own radius */
      .tab:focus-visible {
        outline: none;
        box-shadow: var(--tabs-focus-ring);
      }

      .tab.is-active {
        border-bottom-color: var(--tabs-panel-bg);
        background-color: var(--tabs-panel-bg);
        color: var(--tabs-active-fg);
        font-weight: var(--tabs-active-weight);
        box-shadow: var(--tabs-active-cap);
      }
      .tab.is-active svg {
        color: var(--tabs-active-fg);
      }
      /* -> Both shadows stack: the cap stays visible while the ring shows focus */
      .tab.is-active:focus-visible {
        box-shadow: var(--tabs-focus-ring), var(--tabs-active-cap);
      }

      .panel {
        padding: var(--tabs-panel-padding);
        background-color: var(--tabs-panel-bg);
      }

      /*
        599.98px is the app's own phone breakpoint (--breakpoint-sm, 600px, in css/tailwind.css),
        written out because a block cannot read the app's variables. (No backticks in here: the
        whole stylesheet is a template literal, and one would end it mid-rule.)
      */
      @media (max-width: 599.98px) {
        .panel {
          padding: 12px;
        }
      }

      ::slotted(block-tab) {
        margin-bottom: 0;
      }

      @media print {
        :host {
          --tabs-border: #999;
          --tabs-radius: 0;
          --tabs-shadow: none;
          --tabs-corner-marks: none;
          --tabs-panel-bg: #fff;
        }

        .tabs {
          overflow: visible;
        }

        .strip,
        .tabs-marks {
          display: none;
        }

        .panel {
          padding: 0;
          background-color: #fff;
        }

        ::slotted(block-tab) {
          display: block !important;
          padding: 8px 12px;
        }

        ::slotted(block-tab:not(:last-child)) {
          border-bottom: 1px solid #999;
        }

        ::slotted(block-tab)::before {
          content: attr(data-print-label);
          display: block;
          margin-bottom: 8px;
          color: #000;
          font-weight: 600;
          break-after: avoid;
        }
      }
    `
  }

  static get properties() {
    return {
      _tabs: { state: true },
      /*
        A property rather than internal state because two things outside the block use it: an author
        opening on a later panel (`<block-tabs active="1">`), and the markdown editor, which carries
        it across the preview rebuild every keystroke triggers so the block does not snap back to
        the first tab while an author is typing in the second.
      */
      active: { type: Number }
    }
  }

  constructor() {
    super()
    this._tabs = []
    this.active = 0
    // -> Bound once, so that removing the listener later takes the same function that was added
    this._onReveal = this._onReveal.bind(this)
    /*
      No rule above keys off `[dark]` -- every `--tabs-*` value comes from body-level custom
      properties that already vary by theme -- so this only mirrors `body--dark` onto the element.
    */
    this._darkMode = new DarkMode(this)
  }

  /**
   * The panels stay in the light DOM, slotted in below the strip: their content is page content and
   * has to be reached by the article's own stylesheet.
   */
  _collectTabs() {
    const panels = [...this.querySelectorAll(':scope > block-tab')]
    this._tabs = panels.map((panel, index) => {
      this._trimEdgeMargins(panel)
      const label = panel.getAttribute('label') || `Tab ${index + 1}`
      panel.setAttribute('data-print-label', label)
      return {
        panel,
        label,
        icon: panel.getAttribute('icon') || '',
        svg: ''
      }
    })
    this._showActive()
    this._loadIcons()
  }

  /**
   * The panel supplies the padding; content adding its own on top of it leaves a gap under the
   * strip that reads as a mistake. Set on the element rather than in the stylesheet because the
   * content is slotted, and `::slotted()` reaches only the panel itself, never inside it.
   */
  _trimEdgeMargins(panel) {
    panel.firstElementChild?.style.setProperty('margin-top', '0')
    panel.lastElementChild?.style.setProperty('margin-bottom', '0')
  }

  /**
   * A heading's own `scroll-margin-top` knows nothing about the strip standing above it, so
   * scrolling to a heading in a panel would push the tabs themselves off screen. Set on the
   * elements because the content is slotted, and measured because the strip wraps onto any number
   * of rows.
   */
  _applyScrollMargin() {
    const strip = this.renderRoot.querySelector('.strip')
    if (!strip) {
      return
    }
    const margin = `${strip.offsetHeight + 20}px`
    for (const { panel } of this._tabs) {
      panel.style.setProperty('scroll-margin-top', margin)
      for (const child of panel.children) {
        child.style.setProperty('scroll-margin-top', margin)
      }
    }
  }

  /*
    -> Self-heals an out-of-range `active`, which would otherwise hide every panel and mark no tab
       active until the reader clicks one.
  */
  get _activeIndex() {
    if (this._tabs.length < 1) {
      return 0
    }
    return Math.min(Math.max(this.active, 0), this._tabs.length - 1)
  }

  _showActive() {
    this._tabs.forEach(({ panel }, index) => {
      panel.style.display = index === this._activeIndex ? 'block' : 'none'
    })
  }

  /**
   * All at once rather than one after another — the shared cache collapses the repeats — and one
   * `requestUpdate()` rather than one per tab.
   */
  async _loadIcons() {
    await Promise.all(
      this._tabs
        .filter((t) => t.icon)
        .map(async (tab) => {
          tab.svg = await fetchIcon(tab.icon)
        })
    )
    // -> The tabs were mutated rather than replaced, which Lit has no way of noticing on its own
    this.requestUpdate()
  }

  /*
    -> Setting the property is the whole of it: `updated` shows the panel, so a tab opened from the
       strip and one opened by an outside writer of `active` travel the same path
  */
  _select(index) {
    this.active = index
  }

  _reveal(node) {
    const index = this._tabs.findIndex(({ panel }) => panel.contains(node))
    if (index >= 0 && index !== this.active) {
      this._select(index)
    }
    return index >= 0
  }

  _onReveal(event) {
    this._reveal(event.target)
  }

  _revealFromHash() {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ''))
    const target = id ? document.getElementById(id) : null
    if (target) {
      this._reveal(target)
    }
  }

  /**
   * The strip is a single stop in the tab order, so the arrow keys are the only way a keyboard
   * reaches the tabs other than the active one.
   */
  _onKeydown(event) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) {
      return
    }
    event.preventDefault()
    const next = (this._activeIndex + step + this._tabs.length) % this._tabs.length
    this._select(next)
    this.renderRoot.querySelectorAll('.tab')[next]?.focus()
  }

  /*
    -> The panels live in the light DOM, so `render()` never touches them: which one is showing has
       to be applied by hand, here, where every way of changing it lands
  */
  updated(changed) {
    if (changed.has('active')) {
      this._showActive()
    }
    this._applyScrollMargin()
  }

  connectedCallback() {
    super.connectedCallback()
    this._collectTabs()
    this._revealFromHash()
    this._onHashChange = () => this._revealFromHash()
    window.addEventListener('hashchange', this._onHashChange)
    this.addEventListener(REVEAL_EVENT, this._onReveal)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('hashchange', this._onHashChange)
    this.removeEventListener(REVEAL_EVENT, this._onReveal)
  }

  render() {
    if (this._tabs.length < 1) {
      return html`<slot></slot>`
    }
    return html`
      <div class="tabs-wrap">
        <i class="tabs-marks" aria-hidden="true"></i>
        <div class="tabs">
          <div class="strip" role="tablist" @keydown="${this._onKeydown}">
            ${this._tabs.map(
              (tab, index) => html`
                <button
                  type="button"
                  role="tab"
                  class="tab ${index === this._activeIndex ? 'is-active' : ''}"
                  aria-selected="${index === this._activeIndex}"
                  tabindex="${index === this._activeIndex ? 0 : -1}"
                  @click="${() => this._select(index)}">
                  ${tab.svg ? unsafeSVG(tab.svg) : null}${tab.label}
                </button>
              `
            )}
          </div>
          <div class="panel" role="tabpanel"><slot></slot></div>
        </div>
      </div>
    `
  }
}

window.customElements.define('block-tabs', BlockTabsElement)
