import { onBeforeUnmount, onMounted } from 'vue'

const PROPERTY = '--footer-bar-height'

// A route swap can mount the incoming footer before the outgoing one's cleanup runs, and that
// cleanup must not clear the value the incoming footer just wrote.
let owner = null

export function useFooterBarHeight(target) {
  const token = Symbol('footerBarHeight')
  let footer = null
  let resizeObserver = null
  let classObserver = null

  function sync() {
    if (!footer) {
      return
    }
    const bodyStyle = document.body.style
    if (getComputedStyle(footer).position === 'fixed') {
      owner = token
      bodyStyle.setProperty(PROPERTY, `${Math.ceil(footer.getBoundingClientRect().height)}px`)
    } else if (owner === token) {
      owner = null
      bodyStyle.removeProperty(PROPERTY)
    }
  }

  onMounted(() => {
    const el = target.value
    footer = el && typeof el.closest === 'function' ? el.closest('.w-footer') : null
    if (!footer) {
      return
    }
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(sync)
      resizeObserver.observe(footer)
    }
    if (typeof MutationObserver !== 'undefined') {
      classObserver = new MutationObserver(sync)
      classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    }
    sync()
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    classObserver?.disconnect()
    resizeObserver = null
    classObserver = null
    footer = null
    if (owner === token) {
      owner = null
      document.body.style.removeProperty(PROPERTY)
    }
  })
}
