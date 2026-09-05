<template>
  <div>
    <template v-if="props.screen === `register`">
      <p>{{ t('auth.registerSubTitle') }}</p>
      <w-form ref="form" @submit="register">
        <w-input
          ref="nameIpt"
          v-model="state.newName"
          :rules="nameValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :label="t(`auth.fields.name`)"
          autocomplete="name">
          <template #prepend><w-icon name="tabler:user-circle" /></template>
        </w-input>
        <w-input
          class="mt-2"
          type="email"
          v-model="state.newEmail"
          :rules="emailValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :label="t(`auth.fields.email`)"
          autocomplete="email">
          <template #prepend><w-icon name="tabler:mail" /></template>
        </w-input>
        <w-input
          class="mt-2"
          v-model="state.newPassword"
          :label="t(`auth.fields.password`)"
          type="password"
          autocomplete="new-password"
          :rules="passwordValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #append>
            <w-badge
              v-show="state.newPassword"
              :color="passwordStrength.color"
              :label="passwordStrength.label" />
          </template>
          <template #prepend><w-icon name="tabler:key" /></template>
        </w-input>
        <w-input
          class="mt-2"
          v-model="state.newPasswordVerify"
          :label="t(`auth.fields.verifyPassword`)"
          type="password"
          autocomplete="new-password"
          :rules="passwordVerifyValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #prepend><w-icon name="tabler:key" /></template>
        </w-input>
        <w-btn
          class="w-full mt-2"
          type="submit"
          color="primary"
          :label="t(`auth.actions.register`)"
          icon="tabler:user-plus" />
      </w-form>
      <w-separator class="my-4" />
      <w-btn
        class="acrylic-btn w-full"
        flat
        color="primary"
        :label="t(`auth.switchToLogin.link`)"
        icon="tabler:circle-arrow-left"
        @click="emit(`back-to-login`)" />
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- REGISTER CHECK EMAIL SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="props.screen === `registerCheckEmail`">
      <div class="flex flex-col items-center text-center">
        <w-icon name="tabler:mail-opened" size="48px" color="primary" class="mb-4" />
        <p>{{ t('auth.registerCheckEmail') }}</p>
      </div>
      <w-separator class="my-4" />
      <w-btn
        class="acrylic-btn w-full"
        flat
        color="primary"
        :label="t(`auth.switchToLogin.link`)"
        icon="tabler:circle-arrow-left"
        @click="emit(`back-to-login`)" />
    </template>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, ref } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { emailRules, nameRules, passwordRules, passwordVerifyRules } from '@/helpers/authValidation'
import { localizeError } from '@/helpers/localization'
import { passwordStrengthBadge } from '@/helpers/passwordStrength'

import { useSiteStore } from '@/stores/site'

/**
 * The self-registration screens of `AuthLoginPanel.vue`: the sign-up form, and the "check your
 * emails" screen a site with email validation on ends it at.
 *
 * Split out of the panel because the four fields it fills in are read by nothing else -- the panel's
 * own reset and change-password screens ask for a password too, but their own -- so the only thing
 * it needs from the sign-in attempt is which strategy to register against.
 */

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// PROPS

const props = defineProps({
  /** Which of the two screens to draw: `register` or `registerCheckEmail`. */
  screen: {
    type: String,
    required: true
  },
  /** The strategy to register against. */
  strategyId: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['registered', 'back-to-login'])

// DATA

const state = reactive({
  newName: '',
  newEmail: '',
  newPassword: '',
  newPasswordVerify: ''
})

// REFS

const nameIpt = ref(null)
const form = ref(null)

// COMPUTED

const passwordStrength = computed(() => passwordStrengthBadge(state.newPassword, t))

// VALIDATION RULES

const nameValidation = nameRules(t)
const emailValidation = emailRules(t)
const passwordValidation = passwordRules(t)
const passwordVerifyValidation = passwordVerifyRules(t, () => state.newPassword)

// METHODS

/**
 * REGISTER
 *
 * `nextAction: 'verify'` means the strategy requires email validation: the account was created
 * unverified and a link was mailed to it, so this shows a "check your email" screen instead of
 * calling `handleLoginResponse()` -- there is no session to establish yet. Any other `nextAction`
 * (validation off) is a login exactly like every other successful auth attempt, so it's handed to
 * the same response handler the rest of this panel uses.
 */
async function register() {
  loading.show({
    message: t('auth.registering')
  })
  try {
    const isFormValid = await form.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.register'))
    }
    const resp = await API_CLIENT.post(`sites/${siteStore.id}/auth/register`, {
      json: {
        strategyId: props.strategyId,
        name: state.newName,
        email: state.newEmail,
        password: state.newPassword
      }
    }).json()
    if (resp.ok) {
      state.newPassword = ''
      state.newPasswordVerify = ''
      // -> Where the flow goes next -- the check-your-email screen or straight into a session -- is
      //    the panel's to decide, the same as it is for every other successful auth attempt. It also
      //    owns the login form's own password field, which a completed registration clears.
      emit('registered', resp)
    } else {
      throw new Error(resp.message || 'ERR_REGISTRATION_FAILED')
    }
  } catch (err) {
    loading.hide()
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
}

// MOUNTED

/*
  The panel used to focus this from its own `switchTo('register')`, on the tick after the screen
  changed. Mounting IS that moment now -- this component exists only while the register screen is up.
*/
onMounted(() => {
  nameIpt.value?.focus()
})
</script>
