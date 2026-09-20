<template>
  <!--
    `h-full`: the scroll area below is sized `calc(100% - 50px)`, which against an auto-height card
    resolves to `auto` and lets the card grow past the panel instead of scrolling inside it.
  -->
  <w-card class="page-properties-dialog h-full">
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
                A button, not a bare `w-icon`: WIcon draws a bundled icon's body through `v-html`,
                which renders no slot, so a `w-menu` child of it would never exist.
              -->
              <w-btn
                flat
                dense
                round
                icon="tabler:search"
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
            <!--
              -> A badge, not a `w-chip`: this is a status indicator, and the shape tokens put
                 badges on `--radius-mark` rather than the `--radius-pill` a chip always draws.
            -->
            <w-item-section side>
              <w-badge color="primary" :label="rel.position" />
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
      <!--
        `write:scripts`/`write:styles` are PAGE-scoped, so `userStore.pagePermissions` (this
        reader's grants AT THIS PATH), not `userStore.can()`. A control offered without the grant
        would look like it worked and then be refused with 403 on save.
      -->
      <w-card-section class="alt-card" id="refCardScripts" v-if="mayScripts || mayStyles">
        <div class="w-section-header">{{ t('editor.props.scripts') }}</div>
        <!--
          With the site's `features.pageScripts` kill switch off, a script or stylesheet saved here
          simply never runs -- no error, no log, no request. This hint is the only thing that tells
          the author so.
        -->
        <div class="text-caption text-warning mb-2" v-if="!siteStore.features.pageScripts">
          <em>{{ t('editor.props.pageScriptsDisabledHint') }}</em>
        </div>
        <w-btn
          v-if="mayScripts"
          class="w-full"
          :label="t(`editor.props.jsLoad`)"
          icon="tabler:code"
          color="secondary"
          @click="editScripts(`jsLoad`)">
          <w-tooltip>{{ t('editor.props.jsLoadHint') }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="mayScripts"
          class="w-full mt-2"
          :label="t(`editor.props.jsUnload`)"
          icon="tabler:code"
          color="secondary"
          @click="editScripts(`jsUnload`)">
          <w-tooltip>{{ t('editor.props.jsUnloadHint') }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="mayStyles"
          class="w-full mt-2"
          :label="t(`editor.props.styles`)"
          icon="tabler:brand-css3"
          color="secondary"
          @click="editScripts(`styles`)">
          <w-tooltip>{{ t('editor.props.stylesHint') }}</w-tooltip>
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
      <!--
        `write:tags` is PAGE-scoped, same as `mayScripts`/`mayStyles` above. Unlike the scripts
        section this stays visible without the grant while the page carries tags: an editor who
        cannot retag a page can still see what it is tagged.
      -->
      <w-card-section class="pb-6" id="refCardTags" v-if="mayTags || pageStore.tags?.length > 0">
        <div class="w-section-header">{{ t('editor.props.tags') }}</div>
        <page-tags :edit="mayTags" />
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
            <!-- -> Always starts empty: the server never hands an existing password back, so there
                    is nothing to prefill; leaving it blank on save keeps the current one. -->
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
    <w-dialog v-model="state.showScriptsDialog" :aria-label="t('editor.pageScripts.title')">
      <page-scripts-dialog :mode="state.pageScriptsMode" @close="state.showScriptsDialog = false" />
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
import { log } from '@/helpers/log'

import IconPickerDialog from './IconPickerDialog.vue'
import PageRelationDialog from './PageRelationDialog.vue'
import PageScriptsDialog from './PageScriptsDialog.vue'
import PageTags from './PageTags.vue'

const adminStore = useAdminStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

const state = reactive({
  showRelationDialog: false,
  requirePassword: false,
  editRelationId: null,
  showScriptsDialog: false,
  pageScriptsMode: 'jsLoad',
  showQuickAccess: true,
  originalClassification: pageStore.classification
})

const mayScripts = computed(() => userStore.pagePermissions.includes('write:scripts'))
const mayStyles = computed(() => userStore.pagePermissions.includes('write:styles'))
const mayTags = computed(() => userStore.pagePermissions.includes('write:tags'))

/** Mirrors the sections' own `v-if`s -- a jump button to a hidden section is a bug. */
const quickaccess = computed(() => [
  { key: 'refCardInfo', icon: 'tabler:info-circle', label: t('editor.props.info') },
  { key: 'refCardPublishState', icon: 'tabler:power', label: t('editor.props.publishState') },
  { key: 'refCardRelations', icon: 'tabler:link', label: t('editor.props.relations') },
  ...(mayScripts.value || mayStyles.value
    ? [{ key: 'refCardScripts', icon: 'tabler:code', label: t('editor.props.scripts') }]
    : []),
  { key: 'refCardSidebar', icon: 'tabler:ruler-2', label: t('editor.props.sidebar') },
  { key: 'refCardSocial', icon: 'tabler:messages', label: t('editor.props.social') },
  ...(mayTags.value || pageStore.tags?.length > 0
    ? [{ key: 'refCardTags', icon: 'tabler:tags', label: t('editor.props.tags') }]
    : []),
  {
    key: 'refCardClassification',
    icon: 'tabler:stack-2',
    label: t('editor.props.classification')
  },
  { key: 'refCardVisibility', icon: 'tabler:eye', label: t('editor.props.visibility') }
])

const iptTitle = ref(null)
const iptPagePassword = ref(null)

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
 * Raising a page's classification is free; only lowering it below what the page was loaded with
 * needs `manage:classification`. Advisory only -- the server enforces the guardrail regardless,
 * since these permissions can go stale the moment a group changes under the session.
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
function editScripts(mode) {
  state.pageScriptsMode = mode
  state.showScriptsDialog = true
}
function jumpToSection(id) {
  document.querySelector(`#${id}`).scrollIntoView({
    behavior: 'smooth'
  })
}
/*
  Watched with `immediate`, not read once on mount: this panel can mount before `pageLoad()` resolves.
  `hasPassword` rather than `password` because the server never hands the password back, so `password`
  alone cannot tell "this page has one" from "the field is empty".
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
    // -> Undoes an accidental off-then-back-on before saving
    pageStore.removePassword = false
    nextTick(() => {
      iptPagePassword.value.focus()
      iptPagePassword.value.$el.scrollIntoView({
        behavior: 'smooth'
      })
    })
  } else {
    pageStore.password = ''
    // -> An empty `password` alone is ambiguous between "never touched" and "just cleared", so
    //    `pageSave` needs this explicit "take the password off" signal.
    pageStore.removePassword = true
  }
}

onMounted(async () => {
  nextTick(() => {
    iptTitle.value?.focus()
  })

  setTimeout(() => {
    state.showQuickAccess = true
  }, 300)

  try {
    await adminStore.fetchClassificationLevels()
  } catch (err) {
    log.warn('page', 'could not load the classification levels', err)
  }
})
</script>

<style>
/*
  The two children that reach the card's corners have to round with it -- a square toolbar or scroll
  area paints straight over the radius. `inherit` tracks the card's own value. The scroll area is
  what makes the bottom corners work: it clips its overflow, so the last section is clipped too.
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
    A full-bleed section band over content inset 14px/16px: `WCardSection` pads itself `p-4`, so the
    sections here take the design's inset instead and the header's negative margin has to cancel
    exactly that inset -- mismatched values leave the band a few pixels off the fields under it.
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
