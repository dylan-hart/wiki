import { notify } from '@/composables/notify'
import { localizeError } from '@/helpers/localization'

const ERROR_CODE_PATTERN = /^ERR_[A-Z0-9_]+$/

export function readAuthLinkResult(query) {
  if (query?.authLink === 'added') {
    return {
      ok: true,
      strategyId: typeof query.strategyId === 'string' ? query.strategyId : null,
      strip: ['authLink', 'strategyId']
    }
  }
  if (query && Object.hasOwn(query, 'authLinkError')) {
    const code = query.authLinkError
    return {
      ok: false,
      code: typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : null,
      strip: ['authLinkError']
    }
  }
  return null
}

export function handleAuthLinkResult(to, { router, siteStore, userStore, t }) {
  const result = readAuthLinkResult(to.query)
  if (!result) {
    return false
  }

  if (result.ok) {
    notify({
      type: 'positive',
      message: t('profile.authConnectSuccess')
    })
  } else {
    notify({
      type: 'negative',
      message: t('profile.authConnectFailed'),
      ...(result.code && { caption: localizeError(result.code, t) })
    })
  }

  if (userStore.authenticated) {
    siteStore.openOverlay('Profile', { section: 'auth' })
  }

  const query = Object.fromEntries(
    Object.entries(to.query).filter(([key]) => !result.strip.includes(key))
  )
  router.replace({ path: to.path, query, hash: to.hash })
  return true
}
