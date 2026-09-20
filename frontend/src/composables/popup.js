import { inject } from 'vue'

/**
 * A component rendered inside a `WMenu` injects this; outside one it resolves to a no-op, so a
 * component usable in either place needs no guard of its own.
 */
export const POPUP_CLOSE = Symbol.for('w-popup-close')

export function useClosePopup() {
  return inject(POPUP_CLOSE, () => {})
}
