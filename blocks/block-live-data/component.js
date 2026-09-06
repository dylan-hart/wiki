import { LitElement, html, css, svg, nothing } from 'lit'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { getSiteId } from '../shared/site.js'

/** How many past readings a sparkline keeps, client-side only -- see the class comment below. */
const SPARKLINE_HISTORY = 30

/** Floor matching the server's own clamp (`models/liveData.ts`) -- kept here purely so a page
 *  author sees the effective interval in devtools rather than a number the server silently raised. */
const MIN_REFRESH_SECONDS = 10

/**
 * `ok` / `warning` / `critical` / `unknown` -- the last both when the value isn't a finite number
 * and when neither threshold is set, since there is then nothing to compare it against.
 *
 * @param {unknown} value The resolved value.
 * @param {unknown} okMax At or below this reads `ok`.
 * @param {unknown} warnMax At or below this (but above `okMax`) reads `warning`; above it, `critical`.
 */
export function statusLevel(value, okMax, warnMax) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 'unknown'
  }
  const okThreshold = Number(okMax)
  const warnThreshold = Number(warnMax)
  if (Number.isFinite(okThreshold) && numeric <= okThreshold) {
    return 'ok'
  }
  if (Number.isFinite(warnThreshold) && numeric <= warnThreshold) {
    return 'warning'
  }
  if (Number.isFinite(okThreshold) || Number.isFinite(warnThreshold)) {
    return 'critical'
  }
  return 'unknown'
}

/**
 * An SVG path `d` attribute, `points` scaled into a 100x32 box -- a flat line down the middle when
 * every reading so far has been identical, since there is no range yet to spread them across.
 *
 * @param {number[]} points
 */
export function sparklinePath(points) {
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min
  return points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * 100
      const y = range === 0 ? 16 : 30 - ((value - min) / range) * 28
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

/**
 * Block Live Data (OpenProject #868)
 *
 * Polls a REST/JSON endpoint on an interval and shows the resolved value plain, as a trend
 * sparkline, or as a threshold-coloured status pill. The fetch itself never happens here: this
 * block only ever calls its own wiki's `POST /sites/:siteId/live-data/resolve`, which is what
 * actually reaches the endpoint, resolves a stored credential into a bearer token server-side, and
 * hands back nothing but the one extracted value -- see `backend/models/liveData.ts`'s header
 * comment for why. A page's source (and this component's own network tab) never sees the endpoint's
 * credential, only a `credentialId` naming a row in this site's block-credentials store.
 *
 * The sparkline's history is this element's own memory, not a time series the server keeps: it
 * starts empty on every page load and grows only from polls made while the block has been mounted.
 * A real time-series store is a v2 concern (OpenProject #868 is REST/JSON polling only) -- this is
 * "the trend since you opened the page", which is what a reader watching a live value actually wants
 * most of the time, not a substitute for one.
 */
export class BlockLiveDataElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'live-data',
    name: 'Live Data',
    description:
      'Polls a REST/JSON endpoint on an interval and shows the resolved value, a trend sparkline, or a threshold-based status pill.',
    icon: 'tabler:activity',
    props: [
      {
        name: 'url',
        type: 'string',
        label: 'Endpoint URL',
        hint: 'The REST/JSON endpoint to poll.',
        required: true
      },
      {
        name: 'json-path',
        type: 'string',
        label: 'JSONPath',
        hint: 'Expression naming the one field to show, e.g. $.data.temperature.',
        default: '$'
      },
      {
        name: 'credential-id',
        type: 'string',
        label: 'Credential ID',
        hint: "A stored credential's id, from this site's Blocks admin page. The url above must be within that credential's allowed domains, or the fetch is refused. Leave blank for an endpoint that takes no authentication."
      },
      {
        name: 'refresh-interval',
        type: 'number',
        label: 'Refresh Interval (seconds)',
        hint: 'How often to re-fetch. The server clamps this to 10 seconds - 24 hours.',
        default: 60
      },
      {
        name: 'display-mode',
        type: 'select',
        label: 'Display',
        options: ['value', 'sparkline', 'status'],
        default: 'value'
      },
      {
        name: 'label',
        type: 'string',
        label: 'Label',
        hint: 'Shown above the value.'
      },
      {
        name: 'unit',
        type: 'string',
        label: 'Unit',
        hint: 'Shown after the value, e.g. °C or %.'
      },
      {
        name: 'ok-max',
        type: 'number',
        label: 'OK Threshold (status mode)',
        hint: 'A value at or below this is shown green.'
      },
      {
        name: 'warn-max',
        type: 'number',
        label: 'Warning Threshold (status mode)',
        hint: 'A value at or below this (but above the OK threshold) is shown amber; above it, red.'
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

        .card {
          margin-bottom: 16px;
          border: 1px solid rgba(0, 0, 0, 0.1);
          border-radius: 5px;
          padding: 1rem;
          background-image: linear-gradient(to bottom, #fff, #fafafa);
        }
        :host([dark]) .card {
          border-color: rgba(255, 255, 255, 0.15);
          background-image: linear-gradient(to bottom, #161b22, #0d1117);
        }

        .label {
          font-weight: 500;
          font-size: 0.85em;
          opacity: 0.75;
          margin-bottom: 0.35rem;
        }

        .value-row {
          display: flex;
          align-items: baseline;
          gap: 0.35rem;
        }

        .value {
          font-size: 2rem;
          font-weight: 500;
          line-height: 1.1;
          font-variant-numeric: tabular-nums;
          color: var(--q-primary, #1976d2);
        }

        .unit {
          font-size: 1rem;
          opacity: 0.7;
        }

        .fetched-at {
          margin-top: 0.5rem;
          font-size: 0.75em;
          opacity: 0.6;
        }

        .error {
          margin-bottom: 16px;
        }

        .loading {
          opacity: 0.6;
          font-style: italic;
        }

        .sparkline {
          display: block;
          width: 100%;
          height: 48px;
        }
        .sparkline path {
          fill: none;
          stroke: var(--q-primary, #1976d2);
          stroke-width: 2;
          stroke-linejoin: round;
          stroke-linecap: round;
        }

        .pill {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.4rem 0.9rem;
          border-radius: 999px;
          font-weight: 500;
        }
        .pill .dot {
          width: 0.65rem;
          height: 0.65rem;
          border-radius: 50%;
        }
        .pill.status-ok {
          background-color: color-mix(in srgb, #21ba45 18%, transparent);
          color: #1b7d34;
        }
        .pill.status-ok .dot {
          background-color: #21ba45;
        }
        .pill.status-warning {
          background-color: color-mix(in srgb, #f2c037 22%, transparent);
          color: #8a6416;
        }
        .pill.status-warning .dot {
          background-color: #f2c037;
        }
        .pill.status-critical {
          background-color: color-mix(in srgb, #c10015 18%, transparent);
          color: #c10015;
        }
        .pill.status-critical .dot {
          background-color: #c10015;
        }
        .pill.status-unknown {
          background-color: rgba(128, 128, 128, 0.18);
          color: rgba(128, 128, 128, 0.9);
        }
        .pill.status-unknown .dot {
          background-color: rgba(128, 128, 128, 0.7);
        }
        :host([dark]) .pill.status-ok {
          color: #7be79a;
        }
        :host([dark]) .pill.status-warning {
          color: #f6da8a;
        }
        :host([dark]) .pill.status-critical {
          color: #ff8a8a;
        }
      `
    ]
  }

  static get properties() {
    return {
      url: { type: String },

      /**
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `jsonpath` while the block picker — which writes the
       *    literal `static definition.props[].name`, `json-path` — writes `json-path` into the page.
       */
      jsonPath: { type: String, attribute: 'json-path' },

      // -> Explicit `attribute`, for the same reason as `jsonPath` above.
      credentialId: { type: String, attribute: 'credential-id' },

      // -> Explicit `attribute`, for the same reason as `jsonPath` above.
      refreshInterval: { type: Number, attribute: 'refresh-interval' },

      // -> Explicit `attribute`, for the same reason as `jsonPath` above.
      displayMode: { type: String, attribute: 'display-mode' },

      label: { type: String },
      unit: { type: String },

      // -> Explicit `attribute`, for the same reason as `jsonPath` above.
      okMax: { type: Number, attribute: 'ok-max' },

      // -> Explicit `attribute`, for the same reason as `jsonPath` above.
      warnMax: { type: Number, attribute: 'warn-max' },

      // Internal properties
      _status: { state: true },
      _value: { state: true },
      _fetchedAt: { state: true },
      _error: { state: true },
      _history: { state: true }
    }
  }

  constructor() {
    super()
    this.url = ''
    this.jsonPath = '$'
    this.credentialId = ''
    this.refreshInterval = 60
    this.displayMode = 'value'
    this.label = ''
    this.unit = ''
    this.okMax = undefined
    this.warnMax = undefined

    this._status = 'loading'
    this._value = null
    this._fetchedAt = null
    this._error = ''
    this._history = []
    this._timer = null
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  connectedCallback() {
    super.connectedCallback()
    if (!this.url || !this.jsonPath) {
      this._status = 'error'
      this._error = 'This block needs both an Endpoint URL and a JSONPath.'
      return
    }
    this._poll()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  /**
   * Fetches once, then schedules the next fetch after `refreshInterval` has elapsed -- a chain of
   * `setTimeout`s rather than `setInterval`, so a slow or hung request never overlaps with the next
   * one firing on top of it.
   */
  async _poll() {
    try {
      const siteId = await getSiteId()
      if (!siteId) {
        throw new Error('Could not determine the current site.')
      }
      const resp = await fetch(`/_api/sites/${siteId}/live-data/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentialId: this.credentialId || undefined,
          url: this.url,
          jsonPath: this.jsonPath,
          refreshInterval: this.refreshInterval
        })
      })
      const body = await resp.json().catch(() => null)
      if (!resp.ok) {
        throw new Error(body?.message || `Request failed (${resp.status}).`)
      }
      this._status = 'ready'
      this._value = body.value
      this._fetchedAt = body.fetchedAt
      this._error = ''
      this._pushHistory(body.value)
    } catch (err) {
      this._status = 'error'
      this._error = err.message || 'Could not resolve this block.'
    } finally {
      // -> `disconnectedCallback` only has a live `this._timer` to `clearTimeout` when it runs
      //    between polls; it runs no such check here when it fires while THIS poll's fetch is still
      //    in flight -- there is nothing scheduled yet to cancel. Without this guard that race
      //    leaves the element polling forever in the background after it has left the page (an SPA
      //    navigation away being the ordinary way to trigger it), since each iteration reschedules
      //    itself with no further disconnect ever coming to stop it.
      if (this.isConnected) {
        const seconds = Math.max(Number(this.refreshInterval) || 60, MIN_REFRESH_SECONDS)
        this._timer = setTimeout(() => this._poll(), seconds * 1000)
      }
    }
  }

  _pushHistory(value) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) {
      return
    }
    this._history = [...this._history, numeric].slice(-SPARKLINE_HISTORY)
  }

  _renderValue() {
    return html`
      <div class="value-row">
        <span class="value">${String(this._value)}</span>
        ${this.unit ? html`<span class="unit">${this.unit}</span>` : nothing}
      </div>
    `
  }

  _renderSparkline() {
    const points = this._history
    const path = points.length > 1 ? sparklinePath(points) : ''
    return html`
      <div class="value-row">
        <span class="value">${String(this._value)}</span>
        ${this.unit ? html`<span class="unit">${this.unit}</span>` : nothing}
      </div>
      ${
        points.length > 1
          ? svg`<svg class="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none">
            <path d="${path}"></path>
          </svg>`
          : nothing
      }
    `
  }

  _renderStatus() {
    const level = statusLevel(this._value, this.okMax, this.warnMax)
    return html`
      <div class="pill status-${level}">
        <span class="dot"></span>
        <span class="value-row">
          <span class="value" style="font-size: 1.1rem">${String(this._value)}</span>
          ${this.unit ? html`<span class="unit">${this.unit}</span>` : nothing}
        </span>
      </div>
    `
  }

  render() {
    if (this._status === 'error') {
      return renderError(this._error)
    }
    if (this._status === 'loading') {
      return html`<div class="card loading">${this.label || 'Loading…'}</div>`
    }
    return html`
      <div class="card">
        ${this.label ? html`<div class="label">${this.label}</div>` : nothing}
        ${
          this.displayMode === 'sparkline'
            ? this._renderSparkline()
            : this.displayMode === 'status'
              ? this._renderStatus()
              : this._renderValue()
        }
        ${
          this._fetchedAt
            ? html`<div class="fetched-at">
                Updated ${new Date(this._fetchedAt).toLocaleTimeString()}
              </div>`
            : nothing
        }
      </div>
    `
  }
}

window.customElements.define('block-live-data', BlockLiveDataElement)
