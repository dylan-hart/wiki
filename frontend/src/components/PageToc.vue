<template>
  <nav class="page-toc" :aria-label="t('common.page.toc')">
    <ul class="page-toc-list">
      <li
        v-for="item of visibleItems"
        :key="item.key"
        class="page-toc-item"
        :class="[
          `page-toc-item--d${Math.min(item.depth, 2)}`,
          { 'page-toc-item--active': item.key === selected }
        ]"
        :style="{ '--page-toc-depth': item.depth }">
        <!--
          A real `href` so the section can be middle-clicked or copied, with the click handled here
          instead: scrolling into view keeps the router from being handed a fragment to resolve.
        -->
        <a class="page-toc-link" :href="item.key" @click="onClick($event, item)">{{
          item.label
        }}</a>
      </li>
    </ul>
  </nav>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { scrollToAnchor } from '@/helpers/anchors'
import { flattenToc } from '@/helpers/toc'

/**
 * No disclosure control: which levels the contents cover is the page's own `tocDepth` setting
 * (`minDepth`/`maxDepth` here), not something to fiddle with per visit, and a column of carets both
 * wasted the width and read as a file tree.
 */
const props = defineProps({
  /** The contents tree: `{ key, label, children }`, where `key` is the heading's `#anchor`. */
  nodes: {
    type: Array,
    required: true
  },
  /** Counting from 1, so `2` skips the first level and promotes its subheadings to the top tier. */
  minDepth: {
    type: Number,
    default: 1
  },
  maxDepth: {
    type: Number,
    default: 2
  },
  selected: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:selected'])

const { t } = useI18n()

/*
  Where the page counts as being "at" a heading, measured down from the top of whatever box the
  article scrolls in. Deliberately below that edge, so a heading becomes current as it settles into
  reading position rather than the instant its first pixel appears.
*/
const SPY_LINE = 120

/*
  How long the spy stands down after a click: a smooth scroll passes over every heading in between,
  and letting the marker run down the list behind it looks like a fault.
*/
const CLICK_SETTLE_MS = 1200

let spyFrame = null
let spySuspendedUntil = 0

/**
 * One flat list rather than a component per level: the rail and the active marker are then a single
 * positioning context, so a row at any depth marks the same 1px line.
 */
const visibleItems = computed(() =>
  flattenToc(props.nodes, { minDepth: props.minDepth, maxDepth: props.maxDepth })
)

function headingFor(key) {
  // -> `getElementById` rather than a selector: a heading slug need not be a valid CSS selector, and
  //    would otherwise have to be escaped
  return document.getElementById(key.replace(/^#/, ''))
}

function onClick(ev, item) {
  if (!headingFor(item.key)) {
    // -> Nothing to scroll to; let the browser do whatever it can with the href
    return
  }
  ev.preventDefault()
  emit('update:selected', item.key)
  spySuspendedUntil = performance.now() + CLICK_SETTLE_MS

  // -> Through the helper, so that a heading inside a closed tab is revealed rather than scrolled at
  scrollToAnchor(item.key, { smooth: true })
}

/**
 * The shell is the viewport and the article scrolls in a column inside it, so a heading at the top of
 * its own scrollport is still well down the window. Measuring the reading line from the window
 * instead leaves the spy a heading behind wherever the reader is.
 */
function scrollportTop(heading) {
  for (let el = heading.parentElement; el; el = el.parentElement) {
    if (['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) {
      return el.getBoundingClientRect().top
    }
  }
  return 0
}

/**
 * Positions are read fresh each time rather than cached: the render is replaced wholesale while
 * editing, and images settling in shift every heading below them.
 */
function syncSpy() {
  if (performance.now() < spySuspendedUntil || visibleItems.value.length === 0) {
    return
  }

  let current = null
  let line = null
  for (const item of visibleItems.value) {
    const heading = headingFor(item.key)
    if (!heading) {
      continue
    }
    line ??= scrollportTop(heading) + SPY_LINE
    if (heading.getBoundingClientRect().top <= line) {
      current = item.key
    }
  }

  // -> Above the first heading, the first section is still the one being read
  const next = current ?? visibleItems.value[0].key
  if (next !== props.selected) {
    emit('update:selected', next)
  }
}

/** Scroll fires far more often than the marker can move; one read per frame is enough. */
function queueSpy() {
  if (spyFrame !== null) {
    return
  }
  spyFrame = requestAnimationFrame(() => {
    spyFrame = null
    syncSpy()
  })
}

// -> A new render means new heading positions, and possibly a different set of them
watch(() => props.nodes, queueSpy)

onMounted(() => {
  /*
    `capture` because scroll events do not bubble: the article may scroll the document or a container
    inside it, and capturing on the window catches whichever one moved.
  */
  window.addEventListener('scroll', queueSpy, { capture: true, passive: true })
  window.addEventListener('resize', queueSpy, { passive: true })
  queueSpy()
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', queueSpy, { capture: true })
  window.removeEventListener('resize', queueSpy)
  if (spyFrame !== null) {
    cancelAnimationFrame(spyFrame)
  }
})
</script>

<style>
/*
  Everything hangs off one vertical rail: depth is indentation from it, and the heading being read
  marks it. Colours go through custom properties rather than fixed values so that a re-themed site's
  `--color-primary` follows at runtime.
*/
.page-toc {
  --page-toc-indent: 14px;
  /* Translucent, not a palette grey: the rail sits on the sidebar's own fill in both themes */
  --page-toc-rail: rgba(0, 0, 0, 0.1);
  --page-toc-ink-strong: var(--color-grey-9);
  --page-toc-ink: var(--color-grey-7);
  --page-toc-ink-soft: var(--color-grey-6);
  --page-toc-ink-hover: var(--color-grey-10);
  --page-toc-hover-surface: rgba(0, 0, 0, 0.04);
  /*
    The active entry as several properties rather than one colour: Ledger marks it with a 2px accent
    bar drawn ON the rail and leaves the row untinted, while Cobalt drops the rail and the bar
    altogether and tints the row itself. `--page-toc-active-mark` is the bar's width, so `0` removes it.
  */
  --page-toc-active-ink: var(--color-primary);
  --page-toc-active-surface: transparent;
  --page-toc-active-mark: 2px;
  --page-toc-active-radius: 0;
  --page-toc-active-weight: inherit;
  line-height: 1.4;
}
body.body--cobalt .page-toc {
  --page-toc-rail: transparent;
  --page-toc-ink-strong: var(--color-text-body);
  --page-toc-ink: var(--color-text-secondary);
  --page-toc-ink-soft: var(--color-text-secondary);
  --page-toc-ink-hover: var(--color-ink);
  --page-toc-hover-surface: var(--color-tint);
  --page-toc-active-ink: var(--color-accent);
  --page-toc-active-surface: var(--color-accent-wash);
  --page-toc-active-mark: 0;
  --page-toc-active-radius: 5px;
  --page-toc-active-weight: 600;
}
body.body--cobalt.body--dark .page-toc {
  --page-toc-ink-strong: var(--color-text-dark);
  --page-toc-ink: var(--color-text-secondary-dark);
  --page-toc-ink-soft: var(--color-text-secondary-dark);
  --page-toc-ink-hover: var(--color-text-dark);
  --page-toc-hover-surface: rgba(255, 255, 255, 0.06);
  --page-toc-active-ink: var(--color-accent-dark);
  --page-toc-active-surface: var(--color-accent-wash-dark);
}
.body--dark .page-toc {
  --page-toc-rail: rgba(255, 255, 255, 0.12);
  --page-toc-ink-strong: rgba(255, 255, 255, 0.87);
  --page-toc-ink: rgba(255, 255, 255, 0.6);
  --page-toc-ink-soft: rgba(255, 255, 255, 0.45);
  --page-toc-ink-hover: #fff;
  --page-toc-hover-surface: rgba(255, 255, 255, 0.06);
}
.page-toc-list {
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
  /*
    The rail: inset top and bottom so it stops level with the first and last label, and on the
    INLINE-START edge -- the side the depth ramp indents away from -- so it follows RTL.
  */
}
.page-toc-list::before {
  content: '';
  position: absolute;
  top: 3px;
  bottom: 3px;
  inset-inline-start: 0;
  width: 1px;
  background-color: var(--page-toc-rail);
}
.page-toc-item {
  position: relative;
  /* Depth is carried as a custom property by the template, so one rule indents every level */
  padding-inline-start: calc(var(--page-toc-depth) * var(--page-toc-indent));
}
.page-toc {
  /*
    The active marker is drawn ON the rail: `inset-inline-start: 0` is the item's own border box,
    which starts at the rail whatever the indentation, so every depth marks the same line.
  */
}
.page-toc-item--active::before {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  inset-inline-start: 0;
  width: var(--page-toc-active-mark);
  background-color: var(--page-toc-active-ink);
}
.page-toc-link {
  display: block;
  /* 9px of gutter, not a caret column: the rail is the only thing before a label, on its start side */
  padding-block: 3px;
  padding-inline: 9px 8px;
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
  text-decoration: none;
  overflow-wrap: break-word;
  /*
    Always present, not just while active: only `color`/`background-color` transition below, so a
    radius that came and went with the active class would snap to square the instant the class is
    removed, while the background is still fading out. On a transparent background it draws nothing.
  */
  border-radius: var(--page-toc-active-radius);
  transition:
    color 0.2s var(--ease-standard),
    background-color 0.2s var(--ease-standard);
}
.page-toc-link:hover {
  color: var(--page-toc-ink-hover);
  background-color: var(--page-toc-hover-surface);
}
.page-toc {
  /*
    The depth ramp: each level steps down in weight, size and contrast, so nesting is legible from
    the type alone -- indentation on its own leaves every level looking like the same kind of thing.
  */
}
.page-toc-item--d0 {
  color: var(--page-toc-ink-strong);
  font-size: 0.8125rem;
  font-weight: 500;
}
.page-toc {
  /* Air above each top-level entry, which is what separates one section's block from the next */
}
.page-toc-item--d0 + .page-toc-item--d0,
.page-toc-item--d1 + .page-toc-item--d0,
.page-toc-item--d2 + .page-toc-item--d0 {
  margin-top: 7px;
}
.page-toc-item--d1 {
  color: var(--page-toc-ink);
  font-size: 0.78125rem;
  font-weight: 400;
}
.page-toc-item--d2 {
  color: var(--page-toc-ink-soft);
  font-size: 0.75rem;
  font-weight: 400;
}
.page-toc {
  /* Active beats the ramp at every depth, and keeps that depth's own weight */
}
.page-toc-item--active {
  color: var(--page-toc-active-ink);
}
.body--dark:not(.body--cobalt) .page-toc-item--active {
  color: var(--color-primary-light);
}
.page-toc-item--active {
  /*
    The row's own plate, `transparent`/`0` under Ledger and so drawing nothing there. On the link
    rather than the item, so the tint stops at the label instead of running back under a nested
    entry's indentation.
  */
}
.page-toc-item--active > .page-toc-link {
  background-color: var(--page-toc-active-surface);
  font-weight: var(--page-toc-active-weight);
}
@media (prefers-reduced-motion: reduce) {
  .page-toc-link {
    transition-duration: 0.01ms;
  }
}
</style>
