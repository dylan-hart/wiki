import { LitElement, html, css } from 'lit'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/**
 * Block Countdown
 */
export class BlockCountdownElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
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
        // -> Not 'UTC': the picker never writes an attribute for a field left at its default value
        //    (see `blockAttributes` in `frontend/src/helpers/blocks.js`), and empty is itself a
        //    meaningful choice here -- "each reader's own clock" -- not merely the absence of one.
        //    Defaulting to '' is what makes clearing the field actually reachable from the picker;
        //    UTC remains available, just as something an author types rather than falls into.
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
        The gap below a block lives on this element, not on :host.

        The app resets the margin on every element, and a rule in the page beats a :host rule in the
        shadow tree whatever its specificity -- so a margin set on the host is simply dropped. Set
        inside the shadow root it is out of that rule's reach, and collapses out through the host,
        which carries no padding or border of its own.
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
      /**
       * Target date and time, ISO 8601
       * @type {string}
       */
      date: { type: String },

      /**
       * IANA timezone the target is expressed in. Empty means the reader's own timezone -- see
       * `_target`'s `zone` resolution below.
       * @type {string}
       */
      timezone: { type: String },

      /**
       * What the countdown is for
       * @type {string}
       */
      label: { type: String },

      /**
       * Shown once the target has passed
       *
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `expiredmsg` while the block picker — which writes the
       *    literal `static definition.props[].name`, `expired-msg` — writes `expired-msg` into the page.
       * @type {string}
       */
      expiredMsg: { type: String, attribute: 'expired-msg' },

      // Internal Properties
      _remaining: { state: true },
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.date = ''
    // -> '' (not 'UTC'): matches the prop's own default -- see its comment for why -- so a picker
    //    that never wrote the attribute and a page loaded fresh both resolve to "the reader's own
    //    timezone" identically.
    this.timezone = ''
    this.label = ''
    this.expiredMsg = 'The countdown has ended.'
    this._remaining = null
    this._error = ''
    this._target = null
    this._timer = null
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /**
   * Resolve the target into a zoned instant.
   *
   * A date carrying its own offset — `2026-12-25T09:00-05:00`, or a trailing `Z` — is an exact moment
   * and the timezone only decides how it is displayed. Without one it is a wall-clock time, which is
   * what an author writing "the ninth of December at nine" means, and the timezone is what turns it
   * into a moment. Both then count down to the same instant for every reader, wherever they are.
   */
  _resolveTarget(zone) {
    try {
      return Temporal.Instant.from(this.date).toZonedDateTimeISO(zone)
    } catch {
      return Temporal.PlainDateTime.from(this.date).toZonedDateTime(zone)
    }
  }

  _tick() {
    // -> Through `Date.now()` rather than `Temporal.Now` directly: a native `Temporal.Now` (Node
    //    26+) reads the system clock through its own binding, not through the `Date` global, so
    //    `vi.setSystemTime()` -- which only mocks `Date` -- has no effect on it at all. That made
    //    every test below 100% reproducibly fail on real Node 26 while passing on this sandbox's
    //    Node 25.9 (where `Temporal` is the `temporal-polyfill` package) -- an
    //    environment-specific bug, not a flake (OpenProject #2739). `Date.prototype
    //    .toTemporalInstant()` (CLAUDE.md's documented bridge elsewhere in this repo) isn't an
    //    option here -- `temporal-polyfill` doesn't implement it, only `@js-temporal/polyfill`
    //    does -- so this goes through `Temporal.Instant.fromEpochMilliseconds`, core spec API
    //    every implementation provides, fed by the one thing every implementation and `vi
    //    .setSystemTime()` agree on: `Date.now()`.
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
      Spelled out field by field rather than with `dateStyle` / `timeStyle`, which cannot be combined
      with `timeZoneName` — and the zone is the point: a reader in another country needs to see which
      clock the target is on, not just a time that does not match their own.
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
