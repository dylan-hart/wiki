import { LitElement, html, css, unsafeCSS } from 'lit'
import { load as parseYaml } from 'js-yaml'
import SwaggerUIBundle from 'swagger-ui'
import swaggerUiCss from 'swagger-ui/dist/swagger-ui.css'
import { readFencedSource } from '../shared/body.js'
import { boolean } from '../shared/props.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/*
  Why swagger-ui and not @scalar/api-reference.

  2.5.x's openapi-core rendered a spec into read-only HTML documentation embedded in the page — a
  narrow job. @scalar/api-reference is a Vue 3 application: `createApiReference()` mounts a
  `createApp()` tree and, per its own standalone build (`dist/standalone/lib/html-api.js`), injects
  its stylesheet as a single `<style id="scalar-style">` into `document.head` rather than into
  wherever it was mounted — there is nowhere to hand it a shadow root instead. Every other block here
  styles itself off `:host` in its own shadow root (see the top of this file's CLAUDE.md); Scalar's
  approach would mean either rendering this block into the light DOM against page-global CSS `@layer
  scalar-base` rules that could shift cascade order for the whole site, or mounting it inside a shadow
  root where its injected stylesheet then never reaches in and it draws unstyled. Its dependency graph
  is also a full Vue runtime plus an "API Client" request console and an AI agent chat panel bundled
  in — a much larger surface than "render a spec as docs," and its standalone browser build alone is
  ~3.3MB of JS across chunks before this repo's own bundling touches it.

  swagger-ui's UMD bundle (`dist/swagger-ui-bundle.js`, the file this import resolves to given this
  workspace's `resolve()` has no `browser` export condition set) is a self-contained webpack build —
  React included, nothing left as an external import for rollup to chase down — that mounts into
  whatever DOM node it is handed via `domNode`, shadow root included, and its CSS
  (`dist/swagger-ui.css`) is a plain stylesheet scoped under a `.swagger-ui` root class with no
  document-level side effects. That drops straight into the `unsafeCSS` + shadow-root pattern
  `block-katex` and `block-map` already use for a bundled library's stylesheet, and keeps the surface
  to what 2.5.x actually had: a spec rendered as documentation, with "Try it out" as one config flag
  rather than a whole separate API client product.
*/

/** Every HTTP method swagger-ui knows how to draw an "Execute" button for. */
const ALL_SUBMIT_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/**
 * What to hand `SwaggerUIBundle` for one instance of this block: a URL to fetch the spec from, an
 * already-parsed spec object read out of the block's own body, or an error explaining why neither
 * was possible. `url` wins over `body` when both are given — an author who filled in a URL almost
 * certainly left the starter body untouched.
 *
 * Kept apart from `firstUpdated()` so the actual point of this block — what a reader ends up seeing —
 * is directly testable without mounting swagger-ui (and its React tree) at all, the same reasoning
 * `resolveTileSettings` in `block-map` documents.
 *
 * @param {string} url This instance's `url` prop.
 * @param {string} body The block's light-DOM body, fenced or not, exactly as `readFencedSource()`
 *   reads it — see `../shared/body.js` for why `textContent` is what undoes markdown's escaping.
 * @returns {{ url: string } | { spec: object } | { error: string }}
 */
export function resolveSpecSource(url, body) {
  const trimmedUrl = (url ?? '').trim()
  if (trimmedUrl) {
    return { url: trimmedUrl }
  }

  const source = (body ?? '').trim()
  if (!source) {
    return {
      error: 'This block needs a spec URL, or a fenced YAML/JSON body with the spec written inline.'
    }
  }

  let spec
  try {
    spec = parseYaml(source)
  } catch (err) {
    return {
      error: `This spec could not be read: ${err.reason ?? err.message}. Anything indented — a nested object or list — has to go inside a fenced code block.`
    }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { error: 'This spec could not be read: expected a YAML or JSON object.' }
  }
  return { spec }
}

/**
 * Block OpenAPI
 */
export class BlockOpenapiElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'openapi',
    name: 'OpenAPI Spec',
    description:
      'Renders an OpenAPI (Swagger) spec — fetched from a URL, or written inline — into interactive API documentation.',
    icon: 'api',
    /*
      Fenced, and not as a nicety: an inline spec is YAML or JSON, and both are full of characters
      markdown reads as its own — an unindented mapping key looks like a paragraph, `-` opens a list,
      `#` opens a heading. Inside a fence it arrives as typed. Ignored entirely once `url` is set —
      see `firstUpdated()`.
    */
    template: `\`\`\`yaml
openapi: 3.0.3
info:
  title: Sample API
  version: "1.0"
paths:
  /ping:
    get:
      summary: Health check
      responses:
        "200":
          description: OK
\`\`\``,
    props: [
      {
        name: 'url',
        type: 'string',
        label: 'Spec URL',
        hint: 'Fetched by the reader’s browser. Left empty, the block’s own body — a fenced YAML or JSON block — is read as the spec instead.'
      },
      {
        name: 'try-it-out',
        type: 'boolean',
        label: 'Enable "Try it out"',
        hint: 'Lets a reader send real requests at the API from this page, using the servers the spec declares.',
        default: true
      }
    ]
  }

  static get styles() {
    return [
      // -> swagger-ui first, so the overrides below win where the two touch the same thing
      unsafeCSS(swaggerUiCss),
      errorBox,
      css`
        :host {
          display: block;
        }

        .error {
          margin-bottom: 16px;
        }

        /*
          swagger-ui draws on white and assumes it is the whole page; on a dark wiki page that reads
          as a hole punched in the article. There is no upstream dark theme to opt into, so this is a
          hand-picked override of the classes that actually show up on screen — the operation blocks,
          the model/schema panels, tables and code samples — not a line-by-line recolouring of every
          class the stylesheet above defines.
        */
        :host([dark]) .swagger-ui {
          color: rgba(255, 255, 255, 0.87);
        }
        :host([dark]) .swagger-ui .info .title,
        :host([dark]) .swagger-ui .opblock-tag,
        :host([dark]) .swagger-ui .opblock .opblock-summary-description,
        :host([dark]) .swagger-ui .opblock .opblock-summary-path,
        :host([dark]) .swagger-ui .opblock .opblock-summary-path__deprecated,
        :host([dark]) .swagger-ui table thead tr td,
        :host([dark]) .swagger-ui table thead tr th,
        :host([dark]) .swagger-ui .parameter__name,
        :host([dark]) .swagger-ui .parameter__type,
        :host([dark]) .swagger-ui .response-col_status,
        :host([dark]) .swagger-ui .response-col_description,
        :host([dark]) .swagger-ui .model-title,
        :host([dark]) .swagger-ui .model,
        :host([dark]) .swagger-ui .tab li,
        :host([dark]) .swagger-ui label,
        :host([dark]) .swagger-ui .opblock-description-wrapper p,
        :host([dark]) .swagger-ui .renderedMarkdown p {
          color: rgba(255, 255, 255, 0.87) !important;
        }
        :host([dark]) .swagger-ui .info a,
        :host([dark]) .swagger-ui .opblock-tag small {
          color: rgba(255, 255, 255, 0.6);
        }
        :host([dark]) .swagger-ui .scheme-container,
        :host([dark]) .swagger-ui .opblock .opblock-section-header {
          background: transparent;
          box-shadow: none;
        }
        :host([dark]) .swagger-ui .opblock-tag,
        :host([dark]) .swagger-ui table thead tr td,
        :host([dark]) .swagger-ui table thead tr th {
          border-color: rgba(255, 255, 255, 0.15);
        }
        :host([dark]) .swagger-ui .model-box,
        :host([dark]) .swagger-ui section.models,
        :host([dark]) .swagger-ui section.models.is-open h4,
        :host([dark]) .swagger-ui .responses-inner,
        :host([dark]) .swagger-ui .opblock-body pre.microlight {
          background: rgba(255, 255, 255, 0.05);
        }
        :host([dark]) .swagger-ui section.models {
          border-color: rgba(255, 255, 255, 0.15);
        }
        :host([dark]) .swagger-ui input,
        :host([dark]) .swagger-ui select,
        :host([dark]) .swagger-ui textarea {
          background: rgba(255, 255, 255, 0.05);
          color: rgba(255, 255, 255, 0.87);
          border-color: rgba(255, 255, 255, 0.25);
        }
      `
    ]
  }

  static get properties() {
    return {
      /**
       * Where to fetch the spec from, client-side. Beats the block's own body when both are given —
       * an author who filled in a URL almost certainly left the starter body untouched.
       * @type {string}
       */
      url: { type: String },

      /**
       * Whether the "Execute" button appears on every operation, letting a reader send a real
       * request at the API this spec describes from inside the wiki page.
       *
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `tryitout` while the block picker — which writes the
       *    literal `static definition.props[].name`, `try-it-out` — writes `try-it-out` into the page.
       * @type {boolean}
       */
      tryItOut: { type: Boolean, ...boolean, attribute: 'try-it-out' },

      // Internal Properties
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.url = ''
    this.tryItOut = true
    this._error = ''
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /**
   * Mounts swagger-ui into `container`, from either a URL (the `DownloadUrl` plugin does the actual
   * fetching) or an already-parsed spec object.
   */
  _mount(container, source) {
    SwaggerUIBundle({
      domNode: container,
      ...source,
      presets: [SwaggerUIBundle.presets.apis],
      plugins: [SwaggerUIBundle.plugins.DownloadUrl],
      supportedSubmitMethods: this.tryItOut ? ALL_SUBMIT_METHODS : []
    })
  }

  /*
    The container swagger-ui mounts its own React tree into has to exist in the DOM first, i.e. once
    `render()` has run once — see block-map for the same reasoning around Leaflet.
  */
  firstUpdated() {
    const { source } = readFencedSource(this)

    const result = resolveSpecSource(this.url, source)
    if ('error' in result) {
      this._error = result.error
      return
    }

    this._mount(this.renderRoot.querySelector('.container'), result)
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    return html`<div class="container"></div>`
  }
}

window.customElements.define('block-openapi', BlockOpenapiElement)
