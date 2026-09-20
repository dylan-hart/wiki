import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { fetchIcon, iconImageUrl } from '../shared/icons.js'
import { boolean } from '../shared/props.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { getSiteId, getSiteLocales, getCurrentPage, localeUrlSegment } from '../shared/site.js'

/** Mirrors the page store's own `DEFAULT_PAGE_ICON`, so a listing does not mix two defaults. */
const DEFAULT_PAGE_ICON = 'tabler:file-text'

const BOOK_PAGE_ICON = 'tabler:book-2'

export class BlockIndexElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
   *
   * `props` mirrors `static get properties()` below — a property meant to be authored belongs in
   * both lists, since the renderer strips any attribute a block does not declare.
   */
  static definition = {
    block: 'index',
    name: 'Index',
    description:
      "Lists a folder's pages -- set Depth above 0 to also pull in subfolders for a nested, book/chapter-style index or table of contents.",
    icon: 'tabler:list-search',
    props: [
      {
        name: 'path',
        type: 'string',
        label: 'Path',
        hint: 'Folder to list pages from, without a leading slash. Empty means the site root.'
      },
      {
        name: 'tags',
        type: 'string',
        label: 'Tags',
        hint: 'Comma-separated list of tags a page must carry.'
      },
      {
        name: 'limit',
        type: 'number',
        label: 'Limit',
        hint: 'Maximum number of pages to list.',
        default: 10
      },
      {
        name: 'order-by',
        type: 'select',
        label: 'Order By',
        options: ['title', 'fileName', 'createdAt', 'updatedAt'],
        default: 'title'
      },
      {
        name: 'order-by-direction',
        type: 'select',
        label: 'Direction',
        options: ['asc', 'desc'],
        default: 'asc'
      },
      {
        name: 'depth',
        type: 'number',
        label: 'Depth',
        hint: 'How many folders below the path to include. 0 is the folder itself; above 0 pulls in subfolders too, for a nested book/chapter-style listing.',
        default: 0
      },
      {
        name: 'columns',
        type: 'select',
        label: 'Columns',
        options: ['1', '2', '3'],
        hint: 'Most columns to lay the pages out in. Narrower screens use fewer.',
        default: '2'
      },
      {
        name: 'show-icons',
        type: 'boolean',
        label: 'Show Icons',
        hint: "Draw each page's icon to the left of its title.",
        // -> Stated, so that a toggle switched on and then off again writes nothing into the page
        default: false
      },
      {
        name: 'no-result-msg',
        type: 'string',
        label: 'Empty Message',
        hint: 'Shown when the query matches no pages.',
        default: 'No pages matching your query.'
      }
    ]
  }

  static get styles() {
    return [
      errorBox,
      css`
        :host {
          display: block;
        }

        /*
        -> The gap below the block lives here, not on :host: the app resets the margin on every
           element, and a page rule beats a :host rule whatever its specificity. Set inside the
           shadow root it is out of that rule's reach, and collapses out through the host, which
           carries no padding or border of its own.
      */
        ul {
          padding: 0;
          margin: 0 0 16px;
          list-style: none;
          display: grid;
          grid-auto-flow: row;
          grid-template-columns: repeat(1, minmax(0, 1fr));
          gap: 0.5rem;
        }

        /*
        -> The columns prop is a ceiling, not a count: the listing starts at one column and widens
           with the window, stopping at whatever the author asked for, because a three-column
           listing on a 400px screen is three unreadable slivers. The second column arrives at the
           app's md breakpoint; the third waits for 1600px, a width of this block's own, since at
           1440 a third of the article column leaves a title and its description two lines each.

        -> Matched off the host's attribute rather than read from a custom property: the ceiling has
           to be applied per breakpoint, and clamping one is math inside repeat(), which an engine
           cannot be relied on to take.
      */
        @media (min-width: 1024px) {
          :host(:not([columns='1'])) ul {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (min-width: 1600px) {
          :host([columns='3']) ul {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }

        li {
          position: relative;
          border: 1px solid var(--block-border);
          border-radius: var(--index-radius);
          padding: 0;
          font-weight: 500;
          display: flex;
          align-items: stretch;
          justify-content: stretch;
          /*
          -> Indentation rather than a real nested list, because the listing is ordered by
             title/date/etc. across every depth at once -- a depth-2 page can sort ahead of its own
             depth-0 ancestor, so there is no sibling order to build a parent/child tree from.
             render() sets --depth per row.
        */
          margin-left: calc(var(--depth, 0) * 1.5rem);
        }
        li:hover {
          background-color: var(--index-hover-bg);
          box-shadow: var(--index-hover-edge);
          cursor: pointer;
        }
        /* -> Across, not down, so an icon can sit beside the writing rather than above it */
        li a {
          display: flex;
          color: var(--index-title-fg);
          /* -> The horizontal inset is what the trailing glyph's own right offset is set against */
          padding: 10px 14px;
          text-decoration: none;
          flex: 1;
          flex-direction: row;
          align-items: center;
          gap: 12px;
          position: relative;
          font-weight: var(--index-title-weight);
          font-size: 14.5px;
        }
        .text {
          display: flex;
          flex-direction: column;
          justify-content: center;
          /* -> min-width is what lets a long title wrap inside the card rather than push the row
              wider than it. */
          flex: 1;
          min-width: 0;
        }
        .text span {
          display: block;
          color: var(--index-description-fg);
          font-size: 12.5px;
          font-weight: normal;
          pointer-events: none;
        }

        /*
        -> Inlined rather than pointed at with an img, because an Iconify SVG paints with
           currentColor. The width sits on the slot as well as on the drawing, so a row whose icon
           could not be had keeps its place in the column rather than sliding its writing left of
           every other row's.
      */
        .icon {
          display: flex;
          align-items: center;
          flex: none;
          width: 18px;
          color: var(--index-row-fg);
        }
        .icon svg,
        .icon img {
          width: 18px;
          height: 18px;
        }
        /*
        -> Both trailing glyphs sit in the DOM and the --index-*-display tokens show one at a time:
           which one is the aesthetic's to choose, not something the block can read.
      */
        li a > svg {
          width: 16px;
          height: 16px;
          position: absolute;
          right: 14px;
          color: var(--index-trailing-fg);
          pointer-events: none;
        }
        li a > svg.is-arrow {
          display: var(--index-arrow-display);
        }
        li a > svg.is-chevron {
          display: var(--index-chevron-display);
        }
        li:hover a > svg {
          color: var(--index-hover-trailing-fg);
        }

        /*
        -> The element carries the shared error class too, for that box's look alone. The name stays
           its own: a listing that matched nothing is an outcome, not a failure.
      */
        .no-links {
          margin-bottom: 16px;
        }
      `
    ]
  }

  static get properties() {
    return {
      path: { type: String },

      tags: { type: String },

      limit: { type: Number },

      /**
       * -> Explicit `attribute`, here and below: Lit's default lowercases without inserting a dash,
       *    so it would listen for `orderby` rather than the `props[].name` the block picker writes.
       */
      orderBy: { type: String, attribute: 'order-by' },

      orderByDirection: { type: String, attribute: 'order-by-direction' },

      depth: { type: Number },

      noResultMsg: { type: String, attribute: 'no-result-msg' },

      /**
       * Unread by `render()`: the layout is the styles' business, and they match `:host([columns])`
       * on the page's own attribute. Declared so Lit knows the attribute at all.
       */
      columns: { type: String },

      showIcons: { ...boolean, attribute: 'show-icons' },

      _loading: { state: true },
      _pages: { state: true }
    }
  }

  constructor() {
    super()
    this._loading = true
    this._pages = []
    this.path = ''
    this.tags = ''
    this.limit = 10
    this.orderBy = 'title'
    this.orderByDirection = 'asc'
    this.depth = 0
    this.noResultMsg = 'No pages matching your query.'
    this.columns = '2'
    this.showIcons = false
    this._darkMode = new DarkMode(this)
  }

  async connectedCallback() {
    super.connectedCallback()
    try {
      // -> `fetch` carries the session cookie same-origin, so the server's own page-rule check
      //    decides what comes back: only pages this reader may open.
      const [siteId, locales, current] = await Promise.all([
        getSiteId(),
        getSiteLocales(),
        getCurrentPage()
      ])
      if (!siteId) {
        throw new Error('Could not determine the current site.')
      }
      const params = new URLSearchParams({
        limit: this.limit,
        orderBy: this.orderBy,
        orderByDirection: this.orderByDirection,
        depth: this.depth
      })
      if (current.locale) {
        params.set('locale', current.locale)
      }
      if (this.path) {
        params.set('path', this.path)
      }
      if (this.tags) {
        params.set('tags', this.tags)
      }
      const resp = await fetch(`/_api/sites/${siteId}/tree/pages?${params}`)
      if (!resp.ok) {
        throw new Error(`Request failed (${resp.status}).`)
      }
      const pages = await resp.json()
      // -> The frontend's `localizedPagePath` lives in a workspace a block cannot import from, so
      //    the same rule is composed locally -- keep the two in step.
      const pageLocale = current.locale
      const prefix =
        locales?.active?.length > 1 &&
        pageLocale &&
        (pageLocale !== locales.primary || locales.forcePrefix)
          ? `/${localeUrlSegment(pageLocale, locales.aliases)}`
          : ''
      this._pages = pages.map((p) => ({ ...p, href: `${prefix}/${p.path}` }))
      if (this.showIcons) {
        await this._loadIcons()
      }
    } catch (err) {
      // oxlint-disable-next-line no-console -- the listing renders empty on failure, so the console is the only account of why
      console.warn(`block-index: the page listing could not be loaded — ${err?.message ?? err}`)
    }
    this._loading = false
  }

  /**
   * All at once rather than one after another, since the shared cache collapses the repeats: a
   * listing of pages that never had an icon chosen is one request for the default, however many rows
   * there are. An `img:` icon is a file to point at and needs nothing fetched.
   */
  async _loadIcons() {
    await Promise.all(
      this._pages.map(async (page) => {
        const reference = this._iconReference(page)
        if (!iconImageUrl(reference)) {
          page.svg = await fetchIcon(reference)
        }
      })
    )
    // -> The pages were mutated rather than replaced, which Lit has no way of noticing on its own
    this.requestUpdate()
  }

  /** One resolver for both the prefetch and the draw, so the two cannot disagree about a row. */
  _iconReference(page) {
    return page.icon || (page.hasChildren ? BOOK_PAGE_ICON : DEFAULT_PAGE_ICON)
  }

  _icon(page) {
    const image = iconImageUrl(this._iconReference(page))
    return html`<span class="icon">
      ${image ? html`<img src="${image}" alt="" />` : page.svg ? unsafeSVG(page.svg) : null}
    </span>`
  }

  render() {
    // -> The moment any row is indented the listing drops to one column, since a deep row's
    //    `--depth` indent would otherwise be read against a narrow column's width. Inline, so it
    //    beats the grid rules, media queries included.
    const nested = this._pages.some((p) => (p.depth || 0) > 0)
    return this._pages.length > 0 || this._loading
      ? html`
          <ul style="${nested ? 'grid-template-columns: repeat(1, minmax(0, 1fr))' : ''}">
            ${this._pages.map(
              (p) =>
                html`<li style="--depth: ${p.depth || 0}">
                  <a href="${p.href}" @click="${this._navigate}">
                    ${this.showIcons ? this._icon(p) : null}
                    <div class="text">
                      ${p.title} ${p.description ? html`<span>${p.description}</span>` : null}
                    </div>
                    <svg
                      class="is-arrow"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      data-icon="tabler:arrow-right">
                      <path
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        d="M5 12h14m-6 6l6-6m-6-6l6 6" />
                    </svg>
                    <svg
                      class="is-chevron"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      data-icon="tabler:chevron-right">
                      <path
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        d="m9 6l6 6l-6 6" />
                    </svg>
                  </a>
                </li>`
            )}
          </ul>
        `
      : html` <div class="no-links error">${this.noResultMsg}</div> `
  }

  /*
    -> `currentTarget`, not `target`: a click can land on anything inside the anchor, and asking the
       element the handler was bound to spares marking each of them `pointer-events: none`.
  */
  _navigate(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    if (!globalThis.WIKI_ROUTER) {
      return
    }
    e.preventDefault()
    globalThis.WIKI_ROUTER.push(e.currentTarget.getAttribute('href'))
  }
}

window.customElements.define('block-index', BlockIndexElement)
