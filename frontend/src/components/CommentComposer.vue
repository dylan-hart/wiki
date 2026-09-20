<template>
  <w-form ref="composerForm" class="comment-composer flex flex-col gap-2" @submit="submit">
    <!--
      Guest identity, captured inline rather than in a dialog, for the one case where there is no
      session to read `authorName`/`authorEmail` off.
    -->
    <div
      v-if="!userStore.authenticated"
      class="comment-composer-guest flex flex-col gap-2 sm:flex-row">
      <w-input
        v-model="guestName"
        class="flex-1"
        dense
        :label="t(`common.comments.fieldName`)"
        :rules="nameRules"
        lazy-rules="ondemand"
        autocomplete="name" />
      <w-input
        v-model="guestEmail"
        class="flex-1"
        dense
        type="email"
        :label="t(`common.comments.fieldEmail`)"
        :rules="emailRules"
        lazy-rules="ondemand"
        autocomplete="email" />
    </div>

    <w-input
      ref="contentIpt"
      v-model="content"
      type="textarea"
      dense
      :rows="replyTo ? 2 : 3"
      :placeholder="t(`common.comments.newPlaceholder`)"
      :hint="t(`common.comments.markdownFormat`)"
      :rules="contentRules"
      lazy-rules="ondemand"
      :aria-label="t(`common.comments.fieldContent`)" />

    <div class="comment-composer-actions flex flex-wrap items-center gap-3">
      <w-btn
        dense
        color="primary"
        :loading="submitting"
        :label="t(`common.comments.postComment`)"
        @click="submit" />
      <w-btn
        v-if="replyTo"
        flat
        dense
        color="grey"
        :label="t(`common.actions.cancel`)"
        @click="emit(`cancel`)" />
      <span
        v-if="userStore.authenticated"
        class="text-caption text-text-caption dark:text-text-caption-dark">
        {{ t(`common.comments.postingAs`, { name: userStore.name }) }}
      </span>
    </div>
  </w-form>
</template>

<script setup>
import { nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { guestEmailRules, guestNameRules } from '@/helpers/guestIdentity'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * `PageComments.vue` mounts one of these permanently (as the page's top composer) and one more per
 * comment whose reply box the reader has toggled open -- `replyTo` and the textarea height are the
 * only differences, so both share this component rather than being two near-identical forms.
 *
 * Visibility (holding `write:comments` at this path) is entirely the caller's job: `PageComments.vue`
 * only ever mounts this component once that check has already passed.
 */

const props = defineProps({
  /** The comment being replied to, or null for a top-level comment. */
  replyTo: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['posted', 'cancel'])

const { t } = useI18n()

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const content = ref('')
const guestName = ref('')
const guestEmail = ref('')
const submitting = ref(false)

const composerForm = ref(null)
const contentIpt = ref(null)

/*
  Only a reply composer steals focus: it is mounted fresh the instant `PageComments.vue` toggles its
  reply box open, so `onMounted` lines up with "just appeared for the reader to type into". The
  permanent top-level composer is already on the page at load, with no such moment.
*/
onMounted(() => {
  if (props.replyTo) {
    nextTick(() => {
      contentIpt.value?.focus()
    })
  }
})

const nameRules = guestNameRules(t)
const emailRules = guestEmailRules(t)
const contentRules = [
  (val) => (val ?? '').trim().length >= 2 || t(`common.comments.contentMissingError`)
]

/**
 * The `posted` event is what splices the new comment into `PageComments.vue`'s visible list and
 * bumps `pageStore.commentsCount` -- this component owns none of that page-wide state itself.
 */
async function submit() {
  if (!(await composerForm.value.validate())) {
    return
  }
  submitting.value = true
  try {
    const payload = {
      content: content.value.trim(),
      replyTo: props.replyTo
    }
    if (!userStore.authenticated) {
      payload.guestName = guestName.value.trim()
      payload.guestEmail = guestEmail.value.trim()
    }
    const posted = await API_CLIENT.post(`sites/${siteStore.id}/pages/${pageStore.id}/comments`, {
      json: payload
    }).json()
    // -> A refusal that arrives as a parsed `{ ok: false, message }` envelope rather than as a
    //    rejection would otherwise read as a successful post.
    if (posted?.ok === false) {
      throw new Error(posted.message || t(`common.error.generic.title`))
    }

    notify({ type: 'positive', message: t(`common.comments.postSuccess`) })
    content.value = ''
    guestName.value = ''
    guestEmail.value = ''
    emit('posted', { ...posted, replies: posted?.replies ?? [] })
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`common.error.generic.title`),
      caption: apiErrorMessage(err)
    })
  } finally {
    submitting.value = false
  }
}
</script>
