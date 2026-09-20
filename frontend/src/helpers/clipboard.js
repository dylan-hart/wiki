import { i18n } from '@/boot/i18n'

/**
 * The async Clipboard API covers every browser the app supports but is unavailable on insecure
 * origins -- a real case here, since a wiki is often reached over plain http on an internal network
 * -- so the legacy `execCommand` path stays as a fallback rather than the copy silently failing.
 */
export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
  }

  const el = document.createElement('textarea')
  el.value = text
  // -> Off-screen but still focusable; `display: none` would make the selection fail
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)

  try {
    el.select()
    if (!document.execCommand('copy')) {
      throw new Error(i18n.global.t('common.clipboard.copyRejected'))
    }
  } finally {
    document.body.removeChild(el)
  }
}
