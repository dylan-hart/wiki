import { computed, reactive, ref } from 'vue'

/**
 * A module-level mirror of the `dir` attribute on `<html>`, which is the source of truth and which
 * `App.vue`'s `applyDocumentLocale()` rewrites on every navigation: an attribute on an element
 * outside the app is not reactive, so a layout component mounted across navigations cannot read it
 * once at setup. Only JS-computed direction needs this (`helpers/directionalAnchor.js`); CSS
 * logical properties resolve against `dir` on their own.
 */
const isRTL = ref(typeof document !== 'undefined' && document.documentElement.dir === 'rtl')

function apply(rtl) {
  isRTL.value = rtl === true
  document.documentElement.setAttribute('dir', isRTL.value ? 'rtl' : 'ltr')
}

export function useDirection() {
  return reactive({
    isRTL: computed(() => isRTL.value),

    set(rtl) {
      apply(rtl)
    }
  })
}
