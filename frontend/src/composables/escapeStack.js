/**
 * Shared registry of Escape-consuming popups (`WDialog`, `WMenu`, ...), so exactly one -- whichever
 * opened most recently -- answers a given Escape keypress. See OpenProject #2370: `WDialog`'s own
 * Escape handler used to listen on `document` in the CAPTURE phase, which fires before the event
 * ever reaches a nested `WMenu`'s (bubble-phase, OpenProject #2364) handler -- capture always wins
 * over bubble for the same event, on any node, regardless of which popup opened later or which one
 * reads as "inside" the other in the component tree. Both `WDialog` and `WMenu` are teleported to
 * `<body>` anyway, so DOM containment cannot express "inner" vs. "outer" between them either; only
 * open order can, which is exactly what a LIFO stack tracks.
 *
 * A single BUBBLE-phase `document` listener is bound lazily on the first registration -- bubble,
 * not capture, so a focused control's own `keydown.esc` handler (its target-phase listener, which
 * always runs before the event bubbles anywhere) gets first refusal, the same reasoning `WMenu`'s
 * #2364 fix established. On Escape it walks the stack top-down and calls the first handler that
 * does not decline; that handler is the only one invoked. A handler returning `false` means "not
 * mine to consume" -- the keypress falls through to whichever handler is next down the stack (e.g.
 * a persistent `WDialog` never closes on Escape, so a `WMenu` open inside one still gets a turn).
 */
const stack = []
let bound = false

function dispatch(ev) {
  if (ev.key !== 'Escape') {
    return
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i](ev) !== false) {
      return
    }
  }
}

function ensureBound() {
  if (bound) {
    return
  }
  document.addEventListener('keydown', dispatch)
  bound = true
}

/**
 * Registers `handler` as the current topmost Escape consumer. Call when the popup opens; call the
 * returned `release()` when it closes. `handler` is invoked with the triggering `KeyboardEvent` and
 * may return `false` to decline (see above) -- any other return value, including `undefined`, counts
 * as having consumed the keypress.
 *
 * @param {(ev: KeyboardEvent) => (void | false)} handler
 * @returns {() => void} release
 */
export function pushEscapeHandler(handler) {
  ensureBound()
  stack.push(handler)
  return () => {
    const index = stack.lastIndexOf(handler)
    if (index !== -1) {
      stack.splice(index, 1)
    }
  }
}
