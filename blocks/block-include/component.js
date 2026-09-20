import { LitElement, html } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { getBlockImportUrl } from '../shared/config.js'
import { t } from '../shared/i18n.js'
import { boolean } from '../shared/props.js'
import { getSiteId, getCurrentPage } from '../shared/site.js'
import { errorBoxInline } from '../shared/styles.js'

const MAX_DEPTH = 3

/** So that `/Foo/Bar/` and `foo/bar` are one page when the chain below is checked for a cycle. */
function normalizePath(path) {
  return (path ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase() || 'home'
}

export class BlockIncludeElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
   */
  static definition = {
    block: 'include',
    name: 'Include',
    description: 'Transclude the contents of another page inside this one.',
    icon: 'tabler:copy',
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
        name: 'show-title',
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
      path: { type: String },

      locale: { type: String },

      /**
       * -> Explicit `attribute`: Lit's default lowercases without inserting a dash, so it would
       *    listen for `showtitle` rather than the `props[].name` the block picker writes.
       */
      showTitle: { ...boolean, attribute: 'show-title' },

      _loading: { state: true },
      _title: { state: true },
      _render: { state: true },
      _error: { state: true }
    }
  }

  /*
    Light DOM, unlike every other block: what comes back is page content, styled by the stylesheet
    the article itself is drawn with, and in a shadow root it would arrive unstyled. It also puts
    nested blocks where `_loadNestedBlocks()`'s walk can see them.
  */
  createRenderRoot() {
    // -> Set inline: the page resets the display of everything in it, and a light-DOM block has no
    //    `:host` rule to be styled by.
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
   * A loop — a page including itself, or two pages including each other — would otherwise fetch and
   * draw forever, since each copy arrives carrying the element that fetched it. The page being read
   * counts as the outermost link, so a mutual pair is refused where the loop closes.
   */
  _ancestorPaths(currentPath) {
    const paths = []
    let parent = this.parentElement?.closest('block-include')
    while (parent) {
      paths.push(normalizePath(parent.getAttribute('path')))
      parent = parent.parentElement?.closest('block-include')
    }
    paths.push(normalizePath(currentPath))
    return paths
  }

  /**
   * The page view scans for undefined elements once, when it loads a page, so a block arriving with
   * transcluded content has to ask for itself. A custom block has no flat, tag-only file to fetch,
   * so the URL goes through `getBlockImportUrl()` rather than being guessed from the tag.
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
        // oxlint-disable-next-line no-console -- a nested block that will not load leaves nothing on the page to explain itself
        console.warn(`block-include: ${tag} could not be loaded — ${err?.message ?? err}`)
      }
    }
  }

  async connectedCallback() {
    super.connectedCallback()

    const [siteId, current] = await Promise.all([getSiteId(), getCurrentPage()])
    const path = normalizePath(this.path)
    const chain = this._ancestorPaths(current.path)
    if (!siteId) {
      this._error = 'Could not determine the current site.'
    } else if (chain.includes(path)) {
      // -> A one-link chain is the page naming itself; a longer one has to say which page closes it
      this._error =
        chain.length === 1
          ? await t('blocks.include.errors.selfInclude', 'This page includes itself.')
          : await t(
              'blocks.include.errors.loop',
              `Including "${path}" here would loop: it is already open above.`,
              { path }
            )
    } else if (chain.length > MAX_DEPTH) {
      this._error = await t(
        'blocks.include.errors.maxDepth',
        `Includes are nested more than ${MAX_DEPTH} pages deep.`,
        { maxDepth: MAX_DEPTH }
      )
    } else {
      try {
        const params = new URLSearchParams({ path })
        const locale = this.locale || current.locale
        if (locale) {
          params.set('locale', locale)
        }
        // -> `fetch` carries the session cookie same-origin; the server's own `mayOnPage` check on
        //    this route is what decides what comes back.
        const resp = await fetch(`/_api/sites/${siteId}/pages/include?${params}`)
        if (resp.status === 404) {
          this._error = await t(
            'blocks.include.errors.pageNotFound',
            `There is no page at "${path}".`,
            {
              path
            }
          )
        } else if (!resp.ok) {
          this._error = await t(
            'blocks.include.errors.includeFailed',
            `The page "${path}" could not be included.`,
            { path }
          )
        } else {
          const page = await resp.json()
          if (page.isLocked) {
            // -> The unlock prompt lives on the page itself, so this points at it rather than
            //    asking for a password here.
            this._error = await t(
              'blocks.include.errors.passwordProtected',
              `The page "${path}" is password protected. Open it to enter the password.`,
              { path }
            )
          } else {
            this._title = page.title
            this._render = page.render
          }
        }
      } catch {
        this._error = await t(
          'blocks.include.errors.includeFailed',
          `The page "${path}" could not be included.`,
          { path }
        )
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
      // -> The shared error box as an inline `style`: this block renders into the light DOM, where
      //    Lit never adopts `static styles`, and a `<style>` tag of its own would put a rule for the
      //    generic `.error` class on the whole page. Kept on one line: the box sets `pre-wrap`.
      return html`<div style="${errorBoxInline} margin-bottom: 16px;">${this._error}</div>`
    }
    return html`
      ${this.showTitle ? html`<h2>${this._title}</h2>` : null}${unsafeHTML(this._render)}
    `
  }
}

window.customElements.define('block-include', BlockIncludeElement)
