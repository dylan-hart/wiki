import { VideoEmbedElement } from '../shared/video-embed.js'

/**
 * Matched as a suffix on a dot boundary, so a tenant's own subdomain (`contoso-my.sharepoint.com`)
 * passes while a lookalike ending in the same characters (`evil-sharepoint.com.attacker.net`) does
 * not. This list is the whole of what this block will frame.
 */
const ALLOWED_HOST_SUFFIXES = [
  'sharepoint.com',
  'stream.microsoft.com',
  // -> The name Microsoft Stream carried before it was folded into SharePoint/OneDrive video
  'microsoftstream.com',
  'clipchamp.com'
]

const IFRAME_SRC = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i

/**
 * Takes either the whole `<iframe>` snippet or a bare `src`, since an author pastes both. Input
 * that opens with `<` but carries no `src` is a malformed snippet, not a literal address.
 */
function extractSrc(source) {
  const match = IFRAME_SRC.exec(source)
  if (match) {
    return (match[1] ?? match[2]).trim()
  }
  return source.startsWith('<') ? null : source
}

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
 * This does not, and cannot, get a viewer past Microsoft's own auth wall: the frame plays only for
 * a viewer already signed into the same tenant with access to the file, and Clipchamp has no
 * public-sharing option at all.
 */
export class BlockM365VideoElement extends VideoEmbedElement {
  /**
   * Read out of the source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'm365-video',
    name: 'Microsoft 365 Video',
    description:
      'Embeds a Clipchamp or Stream-on-SharePoint video. Plays only for a viewer already signed into that Microsoft 365 tenant with access to the file — there is no public link for these.',
    icon: 'tabler:brand-office',
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

  static properties = {
    embed: { type: String }
  }

  constructor() {
    super()
    this.embed = ''
  }

  /*
    What an author pastes here is a whole `<iframe>` snippet, not an address, so this block
    overrides the source hook and leaves the inherited `url` prop unset.
  */
  _source() {
    return (this.embed ?? '').trim()
  }

  _providerName() {
    return 'Microsoft 365'
  }

  _frameAllow() {
    return 'autoplay; encrypted-media; fullscreen; picture-in-picture'
  }

  /**
   * The address is passed through untouched rather than rebuilt from parameters the way
   * `block-youtube` does: the snippet carries whatever the tenant's sharing settings require, and
   * there is no safe way to guess which of those can be dropped.
   */
  _parse(source) {
    const src = extractSrc(source)
    const url = src ? parseHttpsUrl(src) : null
    return url && isAllowedHost(url.hostname) ? src : null
  }

  _embedUrl(src) {
    return src
  }

  _missingSourceMessage() {
    return "This player needs a Microsoft 365 video's embed code."
  }

  /**
   * Re-reads the input `_parse` just refused rather than having `_parse` report a reason, which
   * would put that branch in every block sharing the base class for the sake of this one.
   */
  _invalidSourceMessage(source) {
    const src = extractSrc(source)
    const url = src ? parseHttpsUrl(src) : null
    if (url) {
      return (
        `${url.hostname} is not a Microsoft-owned video host, so this will not be rendered. This ` +
        'block only embeds Clipchamp or Stream-on-SharePoint videos — a *.sharepoint.com, ' +
        'stream.microsoft.com, *.microsoftstream.com or *.clipchamp.com address.'
      )
    }
    return (
      "That doesn't look like a Microsoft 365 video embed. Paste the iframe embed code from the " +
      "video's Share > Manage Access panel, or just its src address."
    )
  }
}

window.customElements.define('block-m365-video', BlockM365VideoElement)
