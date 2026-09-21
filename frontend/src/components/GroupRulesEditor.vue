<template>
  <w-page>
    <w-toolbar class="ps-4" :class="dark.isActive ? `bg-dark-3 text-white` : `bg-white text-dark`">
      <div class="text-subtitle1">{{ t('admin.groups.rules') }}</div>
      <w-space />
      <w-btn
        class="acrylic-btn me-2"
        flat
        color="indigo"
        icon="tabler:file-export"
        @click="exportRules">
        <w-tooltip labels>{{ t('admin.groups.exportRules') }}</w-tooltip>
      </w-btn>
      <w-btn
        class="acrylic-btn me-2"
        flat
        color="indigo"
        icon="tabler:file-import"
        v-if="canManage"
        @click="importRules">
        <w-tooltip labels>{{ t('admin.groups.importRules') }}</w-tooltip>
      </w-btn>
      <w-btn
        v-if="canManage"
        color="primary"
        icon="tabler:plus"
        :label="t('admin.groups.newRule')"
        @click="newRule" />
    </w-toolbar>
    <w-separator />
    <div class="p-4">
      <w-banner
        v-if="!groupRules || groupRules.length < 1"
        :class="dark.isActive ? `bg-negative text-white` : `bg-grey-4 text-grey-9`"
        >{{ t('admin.groups.rulesNone') }}</w-banner
      >
      <w-card class="shadow-1 pb-2" v-else>
        <w-card-section>
          <div class="admin-groups-rule" v-for="rule of groupRules" :key="rule.id">
            <div class="admin-groups-rule-icon" :class="getRuleModeColor(rule.mode)">
              <w-icon
                :name="getRuleModeIcon(rule.mode)"
                color="white"
                @click="rule.mode = getNextRuleMode(rule.mode)" />
            </div>
            <div class="admin-groups-rule-name">
              <div class="admin-groups-rule-name-text">
                <strong :class="getRuleModeColor(rule.mode)">{{
                  getRuleModeName(rule.mode)
                }}</strong>
              </div>
              <w-separator class="ms-2 me-1" vertical />
              <input type="text" v-model="rule.name" placeholder="Rule Name" />
            </div>
            <w-card class="admin-groups-rule-card mt-4">
              <w-card-section
                class="admin-groups-rule-card-permissions"
                :class="getRuleModeClass(rule.mode)">
                <w-select
                  class="mt-1"
                  standout
                  v-model="rule.roles"
                  emit-value
                  map-options
                  dense
                  :aria-label="t(`admin.groups.ruleSites`)"
                  :options="ruleOptions"
                  placeholder="Select permissions..."
                  option-value="permission"
                  option-label="title"
                  options-dense
                  multiple
                  use-chips>
                  <template #selected-item="scope">
                    <w-chip dense :color="getRuleModeBgColor(rule.mode)" text-color="white">
                      <span class="text-caption">{{ scope.opt.title }}</span>
                    </w-chip>
                  </template>
                  <template #option="{ itemProps, itemEvents, opt, selected, toggleOption }">
                    <w-item v-bind="itemProps" v-on="itemEvents">
                      <w-item-section side>
                        <w-toggle
                          :model-value="selected"
                          @update:model-value="toggleOption(opt)"
                          :aria-label="opt.label" />
                      </w-item-section>
                      <w-item-section>
                        <w-item-label>{{ opt.title }}</w-item-label>
                        <w-item-label caption>{{ opt.hint }}</w-item-label>
                      </w-item-section>
                    </w-item>
                  </template>
                </w-select>
                <w-btn
                  class="acrylic-btn ms-4"
                  flat
                  icon="tabler:trash"
                  color="negative"
                  padding="sm sm"
                  size="md"
                  v-if="canManage"
                  :aria-label="t(`common.actions.delete`)"
                  @click="deleteRule(rule.id)" />
              </w-card-section>
              <w-card-section horizontal>
                <w-card-section class="admin-groups-rule-card-filters">
                  <div class="text-caption">Applies to...</div>
                  <w-select
                    class="mt-1"
                    standout
                    v-model="rule.sites"
                    emit-value
                    map-options
                    dense
                    :aria-label="t(`admin.groups.ruleSites`)"
                    :options="adminStore.sites"
                    option-value="id"
                    option-label="title"
                    multiple
                    :display-value="
                      t(`admin.groups.selectedSites`, rule.sites.length, {
                        count: rule.sites.length
                      })
                    ">
                    <template #option="{ itemProps, itemEvents, opt, selected, toggleOption }">
                      <w-item v-bind="itemProps" v-on="itemEvents">
                        <w-item-section>
                          <w-item-label>{{ opt.title }}</w-item-label>
                        </w-item-section>
                        <w-item-section side>
                          <w-toggle
                            :model-value="selected"
                            @update:model-value="toggleOption(opt)"
                            :aria-label="opt.label" />
                        </w-item-section>
                      </w-item>
                    </template>
                  </w-select>
                  <w-select
                    class="mt-2"
                    standout
                    v-model="rule.locales"
                    emit-value
                    map-options
                    dense
                    :aria-label="t(`admin.groups.ruleLocales`)"
                    :options="adminStore.locales"
                    option-value="code"
                    option-label="name"
                    multiple
                    :display-value="
                      t(
                        `admin.groups.selectedLocales`,
                        {
                          n:
                            rule.locales.length > 0
                              ? rule.locales[0].toUpperCase()
                              : rule.locales.length
                        },
                        rule.locales.length
                      )
                    ">
                    <template #option="{ itemProps, opt, selected, toggleOption }">
                      <w-item v-bind="itemProps">
                        <w-item-section>
                          <w-item-label>{{ opt.name }}</w-item-label>
                        </w-item-section>
                        <w-item-section side>
                          <w-toggle
                            :model-value="selected"
                            @update:model-value="toggleOption(opt)"
                            :aria-label="opt.name" />
                        </w-item-section>
                      </w-item>
                    </template>
                  </w-select>
                </w-card-section>
                <w-card-section class="admin-groups-rule-card-pattern">
                  <div class="text-caption">Pattern</div>
                  <w-select
                    class="mt-1"
                    standout
                    v-model="rule.match"
                    emit-value
                    map-options
                    dense
                    :aria-label="t(`admin.groups.ruleMatch`)"
                    :options="[
                      { label: t('admin.groups.ruleMatchStart'), value: 'START' },
                      { label: t('admin.groups.ruleMatchSubtree'), value: 'SUBTREE' },
                      { label: t('admin.groups.ruleMatchEnd'), value: 'END' },
                      { label: t('admin.groups.ruleMatchRegex'), value: 'REGEX' },
                      { label: t('admin.groups.ruleMatchTag'), value: 'TAG' },
                      { label: t('admin.groups.ruleMatchTagAll'), value: 'TAGALL' },
                      { label: t('admin.groups.ruleMatchExact'), value: 'EXACT' },
                      {
                        label: t('admin.groups.ruleMatchClassification'),
                        value: 'CLASSIFICATION'
                      }
                    ]" />
                  <!--
                        CLASSIFICATION reads none of `path`: it matches an admin-configured level
                        list, so it gets a picker rather than the shared free-text path input.
                      -->
                  <w-select
                    v-if="rule.match === `CLASSIFICATION`"
                    class="mt-2"
                    standout
                    v-model="rule.classifications"
                    emit-value
                    map-options
                    dense
                    :aria-label="t(`admin.groups.ruleClassifications`)"
                    :options="adminStore.classificationLevels"
                    option-value="id"
                    option-label="name"
                    multiple
                    :display-value="
                      t(
                        `admin.groups.selectedClassifications`,
                        { n: (rule.classifications ?? []).length },
                        (rule.classifications ?? []).length
                      )
                    ">
                    <template #option="{ itemProps, opt, selected, toggleOption }">
                      <w-item v-bind="itemProps">
                        <w-item-section>
                          <w-item-label>{{ opt.name }}</w-item-label>
                        </w-item-section>
                        <w-item-section side>
                          <w-toggle
                            :model-value="selected"
                            @update:model-value="toggleOption(opt)"
                            :aria-label="opt.name" />
                        </w-item-section>
                      </w-item>
                    </template>
                  </w-select>
                  <w-select
                    v-else-if="[`TAG`, `TAGALL`].includes(rule.match)"
                    class="mt-2"
                    standout
                    :model-value="rule.tags ?? []"
                    @update:model-value="rule.tags = $event"
                    dense
                    options-dense
                    use-input
                    create
                    multiple
                    use-chips
                    hide-dropdown-icon
                    @create="createRuleTag(rule, $event)"
                    :options="state.siteTags"
                    :loading="state.siteTagsLoading"
                    :placeholder="t(`admin.groups.ruleTagsPlaceholder`)"
                    :aria-label="t(`admin.groups.ruleTags`)" />
                  <w-input
                    v-else
                    class="mt-2"
                    :model-value="rule.path"
                    @update:model-value="onRulePathInput(rule, $event)"
                    dense
                    :prefix="
                      [`START`, `SUBTREE`, `REGEX`, `EXACT`].includes(rule.match) ? `/` : null
                    "
                    :suffix="rule.match === `REGEX` ? `/` : null"
                    :aria-label="t(`admin.groups.rulePath`)" />
                </w-card-section>
              </w-card-section>
            </w-card>
          </div>
        </w-card-section>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, reactive, watch } from 'vue'

import { confirm } from '@/composables/dialog'
import { useDark } from '@/composables/dark'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'

import { v4 as uuid } from 'uuid'
import { fileOpen, fileSave } from 'browser-fs-access'

const dark = useDark()

const adminStore = useAdminStore()

const { t } = useI18n()

const groupRules = defineModel('rules', {
  type: Array,
  default: () => []
})

const props = defineProps({
  isGuestGroup: {
    type: Boolean,
    default: false
  },
  /** A read-only viewer still gets the export button: it only reads what is on screen. */
  canManage: {
    type: Boolean,
    default: false
  }
})

/**
 * Mirrors `GUEST_ROLES` in `models/groups.ts`, which is the copy that decides — this one only
 * shapes what is offered.
 */
const GUEST_ROLES = [
  'read:pages',
  'read:source',
  'read:history',
  'read:assets',
  'read:comments',
  'write:comments'
]

/*
  Structural only: a module-scope array can hold a literal but not a reactive translation, so
  titles and hints resolve through `t()` in the `rules` computed below instead.

  Keep in step with `PAGE_PERMISSIONS` and `SITE_PERMISSIONS` in `backend/helpers/`, both closed
  vocabularies -- never add to one without the other.

  The `site:*` entries share this catalog rather than getting a second UI: the sites picker below
  already means for them what it means for a page permission (empty is every site, populated is
  only those), and `path` / `match` / `locales` are simply not read for them.
*/
const RULES_DATA = [
  { permission: 'read:pages', warning: false, restrictedForSystem: false, disabled: false },
  { permission: 'write:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'review:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'delete:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'write:styles', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'write:scripts', warning: false, restrictedForSystem: true, disabled: false },
  // -> No special-casing despite write:pages/manage:pages implying read:source: this row grants
  //    the literal string like any other, and the hint text is what says so to the administrator.
  { permission: 'read:source', warning: false, restrictedForSystem: false, disabled: false },
  { permission: 'read:history', warning: false, restrictedForSystem: false, disabled: false },
  { permission: 'read:assets', warning: false, restrictedForSystem: false, disabled: false },
  { permission: 'write:assets', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:assets', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'read:comments', warning: false, restrictedForSystem: false, disabled: false },
  { permission: 'write:comments', warning: false, restrictedForSystem: false, disabled: false },
  { permission: 'manage:comments', warning: false, restrictedForSystem: true, disabled: false },
  {
    permission: 'manage:classification',
    warning: false,
    restrictedForSystem: true,
    disabled: false
  },
  { permission: 'publish:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'write:tags', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:general', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:theme', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:navigation', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:blocks', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:approvals', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:login', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:locale', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'site:editors', warning: false, restrictedForSystem: true, disabled: false }
]

const rules = computed(() =>
  RULES_DATA.map((rule) => ({
    ...rule,
    title: t(`admin.groups.permissions.${rule.permission}.title`),
    hint: t(`admin.groups.permissions.${rule.permission}.hint`)
  }))
)

/**
 * The guests group is every anonymous reader at once, so a rule on it is a rule about the open
 * internet: reading and commenting are what the public may be given, while writing or deleting a
 * page is an action attributable to somebody and there is nobody here. `models/groups.ts` enforces
 * the set; this only keeps the screen from offering what a save would drop.
 */
const ruleOptions = computed(() =>
  props.isGuestGroup
    ? rules.value.filter((rule) => GUEST_ROLES.includes(rule.permission))
    : rules.value
)

/** Suggestions only, not a closed vocabulary: the picker's `create` still takes an unused tag. */
const state = reactive({
  siteTags: [],
  siteTagsLoading: false
})

watch(
  () => adminStore.currentSiteId,
  async (siteId) => {
    if (!siteId) {
      state.siteTags = []
      return
    }
    state.siteTagsLoading = true
    try {
      const tags = await API_CLIENT.get(`sites/${siteId}/tags`).json()
      state.siteTags = (tags ?? []).map((tg) => tg.tag)
    } catch (err) {
      // -> A warning, not a failure: without suggestions the picker still adds tags via `create`.
      notify({
        type: 'warning',
        message: t('admin.groups.ruleTagsFetchFailed'),
        caption: apiErrorMessage(err)
      })
    } finally {
      state.siteTagsLoading = false
    }
  },
  { immediate: true }
)

/**
 * START/SUBTREE/END/EXACT compare `path` against a page path, which is always stored lowercased, so an
 * uppercase character saves a rule that can never match -- silently, for a DENY. REGEX is left
 * alone: its pattern may deliberately use a character class like `[A-Z]`.
 */
function onRulePathInput(rule, value) {
  rule.path = ['START', 'SUBTREE', 'END', 'EXACT'].includes(rule.match)
    ? value.toLowerCase()
    : value
}

/**
 * Split on comma/semicolon so a pasted list adds more than one tag at once. The trim/lowercase/
 * de-dupe fold mirrors `models/groups.ts#normalizeRuleTags`, which re-applies it on save, so the
 * picker shows what will actually be stored.
 */
function createRuleTag(rule, val) {
  const tags = val
    .split(/[,;]+/)
    .map((tg) => tg.trim().toLowerCase())
    .filter(Boolean)
  if (tags.length === 0) {
    return
  }

  const nextSelection = (rule.tags ?? []).slice()
  for (const tag of tags) {
    if (!state.siteTags.includes(tag)) {
      state.siteTags.push(tag)
    }
    if (!nextSelection.includes(tag)) {
      nextSelection.push(tag)
    }
  }
  rule.tags = nextSelection
}

function getRuleModeColor(mode) {
  return {
    DENY: 'text-negative',
    ALLOW: 'text-positive',
    FORCEALLOW: 'text-blue'
  }[mode]
}

function getRuleModeBgColor(mode) {
  return {
    DENY: 'negative',
    ALLOW: 'positive',
    FORCEALLOW: 'blue'
  }[mode]
}

function getRuleModeClass(mode) {
  return 'is-' + mode.toLowerCase()
}

function getRuleModeIcon(mode) {
  return (
    {
      DENY: 'tabler:ban',
      ALLOW: 'tabler:check',
      FORCEALLOW: 'tabler:checks'
    }[mode] || 'tabler:fish'
  )
}

function getNextRuleMode(mode) {
  return (
    {
      DENY: 'FORCEALLOW',
      ALLOW: 'DENY',
      FORCEALLOW: 'ALLOW'
    }[mode] || 'ALLOW'
  )
}

function getRuleModeName(mode) {
  switch (mode) {
    case 'ALLOW':
      return t('admin.groups.ruleAllow')
    case 'DENY':
      return t('admin.groups.ruleDeny')
    case 'FORCEALLOW':
      return t('admin.groups.ruleForceAllow')
    default:
      return '???'
  }
}

function newRule() {
  groupRules.value.push({
    id: uuid(),
    name: t('admin.groups.ruleUntitled'),
    mode: 'ALLOW',
    match: 'START',
    roles: [],
    path: '',
    tags: [],
    locales: [],
    sites: [],
    classifications: []
  })
}

function deleteRule(id) {
  groupRules.value = groupRules.value.filter((r) => r.id !== id)
}

function exportRules() {
  if (groupRules.value.length < 1) {
    return notify({
      type: 'negative',
      message: t('admin.groups.exportRulesNoneError')
    })
  }
  const rules = groupRules.value.map(({ __typename, ...r }) => r)
  fileSave(new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json;charset=UTF-8' }), {
    fileName: 'rules.json',
    extensions: ['.json']
  })
}

async function importRules() {
  try {
    const blob = await fileOpen({
      mimeTypes: ['application/json'],
      extensions: ['.json'],
      startIn: 'downloads',
      excludeAcceptAllOption: true
    })
    const rulesRaw = await blob.text()
    const rules = JSON.parse(rulesRaw)
    if (!Array.isArray(rules) || rules.length < 1) {
      throw new Error(t('admin.groups.importInvalidFormat'))
    }
    confirm({
      title: t('admin.groups.importModeTitle'),
      message: t('admin.groups.importModeText'),
      options: {
        model: 'replace',
        type: 'radio',
        items: [
          { label: t('admin.groups.importModeReplace'), value: 'replace' },
          { label: t('admin.groups.importModeAdd'), value: 'add' }
        ]
      },
      cancel: true,
      persistent: true
    }).onOk((choice) => {
      if (choice === 'replace') {
        groupRules.value = []
      }
      groupRules.value = [
        ...groupRules.value,
        ...rules.map((r) => ({
          id: uuid(),
          name: r.name || t('admin.groups.ruleUntitled'),
          mode: ['ALLOW', 'DENY', 'FORCEALLOW'].includes(r.mode) ? r.mode : 'DENY',
          match: [
            'START',
            'SUBTREE',
            'END',
            'REGEX',
            'TAG',
            'TAGALL',
            'EXACT',
            'CLASSIFICATION'
          ].includes(r.match)
            ? r.match
            : 'START',
          roles: r.roles || [],
          path: r.path || '',
          // -> Folded the same way `models/groups.ts#normalizeRuleTags` will on save, so an
          //    imported rule's tags read back as they will be stored.
          tags: [
            ...new Set(
              (Array.isArray(r.tags) ? r.tags : [])
                .filter((tg) => typeof tg === 'string')
                .map((tg) => tg.trim().toLowerCase())
                .filter(Boolean)
            )
          ],
          locales: r.locales.filter((l) => adminStore.locales.some((loc) => loc.code === l)),
          sites: r.sites.filter((s) => adminStore.sites.some((site) => site.id === s)),
          classifications: (r.classifications || []).filter((c) =>
            adminStore.classificationLevels.some((level) => level.id === c)
          )
        }))
      ]
      notify({
        type: 'positive',
        message: t('admin.groups.importSuccess')
      })
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.groups.importFailed') + ` [${apiErrorMessage(err)}]`
    })
  }
}
</script>

<style>
.admin-groups-rule {
  position: relative;
  padding-block: 10px 24px;
  padding-inline-start: 40px;
}
.admin-groups-rule-icon {
  position: absolute;
  top: 0;
  inset-inline-start: 0;
  bottom: 0;
  width: 31px;
}
.admin-groups-rule-icon::before {
  position: absolute;
  content: '';
  border-radius: 100%;
  width: 31px;
  height: 31px;
  background-color: currentColor;
  top: 4px;
}
.admin-groups-rule-icon::after {
  position: absolute;
  content: '';
  width: 3px;
  top: 41px;
  bottom: 0;
  inset-inline-start: 14px;
  opacity: 0.4;
  background-color: currentColor;
  display: block;
}
.admin-groups-rule-icon {
  /*
    The icon box below is sized to the disc `::before` draws and insets the glyph with padding: an
    inline <svg> scales its viewBox to whatever box it is given, and the full 31px keeps the click
    target on the disc the reader is aiming at rather than the smaller mark inside it.
  */
}
.admin-groups-rule-icon .w-icon {
  position: absolute;
  top: 4px;
  inset-inline-start: 0;
  box-sizing: border-box;
  width: 31px;
  height: 31px;
  padding: 8px;
  cursor: pointer;
}
.admin-groups-rule-name {
  line-height: 12px;
  display: flex;
  flex-wrap: nowrap;
  /*
    Baseline, not stretch: a stretched <input> centres its text in the row height while the mode
    name beside it sits at the top of its own box, so the two read as a few pixels apart.
  */
  align-items: baseline;
  padding-top: 4px;
}
.admin-groups-rule-name-text {
  flex: 0 0;
  white-space: nowrap;
}
.admin-groups-rule-name input {
  font-weight: 700;
  color: var(--color-grey-6);
  letter-spacing: 1px;
  font-size: 12px;
  line-height: 12px;
  border: none;
  padding: 0 0 0 5px;
  outline: none;
  flex: 1;
  background-color: transparent;
}
.admin-groups-rule-name input::placeholder {
  color: var(--color-grey-5);
}
.body--dark .admin-groups-rule-name input {
  color: rgba(255, 255, 255, 0.7);
}
.body--dark .admin-groups-rule-name input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}
.admin-groups-rule-card {
  background-color: var(--color-grey-2) !important;
}
.body--dark .admin-groups-rule-card {
  background-color: var(--color-dark-6) !important;
}
.admin-groups-rule-card-permissions {
  background-color: color-mix(in srgb, var(--color-positive) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-positive) 30%, transparent);
  display: flex;
  align-items: center;
}
.admin-groups-rule-card-permissions .w-select {
  flex-basis: 100%;
}
.admin-groups-rule-card-permissions.is-allow {
  background-color: color-mix(in srgb, var(--color-positive) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-positive) 30%, transparent);
}
.admin-groups-rule-card-permissions.is-deny {
  background-color: color-mix(in srgb, var(--color-negative) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-negative) 30%, transparent);
}
.admin-groups-rule-card-permissions.is-forceallow {
  background-color: color-mix(in srgb, var(--color-blue) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-blue) 30%, transparent);
}
.admin-groups-rule-card-filters {
  background-color: var(--color-grey-3);
  flex-basis: 300px;
}
.admin-groups-rule-card-filters .text-caption:first-child {
  color: var(--color-grey-7);
}
.body--dark .admin-groups-rule-card-filters {
  background-color: var(--color-dark-5);
}
.admin-groups-rule-card-pattern {
  flex-grow: 1;
}
</style>
