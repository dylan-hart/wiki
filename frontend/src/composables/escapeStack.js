/**
 * Shared LIFO registry of Escape-consuming popups (`WDialog`, `WMenu`, ...), so exactly one --
 * whichever opened most recently -- answers a given keypress. Both are teleported to `<body>`, so
 * DOM containment cannot express "inner" vs. "outer" between them; only open order can. A
 * capture-phase listener cannot arbitrate either: capture always wins over bubble for the same
 * event, on any node, regardless of which popup opened later.
 *
 * The single `document` listener is bound lazily on the first registration, in the BUBBLE phase so
 * that a focused control's own target-phase `keydown.esc` handler gets first refusal. A handler
 * returning `false` declines and the keypress falls through to the next one down -- a persistent
 * `WDialog` never closes on Escape, so a `WMenu` open inside one still gets a turn.
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
 * Call the returned release function when the popup closes.
 *
 * @param {(ev: KeyboardEvent) => (void | false)} handler `false` declines the keypress; any other
 *   return value, `undefined` included, consumes it.
 * @returns {() => void}
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
