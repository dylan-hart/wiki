import { LitElement, html, css } from 'lit'
import { load as parseYamlRaw, CORE_SCHEMA, timestampTag } from 'js-yaml'
import { DarkMode } from '../shared/theme.js'

/*
  `CORE_SCHEMA` (js-yaml's YAML-1.2 default) has no `!!timestamp`, so a bare date resolves to a
  string and `valueOf()`'s `Date` branch never fires. The tag alone rather than `YAML11_SCHEMA`, so
  a date is recognized without YAML 1.1's `yes`/`no`/`on`/`off` booleans and octal integers also
  changing how every other value in an infobox parses.
*/
const INFOBOX_SCHEMA = CORE_SCHEMA.withTags(timestampTag)

function parseYaml(source) {
  return parseYamlRaw(source, { schema: INFOBOX_SCHEMA })
}

/* Inline rather than fetched through `shared/icons.js`: the same two glyphs on every infobox. */
const YES_SVG = html`
  <svg
    viewBox="0 0 24 24"
    width="15"
    height="15"
    role="img"
    aria-label="Yes"
    class="yes"
    data-icon="tabler:check">
    <path fill="none" stroke="currentColor" stroke-width="1.5" d="m5 12l5 5L20 7" />
  </svg>
`

const NO_SVG = html`
  <svg
    viewBox="0 0 24 24"
    width="15"
    height="15"
    role="img"
    aria-label="No"
    class="no"
    data-icon="tabler:x">
    <path fill="none" stroke="currentColor" stroke-width="1.5" d="M18 6L6 18M6 6l12 12" />
  </svg>
`

/* `aria-hidden`: it stands in for a missing picture, not for information of its own. */
const PHOTO_SVG = html`
  <svg
    viewBox="0 0 24 24"
    width="26"
    height="26"
    aria-hidden="true"
    class="well-icon"
    data-icon="tabler:photo">
    <g fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" />
      <path stroke-linecap="round" d="M15 8h.01" />
      <path d="m3 16l5-5c.928-.893 2.072-.893 3 0l5 5" />
      <path d="m14 14l1-1c.928-.893 2.072-.893 3 0l3 3" />
    </g>
  </svg>
`

/**
 * The scheme has to be spelled out: a bare hostname is left alone, since plenty of ordinary facts
 * read that way — a file name, a version, a decimal — and nothing tells `notes.txt` from
 * `montreal.ca` without guessing.
 */
const SCHEME = /^(?:https?:\/\/|mailto:|tel:)/i

/**
 * The whole value has to be the address; a sentence with a URL in it is prose, and picking the link
 * out of it is markdown's job, not this block's.
 *
 * @returns {{ href: string, label: string, isExternal: boolean } | null}
 */
function linkOf(text) {
  if (!SCHEME.test(text) || /\s/.test(text)) {
    return null
  }
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  /*
    The scheme is boilerplate on a column of short facts, so it is dropped. Off the text as typed
    rather than the parsed URL, which would put back a trailing slash the author did not write.
  */
  const label = text.replace(SCHEME, '')
  if (!label) {
    return null
  }
  return {
    href: url.href,
    label,
    /*
      Judged on the host, matching `isExternalHref` in `renderers/markdown.js`. An email address or
      telephone number stays unmarked: neither goes to a page at all, and both say what they are.
    */
    isExternal:
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin !== globalThis.location?.origin
  }
}

function valueOf(value) {
  // -> A valueless key ("City:") parses to `null`, which `String()` would draw as the word "null"
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'boolean') {
    return value ? YES_SVG : NO_SVG
  }
  if (value instanceof Date) {
    // -> js-yaml represents a bare date as UTC midnight, so it has to be read back out in UTC: in
    //    the local zone `toLocaleDateString` prints the day before across the whole of the Americas.
    return value.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC'
    })
  }
  if (Array.isArray(value)) {
    // -> Joined by hand rather than with `join`, so that a boolean among them is still drawn
    return value.map((entry, index) => html`${index > 0 ? ', ' : ''}${valueOf(entry)}`)
  }
  const text = String(value)
  const link = linkOf(text)
  if (!link) {
    return text
  }
  // -> No whitespace inside the anchor — hence the tags broken after their closing bracket: a space
  //    beside the words is underlined on hover and pushes the external mark off the end of them
  return html`<a class="${link.isExternal ? 'is-external-link' : ''}" href="${link.href}"
    >${link.label}</a
  >`
}

function rowsOf(value) {
  // -> Not `typeof value === 'object'`, which also matches a `Date` and `null`: `Object.entries()`
  //    on either is `[]`, leaving `render()` reading `rows[0].label` off an empty array
  if (value?.constructor === Object) {
    const entries = Object.entries(value)
    // -> An empty mapping ("Key: {}") becomes one empty row, not a group `render()` cannot head
    if (entries.length === 0) {
      return [{ value: null }]
    }
    return entries.map(([label, nested]) => ({ label, value: nested }))
  }
  return [{ value }]
}

export class BlockInfoboxElement extends LitElement {
  /**
   * Read out of the source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'infobox',
    name: 'Infobox',
    description: 'A summary box beside the text, filled in from a list of facts.',
    icon: 'tabler:info-square',
    template: `\`\`\`yaml
City: Montreal
Country: Canada
Public Transport:
  Metro: true
  Bus: true
  Monorail: false
Website: https://montreal.ca
\`\`\``,
    props: [
      {
        name: 'name',
        type: 'string',
        label: 'Name',
        hint: 'Heading at the top of the box.',
        required: true
      },
      {
        name: 'image',
        type: 'string',
        label: 'Image URL',
        hint: 'Path or URL of a picture to show under the heading.'
      },
      {
        name: 'image-caption',
        type: 'string',
        label: 'Image Caption',
        hint: 'Shown under the picture.'
      }
    ]
  }

  static get styles() {
    return css`
      /*
        Floated, so the article runs down its left and closes under it — the whole point of an
        infobox. The margin carries !important because the app resets the margin of everything in a
        page, and a rule in the page beats a :host rule however specific; a declaration marked
        important in a shadow tree is the one thing that outranks it. See block-index for the usual
        way round this, which does not work on a float: a float collapses no margins.
      */
      :host {
        display: block;
        float: right;
        clear: right;
        width: 320px;
        max-width: 100%;
        margin: 4px 0 16px 24px !important;
        /*
          A layer of its own, above the article's own decoration. A heading draws its rule as an
          absolutely positioned pseudo-element spanning the whole column, and a positioned element
          paints over a float whichever way round the two are written — so the rule ran straight
          across the box. This is the right way round anyway: the box is a card sitting on the page,
          and the rule belongs to the text it is sitting on.
        */
        position: relative;
        z-index: 1;
      }

      /* -> Below a certain width the column cannot spare 320px, and a full-width card reads better */
      @media (max-width: 800px) {
        :host {
          float: none;
          width: auto;
          margin: 0 0 16px !important;
        }
      }

      /*
        Two opposite corner marks, Ledger only -- var(--block-corner-marks) is "none" under Cobalt.
        Sized against :host, since .infobox itself fills it with no host padding of its own. Same
        aria-hidden four-gradient technique block-tabs' .tabs-marks draws (OpenProject #2874).
      */
      .marks {
        display: var(--block-corner-marks);
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

      .infobox {
        border: 1px solid var(--infobox-border);
        border-radius: var(--block-radius);
        background-color: var(--block-bg);
        font-size: 0.85em;
        line-height: 1.45;
        overflow: hidden;
      }

      .name {
        padding: 10px 12px;
        border-bottom: var(--infobox-name-rule);
        background-color: var(--infobox-name-bg);
        color: var(--infobox-name-fg);
        font: 600 var(--infobox-name-font-size) var(--font-display);
        letter-spacing: var(--infobox-name-tracking);
        text-align: center;
      }

      figure {
        margin: 0;
        padding: 12px 12px 0;
        text-align: center;
      }

      /*
        The image well (OpenProject #2944) -- a tinted, rounded box behind the picture, or, with no
        picture, behind a centered placeholder glyph. --block-tile-radius is the same generic
        token img below already rounds its own corners with (0 Ledger, 6px Cobalt via
        --radius-control), so the well and the image it frames round in step with no
        aesthetic-specific override needed here.
      */
      .well {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12px;
        background-color: var(--infobox-well-bg);
        border-radius: var(--block-tile-radius);
      }

      .well-icon {
        color: var(--infobox-well-icon-fg);
      }

      img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: var(--block-tile-radius);
      }

      figcaption {
        padding-top: 6px;
        font-size: 11.5px;
        color: var(--infobox-caption-fg);
      }

      dl {
        display: grid;
        grid-template-columns: minmax(6em, auto) 1fr;
        gap: 0;
        margin: 0;
        padding: 0;
      }

      dt,
      dd {
        margin: 0;
        padding: 7px 12px;
        border-top: 1px solid var(--block-border);
      }
      dl > :is(dt, dd):is(:first-child, :nth-child(2)) {
        border-top: 0;
      }
      /*
        -> Cobalt only (--infobox-row-alt-bg is transparent in Ledger): every second row pair (dt+dd)
           takes the tint fill instead of a rule -- blocks.md's "rows alternate #fff / #f2f5ff
           (dl > :nth-child(4n+3), :nth-child(4n+4))".
      */
      dl > :nth-child(4n + 3),
      dl > :nth-child(4n + 4) {
        background-color: var(--infobox-row-alt-bg);
      }

      dt {
        color: var(--infobox-dt-fg);
        font-weight: 500;
        font-size: 12.5px;
        overflow-wrap: anywhere;
      }

      dd {
        color: var(--infobox-dd-fg);
        overflow-wrap: anywhere;
      }

      /* -> A nested mapping: its own heading across both columns, then its rows under it. Flat tint,
           no gradient (--infobox-head-top is gone -- OpenProject #2875 removed it). */
      .group {
        grid-column: 1 / -1;
        padding: 7px 12px;
        border-top: 1px solid var(--block-border);
        background-color: var(--block-tint-bg);
        color: var(--infobox-group-fg);
        font: var(--infobox-group-font);
        letter-spacing: var(--infobox-group-tracking);
        text-transform: var(--infobox-group-transform);
        text-align: center;
      }

      /*
        The rule that closes a group -- 2px in the border colour (was 3px), so a row belonging to the
        group and a row that follows it are told apart at a glance. Cobalt draws none: the group tint
        above is the only separation there.
      */
      dl > :is(dt, dd).is-group-end {
        border-bottom: var(--infobox-group-end-width) solid var(--block-border);
      }

      /* -> At the foot of the box there is nothing to separate from, and the card's own border is there */
      dl > :is(dt, dd):is(:last-child, :nth-last-child(2)) {
        border-bottom: 0;
      }

      /*
        Whatever comes next drops its own line: the thick one above it is the separation, and the two
        together would read as a single rule of an odd weight.

        Two selectors because a row is two children of the grid — the label and the value — so the
        line over it is drawn twice, once per column. Leaving the second one on broke the rule in
        half: nothing above the label, a hairline above the value. A group heading spans both columns
        and is only ever the one element, which is why the second selector asks for a dd.
      */
      dl > dd.is-group-end + *,
      dl > dd.is-group-end + * + dd {
        border-top: 0;
      }

      /*
        A value that is a web address, drawn the way the page draws its links. The rules are repeated
        here because a stylesheet in the page cannot reach into a shadow root — the custom properties
        it declares do reach in, which is what keeps the box in step with a re-themed site.
      */
      a {
        color: var(--infobox-link-fg);
        font-weight: 500;
        text-decoration: none;
      }
      a:hover,
      a:focus-visible {
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 2px;
      }

      /*
        A link that leaves the wiki says so — the same mark, from the same masked SVG, as a link in the
        text beside it. Masked rather than drawn, so it takes the link's own colour in either theme,
        and sized in em so it keeps its proportion to the words. See the LINKS section of
        css/_page-contents.scss.
      */
      a.is-external-link::after {
        content: '';
        display: inline-block;
        width: 0.8em;
        height: 0.8em;
        margin-left: 0.25em;
        background-color: currentColor;
        /* -> Subordinate to the words: a marker, not a second link */
        opacity: 0.7;
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M14 3v2h3.59l-9.83 9.83l1.41 1.41L19 6.41V10h2V3m-2 16H5V5h7V3H5c-1.11 0-2 .9-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2z'/%3E%3C/svg%3E");
        mask-repeat: no-repeat;
        mask-size: contain;
        vertical-align: baseline;
      }

      .yes {
        color: var(--infobox-yes-fg);
        vertical-align: -2px;
      }

      .no {
        color: var(--infobox-no-fg);
        vertical-align: -2px;
      }

      .error {
        padding: 10px 12px;
        color: var(--infobox-no-fg);
      }
    `
  }

  static get properties() {
    return {
      name: { type: String },

      image: { type: String },

      /**
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `imagecaption` while the block picker writes the literal
       *    `static definition.props[].name`, `image-caption`, into the page.
       */
      imageCaption: { type: String, attribute: 'image-caption' },

      _entries: { state: true },
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.name = ''
    this.image = ''
    this.imageCaption = ''
    this._entries = []
    this._error = ''
    this._darkMode = new DarkMode(this)
  }

  /**
   * The content stylesheet drops the top margin of the first element in a page. A floated infobox
   * at the very top takes that reset with it, leaving the heading behind it holding a full margin,
   * so the reset is passed on to whatever follows — the element the rule was written for. 2px
   * rather than 0 because the box's own top margin and border sit in that space, and the two
   * together line the rule under a page title up with the rule under the box's name.
   */
  _alignWithTop() {
    if (this.previousElementSibling) {
      return
    }
    this.nextElementSibling?.style.setProperty('margin-top', '2px')
  }

  connectedCallback() {
    super.connectedCallback()
    this._alignWithTop()
    // -> The body has been through markdown, which strips a value's markup and rearranges anything
    //    it reads as structure of its own; a fenced body reaches here exactly as it was typed
    const source = (this.querySelector('pre') ?? this).textContent ?? ''
    if (!source.trim()) {
      return
    }
    let parsed
    try {
      parsed = parseYaml(source)
    } catch (err) {
      this._error = `This infobox could not be read: ${err.reason ?? err.message}. Anything indented — a list, or a nested group — has to go inside a fenced code block.`
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this._error = 'An infobox is a list of "key: value" lines.'
      return
    }
    this._entries = Object.entries(parsed)
  }

  render() {
    return html`
      <i class="marks" aria-hidden="true"></i>
      <aside class="infobox">
        <div class="name">${this.name}</div>
        <figure>
          <div class="well">
            ${
              this.image
                ? html`<img src="${this.image}" alt="${this.imageCaption || this.name}" />`
                : PHOTO_SVG
            }
          </div>
          ${this.imageCaption ? html`<figcaption>${this.imageCaption}</figcaption>` : null}
        </figure>
        ${this._error ? html`<div class="error">${this._error}</div>` : null}
        ${
          this._entries.length > 0
            ? html`
                <dl>
                  ${this._entries.map(([label, value]) => {
                    const rows = rowsOf(value)
                    const isGroup = rows.length > 1 || rows[0].label !== undefined
                    return html`
                      ${isGroup ? html`<div class="group">${label}</div>` : null}
                      ${rows.map((row, index) => {
                        const groupEnd = isGroup && index === rows.length - 1 ? 'is-group-end' : ''
                        return html`
                          <dt class="${groupEnd}">${isGroup ? row.label : label}</dt>
                          <dd class="${groupEnd}">${valueOf(row.value)}</dd>
                        `
                      })}
                    `
                  })}
                </dl>
              `
            : null
        }
      </aside>
    `
  }
}

window.customElements.define('block-infobox', BlockInfoboxElement)
