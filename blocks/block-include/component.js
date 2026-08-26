import { LitElement, html } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { getBlockImportUrl } from '../shared/config.js'
import { currentPageLocation, getSiteId } from '../shared/site.js'

/** How many includes may nest before the chain is treated as a mistake. */
const MAX_DEPTH = 3

/**
 * An attribute that means "off" when it says so.
 *
 * MDC writes every prop with a value, and Lit's own Boolean converter reads any string at all as
 * true — `showTitle="false"` included. The picker never writes that one, since it leaves a prop out
 * while it holds its default, but a page written by hand can say it and means it. See `block-index`,
 * where this converter's own doc comment explains why the `boolean` prop below also declares
 * `default: false`.
 */
const boolean = {
  converter: {
    fromAttribute: (value) => value !== null && value !== 'false',
    toAttribute: (value) => (value ? 'true' : null)
  }
}

/**
 * Strip a path down to the form the server stores, so that `/Foo/Bar/` and `foo/bar` are one page
 * when the chain below is checked for a cycle.
 */
function normalizePath(path) {
  return (path ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase() || 'home'
}

/**
 * Block Include
 */
export class BlockIncludeElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'include',
    name: 'Include',
    description: 'Transclude the contents of another page inside this one.',
    icon: 'duplicate',
    props: [
      {
        name: 'path',
        type: 'string',
        label: 'Page Path',
        hint: 'Path of the page to include, without a leading slash.',
        required: true
      },
      {
        name: 'locale',
        type: 'string',
        label: 'Locale',
        hint: "Locale of the page to include. This page's own locale when empty."
      },
      {
        name: 'showTitle',
        type: 'boolean',
        label: 'Show Title',
        hint: "Draw the included page's title above it.",
        // -> Stated, so that a toggle switched on and then off again writes nothing into the page
        default: false
      }
    ]
  }

  static get properties() {
    return {
      /**
       * Path of the page to include
       * @type {string}
       */
      path: { type: String },

      /**
       * Locale of the page to include
       * @type {string}
       */
      locale: { type: String },

      /**
       * Whether to draw the included page's title above it
       * @type {boolean}
       */
      showTitle: boolean,

      // Internal Properties
      _loading: { state: true },
      _title: { state: true },
      _render: { state: true },
      _error: { state: true }
    }
  }

  /*
    Rendered into the light DOM, unlike every other block: what comes back is page content, and page
    content is styled by the stylesheet the article itself is drawn with. In a shadow root it would
    arrive unstyled, and the whole point is that an included page reads as part of the page including
    it. It also puts nested blocks where the DOM walk below can see them.
  */
  createRenderRoot() {
    // -> A box of its own, set inline because the page resets the margin and display of everything
    //    in it and a light-DOM block has no `:host` rule to be styled by. The spacing below comes
    //    from the included content's own last element, which is page content like any other.
    this.style.display = 'block'
    return this
  }

  constructor() {
    super()
    this._loading = true
    this._title = ''
    this._render = ''
    this._error = ''
    this.path = ''
    this.locale = ''
    this.showTitle = false
  }

  /**
   * Every page already on screen above this element, innermost first.
   *
   * A loop — a page including itself, or two pages including each other — would otherwise fetch and
   * draw forever, since each copy arrives carrying the element that fetched it.
   *
   * The page being read counts as the outermost link, and that is the part that matters: without it
   * a mutual pair only trips on the second lap, after fetching and drawing one pointless extra copy
   * of each page. With it, the loop is refused at the exact point it would close, before a request
   * goes out.
   */
  _ancestorPaths(currentPagePath) {
    const paths = []
    let parent = this.parentElement?.closest('block-include')
    while (parent) {
      paths.push(normalizePath(parent.getAttribute('path')))
      parent = parent.parentElement?.closest('block-include')
    }
    paths.push(normalizePath(currentPagePath))
    return paths
  }

  /**
   * Fetch the components for any block the included page brought with it.
   *
   * The page view scans for undefined elements once, when it loads a page, so anything arriving
   * afterwards has to ask for itself. Same contract: the element's tag names the file to fetch --
   * except a custom block doesn't have a flat, tag-only file to fetch: its code lives at
   * `/_blocks/custom/:siteId/:id.js`, which `getBlockImportUrl()` resolves the same way the page
   * view's own scan does (`stores/common.js`'s `blockImportUrl()`). Without this, a custom block
   * nested inside transcluded content 404'd for every reader, author or not (OpenProject #954).
   */
  async _loadNestedBlocks() {
    for (const el of this.querySelectorAll(':not(:defined)')) {
      const tag = el.tagName.toLowerCase()
      if (!tag.startsWith('block-')) {
        continue
      }
      try {
        await import(/* @vite-ignore */ await getBlockImportUrl(tag))
      } catch (err) {
        console.warn(`Failed to load ${tag}: ${err.message}`)
      }
    }
  }

  async connectedCallback() {
    super.connectedCallback()

    const path = normalizePath(this.path)

    const siteId = await getSiteId()
    if (!siteId) {
      this._error = 'Could not determine the current site.'
      this._loading = false
      return
    }
    // -> The site's `locales` config is public info served on the same `GET /_api/sites/current`
    //    `getSiteId()` above already reads; the reader's own locale and page path have no live store
    //    to ask (separate workspace), so both are read back off the browser's own URL instead -- see
    //    `currentPageLocation`'s own doc comment.
    const site = await fetch('/_api/sites/current')
      .then((resp) => (resp.ok ? resp.json() : null))
      .catch(() => null)
    const { locale: urlLocale, path: currentPagePath } = currentPageLocation(site?.locales?.active)
    const pageLocale = urlLocale ?? site?.locales?.primary

    const chain = this._ancestorPaths(currentPagePath)
    if (chain.includes(path)) {
      // -> A page naming itself is its author's own doing; anything longer went round other pages,
      //    and saying which one closes the loop is the part that helps
      this._error =
        chain.length === 1
          ? 'This page includes itself.'
          : `Including "${path}" here would loop: it is already open above.`
    } else if (chain.length > MAX_DEPTH) {
      this._error = `Includes are nested more than ${MAX_DEPTH} pages deep.`
    } else {
      try {
        const params = new URLSearchParams({ path })
        const includeLocale = this.locale || pageLocale
        if (includeLocale) {
          params.set('locale', includeLocale)
        }
        // -> A plain, cookie-authenticated fetch, so a signed-in reader's session comes along and the
        //    same access check the server applies when they open the page directly still applies here.
        const resp = await fetch(`/_api/sites/${siteId}/pages/include?${params}`)
        if (!resp.ok) {
          const err = new Error(`Request failed (${resp.status}).`)
          err.status = resp.status
          throw err
        }
        const page = await resp.json()
        if (page.isLocked) {
          // -> Withheld by the server, which is the same answer this reader gets by opening the page.
          //    The unlock prompt lives there, so this points at it rather than asking for a password.
          this._error = `The page "${path}" is password protected. Open it to enter the password.`
        } else {
          this._title = page.title
          this._render = page.render
        }
      } catch (err) {
        this._error =
          err.status === 404
            ? `There is no page at "${path}".`
            : `The page "${path}" could not be included.`
      }
    }

    this._loading = false
    if (this._render) {
      // -> After the render lands in the DOM, since that is what it walks
      await this.updateComplete
      await this._loadNestedBlocks()
    }
  }

  render() {
    if (this._loading) {
      return null
    }
    if (this._error) {
      return html`
        <div
          style="
            color: var(--q-negative, #c10015);
            border: 1px dashed color-mix(in srgb, currentColor 50%, transparent);
            border-radius: 5px;
            padding: 1rem;
            margin-bottom: 16px;
          ">
          ${this._error}
        </div>
      `
    }
    return html`
      ${this.showTitle ? html`<h2>${this._title}</h2>` : null}${unsafeHTML(this._render)}
    `
  }
}

window.customElements.define('block-include', BlockIncludeElement)
