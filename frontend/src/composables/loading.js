import { reactive, ref } from 'vue'

/**
 * Full-screen blocking loading overlay: a module singleton, rendered once by
 * `<w-loading-overlay>` in App.vue.
 */

/** True only once the delay has elapsed, not on `show()`. */
export const isActive = ref(false)

/**
 * Deliberately not cleared by `hide()`: the overlay fades out over 200ms, and blanking the text as
 * the fade starts empties the box before it goes. `show()` overwrites both fields anyway.
 */
export const content = reactive({
  message: '',
  caption: ''
})

/** An operation finishing inside this window shows nothing, rather than flashing a spinner. */
const DELAY = 500

let timer = null

export const loading = {
  /**
   * A call made while the overlay is already showing or pending updates the text rather than being
   * dropped, and does not re-arm a pending timer: the wait belongs to the operation that started
   * it, not to the latest thing said about it.
   *
   * @param delay Milliseconds before appearing. Zero is for a message that is the whole point of
   *   the overlay rather than an apology for a slow request.
   */
  show({ message = '', caption = '', delay = DELAY } = {}) {
    content.message = message
    content.caption = caption
    if (isActive.value) {
      return
    }
    if (delay > 0 && timer !== null) {
      return
    }
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = null
        isActive.value = true
      }, delay)
      return
    }
    // -> Cancels a pending wait as well, so an immediate show really is immediate
    clearTimeout(timer)
    timer = null
    isActive.value = true
  },

  hide() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    isActive.value = false
  }
}
