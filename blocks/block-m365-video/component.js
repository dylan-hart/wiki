import { LitElement, html, css } from 'lit'

import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'

/**
 * Hostnames Microsoft serves these embeds from. Deliberately the whole allow-list, checked as a
 * suffix with a dot boundary (`host === suffix || host.endsWith('.' + suffix)`) so a video's own
 * subdomain (`contoso-my.sharepoint.com`, `web.microsoftstream.com`) passes while a lookalike host
 * that merely ends with the same characters (`notsharepoint.com`, `evil-sharepoint.com.attacker.net`)
 * does not. This list, not a generic "any iframe src" field, is what keeps this block narrow.
 */
const ALLOWED_HOST_SUFFIXES = [
  'sharepoint.com',
  'stream.microsoft.com',
  // -> The name Microsoft Stream carried before it was folded into SharePoint/OneDrive video
  'microsoftstream.com',
  'clipchamp.com'
]

/** An embed-code snippet's `src` attribute, single- or double-quoted, across any line breaks in it. */
const IFRAME_SRC = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i

/**
 * The address a pasted embed points at, or null for input with nothing to extract.
 *
 * Accepts either the full `<iframe>` snippet Microsoft's Share -> Manage Access flow hands out, or
 * just the `src` pulled out of it by hand — both are what an author is likely to paste. Input that
 * opens with `<` but carries no `src` is treated as a malformed snippet, not as a literal address.
 */
function extractSrc(source) {
  const match = IFRAME_SRC.exec(source)
  if (match) {
    return (match[1] ?? match[2]).trim()
  }
  return source.startsWith('<') ? null : source
}

/** `src` parsed as a URL, or null for one that is not a well-formed `https:` address. */
function parseHttpsUrl(src) {
  const withScheme = src.startsWith('//') ? `https:${src}` : src
  const url = URL.parse(withScheme)
  return url && url.protocol === 'https:' ? url : null
}

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase()
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Block Microsoft 365 Video
 *
 * A Clipchamp or Stream-on-SharePoint video, from the embed code Microsoft's own Share -> Manage
 * Access flow hands out. The `src` is validated against Microsoft's own video hosts and then passed
 * through untouched — unlike `block-youtube`, this never rebuilds the address from parameters, since
 * Microsoft's snippet already carries whatever the tenant's sharing settings require and there is no
 * safe way to guess which of them can be dropped.
 *
 * This does not, and cannot, get a viewer past Microsoft's own auth wall: the frame plays only for a
 * viewer already signed into the same Microsoft 365 tenant with access to the file. Clipchamp has no
 * public-sharing option at all — see the block's `hint` text, which says so wherever an author fills
 * this prop in.
 */
export class BlockM365VideoElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'm365-video',
    name: 'Microsoft 365 Video',
    description:
      'Embeds a Clipchamp or Stream-on-SharePoint video. Plays only for a viewer already signed into that Microsoft 365 tenant with access to the file — there is no public link for these.',
    icon: 'microsoft',
    props: [
      {
        name: 'embed',
        type: 'string',
        label: 'Embed Code',
        hint: "Paste the iframe embed code from the video's Share > Manage Access panel, or just its src address. This only renders for a viewer separately signed into the source Microsoft 365 tenant with access to the file — it is not a public embed, and Clipchamp has no public-sharing option at all.",
        required: true
      },
      {
        name: 'width',
        type: 'number',
        label: 'Width',
        hint: 'Width of the player in pixels. Empty fills the width of the page.'
      },
      {
        name: 'height',
        type: 'number',
        label: 'Height',
        hint: 'Height of the player in pixels. Empty keeps the widescreen shape.'
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
        The frame's box, and the gap below the block. On this element rather than :host: see
        block-index.

        -> A max-width rather than a plain width, so a player asked for at a fixed size on a phone is
           the width of the phone instead of pushing the page sideways.
      */
        .player {
          max-width: 100%;
          margin-bottom: 16px;
          border-radius: 5px;
          overflow: hidden;
          background-color: #000;
        }

        iframe {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
        }

        .error {
          margin-bottom: 16px;
        }
      `
    ]
  }

  static get properties() {
    return {
      /**
       * The pasted embed code or address
       * @type {string}
       */
      embed: { type: String },

      /**
       * Width of the player in pixels
       * @type {number}
       */
      width: { type: Number },

      /**
       * Height of the player in pixels
       * @type {number}
       */
      height: { type: Number }
    }
  }

  constructor() {
    super()
    this.embed = ''
    this.width = null
    this.height = null
  }

  /** A prop given a usable number, or null for one left empty. */
  _size(value) {
    const size = Number(value)
    return Number.isFinite(size) && size > 0 ? size : null
  }

  render() {
    const raw = (this.embed ?? '').trim()
    if (!raw) {
      return renderError("This player needs a Microsoft 365 video's embed code.")
    }

    const src = extractSrc(raw)
    const url = src ? parseHttpsUrl(src) : null
    if (!url) {
      return renderError(
        "That doesn't look like a Microsoft 365 video embed. Paste the iframe embed code from the " +
          "video's Share > Manage Access panel, or just its src address."
      )
    }
    if (!isAllowedHost(url.hostname)) {
      return renderError(
        `${url.hostname} is not a Microsoft-owned video host, so this will not be rendered. This ` +
          'block only embeds Clipchamp or Stream-on-SharePoint videos — a *.sharepoint.com, ' +
          'stream.microsoft.com, *.microsoftstream.com or *.clipchamp.com address.'
      )
    }

    const width = this._size(this.width)
    const height = this._size(this.height)
    const style = [
      width ? `width: ${width}px` : 'width: 100%',
      height ? `height: ${height}px` : 'aspect-ratio: 16 / 9'
    ].join('; ')

    return html`
      <div class="player" style=${style}>
        <iframe
          src=${src}
          title="Microsoft 365 video player"
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowfullscreen></iframe>
      </div>
    `
  }
}

window.customElements.define('block-m365-video', BlockM365VideoElement)
