<template>
  <!--
    `h-full` so the card fills the panel: the scroll area below is sized `calc(100% - 50px)`, which
    against an auto-height card resolves to `auto` and let the card grow past the panel instead of
    scrolling inside it -- the white surface and the panel's shadow ending in different places.
  -->
  <w-card class="page-properties-dialog h-full">
    <!-- -> Offset comes from the stylesheet now, relative to this card; see SideDialog -->
    <div class="floating-sidepanel-quickaccess animated fadeIn" v-if="state.showQuickAccess">
      <template v-for="(qa, idx) of quickaccess" :key="`qa-` + qa.key">
        <w-btn
          :icon="qa.icon"
          flat
          padding="sm xs"
          size="sm"
          :aria-label="qa.label"
          @click="jumpToSection(qa.key)">
          <w-tooltip anchor="center left" self="center right">{{ qa.label }}</w-tooltip>
        </w-btn>
        <w-separator dark v-if="idx < quickaccess.length - 1" />
      </template>
    </div>
    <w-toolbar class="card-header card-header--slate flex">
      <div>{{ t('editor.props.pageProperties') }}</div>
      <w-space />
      <w-btn
        class="me-2"
        dense
        flat
        rounded
        color="white"
        icon="tabler:help-circle"
        :aria-label="t(`common.actions.viewDocs`)"
        :href="siteStore.docsBase + `/guide/page-properties`"
        target="_blank"
        type="a" />
      <w-btn
        icon="tabler:x"
        dense
        flat
        :aria-label="t(`common.actions.close`)"
        @click="siteStore.sideDialogShown = false" />
    </w-toolbar>
    <w-scroll-area ref="scrollArea" style="height: calc(100% - 50px)">
      <w-card-section id="refCardInfo">
        <div class="w-section-header">{{ t('editor.props.info') }}</div>
        <w-form class="gap-2">
          <w-input
            ref="iptTitle"
            v-model="pageStore.title"
            :placeholder="t(`editor.props.title`)"
            :aria-label="t(`editor.props.title`)"
            dense />
          <w-input
            v-model="pageStore.description"
            :placeholder="t(`editor.props.shortDescription`)"
            :aria-label="t(`editor.props.shortDescription`)"
            dense />
          <w-input
            v-model="pageStore.icon"
            :placeholder="t(`editor.props.icon`)"
            :aria-label="t(`editor.props.icon`)"
            dense>
            <template #prepend>
              <w-icon :name="pageStore.icon" size="20px" color="primary" />
            </template>
            <template #append>
              <!--
                A button, not a bare `w-icon`: for a bundled icon WIcon renders an <svg> whose body is
                set through `v-html`, which renders no slot -- so the menu inside it never existed and
                the control did nothing. It was also just the 14px glyph, with no hit area of its own.
              -->
              <w-btn
                flat
                dense
                round
                icon="tabler:icons"
                color="primary"
                :aria-label="t(`iconPicker.open`)">
                <w-tooltip>{{ t('iconPicker.open') }}</w-tooltip>
                <!-- The properties panel is docked to the right edge, so the picker has to grow leftwards -->
                <w-menu content-class="shadow-7" anchor="bottom right" self="top right">
                  <icon-picker-dialog v-model="pageStore.icon" />
                </w-menu>
              </w-btn>
            </template>
          </w-input>
          <w-input
            v-if="pageStore.path !== `home`"
            v-model="pageStore.alias"
            :placeholder="t(`editor.props.alias`)"
            :aria-label="t(`editor.props.alias`)"
            dense
            prefix="/a/" />
        </w-form>
      </w-card-section>
      <w-card-section class="alt-card" id="refCardPublishState">
        <div class="w-section-header">{{ t('editor.props.publishState') }}</div>
        <w-form class="gap-4">
          <div>
            <w-btn-toggle
              v-model="pageStore.publishState"
              toggle-color="primary"
              :aria-label="t(`editor.props.publishState`)"
              :options="[
                { label: t('editor.props.draft'), value: 'draft' },
                { label: t('editor.props.published'), value: 'published' },
                { label: t('editor.props.dateRange'), value: 'scheduled' }
              ]" />
          </div>
          <div class="text-caption" v-if="pageStore.publishState === `published`">
            <em>{{ t('editor.props.publishedHint') }}</em>
          </div>
          <div class="text-caption" v-else-if="pageStore.publishState === `draft`">
            <em>{{ t('editor.props.draftHint') }}</em>
          </div>
          <template v-else-if="pageStore.publishState === `scheduled`">
            <div class="text-caption">
              <em>{{ t('editor.props.dateRangeHint') }}</em>
            </div>
            <w-date v-model="publishingRange" range bordered />
          </template>
        </w-form>
      </w-card-section>
      <w-card-section id="refCardRelations">
        <div class="w-section-header">{{ t('editor.props.relations') }}</div>
        <w-list
          class="rounded mb-2 bg-white dark:bg-black/20"
          v-if="pageStore.relations.length > 0"
          separator
          bordered>
          <w-item v-for="rel of pageStore.relations" :key="`rel-id-` + rel.id">
            <w-item-section side><w-icon :name="rel.icon" /></w-item-section>
            <w-item-section>
              <w-item-label
                ><strong>{{ rel.label }}</strong></w-item-label
              >
              <w-item-label caption>{{ rel.caption }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-chip class="px-2" dense color="primary" text-color="white">
                <div class="text-caption">{{ rel.position }}</div>
              </w-chip>
            </w-item-section>
            <w-item-section side>
              <w-btn
                icon="tabler:pencil"
                dense
                flat
                padding="none"
                :aria-label="t(`common.actions.edit`)"
                @click="editRelation(rel)" />
            </w-item-section>
            <w-item-section side>
              <w-btn
                icon="tabler:x"
                dense
                flat
                padding="none"
                :aria-label="t(`common.actions.remove`)"
                @click="removeRelation(rel)" />
            </w-item-section>
          </w-item>
        </w-list>
        <w-btn
          class="w-full"
          :label="t(`editor.props.relationAdd`)"
          icon="tabler:plus"
          color="slate"
          @click="newRelation">
          <w-tooltip>{{ t('editor.props.relationAddHint') }}</w-tooltip>
        </w-btn>
      </w-card-section>
      <w-card-section class="pb-6" id="refCardSidebar">
        <div class="w-section-header">{{ t('editor.props.sidebar') }}</div>
        <w-form class="gap-4 pt-2">
          <div>
            <w-toggle
              v-model="pageStore.showSidebar"
              dense
              :label="t(`editor.props.showSidebar`)" />
          </div>
          <div>
            <w-toggle
              v-if="pageStore.showSidebar"
              v-model="pageStore.showToc"
              dense
              :label="t(`editor.props.showToc`)" />
          </div>
          <div v-if="pageStore.showSidebar && pageStore.showToc" style="padding-inline-start: 40px">
            <div class="text-caption">
              {{ t('editor.props.tocMinMaxDepth') }}
              <strong>(H{{ pageStore.tocDepth.min }} &rarr; H{{ pageStore.tocDepth.max }})</strong>
            </div>
            <w-range
              v-model="pageStore.tocDepth"
              :min="1"
              :max="6"
              color="primary"
              :left-label-value="`H` + pageStore.tocDepth.min"
              :right-label-value="`H` + pageStore.tocDepth.max"
              :aria-label-min="t('editor.props.tocMinMaxDepth')"
              :aria-label-max="t('editor.props.tocMinMaxDepth')"
              label
              markers />
          </div>
          <div>
            <w-toggle
              v-if="pageStore.showSidebar"
              v-model="pageStore.showTags"
              dense
              :label="t(`editor.props.showTags`)" />
          </div>
        </w-form>
      </w-card-section>
      <w-card-section class="alt-card pb-6" id="refCardSocial">
        <div class="w-section-header">{{ t('editor.props.social') }}</div>
        <w-form class="gap-4 pt-2">
          <div>
            <w-toggle
              v-model="pageStore.allowComments"
              dense
              :label="t(`editor.props.allowComments`)" />
          </div>
          <div>
            <w-toggle
              v-model="pageStore.allowContributions"
              dense
              :label="t(`editor.props.allowContributions`)" />
          </div>
        </w-form>
      </w-card-section>
      <w-card-section class="pb-6" id="refCardTags">
        <div class="w-section-header">{{ t('editor.props.tags') }}</div>
        <page-tags edit />
      </w-card-section>
      <w-card-section class="pb-6" id="refCardClassification">
        <div class="w-section-header">{{ t('editor.props.classification') }}</div>
        <w-select
          v-model="pageStore.classification"
          standout
          dense
          emit-value
          map-options
          :options="adminStore.classificationLevels"
          option-value="id"
          option-label="name"
          :placeholder="t('editor.props.classification')"
          :aria-label="t('editor.props.classification')" />
        <div class="text-caption mt-1">
          <em>{{ t('editor.props.classificationHint') }}</em>
        </div>
        <div class="text-caption text-warning mt-1" v-if="!mayLowerClassification">
          <em>{{ t('editor.props.classificationGuardHint') }}</em>
        </div>
      </w-card-section>
      <w-card-section class="alt-card pb-6" id="refCardVisibility">
        <div class="w-section-header">{{ t('editor.props.visibility') }}</div>
        <w-form class="gap-4 pt-2">
          <div>
            <w-toggle
              v-model="pageStore.isBrowsable"
              dense
              :label="$t(`editor.props.showInTree`)" />
          </div>
          <div>
            <w-toggle
              v-model="pageStore.isSearchable"
              dense
              :label="$t(`editor.props.isSearchable`)" />
          </div>
          <div>
            <w-toggle
              v-model="state.requirePassword"
              @update:model-value="toggleRequirePassword"
              dense
              :label="$t(`editor.props.requirePassword`)" />
          </div>
          <div v-if="state.requirePassword" style="padding-inline-start: 40px">
            <!-- -> Masked, with WInput's own reveal toggle: this is a secret to hand out rather than
                    one to remember, so the author has to be able to read back what they typed.
                    Always starts empty -- the server never hands an existing password back
                    (OpenProject #2232), so there is nothing here to prefill even when the page
                    already has one; leaving it blank on save just keeps that one as it is. -->
            <w-input
              ref="iptPagePassword"
              v-model="pageStore.password"
              type="password"
              revealable
              autocomplete="off"
              :placeholder="t(`editor.props.password`)"
              :aria-label="t(`editor.props.password`)"
              :hint="
                pageStore.hasPassword
                  ? t(`editor.props.passwordKeepHint`)
                  : t(`editor.props.passwordHint`)
              "
              dense />
          </div>
        </w-form>
      </w-card-section>
    </w-scroll-area>
    <w-dialog
      v-model="state.showRelationDialog"
      :aria-label="
        state.editRelationId ? t('editor.pageRel.titleEdit') : t('editor.pageRel.title')
      ">
      <page-relation-dialog
        :edit-id="state.editRelationId"
        @close="state.showRelationDialog = false" />
    </w-dialog>
  </w-card>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

import { useAdminStore } from '@/stores/admin'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import IconPickerDialog from './IconPickerDialog.vue'
import PageRelationDialog from './PageRelationDialog.vue'
import PageTags from './PageTags.vue'

// STORES

const adminStore = useAdminStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  showRelationDialog: false,
  requirePassword: false,
  editRelationId: null,
  showQuickAccess: true,
  /**
   * The classification this page was loaded with, before anything in this panel touched it -- what
   * `mayLowerClassification` compares a picker change against. An editor may raise it freely; only
   * lowering (making it MORE open than this) needs `manage:classification` on the page.
   */
  originalClassification: pageStore.classification
})

const quickaccess = computed(() => [
  { key: 'refCardInfo', icon: 'tabler:info-circle', label: t('editor.props.info') },
  { key: 'refCardPublishState', icon: 'tabler:power', label: t('editor.props.publishState') },
  { key: 'refCardRelations', icon: 'tabler:link', label: t('editor.props.relations') },
  { key: 'refCardSidebar', icon: 'tabler:ruler-2', label: t('editor.props.sidebar') },
  { key: 'refCardSocial', icon: 'tabler:messages', label: t('editor.props.social') },
  { key: 'refCardTags', icon: 'tabler:tags', label: t('editor.props.tags') },
  {
    key: 'refCardClassification',
    icon: 'tabler:stack-2',
    label: t('editor.props.classification')
  },
  { key: 'refCardVisibility', icon: 'tabler:eye', label: t('editor.props.visibility') }
])

// REFS

const iptTitle = ref(null)
const iptPagePassword = ref(null)

// COMPUTED

const publishingRange = computed({
  get() {
    return {
      from: pageStore.publishStartDate,
      to: pageStore.publishEndDate
    }
  },
  set(newValue) {
    pageStore.publishStartDate = newValue?.from
    pageStore.publishEndDate = newValue?.to
  }
})

/**
 * Whether the current picker selection is safe to save without `manage:classification` on this page
 * (OpenProject #1080) -- unchanged or raised needs nothing extra; only actually lowering it below
 * `state.originalClassification` does. Purely advisory: the server enforces the real guardrail
 * regardless of what this shows, since `pagePermissions` here can be stale the moment a group
 * changes underneath the session.
 */
const mayLowerClassification = computed(() => {
  if (pageStore.classification === state.originalClassification) {
    return true
  }
  const levels = adminStore.classificationLevels
  const current = levels.find((l) => l.id === pageStore.classification)
  const original = levels.find((l) => l.id === state.originalClassification)
  if (!current || !original || current.sortOrder >= original.sortOrder) {
    return true
  }
  return userStore.can('manage:classification')
})

// WATCHERS

/*
  No `pageStore.$subscribe` of this component's own (OpenProject #1133): `<page-tags edit />` below
  is always rendered, unconditionally, whenever this panel is open, and `PageTags.vue` registers the
  identical whole-store subscribe itself whenever `props.edit` is true. A second one here would just
  double-patch `lastChangeTimestamp` on every mutation this panel makes, tags included -- harmless
  since `hasPendingChanges` only checks inequality, but redundant. `PageTags.vue` keeps its own copy
  because it is also used standalone, outside Properties, where nothing else would fire the signal.
*/

// METHODS

function newRelation() {
  state.editRelationId = null
  state.showRelationDialog = true
}
function editRelation(rel) {
  state.editRelationId = rel.id
  state.showRelationDialog = true
}
function removeRelation(rel) {
  pageStore.relations = pageStore.relations.filter((r) => r.id !== rel.id)
}
function jumpToSection(id) {
  document.querySelector(`#${id}`).scrollIntoView({
    behavior: 'smooth'
  })
}
/*
  Watched rather than read once in `onMounted` (OpenProject #1133): this panel can mount before
  `pageStore.pageLoad()` resolves, and a one-time read left `state.requirePassword` stuck at whatever
  it saw at that moment even after the real answer arrived. `immediate: true` still covers the
  already-loaded case `onMounted` used to handle, so nothing here depends on load ordering any more.
  Watches `hasPassword` rather than `password` (OpenProject #2232): the server never hands the actual
  password back, so `password` alone cannot tell "this page has one" from "the field is empty" --
  `hasPassword` is the informational flag it sends instead. `toggleRequirePassword` below also writes
  `pageStore.password`, but only ever to `''` while turning the toggle off -- `state.requirePassword`
  is already `false` by then from the toggle's own `v-model`, so this watcher re-deriving the same
  value is a no-op, not a fight over who owns it.
*/
watch(
  () => pageStore.hasPassword,
  (newValue) => {
    state.requirePassword = Boolean(newValue)
  },
  { immediate: true }
)

function toggleRequirePassword(newValue) {
  if (newValue) {
    // -> Undoes an accidental off-then-back-on before saving; see `pageStore.removePassword`'s own
    //    doc comment for what turning the toggle off records instead.
    pageStore.removePassword = false
    nextTick(() => {
      iptPagePassword.value.focus()
      iptPagePassword.value.$el.scrollIntoView({
        behavior: 'smooth'
      })
    })
  } else {
    pageStore.password = ''
    // -> The explicit "take the password off" signal `pageSave` needs (OpenProject #2232): once the
    //    server stopped echoing the password back, an empty `password` field alone is ambiguous
    //    between "never touched" and "just cleared it".
    pageStore.removePassword = true
  }
}

// MOUNTED

onMounted(async () => {
  // -> Title is the field this panel is opened to edit, so the caret starts there
  nextTick(() => {
    iptTitle.value?.focus()
  })

  setTimeout(() => {
    state.showQuickAccess = true
  }, 300)

  try {
    await adminStore.fetchClassificationLevels()
  } catch (err) {
    console.warn('Failed to load classification levels.', err)
  }
})
</script>

<style lang="scss">
/*
  The panel is inset from the window and rounded now, so the two children that reach its corners have
  to be rounded too -- a square toolbar or scroll area paints straight over the radius. `inherit`
  takes the card's own value, so these stay right if that radius ever changes.

  The scroll area is what makes the BOTTOM corners work: it already clips its overflow, so giving it
  the radius clips the last section (grey, `alt-card`) to the corner instead of letting it square off.
*/
.page-properties-dialog {
  > .w-toolbar {
    border-top-left-radius: inherit;
    border-top-right-radius: inherit;
  }

  > .w-scroll-area {
    border-bottom-left-radius: inherit;
    border-bottom-right-radius: inherit;
  }

  /*
    The design's own section rhythm: a full-bleed 34px band, then 14px/16px of content under it
    (`ui-redesign/Cardinal Wiki - Page Properties 3x.dc.html`). `WCardSection` pads itself `p-4`, so
    the sections here take the design's inset instead and the band cancels exactly that inset back
    out -- it used to cancel 16px against a 16px pad while giving 16px back at the top, which left
    the band sitting a couple of pixels off the fields under it in every section.

    The band's own top rule is the shared `.w-section-header`'s; all this does is give back the
    section's inset around it.

    The tinted `alt-card` sections keep their stripe: the heading is inside the section, so the wash
    is drawn over whichever surface that section has.
  */
  .w-card-section {
    padding: 14px 16px;
  }

  .w-section-header {
    margin: -14px -16px 14px;
  }

  /* -> Nothing above the panel's first band to rule off from; it is not its parent's `:first-child` */
  .w-scroll-area .w-card-section:first-child .w-section-header {
    border-block-start: 0;
  }
}
</style>
