import { LitElement, html, css, unsafeCSS } from 'lit'
// -> The ESM build by name: leaflet's `main` is the UMD bundle and it has no `exports` map to pick
//    the module build instead
import * as L from 'leaflet/dist/leaflet-src.esm.js'
import leafletCss from 'leaflet/dist/leaflet.css'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { getBlockConfig } from '../shared/config.js'

const DEFAULT_TILE_SERVER_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * A site admin's config beats a page author's own prop, which beats the built-in OSM default: the
 * admin is the one accountable for the site's tile bill and terms of service.
 *
 * Kept out of `firstUpdated` so the precedence is testable without mounting Leaflet.
 */
export function resolveTileSettings(siteConfig, props) {
  return {
    tileServerUrl: siteConfig.tileServerUrl || props.tileServerUrl || DEFAULT_TILE_SERVER_URL,
    apiKey: siteConfig.apiKey || props.apiKey || ''
  }
}

/**
 * Drawn rather than fetched: Leaflet's default icon is a pair of PNGs whose URL it builds at
 * runtime, which does not survive bundling.
 */
const MARKER_SVG = `
  <svg viewBox="0 0 24 36" width="24" height="36" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24c0-6.6-5.4-12-12-12z" fill="#c62828"/>
    <circle cx="12" cy="12" r="4.5" fill="#fff"/>
  </svg>
`

export class BlockMapElement extends LitElement {
  /**
   * Read out of the source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'map',
    name: 'Map',
    description: 'Shows a location on an OpenStreetMap map.',
    icon: 'tabler:map-2',
    props: [
      {
        name: 'lat',
        type: 'number',
        label: 'Latitude',
        hint: 'Decimal degrees, e.g. 45.5019.',
        required: true
      },
      {
        name: 'lon',
        type: 'number',
        label: 'Longitude',
        hint: 'Decimal degrees, e.g. -73.5674.',
        required: true
      },
      {
        name: 'zoom',
        type: 'number',
        label: 'Zoom',
        hint: '1 is the whole world, 19 is a single building.',
        default: 13
      },
      {
        name: 'height',
        type: 'number',
        label: 'Height',
        hint: 'Height of the map in pixels.',
        default: 400
      },
      {
        name: 'label',
        type: 'string',
        label: 'Marker Label',
        hint: 'Shown in a popup when the marker is clicked. The marker is drawn either way.'
      },
      {
        name: 'theme',
        type: 'select',
        label: 'Theme',
        options: ['auto', 'light', 'dark'],
        hint: 'auto follows the light or dark theme the reader is using.',
        default: 'auto'
      },
      {
        name: 'tile-server-url',
        type: 'string',
        label: 'Tile Server URL',
        hint: "Overrides the default OpenStreetMap tiles for this map only. A site-wide tile server, set in this block's admin config, takes precedence over this."
      },
      {
        name: 'api-key',
        type: 'string',
        label: 'API Key',
        hint: "Only needed for tile providers that require one. A site-wide key, set in this block's admin config, takes precedence over this."
      }
    ],
    /**
     * Set once per site by an admin, where `props` above are per use by an author. The field names
     * match those props deliberately; `resolveTileSettings` decides between them.
     */
    config: [
      {
        name: 'tileServerUrl',
        type: 'string',
        label: 'Tile Server URL',
        hint: 'Must contain {z}/{x}/{y} placeholders. Defaults to the public OpenStreetMap tile server.',
        default: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      },
      {
        name: 'apiKey',
        type: 'string',
        label: 'API Key',
        hint: 'Only needed for tile providers that require one.'
      }
    ]
  }

  static get styles() {
    return [
      unsafeCSS(leafletCss),
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
        .map,
        .error {
          margin-bottom: 16px;
        }

        /*
          The palette, as custom properties on the container so that the rules below are written once
          and only the values are switched.

          Which set applies is decided on the data-theme attribute rather than on a class, because
          Leaflet owns the class attribute of this element -- it writes leaflet-container,
          leaflet-touch and the animation classes onto it -- and a Lit class binding sets the whole
          attribute, so rebinding it (which the theme changing under the reader does) would take
          Leaflet's own classes off with it. render() resolves auto to one of the two, so the
          attribute in the DOM is always the palette actually in use.
        */
        .map {
          --tile-filter: none;
          --edge: rgba(0, 0, 0, 0.1);
          --surface: #f2efe9;
          --control-bg: #fff;
          --control-fg: #333;
          --control-link: #0078a8;
        }
        .map[data-theme='dark'] {
          /*
            OpenStreetMap publishes one style and it is a light one, so a dark map is the light tiles
            recoloured: inverted for the dark ground and light labels, turned back through half the
            colour wheel so water reads as water again, and taken slightly off full contrast, which
            the inversion otherwise exaggerates. An approximation -- greenery lands cooler than it
            should -- but it costs no second tile provider and no second request.

            The filter is on the tile pane alone. Marker, popup and controls sit in panes of their
            own and would come back inverted too.
          */
          --tile-filter: invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.9) saturate(0.85);
          --edge: rgba(255, 255, 255, 0.15);
          --surface: #16130f;
          --control-bg: #2b2b2b;
          --control-fg: #ddd;
          --control-link: #6cb6d9;
        }

        .map {
          width: 100%;
          border-radius: var(--block-radius);
          border: 1px solid var(--edge);
          background-color: var(--surface);
        }

        .map .leaflet-tile-pane {
          filter: var(--tile-filter);
        }

        /* -> The tiles are somebody else's work and the licence asks for the credit to be visible */
        .leaflet-container .leaflet-control-attribution {
          font-size: 10px;
          /* -> Leaflet shows the credit through a translucent plate, which is worth keeping */
          background: color-mix(in srgb, var(--control-bg) 80%, transparent);
          color: var(--control-fg);
        }
        .leaflet-container .leaflet-control-attribution a {
          color: var(--control-link);
        }

        /* -> Leaflet's zoom buttons are white by default, which is a lamp on a dark map */
        .leaflet-container .leaflet-bar a {
          background-color: var(--control-bg);
          color: var(--control-fg);
          border-bottom-color: var(--edge);
        }
        .leaflet-container .leaflet-bar a:hover {
          background-color: color-mix(in srgb, var(--control-bg) 90%, var(--control-fg));
        }
      `
    ]
  }

  static get properties() {
    return {
      lat: { type: Number },

      lon: { type: Number },

      zoom: { type: Number },

      height: { type: Number },

      label: { type: String },

      theme: { type: String },

      /**
       * -> Both dashed `attribute`s here are explicit, because Lit's default (a bare lowercasing of
       *    the property name, no dash inserted) would listen for `tileserverurl` while the block
       *    picker writes the literal `static definition.props[].name`, `tile-server-url`.
       */
      tileServerUrl: { type: String, attribute: 'tile-server-url' },

      apiKey: { type: String, attribute: 'api-key' },

      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.lat = null
    this.lon = null
    this.zoom = 13
    this.height = 400
    this.label = ''
    this.theme = 'auto'
    this.tileServerUrl = ''
    this.apiKey = ''
    this._error = ''
    this._map = null
    /*
      No `dark` attribute on the host: the `theme` prop can pin a map light on a dark page, so this
      block resolves the question itself and puts the answer on `data-theme`.
    */
    this._darkMode = new DarkMode(this, { attribute: false })
  }

  /*
    Not `connectedCallback`: the Leaflet map needs the `.map` container, which exists only after
    the first render. Lit does not await a lifecycle callback, so awaiting the config fetch here
    delays the tile layer alone, not the element's own render.
  */
  async firstUpdated() {
    const lat = Number(this.lat)
    const lon = Number(this.lon)
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      this._error =
        'This map needs a latitude between -90 and 90 and a longitude between -180 and 180.'
      return
    }

    const container = this.renderRoot.querySelector('.map')
    const siteConfig = await getBlockConfig('map')
    // -> A reader may have navigated away by the time the fetch resolves
    if (!this.isConnected) {
      return
    }
    const { tileServerUrl, apiKey } = resolveTileSettings(siteConfig, {
      tileServerUrl: this.tileServerUrl,
      apiKey: this.apiKey
    })

    this._map = L.map(container, {
      center: [lat, lon],
      zoom: Math.min(Math.max(Number(this.zoom) || 13, 1), 19),
      // -> A map mid-article must not swallow the wheel of a reader scrolling past it; the click
      //    handler below is them saying they meant to use it
      scrollWheelZoom: false
    })
    this._map.on('click', () => this._map.scrollWheelZoom.enable())
    this._map.on('mouseout', () => this._map.scrollWheelZoom.disable())

    L.tileLayer(tileServerUrl, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      // -> Leaflet's URL templating fills any `{apiKey}` placeholder from this option, the same way
      //    it fills `{z}`/`{x}`/`{y}`; a URL without the placeholder just ignores it
      apiKey
    }).addTo(this._map)

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        html: MARKER_SVG,
        className: '',
        iconSize: [24, 36],
        iconAnchor: [12, 36],
        popupAnchor: [0, -32]
      }),
      // -> Only a labelled marker is tabbable (Leaflet opens its popup on Enter); a bare pin is a
      //    picture
      keyboard: Boolean(this.label)
    }).addTo(this._map)
    if (this.label) {
      marker.bindPopup(this.label)
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    // -> Leaflet's window listeners and resize observer outlive the element otherwise
    this._map?.remove()
    this._map = null
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    // -> Anything but the two pinned values falls back to `auto`, which has an answer for any page
    const theme = ['light', 'dark'].includes(this.theme)
      ? this.theme
      : this._darkMode.isDark
        ? 'dark'
        : 'light'
    return html`<div
      class="map"
      data-theme="${theme}"
      style="height: ${Number(this.height) || 400}px"></div>`
  }
}

window.customElements.define('block-map', BlockMapElement)
