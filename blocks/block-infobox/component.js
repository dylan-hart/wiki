import { LitElement, html, css } from 'lit'
import { load as parseYamlRaw, CORE_SCHEMA, timestampTag } from 'js-yaml'
import { DarkMode } from '../shared/theme.js'

/*
  OpenProject #956: `load()`'s own default is `CORE_SCHEMA` (js-yaml 5's YAML-1.2-only schema),
  which -- unlike the `DEFAULT_SCHEMA` older js-yaml majors shipped -- has no `!!timestamp` type, so
  a bare date ("Founded: 2020-01-01") resolves to the plain string "2020-01-01", never a `Date`.
  `valueOf()` below has a `Date`-formatting branch that depended on this, so it needs the tag added
  back explicitly. `withTags(timestampTag)` alone, not a switch to the fuller `YAML11_SCHEMA`, so a
  bare date is still recognized without also pulling in YAML 1.1's `yes`/`no`/`on`/`off` booleans or
  octal integers changing how every other value in an infobox parses.
*/
const INFOBOX_SCHEMA = CORE_SCHEMA.withTags(timestampTag)

function parseYaml(source) {
  return parseYamlRaw(source, { schema: INFOBOX_SCHEMA })
}

/**
 * Yes and no, drawn rather than spelled out.
 *
 * A column of "true"/"false" is read word by word; a tick and a cross are read at a glance, which is
 * what an infobox is for. Inline, because they are the same two pictures on every infobox there is,
 * and labelled, since the shape alone means nothing to a screen reader.
 */
const YES_SVG = html`
  <svg viewBox="0 0 24 24" width="18" height="18" role="img" aria-label="Yes" class="yes">
    <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
`

const NO_SVG = html`
  <svg viewBox="0 0 24 24" width="18" height="18" role="img" aria-label="No" class="no">
    <path
      fill="currentColor"
      d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
`

/**
 * What an author writes to mean "this value goes somewhere": a page, an email address, a number.
 *
 * The scheme has to be spelled out. A value that merely looks like a hostname is left alone, since
 * plenty of ordinary facts read that way — a file name, a version, a decimal — and there is no test
 * that tells `notes.txt` from `montreal.ca` without guessing.
 */
const SCHEME = /^(?:https?:\/\/|mailto:|tel:)/i

/**
 * The link a value stands for, if it is one.
 *
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
    Shown without its scheme. An infobox is a column of short facts read at a glance, and `https://`
    is the same four inches of boilerplate on every row of it — the address is the part that says
    where the row goes. The label comes off the text as typed rather than out of the parsed URL, which
    would put back a trailing slash the author did not write.
  */
  const label = text.replace(SCHEME, '')
  if (!label) {
    return null
  }
  return {
    href: url.href,
    label,
    /*
      The mark means "this leaves the wiki", so it is for a web address on another host — the question
      the page's renderer asks of a link, and for the same reason it asks it of the host and not of
      the text. See `isExternalHref` in `renderers/markdown.js`, which also leaves an email address
      and a telephone number unmarked: neither goes to a page at all, and both say what they are.
    */
    isExternal:
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin !== globalThis.location?.origin
  }
}

/**
 * One value, as it is shown.
 *
 * A list reads as one line, since an infobox row is a line: "French, English" rather than a bullet
 * list squeezed into half a column.
 */
function valueOf(value) {
  // -> A valueless key ("City:") parses to `null`; shown as nothing rather than the literal word
  //    "null" a bare `String()` would produce.
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'boolean') {
    return value ? YES_SVG : NO_SVG
  }
  if (value instanceof Date) {
    // -> A bare YAML date ("Founded: 2020-01-01", opted back into `!!timestamp` resolution above) is
    //    a calendar date with no time of day, and js-yaml represents it as UTC midnight -- so it has
    //    to be read back out in UTC too. Left to the default (local) zone, `toLocaleDateString` shifts
    //    it backward a day in any negative-offset timezone: UTC midnight Jan 1st is 7pm/8pm Dec 31st
    //    across the whole of the Americas, which would print the wrong date on most readers' clocks.
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
  // -> No whitespace inside the anchor — hence the tags broken after their closing bracket, which is
  //    how the formatter keeps it out: a space beside the words is taken in by the underline on hover
  //    and pushes the external mark off the end of them
  return html`<a class="${link.isExternal ? 'is-external-link' : ''}" href="${link.href}"
    >${link.label}</a
  >`
}

/**
 * The rows a value turns into.
 *
 * A nested mapping becomes a group of its own with a heading, which is how an infobox shows a cluster
 * of related facts. Anything else is a single row.
 */
function rowsOf(value) {
  // -> `typeof value === 'object'` alone also matches a `Date` (a bare YAML date, e.g.
  //    "Founded: 2020-01-01") and `null` (a valueless key) — neither is a nested mapping, and
  //    `Object.entries()` on either is `[]`, which left `render()` reading `rows[0].label` off an
  //    empty array. `constructor === Object` is what js-yaml's default schema actually produces for
  //    a mapping; everything else falls through to the single-row branch below.
  if (value?.constructor === Object) {
    const entries = Object.entries(value)
    // -> An empty mapping ("Key: {}") is shown as a single row with an empty value, not a
    //    zero-member group `render()` would have nothing to head with.
    if (entries.length === 0) {
      return [{ value: null }]
    }
    return entries.map(([label, nested]) => ({ label, value: nested }))
  }
  return [{ value }]
}

/**
 * Block Infobox
 */
export class BlockInfoboxElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
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

      .infobox {
        border: 1px solid var(--infobox-border);
        border-radius: 6px;
        background-color: var(--infobox-bg);
        font-size: 0.85em;
        line-height: 1.45;
        overflow: hidden;
      }

      .name {
        padding: 10px 12px;
        border-bottom: 1px solid var(--infobox-border);
        background-color: var(--infobox-head);
        font-size: 1.1em;
        font-weight: 600;
        text-align: center;
      }

      figure {
        margin: 0;
        padding: 12px 12px 0;
        text-align: center;
      }

      img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 4px;
      }

      figcaption {
        padding-top: 6px;
        font-size: 0.9em;
        opacity: 0.75;
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
        border-top: 1px solid var(--infobox-rule);
      }
      dl > :is(dt, dd):is(:first-child, :nth-child(2)) {
        border-top: 0;
      }

      dt {
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      dd {
        overflow-wrap: anywhere;
      }

      /*
        -> A nested mapping: its own heading across both columns, then its rows under it

        Shaded top-down rather than flat, so the heading reads as the lid of the group under it: the
        pale edge catches the eye where the group starts and the colour settles into the one the box's
        own name is drawn on. The two stops are declared per theme, since "lighter" in dark mode is a
        lighter dark grey and not a step towards white.
      */
      .group {
        grid-column: 1 / -1;
        padding: 7px 12px;
        border-top: 1px solid var(--infobox-rule);
        background-image: linear-gradient(to bottom, var(--infobox-head-top), var(--infobox-head));
        font-weight: 600;
        text-align: center;
      }

      /*
        The rule that closes a group.
        Thicker than the ones between rows, and in the border colour rather than the rule colour, so
        that a row belonging to the group and a row that follows it are told apart at a glance — the
        heading marks where the group starts, this marks where it stops.
      */
      dl > :is(dt, dd).is-group-end {
        border-bottom: 3px solid var(--infobox-border);
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
        A value that is a web address, drawn the way the page draws its links: the same colour token,
        the same medium weight, the same underline on hover. The rules are repeated here because a
        stylesheet in the page cannot reach into a shadow root — the custom properties it declares do
        reach in, which is what keeps the box in step with a re-themed site.
      */
      a {
        color: var(--content-link, var(--q-primary, #1976d2));
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
        color: var(--q-positive, #02c39a);
        vertical-align: -3px;
      }

      .no {
        color: var(--q-negative, #c10015);
        vertical-align: -3px;
      }

      .error {
        padding: 10px 12px;
        color: var(--q-negative, #c10015);
      }

      :host {
        --infobox-border: #d5d5d5;
        --infobox-bg: #f8f9fa;
        --infobox-head: #eaecf0;
        --infobox-head-top: #f7f8fa;
        --infobox-rule: #e3e5e8;
      }
      :host([dark]) {
        --infobox-border: rgba(255, 255, 255, 0.15);
        --infobox-bg: #161b22;
        --infobox-head: #1e232a;
        --infobox-head-top: #2b323c;
        --infobox-rule: rgba(255, 255, 255, 0.1);
      }
    `
  }

  static get properties() {
    return {
      /**
       * Heading at the top of the box
       * @type {string}
       */
      name: { type: String },

      /**
       * Path or URL of a picture
       * @type {string}
       */
      image: { type: String },

      /**
       * Caption under the picture
       *
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `imagecaption` while the block picker — which writes the
       *    literal `static definition.props[].name`, `image-caption` — writes `image-caption` into
       *    the page.
       * @type {string}
       */
      imageCaption: { type: String, attribute: 'image-caption' },

      // Internal Properties
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
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /**
   * Read the facts out of the block's body.
   *
   * The body has been through markdown by the time it gets here, so what is left of `city: Montreal`
   * is its text — which is all YAML needs. Markdown does leave its mark: a value written with
   * emphasis or a link keeps the words and loses the markup, and anything markdown reads as
   * structure of its own (a line opening with `-`, `#` or `>`) arrives rearranged. A fenced code
   * block is the way out of that, since its contents reach here exactly as they were typed.
   */
  /**
   * Hand the first line of the column back its place at the top.
   *
   * The content stylesheet drops the top margin of the first element in a page, because the space
   * above it belongs to the container. A floated infobox at the very top takes that reset with it and
   * leaves the heading behind it holding a full margin — so the heading, which is what a reader sees
   * as the start of the page, sits an inch below the box beside it. Passed on to whatever follows,
   * since that is the element the rule was written for.
   *
   * Two pixels rather than none: the box's own top margin and border sit in that space, and the two
   * together put the rule under a page title on the rule under the box's name — the line the eye
   * follows across from one to the other.
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
    const source = (this.querySelector('pre') ?? this).textContent ?? ''
    if (!source.trim()) {
      return
    }
    let parsed
    try {
      parsed = parseYaml(source)
    } catch (err) {
      // -> Naming the fence, because it is the answer nine times out of ten: markdown reads an
      //    indented line as structure of its own and hands this the text without the indentation
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
      <aside class="infobox">
        <div class="name">${this.name}</div>
        ${
          this.image
            ? html`
                <figure>
                  <img src="${this.image}" alt="${this.imageCaption || this.name}" />
                  ${this.imageCaption ? html`<figcaption>${this.imageCaption}</figcaption>` : null}
                </figure>
              `
            : null
        }
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
                        // -> The pair that closes a group carries the rule that separates it from
                        //    whatever is listed after it
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
