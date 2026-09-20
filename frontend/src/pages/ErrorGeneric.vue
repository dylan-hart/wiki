<template>
  <div class="errorpage">
    <div class="errorpage-bg" />
    <div class="errorpage-content">
      <div class="errorpage-code">{{ error.code }}</div>
      <div class="errorpage-title">{{ error.title }}</div>
      <div class="errorpage-hint">{{ error.hint }}</div>
      <div class="errorpage-actions">
        <w-btn
          v-if="error.showHomeBtn"
          color="primary"
          :label="t('common.error.goHome')"
          icon="tabler:home"
          to="/" />
        <w-btn
          v-if="error.showLoginBtn"
          color="primary"
          :label="t('common.error.loginAs')"
          icon="tabler:login"
          to="/login" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useMeta } from '@/composables/meta'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

const actions = {
  unauthorized: {
    code: 403,
    showLoginBtn: true
  },
  notfound: {
    code: 404
  },
  unknownsite: {
    code: 'X!?',
    showHomeBtn: false
  },
  // -> The site an administrator can still sign in to fix, so `/login` gets shown instead of `/` —
  //    home would only bounce right back here, since the hostname is what's disabled
  disabled: {
    code: 503,
    showHomeBtn: false,
    showLoginBtn: true
  },
  generic: {
    code: '!?0'
  }
}

const route = useRoute()
const router = useRouter()

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('common.error.title')
}))

/*
  With `bypassUnauthorized` on, a refused visitor is sent to sign in rather than to a screen whose
  only purpose is to offer them a login button. Only when nobody is logged in: somebody already
  signed in and still refused would be bounced straight back here.
*/
onMounted(() => {
  if (
    route.params.action === 'unauthorized' &&
    siteStore.auth.bypassUnauthorized &&
    !userStore.authenticated
  ) {
    router.replace('/login')
  }
})

const error = computed(() => {
  if (route.params.action && actions[route.params.action]) {
    return {
      showHomeBtn: true,
      ...actions[route.params.action],
      title: t(`common.error.${route.params.action}.title`),
      hint: t(`common.error.${route.params.action}.hint`)
    }
  } else {
    return {
      showHomeBtn: true,
      ...actions.generic,
      title: t('common.error.generic.title'),
      hint: t('common.error.generic.hint')
    }
  }
})
</script>

<style>
/* Flat selectors, not `&-suffix` nesting: that is a Sass string-concatenation idiom, and native
   CSS nesting silently drops such a rule. */
.errorpage {
  background: var(--color-dark-6) radial-gradient(ellipse, var(--color-dark-4), var(--color-dark-6));
  color: #fff;
  height: 100vh;
}
.errorpage-bg {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 320px;
  height: 320px;
  background: linear-gradient(0, transparent 50%, var(--color-red-9) 50%);
  border-radius: 50%;
  filter: blur(80px);
  transform: translate(-50%, -50%);
  visibility: hidden;
}
.errorpage-content {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 100%;
  max-width: 100%;
  padding: 0 1rem;
  text-align: center;
}
.errorpage-code {
  font-size: clamp(4rem, 30vw, 12rem);
  line-height: 1;
  font-weight: 700;
  background: linear-gradient(45deg, var(--color-red-9), var(--color-red-3));
  background-clip: text;
  -webkit-text-fill-color: transparent;
  user-select: none;
}
.errorpage-title {
  font-size: clamp(1.75rem, 10vw, 5rem);
  font-weight: 500;
  line-height: 1;
}
.errorpage-hint {
  font-size: 1.2rem;
  font-weight: 500;
  color: var(--color-red-3);
  line-height: 1.2rem;
  margin-top: 1rem;
}
.errorpage-actions {
  margin-top: 2rem;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 1rem;
}
</style>
