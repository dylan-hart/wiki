<template>
  <w-page class="py-4">
    <h1 class="w-section-header">{{ t('profile.groups') }}</h1>
    <div class="p-4">
      <div class="text-body2">{{ t('profile.groupsInfo') }}</div>
      <!--
        A settings row with nothing at the trailing edge: membership here is read-only, so every row
        is a plate and a name and no control at all. `control-width="auto"` rather than the default
        `grow` is what makes that read correctly -- an empty `grow` control still claims 200px of the
        row, which leaves the name crammed into a fraction of a card it has all of.
      -->
      <w-settings-card class="mt-4" :title="t('profile.groupsMemberOf')">
        <w-settings-row
          v-if="state.groups.length === 0 && state.loading < 1"
          control-width="auto"
          icon="tabler:users-group">
          <template #label>
            <span class="text-negative">{{ t('profile.groupsNone') }}</span>
          </template>
        </w-settings-row>
        <w-settings-row
          v-for="grp of state.groups"
          :key="grp.id"
          control-width="auto"
          icon="tabler:users"
          :label="grp.name" />
      </w-settings-card>

      <!--
        Informational only -- these are groups the viewer does NOT belong to, so there is nothing here
        for them to act on. Dimmed with opacity-60 rather than hidden or styled as a warning, the same
        "still part of the page, just not actionable" treatment AdminApprovals.vue uses for a disabled
        rule -- on the card now that a row is one component rather than the two sections that used to
        carry the class each.
      -->
      <template v-if="state.otherGroups.length > 0">
        <div class="text-body2 mt-6">
          {{ t('profile.otherGroups', { siteName: siteStore.title }) }}
        </div>
        <w-settings-card class="mt-4 opacity-60" :title="t('profile.otherGroupsTitle')">
          <w-settings-row
            v-for="grp of state.otherGroups"
            :key="grp.id"
            control-width="auto"
            icon="tabler:users"
            :label="grp.name" />
        </w-settings-card>
      </template>
    </div>

    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'
import { onMounted, reactive } from 'vue'

import { apiErrorMessage } from '@/helpers/apiError'

// I18N

const { t } = useI18n()

// STORES

const siteStore = useSiteStore()

// META

useMeta(() => ({
  title: t('profile.groups')
}))

// DATA

const state = reactive({
  groups: [],
  otherGroups: [],
  loading: 0
})

// METHODS

/**
 * The groups come from the session's own endpoint rather than from `users/:id`: reading an arbitrary
 * user requires `read:users`, which a regular user does not have.
 *
 * The response is a plain array of the groups the user belongs to, UNLESS the site has
 * `features.showOtherGroups` enabled, in which case it is `{ groups, otherGroups }` -- see
 * `backend/api/users/profile.ts`'s `/profile/groups` route for why the shape itself is what carries the
 * gating, rather than the frontend filtering a fetched-in-full list.
 */
async function fetchGroups() {
  state.loading++
  try {
    const data = await API_CLIENT.get('users/profile/groups').json()
    if (Array.isArray(data)) {
      state.groups = data ?? []
      state.otherGroups = []
    } else {
      state.groups = data?.groups ?? []
      state.otherGroups = data?.otherGroups ?? []
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.groupsLoadingFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

// MOUNTED

onMounted(() => {
  fetchGroups()
})
</script>
