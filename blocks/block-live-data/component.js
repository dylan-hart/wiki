import { LitElement, html, css, svg, nothing } from 'lit'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { getSiteId } from '../shared/site.js'

const SPARKLINE_HISTORY = 30

/** Mirrors the server's own clamp (`models/liveData.ts`), so the interval this block schedules is
 *  the one the server will honour rather than a number it silently raises. */
const MIN_REFRESH_SECONDS = 10

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
 * Scaled into a 100x32 box; a flat line down the middle when every reading so far is identical,
 * since there is no range to spread them across.
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
 * The endpoint is never fetched from here: this block calls its own wiki's `POST
 * /sites/:siteId/live-data/resolve`, which reaches the endpoint, resolves a stored credential into
 * a bearer token server-side and hands back the one extracted value. A page's source and this
 * component's network tab therefore see only a `credentialId`, never the credential itself.
 *
 * The sparkline's history is this element's own memory, not a series the server keeps: it starts
 * empty on every page load and grows only from polls made while the block has been mounted.
 */
export class BlockLiveDataElement extends LitElement {
  /**
   * Read out of the source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
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
          position: relative;
          margin-bottom: 16px;
          border: 1px solid var(--block-border);
          border-radius: var(--block-radius);
          padding: 14px 18px;
        }

        /* Two opposite corner marks, Ledger only -- same technique as the other board blocks. */
        .marks {
          display: var(--block-corner-marks);
          position: absolute;
          inset: -5px;
          pointer-events: none;
          background:
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 7px 1px
              no-repeat,
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 1px 7px
              no-repeat,
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 7px 1px
              no-repeat,
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 1px 7px
              no-repeat;
        }

        .label {
          color: var(--live-data-label-fg);
          font: var(--live-data-label-font);
          letter-spacing: var(--live-data-label-tracking);
          text-transform: var(--live-data-label-transform);
          margin-bottom: 0.35rem;
        }

        .value-row {
          display: flex;
          align-items: baseline;
          gap: 0.35rem;
        }

        .value {
          font: var(--live-data-value-font);
          line-height: 1.1;
          font-variant-numeric: tabular-nums;
          color: var(--live-data-value-fg);
        }

        .unit {
          font-size: 14px;
          color: var(--block-caption-fg);
        }

        .fetched-at {
          margin-top: 0.5rem;
          color: var(--live-data-fetched-fg);
          font: var(--live-data-fetched-font);
        }

        .error {
          margin-bottom: 16px;
        }

        .loading {
          color: var(--block-caption-fg);
          font-style: italic;
        }

        .sparkline {
          display: block;
          width: 100%;
          height: 48px;
        }
        .sparkline path {
          fill: none;
          stroke: var(--live-data-spark-stroke);
          stroke-width: var(--live-data-spark-width);
          stroke-linejoin: var(--live-data-spark-linejoin);
          stroke-linecap: var(--live-data-spark-linecap);
        }

        .pill {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.4rem 0.9rem;
          border-radius: var(--live-data-pill-radius);
          font-weight: 500;
          font-size: 13px;
        }
        .pill .dot {
          width: 9px;
          height: 9px;
          border-radius: var(--live-data-pill-dot-radius);
        }
        .pill.status-ok {
          background-color: var(--live-data-ok-bg);
          color: var(--live-data-ok-fg);
        }
        .pill.status-ok .dot {
          background-color: var(--live-data-ok-dot);
        }
        .pill.status-warning {
          background-color: var(--live-data-warning-bg);
          color: var(--live-data-warning-fg);
        }
        .pill.status-warning .dot {
          background-color: var(--live-data-warning-dot);
        }
        .pill.status-critical {
          background-color: var(--live-data-critical-bg);
          color: var(--live-data-critical-fg);
        }
        .pill.status-critical .dot {
          background-color: var(--live-data-critical-dot);
        }
        .pill.status-unknown {
          background-color: var(--live-data-unknown-bg);
          color: var(--live-data-unknown-fg);
        }
        .pill.status-unknown .dot {
          background-color: var(--live-data-unknown-dot);
        }
      `
    ]
  }

  static get properties() {
    return {
      url: { type: String },

      /**
       * -> Every dashed `attribute` here is explicit, because Lit's default (a bare lowercasing of
       *    the property name, no dash inserted) would listen for `jsonpath` while the block picker
       *    writes the literal `static definition.props[].name`, `json-path`, into the page.
       */
      jsonPath: { type: String, attribute: 'json-path' },

      credentialId: { type: String, attribute: 'credential-id' },

      refreshInterval: { type: Number, attribute: 'refresh-interval' },

      displayMode: { type: String, attribute: 'display-mode' },

      label: { type: String },
      unit: { type: String },

      okMax: { type: Number, attribute: 'ok-max' },

      warnMax: { type: Number, attribute: 'warn-max' },

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
   * A chain of `setTimeout`s rather than `setInterval`, so a slow or hung request never has the
   * next one firing on top of it.
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
      // -> A disconnect during the fetch has no timer to cancel yet, so without this guard the
      //    element reschedules itself forever after leaving the page (an SPA navigation away)
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
        <i class="marks" aria-hidden="true"></i>
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
