import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { fetchIcon } from '../shared/icons.js'
import { DarkMode } from '../shared/theme.js'

/**
 * Asked of a block that might be hiding the element the event was dispatched on.
 *
 * The app sends it at a heading before scrolling to it — see `helpers/anchors.js` — so that a heading
 * inside a panel that is not showing is opened rather than scrolled at. Matched by name only: a block
 * answers it or ignores it, and neither side has to know about the other.
 */
const REVEAL_EVENT = 'block-reveal'

/**
 * Block Tabs
 */
export class BlockTabsElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   *
   * `template` is the body the picker writes into the page along with the opening line. A block that
   * has one is fenced with `:::`, so that the `::block-tab` children inside it are read as blocks of
   * their own rather than as the end of this one.
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

      /*
        The marks live outside .tabs' own box (see .tabs-marks below), so the wrapper is what
        carries the gap below the block and gives the marks something to position against. On this
        element rather than :host: see block-index.
      */
      .tabs-wrap {
        position: relative;
        margin-bottom: 16px;
      }

      /*
        The frame: a hairline square (Ledger) or an 8px matte card (Cobalt) -- --tabs-radius and
        --tabs-shadow carry the whole difference, and both aesthetics agree on "none" for the shadow,
        so no shadow is drawn at all any more (OpenProject #2874's own removal list). Clipping to the
        radius is what rounds the strip's top corners and the panel's bottom ones without either of
        them having to know where it sits.
      */
      .tabs {
        border: 1px solid var(--tabs-border);
        border-radius: var(--tabs-radius);
        overflow: hidden;
        box-shadow: var(--tabs-shadow);
      }

      /*
        Two opposite corner marks, Ledger only -- --tabs-corner-marks is "none" under Cobalt, whose
        frame is bounded by its own radius instead. Same technique PageHeader.vue's
        .page-header-icon__marks draws, trimmed to the two corners tabset-block.md calls for. A
        sibling of .tabs rather than a child of it: .tabs clips its own content to round Cobalt's
        corners, and a mark drawn outside that frame would be clipped away right along with it if it
        lived inside.
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
        The whole row is the unselected surface, tabs and the space past the last one alike. The line
        along the bottom (none, under Cobalt) is the panel's top edge; the tabs are pulled down onto
        it so the active one can paint over its own stretch and open the seam into the panel. "gap"
        does double duty in a wrapping flex row: it is the space between tabs on one line AND the
        space between wrapped lines, which is the same 4px Cobalt wants in both directions.
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
      /* -> Inset rather than an outline, so the ring follows the tab's own radius under Cobalt */
      .tab:focus-visible {
        outline: none;
        box-shadow: var(--tabs-focus-ring);
      }

      /* -> Flat panel colour, which is what lifts it out of the strip; the cap replaces the old border-top */
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
        Tighter on a phone. The panel sits inside an article that pads by 8px there, so 20px of its own
        put the text 28px in from the edge of the screen -- a third of the indent a 390px column can
        afford, spent twice over on the same margin.

        599.98px is the app's own phone breakpoint -- --breakpoint-sm is 600px in css/tailwind.css. A
        block cannot read the app's Sass variables, so the value is written out, as block-infobox does
        with its own. (No backticks in here: this whole stylesheet is a template literal, and one ends
        it mid-rule.)
      */
      @media (max-width: 599.98px) {
        .panel {
          padding: 12px;
        }
      }

      /* -> The panel owns the spacing, so the content inside it does not add its own at the edges */
      ::slotted(block-tab) {
        margin-bottom: 0;
      }
    `
  }

  static get properties() {
    return {
      _tabs: { state: true },
      /*
        Which panel is open, zero-based. A property rather than internal state because two things
        outside this block have a use for it: an author can open a block on something other than its
        first panel (`<block-tabs active="1">`), and the markdown editor reads it off one element and
        writes it onto the next, because every keystroke rebuilds the preview and with it this block --
        which otherwise snapped back to the first tab while an author was typing in the second.
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
      Kept even though the styles above no longer key off `[dark]` themselves (OpenProject #2874):
      every `--tabs-*` value now comes from the body-level custom properties, which already vary by
      theme on their own. Constructing it is still what OpenProject #2874's own scope note calls
      "behaviour unchanged", and the shared `describeDarkMode` suite below still asserts it mirrors
      `body--dark` onto this element correctly.
    */
    this._darkMode = new DarkMode(this)
  }

  /**
   * Read the panels the page gave this block, and start showing the first.
   *
   * The panels stay in the light DOM, slotted in below the strip: their content is page content and
   * is styled by the article's own stylesheet, the way an included page is.
   */
  _collectTabs() {
    const panels = [...this.querySelectorAll(':scope > block-tab')]
    this._tabs = panels.map((panel, index) => {
      this._trimEdgeMargins(panel)
      return {
        panel,
        label: panel.getAttribute('label') || `Tab ${index + 1}`,
        icon: panel.getAttribute('icon') || '',
        svg: ''
      }
    })
    this._showActive()
    this._loadIcons()
  }

  /**
   * Drop the outermost margins of a panel's content.
   *
   * The panel supplies the padding; the content adding its own on top of it leaves a gap under the
   * strip that reads as a mistake — a heading, whose margin is the largest of any element, most of
   * all. Set on the element rather than in the stylesheet because the content is slotted: it lives in
   * the page, styled by the page, and `::slotted()` reaches only the panel itself, never inside it.
   */
  _trimEdgeMargins(panel) {
    panel.firstElementChild?.style.setProperty('margin-top', '0')
    panel.lastElementChild?.style.setProperty('margin-bottom', '0')
  }

  /**
   * Keep the strip on screen when something inside a panel is scrolled to.
   *
   * A heading carries a `scroll-margin-top` so it does not land flush against the top edge, but that
   * margin knows nothing about the strip standing above it — following a link to a heading in a tab
   * would scroll the tabs themselves out of view, leaving the reader in a panel with no way to see
   * which one they were in. Set on the elements because the content is slotted, and measured because
   * the strip is as tall as the labels wrapped onto however many rows.
   */
  _applyScrollMargin() {
    const strip = this.renderRoot.querySelector('.strip')
    if (!strip) {
      return
    }
    const margin = `${strip.offsetHeight + 20}px`
    for (const { panel } of this._tabs) {
      for (const child of panel.children) {
        child.style.setProperty('scroll-margin-top', margin)
      }
    }
  }

  /*
    -> Self-heals an out-of-range `active` (hand-written markdown with too few tabs, or a stale value
       left over after tabs were added/removed): without this, every panel hides and no tab in the
       strip is marked active until the reader clicks one.
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
   * Fetch the icons the tab strip is about to draw.
   *
   * All of them at once rather than one after another, since the shared cache collapses the repeats,
   * and one `requestUpdate()` rather than one per tab — matching `block-index`'s `_loadIcons`.
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
    -> Setting the property is the whole of it: `updated` is what shows the panel, so a tab opened from
       the strip and one opened by whoever set `active` from outside travel the same path
  */
  _select(index) {
    this.active = index
  }

  /**
   * Open the panel holding a given node, if it is one of these.
   *
   * Both ways in end up here: the app asking for a heading it is about to scroll to, and the reader
   * arriving on a URL whose fragment names a heading in a panel that is not the first.
   */
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

  /** The panel holding the heading the URL points at, if the URL points at one. */
  _revealFromHash() {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ''))
    const target = id ? document.getElementById(id) : null
    if (target) {
      this._reveal(target)
    }
  }

  /**
   * Left and right walk the strip, as they do in every other set of tabs — the panels are a single
   * stop in the tab order, so the arrow keys are how a keyboard reaches the other ones.
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
    -> The panels live in the light DOM, so `render()` never touches them: which one is showing has to
       be applied by hand, here, where it covers a click on the strip, an arrow key, a `block-reveal`
       and an `active` set from outside alike
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
    // -> On arrival, and again whenever the fragment changes under a reader using back and forward
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
