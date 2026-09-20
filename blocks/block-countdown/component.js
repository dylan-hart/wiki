import { LitElement, html, css } from 'lit'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

export class BlockCountdownElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
   */
  static definition = {
    block: 'countdown',
    name: 'Countdown',
    description: 'Counts down to a date and time.',
    icon: 'tabler:hourglass',
    props: [
      {
        name: 'date',
        type: 'string',
        label: 'Target Date',
        hint: 'ISO date and time, e.g. 2026-12-25T09:00. Read in the timezone below unless it carries an offset of its own.',
        required: true
      },
      {
        name: 'timezone',
        type: 'string',
        label: 'Timezone',
        hint: "IANA name, e.g. Europe/Paris or UTC. Each reader's own timezone when left empty.",
        // -> Not 'UTC': the picker writes no attribute for a field left at its default
        //    (`blockAttributes`, `frontend/src/helpers/blocks.js`), so only a default that is itself
        //    meaningful -- '' being "the reader's own clock" -- leaves clearing the field reachable.
        default: ''
      },
      {
        name: 'label',
        type: 'string',
        label: 'Label',
        hint: 'What is being counted down to. Shown above the numbers.'
      },
      {
        name: 'expired-msg',
        type: 'string',
        label: 'Ended Message',
        hint: 'Shown once the target has passed.',
        default: 'The countdown has ended.'
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
        Not on :host: the app's margin reset in the page beats a :host rule whatever its specificity,
        so a host margin is simply dropped. Set inside the shadow root it is out of that rule's
        reach, and collapses out through the host, which has no padding or border of its own.
      */
        .countdown,
        .error {
          margin-bottom: 16px;
        }

        .countdown {
          position: relative;
          border: 1px solid var(--block-border);
          border-radius: var(--block-radius);
          padding: 18px 20px;
          text-align: center;
        }

        /* Theme-gated decoration: --block-corner-marks is "none" under Cobalt. */
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
          font: var(--countdown-label-font);
          margin-bottom: 0.75rem;
        }

        .segments {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 8px;
        }

        .segment {
          min-width: 72px;
          padding: var(--countdown-segment-pad);
          border-radius: var(--countdown-segment-radius);
          background-color: var(--countdown-segment-bg);
        }
        /* -> Ledger only (--countdown-segment-rule is none in Cobalt, which separates by gap+tile) */
        .segment + .segment {
          border-left: var(--countdown-segment-rule);
        }

        .value {
          font: var(--countdown-value-font);
          line-height: 1.1;
          font-variant-numeric: tabular-nums;
          color: var(--countdown-value-fg);
        }

        .unit {
          color: var(--countdown-unit-fg);
          font: var(--countdown-unit-font);
          letter-spacing: var(--countdown-unit-tracking);
          text-transform: var(--countdown-unit-transform);
        }

        .target {
          margin-top: 0.75rem;
          color: var(--countdown-target-fg);
          font: var(--countdown-target-font, 10.5px var(--font-mono));
        }

        .ended {
          color: var(--countdown-ended-fg);
          font-weight: 500;
          font-size: 14px;
        }
      `
    ]
  }

  static get properties() {
    return {
      date: { type: String },

      timezone: { type: String },

      label: { type: String },

      /**
       * -> Explicit `attribute`: Lit's default lowercases without inserting a dash (`expiredmsg`),
       *    but the picker writes `static definition.props[].name` verbatim.
       */
      expiredMsg: { type: String, attribute: 'expired-msg' },

      _remaining: { state: true },
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.date = ''
    // -> Matches the prop's own default, so an absent attribute resolves to the reader's own
    //    timezone rather than to a different fallback here
    this.timezone = ''
    this.label = ''
    this.expiredMsg = 'The countdown has ended.'
    this._remaining = null
    this._error = ''
    this._target = null
    this._timer = null
    this._darkMode = new DarkMode(this)
  }

  /**
   * A date carrying its own offset — `2026-12-25T09:00-05:00`, or a trailing `Z` — is already an
   * exact moment, and the timezone only decides how it is displayed. Without one it is a wall-clock
   * time, what an author writing "the ninth of December at nine" means, and the zone makes it exact.
   */
  _resolveTarget(zone) {
    try {
      return Temporal.Instant.from(this.date).toZonedDateTimeISO(zone)
    } catch {
      return Temporal.PlainDateTime.from(this.date).toZonedDateTime(zone)
    }
  }

  _tick() {
    // -> Through `Date.now()`, not `Temporal.Now`: a native `Temporal.Now` reads the system clock
    //    through its own binding, so `vi.setSystemTime()` (which mocks only `Date`) cannot reach it.
    //    `Date.prototype.toTemporalInstant()` is no help either -- `temporal-polyfill` does not
    //    implement it. `Date.now()` is the one clock every implementation and the mock agree on.
    const now = Temporal.Instant.fromEpochMilliseconds(Date.now()).toZonedDateTimeISO(
      this._target.timeZoneId
    )
    if (Temporal.ZonedDateTime.compare(now, this._target) >= 0) {
      this._remaining = null
      this._stop()
      return
    }
    // -> Through ZonedDateTime rather than Instant, so that a day is a day across a DST change and
    //    not always exactly 24 hours
    this._remaining = now.until(this._target, { largestUnit: 'day', smallestUnit: 'second' })
  }

  _stop() {
    clearInterval(this._timer)
    this._timer = null
  }

  connectedCallback() {
    super.connectedCallback()
    // -> An empty timezone means the reader's own, which is also what an unknown one must not
    //    silently become: a countdown to the wrong moment is worse than a visible mistake
    const zone = this.timezone?.trim() || Temporal.Now.timeZoneId()
    try {
      Temporal.Now.zonedDateTimeISO(zone)
    } catch {
      this._error = `"${zone}" is not a known timezone.`
      return
    }
    try {
      this._target = this._resolveTarget(zone)
    } catch {
      this._error = `"${this.date}" is not a date this can count down to.`
      return
    }
    this._tick()
    if (this._remaining) {
      this._timer = setInterval(() => this._tick(), 1000)
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._stop()
  }

  _segment(value, unit) {
    return html`
      <div class="segment">
        <div class="value">${value}</div>
        <div class="unit">${value === 1 ? unit : `${unit}s`}</div>
      </div>
    `
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    if (!this._target) {
      return null
    }
    /*
      Field by field rather than `dateStyle`/`timeStyle`, which cannot be combined with
      `timeZoneName` — and the zone is the point for a reader in another country.
    */
    const at = this._target.toLocaleString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    })
    return html`
      <div class="countdown">
        <i class="marks" aria-hidden="true"></i>
        ${this.label ? html`<div class="label">${this.label}</div>` : null}
        ${
          this._remaining
            ? html`
                <div class="segments">
                  ${this._remaining.days > 0 ? this._segment(this._remaining.days, 'Day') : null}
                  ${this._segment(this._remaining.hours, 'Hour')}
                  ${this._segment(this._remaining.minutes, 'Minute')}
                  ${this._segment(this._remaining.seconds, 'Second')}
                </div>
              `
            : html`<div class="ended">${this.expiredMsg}</div>`
        }
        <div class="target">${at}</div>
      </div>
    `
  }
}

window.customElements.define('block-countdown', BlockCountdownElement)
