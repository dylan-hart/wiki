<template>
  <w-page>
    <w-toolbar class="ps-4" :class="dark.isActive ? `bg-dark-3 text-white` : `bg-white text-dark`">
      <div class="text-subtitle1">{{ t('admin.groups.rules') }}</div>
      <w-space />
      <w-btn
        class="acrylic-btn me-2"
        flat
        color="indigo"
        icon="la:file-export"
        @click="exportRules">
        <w-tooltip labels>{{ t('admin.groups.exportRules') }}</w-tooltip>
      </w-btn>
      <w-btn
        class="acrylic-btn me-2"
        flat
        color="indigo"
        icon="la:file-import"
        v-if="canManage"
        @click="importRules">
        <w-tooltip labels>{{ t('admin.groups.importRules') }}</w-tooltip>
      </w-btn>
      <w-btn
        v-if="canManage"
        unelevated
        color="primary"
        icon="la:plus"
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
            <w-card class="admin-groups-rule-card mt-4" flat>
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
                    <w-chip square dense :color="getRuleModeBgColor(rule.mode)" text-color="white">
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
                  icon="la:trash"
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
                        OpenProject #1079: CLASSIFICATION reads none of `path` -- it matches page
                        metadata via `rule.classifications`, an admin-configured level list rather than
                        free text, so it gets its own picker instead of the path input every other
                        match kind shares.
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
                  <w-input
                    v-else
                    class="mt-2"
                    :model-value="rule.path"
                    @update:model-value="onRulePathInput(rule, $event)"
                    dense
                    :prefix="[`START`, `REGEX`, `EXACT`].includes(rule.match) ? `/` : null"
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
import { computed } from 'vue'

import { confirm } from '@/composables/dialog'
import { useDark } from '@/composables/dark'
import { notify } from '@/composables/notify'

import { useAdminStore } from '@/stores/admin'

import { v4 as uuid } from 'uuid'
import { fileOpen, fileSave } from 'browser-fs-access'

/**
 * The rules half of `GroupEditOverlay.vue`: the catalog of permissions a rule may grant, the card
 * each rule is edited through, and the import/export of the whole set as JSON.
 *
 * Split out of the overlay because it shares nothing with the other three sections except the group
 * it belongs to -- and the group's `rules` array is the entirety of that, so it comes in as the
 * model and is written back through it.
 */

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// MODEL

const groupRules = defineModel('rules', {
  type: Array,
  default: () => []
})

// PROPS

const props = defineProps({
  /** Whether this is the guests group, whose rules may only grant `GUEST_ROLES` below. */
  isGuestGroup: {
    type: Boolean,
    default: false
  },
  /**
   * Whether the viewer holds `manage:groups`. A `read:groups` viewer still gets the export button:
   * it only reads what is on screen.
   */
  canManage: {
    type: Boolean,
    default: false
  }
})

// DATA

/**
 * The subset of `rules` below that the guests group may be granted. Mirrors `GUEST_ROLES` in
 * `models/groups.ts`, which is the copy that decides — this one only shapes what is offered.
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
  Structural data only -- no English text. `title:`/`hint:` are resolved from
  `admin.groups.permissions.<permission>.title` / `.hint` in the `rules` computed below, where `t()`
  is available; a plain module-scope array can only ever hold a literal, not a reactive translation,
  so it stays purely structural here.

  Task #684: the eight `site:*` site-admin permissions (see `backend/helpers/siteRules.ts`'s
  `SITE_PERMISSIONS`, the closed vocabulary this list must stay in step with -- do not add to
  one without the other). Each governs one settings surface behind `/_admin/:siteid/...` -- see
  `docs/decisions/delegated-per-site-administration.md` §3 for the one-per-surface reasoning.

  Deliberately in the SAME catalog as the page permissions above, not a second list or a second
  UI: a rule already has a sites picker ("Applies to..." below), which for one of these means
  exactly what it already means for a page permission -- empty is every site, populated is only
  those. The `path` / `match` / `locales` fields alongside it are simply not read for these (see
  `helpers/siteRules.ts`'s own doc comment) and can be left at whatever a new rule defaults to.

  None of these are in `GUEST_ROLES` above, so `ruleOptions` already keeps them off the guests
  group's picker -- and `models/groups.ts` enforces that server-side regardless of what this
  screen offers.
*/
const RULES_DATA = [
  { permission: 'read:pages', warning: false, restrictedForSystem: false, disabled: false },
  { permission: 'write:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'review:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'delete:pages', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'write:styles', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'write:scripts', warning: false, restrictedForSystem: true, disabled: false },
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

// COMPUTED

/**
 * The permissions a rule may grant, which for the guests group is a short list.
 *
 * That group is every anonymous reader at once, so a rule on it is a rule about the open internet:
 * reading, and saying something in a comment, are what the public may be given — writing a page or
 * deleting one is an action attributable to somebody, and there is nobody here.
 *
 * Only what is OFFERED. The set is enforced in `models/groups.ts`, which is what makes it true for a
 * group edited through the API as well; this keeps the screen from offering what would be dropped.
 */
const ruleOptions = computed(() =>
  props.isGuestGroup
    ? rules.value.filter((rule) => GUEST_ROLES.includes(rule.permission))
    : rules.value
)

// METHODS

/**
 * START/END/EXACT compare `path` directly against a page path, which is always stored lowercased
 * (`backend/helpers/common.ts#normalizePagePath`) -- so typing any uppercase character there would
 * save a rule that can never match (silently, for a DENY -- OpenProject #2182). Lowercase as the
 * administrator types rather than only rejecting on save: TAG/TAGALL read `path` as a comma list
 * (already lowercased at match time) and REGEX as a pattern that may deliberately use a character
 * class like `[A-Z]`, so neither is folded here.
 */
function onRulePathInput(rule, value) {
  rule.path = ['START', 'END', 'EXACT'].includes(rule.match) ? value.toLowerCase() : value
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
      DENY: 'la:ban',
      ALLOW: 'la:check',
      FORCEALLOW: 'la:check-double'
    }[mode] || 'la:frog'
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
          match: ['START', 'END', 'REGEX', 'TAG', 'TAGALL', 'EXACT', 'CLASSIFICATION'].includes(
            r.match
          )
            ? r.match
            : 'START',
          roles: r.roles || [],
          path: r.path || '',
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
      message: t('admin.groups.importFailed') + ` [${err.message}]`
    })
  }
}
</script>

<style lang="scss">
.admin-groups-rule {
  position: relative;
  padding: 10px 0 24px 40px;

  &-icon {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 31px;

    &::before {
      position: absolute;
      content: '';
      border-radius: 100%;
      width: 31px;
      height: 31px;
      background-color: currentColor;
      top: 4px;
    }

    &::after {
      position: absolute;
      content: '';
      width: 3px;
      top: 41px;
      bottom: 0;
      left: 14px;
      opacity: 0.4;
      background-color: currentColor;
      display: block;
    }

    /*
      Sized and placed to the disc `::before` draws, with the glyph inset by the padding: an inline
      <svg> scales its viewBox to whatever box it is given, so the old `width: 100%; height: 38px`
      -- metrics for the icon FONT this replaced, where `font-size` did the sizing -- stretched the
      mark across the whole circle.

      The box stays the full 31px even though the glyph is 15px, so the click target is the disc a
      reader is aiming at rather than the mark inside it.
    */
    .w-icon {
      position: absolute;
      top: 4px;
      left: 0;
      box-sizing: border-box;
      width: 31px;
      height: 31px;
      padding: 8px;
      cursor: pointer;
    }
  }

  &-name {
    line-height: 12px;
    display: flex;
    flex-wrap: nowrap;
    /*
      On the text baseline, not stretched. An <input> stretched to the row's height centres its text
      inside that height, while the mode name beside it sits at the top of its own box -- so the two
      read as a few pixels apart even though both are 12px type. The separator between them is
      unaffected: it carries its own `self-stretch`, which outranks this.
    */
    align-items: baseline;
    padding-top: 4px;

    &-text {
      flex: 0 0;
      white-space: nowrap;
    }

    input {
      font-weight: 700;
      color: $grey-6;
      letter-spacing: 1px;
      font-size: 12px;
      line-height: 12px;
      border: none;
      padding: 0 0 0 5px;
      outline: none;
      flex: 1;
      background-color: transparent;

      &::placeholder {
        color: $grey-5;
      }

      @at-root .body--dark & {
        color: rgba(255, 255, 255, 0.7);

        &::placeholder {
          color: rgba(255, 255, 255, 0.4);
        }
      }
    }
  }

  &-card {
    background-color: $grey-2 !important;

    @at-root .body--dark & {
      background-color: $dark-6 !important;
    }

    &-permissions {
      background-color: rgba($positive, 0.1);
      border-bottom: 1px solid rgba($positive, 0.3);
      display: flex;
      align-items: center;

      .w-select {
        flex-basis: 100%;
      }

      &.is-allow {
        background-color: rgba($positive, 0.1);
        border-bottom: 1px solid rgba($positive, 0.3);
      }
      &.is-deny {
        background-color: rgba($negative, 0.1);
        border-bottom: 1px solid rgba($negative, 0.3);
      }
      &.is-forceallow {
        background-color: rgba($blue, 0.1);
        border-bottom: 1px solid rgba($blue, 0.3);
      }
    }

    &-filters {
      background-color: $grey-3;
      flex-basis: 300px;

      .text-caption:first-child {
        color: $grey-7;
      }

      @at-root .body--dark & {
        background-color: $dark-5;
      }
    }
    &-pattern {
      flex-grow: 1;
    }
  }
}
</style>
