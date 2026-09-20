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
  swagger-ui rather than @scalar/api-reference: Scalar is a Vue application that injects its
  stylesheet as a `<style>` into `document.head`, with nowhere to hand it a shadow root instead, so
  it either draws unstyled inside one or forces this block into the light DOM against page-global
  `@layer` rules that shift cascade order site-wide. swagger-ui's UMD bundle
  (`dist/swagger-ui-bundle.js`) is self-contained (React included, no bare imports left for the
  bundler to chase), mounts into whatever node it is handed via `domNode`, and its CSS is scoped
  under a `.swagger-ui` root class with no document-level side effects — the `unsafeCSS` +
  shadow-root pattern the other library-backed blocks use.

  Reaching that specific file takes the `resolve.alias` in `rolldown.config.mjs`, not just the bare
  `import SwaggerUIBundle from 'swagger-ui'` below: `platform: 'browser'` puts `browser` in the
  resolved condition set, and swagger-ui's `exports` map picks a different, non-self-contained ESM
  build under it (`dist/swagger-ui-es-bundle-core.js`, whose bare imports like `base64-js` expect a
  consuming bundler). Rolldown bundles that happily and it imports cleanly — a real
  `SwaggerUIBundle({ domNode, spec, ... })` call is what then throws `TypeError: o is not a function`
  and renders nothing, so "did it register" proves nothing about this package.
*/

const ALL_SUBMIT_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/**
 * `url` wins over `body` when both are given — an author who filled in a URL almost certainly left
 * the starter body untouched. Kept apart from `firstUpdated()` so what a reader ends up seeing is
 * testable without mounting swagger-ui and its React tree.
 *
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

export class BlockOpenapiElement extends LitElement {
  /**
   * Read out of this source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'openapi',
    name: 'OpenAPI Spec',
    description:
      'Renders an OpenAPI (Swagger) spec — fetched from a URL, or written inline — into interactive API documentation.',
    icon: 'tabler:api',
    /*
      Fenced because YAML and JSON are full of characters markdown reads as its own — an unindented
      mapping key looks like a paragraph, `-` opens a list, `#` opens a heading. Inside a fence the
      spec arrives as typed.
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
      url: { type: String },

      /**
       * Explicit `attribute`: Lit's default lowercases the property name without inserting a dash,
       * so it would listen for `tryitout` while the block picker writes `try-it-out` into the page.
       */
      tryItOut: { type: Boolean, ...boolean, attribute: 'try-it-out' },

      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.url = ''
    this.tryItOut = true
    this._error = ''
    this._darkMode = new DarkMode(this)
  }

  /** The `DownloadUrl` plugin is what fetches the spec when `source` is a URL. */
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
    swagger-ui mounts its own React tree into `.container`, which does not exist until `render()` has
    run once.
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
