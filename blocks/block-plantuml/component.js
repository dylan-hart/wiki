import { compress } from '../shared/compress.js'
import { DiagramImageElement } from '../shared/diagram-image.js'

/** The default server, which is the one PlantUML runs for everybody. */
const DEFAULT_SERVER = 'https://www.plantuml.com/plantuml'

/**
 * PlantUML's own alphabet for the text it carries in a URL.
 *
 * Base64 by shape but not by order — digits first, then the letters, and `-_` for the last two — so
 * the standard encoders cannot be used and this is done by hand below.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

/**
 * A diagram source as it goes into a PlantUML URL: deflated, then written in that alphabet.
 *
 * Raw deflate with no zlib header, which is what the server's decoder expects. Three bytes at a time
 * become four characters; a group short of three is padded with zeros, and the server disregards what
 * the padding decodes to.
 *
 * The result is about 1.4 characters per character of source, so a very large diagram can outgrow what
 * a server will accept in a URL. That is a limit of this transport this fork has decided to live with
 * rather than add a server-side POST proxy for -- see `docs/variances.md` -- so `firstUpdated()` below
 * measures the result and refuses to draw a diagram whose URL would exceed `MAX_DIAGRAM_URL_LENGTH`.
 */
async function encodeForUrl(source) {
  const bytes = await compress(new TextEncoder().encode(source), 'deflate-raw')
  let encoded = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i]
    const b2 = bytes[i + 1] ?? 0
    const b3 = bytes[i + 2] ?? 0
    encoded += ALPHABET[b1 >> 2]
    encoded += ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)]
    encoded += ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)]
    encoded += ALPHABET[b3 & 0x3f]
  }
  return encoded
}

/**
 * Block PlantUML
 */
export class BlockPlantumlElement extends DiagramImageElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'plantuml',
    name: 'PlantUML',
    description:
      'Draws a PlantUML diagram — sequence, class, state, activity, mindmap, gantt and the rest.',
    icon: 'tabler:schema',
    /*
      Fenced, and named `plantuml` so the source is what it says it is. The fence is also what keeps
      markdown off it: `->` survives, but `--` becomes a dash, a line opening with `*` or `#` is read
      as a list or a heading, and an indented line becomes a code block of its own.

      Passed to the server exactly as written, `@startuml` included — which is why a `@startmindmap`
      or a `@startgantt` works here too. Wrapping it in `@startuml` on the author's behalf would rule
      every one of those out.
    */
    template: `\`\`\`plantuml
@startuml
Alice -> Bob : hello
Bob --> Alice : hi
@enduml
\`\`\``,
    props: [
      {
        name: 'server',
        type: 'string',
        label: 'Server',
        hint: 'PlantUML server to draw with. The public one when left empty.',
        // -> Written out rather than taken from DEFAULT_SERVER above: the manifest is read out of this
        //    file's syntax tree at build time, where a name is just a name
        default: 'https://www.plantuml.com/plantuml'
      },
      {
        name: 'format',
        type: 'select',
        label: 'Format',
        options: ['svg', 'png'],
        hint: 'svg stays sharp at any size; png is there for a server with svg switched off.',
        default: 'svg'
      },
      {
        name: 'caption',
        type: 'string',
        label: 'Caption',
        hint: 'Shown under the diagram.'
      },
      {
        name: 'align',
        type: 'select',
        label: 'Alignment',
        options: ['left', 'center'],
        default: 'left'
      }
    ],
    /**
     * Site-level field an admin sets once for the whole site, as opposed to the `server` prop above,
     * which an author sets per use in the editor for the reader's own browser to fetch from directly.
     * This one is what the backend itself renders against for a server-side request — OpenProject
     * task 2223 — so unlike the prop, an admin-set value here is validated at write time
     * (`models/blocks.ts`) to be an http(s) URL with no query string or fragment. Same field name as
     * the `server` prop above on purpose — an admin's site-wide server is what `propDefault()`
     * (`frontend/src/helpers/blocks.js`) seeds the picker's `server` field from, the same way
     * block-map's `config`/`props` pair does for its own tile-server fields.
     */
    config: [
      {
        name: 'server',
        type: 'string',
        label: 'Server',
        hint: "PlantUML server this wiki renders diagrams against server-side (PDF export, and any other context that draws a diagram without a reader's own browser). The public one when left empty.",
        default: 'https://www.plantuml.com/plantuml'
      }
    ]
  }

  _defaultServer() {
    return DEFAULT_SERVER
  }

  _fenceName() {
    return 'plantuml'
  }

  _alt() {
    return this.caption || 'PlantUML diagram'
  }

  /**
   * Where the drawing comes from.
   *
   * An `img` rather than markup fetched and inlined, because that is the one way of asking that needs
   * nothing of the server beyond the picture: no CORS headers, which a PlantUML behind somebody's own
   * proxy may well not send. It also means the browser caches the drawing like any other image.
   */
  async _url(source) {
    return `${this._serverBase()}/${this._imageFormat()}/${await encodeForUrl(source)}`
  }

  /**
   * PlantUML's own reason for refusing a diagram, when the second request carries one.
   *
   * The block's `_explain()` otherwise has only "the image did not load" to go on. PlantUML answers
   * a diagram it cannot read with a picture saying so — which is where a mistake in the source
   * shows up, and the best place for it — but it also puts the reason in this header, which is worth
   * repeating for the case where the picture itself never arrived.
   */
  _explainBody(response) {
    const reason = response.headers.get('x-plantuml-diagram-error')
    return reason ? `PlantUML could not read this diagram: ${reason}` : null
  }

  _emptySourceMessage() {
    let message = super._emptySourceMessage()
    if (this.querySelector('img')) {
      // -> Something already put an image where the source should be — pasted-in markup, most
      //    likely, since nothing in this wiki's own render pipeline ever does
      message +=
        "\n\nAn image sits here instead of source text. Replace it with the diagram's PlantUML source, inside the ```plantuml fence."
    }
    return message
  }
}

window.customElements.define('block-plantuml', BlockPlantumlElement)
