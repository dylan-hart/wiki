import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { fetchIcon, iconImageUrl } from '../shared/icons.js'
import { boolean } from '../shared/props.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { getSiteId, getSiteLocales, getCurrentPage } from '../shared/site.js'

/**
 * What to draw for a leaf page carrying no icon of its own.
 *
 * The same one the app gives a new page (`DEFAULT_PAGE_ICON` in the page store), so that a listing
 * mixing pages made in the editor with pages made through the API still lines up down the left.
 */
const DEFAULT_PAGE_ICON = 'tabler:file-text'

/**
 * What to draw for a "book" page carrying no icon of its own — one with a page nested below its own
 * path, the BookStack-style chapter arrangement `hasChildren` signals (OpenProject #2462). An
 * "outline" glyph, matching `DEFAULT_PAGE_ICON`'s style.
 */
const BOOK_PAGE_ICON = 'tabler:book-2'

/**
 * Block Index
 */
export class BlockIndexElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals.
   *
   * `props` is what the picker turns into a form, and therefore what an author can set from the
   * editor: one entry per attribute worth writing into the page, in the order they should be asked
   * for. It mirrors `static get properties()` below — that one tells Lit how to read an attribute at
   * runtime, this one describes it to a person — so a property meant to be authored belongs in both.
   * It is also what survives being saved: the renderer strips any attribute a block does not declare.
   *
   * A `boolean` prop must default to false, unless the block reads the attribute itself. MDC writes
   * attributes as strings and Lit reads any attribute that is present as true, so `showThing="false"`
   * would come out true — the picker leaves a prop out entirely when it still holds its default,
   * which is what keeps false meaning false. A block declaring the converter `block-asciinema` and
   * `block-youtube` share is free of that, and so free to default a prop to true: `false` written out
   * is then read back as false, which is the only case the stock converter gets wrong.
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
        The gap below a block lives on this element, not on :host.

        The app resets the margin on every element, and a rule in the page beats a :host rule in the
        shadow tree whatever its specificity -- so a margin set on the host is simply dropped. Set
        inside the shadow root it is out of that rule's reach, and collapses out through the host,
        which carries no padding or border of its own.
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
        The columns prop is a ceiling, not a count: the listing starts at one column and widens with
        the window, stopping at whatever the author asked for. A phone gets one column whichever value
        it carries, which is the whole reason the choice cannot simply be the number of columns -- a
        three-column listing on a 400px screen is three unreadable slivers.

        The second column arrives at the app's md breakpoint (--breakpoint-md in
        frontend/src/css/tailwind.css), which is the width the listing has always widened at. The
        third waits for 1600px, which is a width of this block's own rather than one of the shared
        ones: at lg (1440) a third of the article column, minus the sidebar beside it, leaves a title
        and its description with nowhere to go but two lines each.

        Matched off the host's attribute rather than read from a custom property, because the ceiling
        has to be applied per breakpoint -- and clamping one is math inside repeat(), which is not
        something an engine can be relied on to take.
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
          -> Renders the tree nested/indented (OpenProject #2461): --depth is set inline per row
             from the page's own depth (how many folders below the listed path it sits -- see
             render()). Indentation rather than a real nested list, because the listing is ordered
             by title/date/etc. across every depth at once -- a depth-2 page can sort ahead of its own
             depth-0 ancestor, so there is no sibling order to build an actual parent/child tree from.
        */
          margin-left: calc(var(--depth, 0) * 1.5rem);
        }
        li:hover {
          background-color: var(--index-hover-bg);
          box-shadow: var(--index-hover-edge);
          cursor: pointer;
        }
        /*
        -> The row runs across rather than down, so an icon can sit beside the writing rather than
           above it. The title and its description stack inside .text, which is the column the
           anchor itself used to be.
      */
        li a {
          display: flex;
          color: var(--index-title-fg);
          /* -> Vertical only: the horizontal inset is what the trailing glyph's own offset is set against */
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
          /* -> The row less the icon. min-width is what lets a long title wrap inside the card
              rather than pushing the row wider than it. */
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
        The page's own icon. Sized in em so it keeps its place beside writing at whatever size the
        article is set in, and left to take the anchor's colour: an Iconify SVG paints with
        currentColor, which is the whole reason it is inlined rather than pointed at with an an <img>.
      */
        /*
        -> The width is on the slot as well as on the drawing, so a row whose icon could not be had
           keeps its place in the column rather than sliding its writing left of every other row's.
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
        The trailing glyph -- Tabler arrow-right (Ledger) or chevron-right (Cobalt), pasted verbatim
        from frontend/src/assets/icons.generated.js, replacing the 48px Material arrow. Both sit in
        the DOM; only one shows at a time, per aesthetic, via the --index-*-display tokens -- the same
        display-toggle mechanism block-tabs' and block-infobox's corner marks use.
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
        "Nothing here" is drawn in the shared error box (see ../shared/styles.js), which is what this
        rule used to be a copy of -- hence the second class on the element itself. The name stays its
        own: a listing that matched nothing is an outcome, not a failure, and noResultMsg is the
        author's to word.
      */
        .no-links {
          margin-bottom: 16px;
        }
      `
    ]
  }

  static get properties() {
    return {
      /**
       * The base path to fetch pages from
       * @type {string}
       */
      path: { type: String },

      /**
       * A comma-separated list of tags to filter with
       * @type {string}
       */
      tags: { type: String },

      /**
       * The maximum number of items to fetch
       * @type {number}
       */
      limit: { type: Number },

      /**
       * Ordering (createdAt, fileName, title, updatedAt)
       *
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `orderby` while the block picker — which writes the
       *    literal `static definition.props[].name`, `order-by` — writes `order-by` into the page.
       * @type {string}
       */
      orderBy: { type: String, attribute: 'order-by' },

      /**
       * Ordering direction (asc, desc)
       *
       * -> Explicit `attribute`, for the same reason as `orderBy` above: the picker writes the
       *    dashed `order-by-direction`, not Lit's default lowercased `orderbydirection`.
       * @type {string}
       */
      orderByDirection: { type: String, attribute: 'order-by-direction' },

      /**
       * Maximum folder depth to fetch
       * @type {number}
       */
      depth: { type: Number },

      /**
       * A fallback message if no results are returned
       *
       * -> Explicit `attribute`, for the same reason as `orderBy` above: the picker writes the
       *    dashed `no-result-msg`, not Lit's default lowercased `noresultmsg`.
       * @type {string}
       */
      noResultMsg: { type: String, attribute: 'no-result-msg' },

      /**
       * Most columns to lay the pages out in (1, 2, 3)
       *
       * Declared for the sake of the pair -- an authored prop belongs in both lists -- and because
       * Lit would otherwise not know the attribute at all. Nothing in `render()` reads it: the layout
       * is the styles' business, and they match `:host([columns])` on the page's own attribute.
       *
       * @type {string}
       */
      columns: { type: String },

      /**
       * Whether each page's icon is drawn beside its title
       *
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `showicons` while the block picker — which writes the
       *    literal `static definition.props[].name`, `show-icons` — writes `show-icons` into the page.
       * @type {boolean}
       */
      showIcons: { ...boolean, attribute: 'show-icons' },

      // Internal Properties
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
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  async connectedCallback() {
    super.connectedCallback()
    try {
      // -> A page reader's request needs no site id or session threaded down to it -- see
      //    `../shared/site.js`'s header for the convention. `fetch` carries the session cookie the
      //    same as `API_CLIENT` did, same-origin, so a signed-in reader's listing is still the one
      //    they would get anywhere else -- only pages they may open come back.
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
      // -> A block cannot import the frontend's own `localizedPagePath` helper (a separate,
      //    unrelated-at-build-time workspace), so the same rule it applies is composed locally instead.
      const pageLocale = current.locale
      const prefix =
        locales?.active?.length > 1 &&
        pageLocale &&
        (pageLocale !== locales.primary || locales.forcePrefix)
          ? `/${pageLocale}`
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
   * Fetch the icons the listing is about to draw.
   *
   * All of them at once rather than one after another, since the shared cache collapses the repeats:
   * a listing of pages that never had an icon chosen for them is one request for the default, however
   * many rows there are. An `img:` icon is a file to point at and needs nothing fetched.
   *
   * Failures are already an empty string, so a row whose icon could not be had is a row without one.
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

  /**
   * One page's icon reference: the author's own choice when there is one, otherwise the book/file
   * default carried by `hasChildren` (OpenProject #2462) — a page with a nested page below its own
   * path draws as a book, a leaf page as a file. Shared by `_loadIcons()` (what to prefetch) and
   * `_icon()` (what to draw), so the two never disagree about which reference a row resolved to.
   */
  _iconReference(page) {
    return page.icon || (page.hasChildren ? BOOK_PAGE_ICON : DEFAULT_PAGE_ICON)
  }

  /** One page's icon: an inlined SVG, or an `<img>` for a reference that names a file. */
  _icon(page) {
    const image = iconImageUrl(this._iconReference(page))
    return html`<span class="icon">
      ${image ? html`<img src="${image}" alt="" />` : page.svg ? unsafeSVG(page.svg) : null}
    </span>`
  }

  render() {
    // -> A depth-0-only listing still lays out in the usual 1-3 columns; the moment any row is
    //    indented, an inline single-column override (which always beats the CSS grid rules, media
    //    queries included) keeps a deep row from having its `--depth` indent read against the wrong
    //    column's width.
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
    -> `currentTarget` is the anchor the handler is bound to; `target` is whatever was clicked, which
       is the anchor only for a click that landed on the title. The rest of the row got there by
       being marked `pointer-events: none`, one declaration at a time -- an icon is one more thing
       inside the anchor, and asking the element it was bound to is what makes that unnecessary.
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

  // createRenderRoot() {
  //   return this;
  // }
}

window.customElements.define('block-index', BlockIndexElement)
