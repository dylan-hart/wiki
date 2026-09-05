import { reactive } from 'vue'

/**
 * Toast notifications.
 *
 * A plain module singleton rather than a composable -- there is exactly one notification stack for
 * the whole app, and nothing here depends on a component instance. `<w-notifications>` (mounted
 * once in App.vue) renders `queue`.
 *
 * Scope note: this covers only what the app actually calls. A survey of the 252 existing call sites
 * found just `type` (positive / negative / warning), `message`, `caption`, `icon` and `timeout` in
 * use, so the positioning / html features of the plugin this replaces are intentionally absent. A
 * single `action` (label + callback) was added for OpenProject #2073's undo-discard toast -- still
 * far short of that plugin's full multi-action API, and not meant to grow into it; add a second
 * action only if a real second call site needs one. Grouping is kept, because it is not opt-in:
 * repeating the same message -- a save that fails on every keystroke, say -- otherwise fills the
 * screen with identical toasts. A notification carrying an `action` is never grouped: its callback
 * closes over state (e.g. a specific discarded-content snapshot) that a merged, count-bumped toast
 * could silently go stale against.
 */

/**
 * @typedef {object} NotificationAction
 * @property {string} label Button text.
 * @property {() => void} onClick Called when clicked; the toast is then dismissed.
 */

/** @type {Array<{ id: number, type: string, message: string, caption: string|null, icon: string, timeout: number, count: number, action: NotificationAction|null }>} */
export const queue = reactive([])

let seq = 0

/**
 * Auto-dismiss timers by notification id, kept out of the queue entries so they are not reactive
 * state. A repeat has to restart its notification's timer, which means being able to cancel it.
 */
const timers = new Map()

/**
 * Visual presets per type. Icons are Iconify references (`<prefix>:<name>`) resolved through
 * `<w-icon>`, matching the equivalents from the mdi-v7 icon set that were previously in use.
 */
const PRESETS = {
  /*
    Cardinal fills each toast in the status colour it is about, and picks the foreground per fill
    rather than defaulting to white: `warning` is the one light enough to need dark ink over it
    (#d9a441 under white is 2.5:1, under `--color-ink` 7.0:1). `info` is the chrome slate, which is
    also what the design's fourth, action-carrying toast is drawn in.
  */
  positive: { icon: 'tabler:circle-check', classes: 'bg-positive text-white' },
  negative: { icon: 'tabler:alert-triangle', classes: 'bg-negative text-white' },
  warning: { icon: 'tabler:exclamation-mark', classes: 'bg-warning text-ink' },
  info: { icon: 'tabler:info-circle', classes: 'bg-info text-white' }
}

const DEFAULT_TIMEOUT = 5000

/**
 * Remove a notification by id. Safe to call for an id that has already gone.
 * @param {number} id
 */
export function dismiss(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  const idx = queue.findIndex((n) => n.id === id)
  if (idx >= 0) {
    queue.splice(idx, 1)
  }
}

/** (Re)starts a notification's auto-dismiss timer. A timeout of 0 means it stays until dismissed. */
function schedule(n) {
  clearTimeout(timers.get(n.id))
  if (n.timeout > 0) {
    timers.set(
      n.id,
      setTimeout(() => dismiss(n.id), n.timeout)
    )
  }
}

/** Two notifications are the same notification when they would render identically. */
function groupKey({ type, message, caption, icon }) {
  return JSON.stringify([type, message, caption, icon])
}

/**
 * Show a notification.
 *
 * @param {object|string} opts Options, or a bare string treated as the message.
 * @param {'positive'|'negative'|'warning'|'info'} [opts.type='info']
 * @param {string} opts.message
 * @param {string} [opts.caption] Secondary line, rendered smaller and dimmed.
 * @param {string} [opts.icon] Iconify reference, overriding the type preset.
 * @param {number} [opts.timeout=5000] Auto-dismiss delay in ms; 0 disables auto-dismiss.
 * @param {NotificationAction} [opts.action] A single labeled button, e.g. an "Undo" offer. Never
 *   grouped with another notification -- see the module doc comment above.
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
    A repeat of a notification already on screen bumps its count instead of stacking a second copy,
    and restarts its timer -- otherwise the merged toast would inherit the remaining time of the
    first one and could vanish immediately after the repeat that produced it. Skipped for an
    actioned notification, per the module doc comment above.
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
