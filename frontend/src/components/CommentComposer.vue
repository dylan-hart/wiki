<template>
  <w-form ref="composerForm" class="comment-composer flex flex-col gap-2" @submit="submit">
    <!--
      Guest identity capture, above the textarea -- matching 2.5.x's inline fields (never a modal;
      `SuggestionGuestDialog.vue`'s dialog is a different flow entirely) for the one case a comment
      poster's identity isn't already known: no session to read `authorName`/`authorEmail` off.
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
      <span v-if="userStore.authenticated" class="text-caption text-grey-6">
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
 * The composer for posting a comment: a new top-level one, or a reply when `replyTo` names an
 * existing comment on this page.
 *
 * `PageComments.vue` mounts one of these permanently (as the page's top composer) and one more per
 * comment whose reply box the reader has toggled open -- the only difference between the two is
 * `replyTo` and the smaller textarea a reply gets, so this is the one component both share rather
 * than two near-identical forms.
 *
 * Reads `pageStore`/`siteStore`/`userStore` directly, matching `PageComments.vue`'s own convention,
 * so it needs no page-identity props -- only what distinguishes a reply from a top-level post.
 * Visibility (holding `write:comments` at this path) is entirely the caller's job: `PageComments.vue`
 * only ever mounts this component once that check has already passed.
 */

const props = defineProps({
  /** The comment being replied to, on this page, or null for a top-level comment. */
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
  Only a reply composer steals focus on mount -- the permanent top-level one (`replyTo: null`) is
  already on the page when it loads, and there is no "just opened this" moment to justify jumping the
  caret into it. A reply composer, by contrast, is freshly mounted the instant `PageComments.vue`
  toggles its reply box open (`v-if="openReplyIds.has(...)"`), so `onMounted` here really does line up
  with "just appeared for the reader to type into."
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
/** 2.5.x's own threshold (`length: { minimum: 2 }`) -- short of that reads as "empty or too short". */
const contentRules = [
  (val) => (val ?? '').trim().length >= 2 || t(`common.comments.contentMissingError`)
]

/**
 * Validates, posts, and on success clears the composer and hands the new comment back to
 * `PageComments.vue` via `posted` -- which is what splices it into the visible list and bumps
 * `pageStore.commentsCount`, since this component owns none of that page-wide state itself.
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
    // -> The API client does not throw for a 400, so a refusal comes back as a parsed error
    //    envelope rather than a rejection: without this check it reads as a successful post.
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
