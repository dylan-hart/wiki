import { reactive } from 'vue'

/**
 * Toast notifications: a module singleton rather than a composable, since there is one stack for the
 * whole app and nothing here needs a component instance.
 *
 * Deliberately narrow -- this covers what the app actually calls, and is not meant to grow back into
 * the full API of the plugin it replaces; add a second `action` only when a real call site needs
 * one. Grouping is not opt-in: a message that repeats on every keystroke would otherwise fill the
 * screen with identical toasts. A notification carrying an `action` is never grouped, because that
 * callback closes over state a merged, count-bumped toast could silently go stale against.
 */

/**
 * @typedef {object} NotificationAction
 * @property {string} label
 * @property {() => void} onClick The toast is dismissed afterwards.
 */

/** @type {Array<{ id: number, type: string, message: string, caption: string|null, icon: string, timeout: number, count: number, action: NotificationAction|null }>} */
export const queue = reactive([])

let seq = 0

/**
 * Auto-dismiss timers by notification id, kept out of the queue entries so they are not reactive
 * state. A repeat has to restart its notification's timer, which means being able to cancel it.
 */
const timers = new Map()

const PRESETS = {
  /*
    The foreground is picked per fill rather than defaulting to white: `warning` is the one fill
    light enough to need dark ink over it (#d9a441 is 2.5:1 under white, 7.0:1 under `--color-ink`).
  */
  positive: { icon: 'tabler:circle-check', classes: 'bg-positive text-white' },
  negative: { icon: 'tabler:alert-triangle', classes: 'bg-negative text-white' },
  warning: { icon: 'tabler:exclamation-mark', classes: 'bg-warning text-ink' },
  info: { icon: 'tabler:info-circle', classes: 'bg-info text-white' }
}

const DEFAULT_TIMEOUT = 5000

/** Safe to call for an id that has already gone. */
export function dismiss(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  const idx = queue.findIndex((n) => n.id === id)
  if (idx >= 0) {
    queue.splice(idx, 1)
  }
}

function schedule(n) {
  clearTimeout(timers.get(n.id))
  if (n.timeout > 0) {
    timers.set(
      n.id,
      setTimeout(() => dismiss(n.id), n.timeout)
    )
  }
}

/** Two notifications group together when they would render identically. */
function groupKey({ type, message, caption, icon }) {
  return JSON.stringify([type, message, caption, icon])
}

/**
 * @param {object|string} opts Options, or a bare string treated as the message.
 * @param {'positive'|'negative'|'warning'|'info'} [opts.type='info']
 * @param {string} opts.message
 * @param {string} [opts.caption]
 * @param {string} [opts.icon] Iconify reference, overriding the type preset.
 * @param {number} [opts.timeout=5000] Milliseconds; 0 disables auto-dismiss.
 * @param {NotificationAction} [opts.action] Never grouped with another notification.
 * @returns {() => void} Dismisses this notification.
 */
export function notify(opts) {
  const {
    type = 'info',
    message = '',
    caption = null,
    icon,
    timeout,
    action = null
  } = typeof opts === 'string' ? { message: opts } : (opts ?? {})

  const preset = PRESETS[type] ?? PRESETS.info
  // -> `timeout: 0` must survive as 0 (never auto-dismiss), so this cannot be `timeout || DEFAULT`
  const resolvedTimeout = Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT
  const resolvedIcon = icon ?? preset.icon
  const key = groupKey({ type, message, caption, icon: resolvedIcon })

  /*
    A repeat bumps the existing count and restarts the timer -- inheriting the first toast's
    remaining time would let the merged one vanish immediately after the repeat that produced it.
  */
  if (!action) {
    const existing = queue.find((n) => n.key === key)
    if (existing) {
      existing.count++
      schedule(existing)
      return () => dismiss(existing.id)
    }
  }

  const id = ++seq
  const entry = {
    id,
    key,
    type,
    message,
    caption,
    icon: resolvedIcon,
    classes: preset.classes,
    timeout: resolvedTimeout,
    count: 1,
    action
  }
  queue.push(entry)
  schedule(entry)

  return () => dismiss(id)
}

notify.positive = (message, caption) => notify({ type: 'positive', message, caption })
notify.negative = (message, caption) => notify({ type: 'negative', message, caption })
notify.warning = (message, caption) => notify({ type: 'warning', message, caption })
notify.info = (message, caption) => notify({ type: 'info', message, caption })
