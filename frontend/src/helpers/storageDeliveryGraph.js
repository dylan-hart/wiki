/**
 * The Delivery Paths diagram on `AdminStorage.vue`: what `v-network-graph` is handed for the site's
 * current set of storage targets.
 *
 * A pure function of those targets -- nothing here reads or writes component state, and the result
 * is a fresh object each call, so the page simply assigns what comes back. Extracted from the page
 * both because it was the single largest thing in it and because "which node a content type
 * actually comes from" is worth being able to assert directly (see the sibling test).
 *
 * @param {Array<object>} targets `state.targets` -- the site's storage targets, as the API lists
 *   them (module, title, icon, isEnabled, contentTypes.activeTypes, assetDelivery).
 * @param {(key: string) => string} t The page's `useI18n()` translator, for the node labels.
 * @returns {{nodes: object, edges: object, layouts: {nodes: object}, paths: Array<object>}} The four
 *   props `v-network-graph` takes.
 */
export function generateGraph(targets, t) {
  /*
    Every node icon is an SVG under `/_assets/icons/`, the same form the `user` and `pages_wiki`
    nodes below already use. These four (and `pages`/`missingOrigin` further down) were Line Awesome
    webfont glyphs -- `icon: 'las'` plus a raw codepoint rendered into a `<text class="las">` -- and
    no Line Awesome font is loaded anywhere in this app, so they drew as blank tofu boxes. See
    CLAUDE.md's Icons section: a webfont-style class name has never resolved to anything here.
  */
  const types = [
    {
      key: 'images',
      label: t('admin.storage.contentTypeImages'),
      icon: '/_assets/icons/ultraviolet-image.svg'
    },
    {
      key: 'documents',
      label: t('admin.storage.contentTypeDocuments'),
      icon: '/_assets/icons/fluent-binder.svg'
    },
    {
      key: 'others',
      label: t('admin.storage.contentTypeOthers'),
      icon: '/_assets/icons/ultraviolet-binary-file.svg'
    },
    {
      key: 'large',
      label: t('admin.storage.contentTypeLargeFiles'),
      icon: '/_assets/icons/ultraviolet-archive-folder.svg'
    }
  ]

  // -> Create PagesNodes

  const nodes = {
    user: {
      name: t('admin.storage.deliveryPathsUser'),
      borderRadius: 16,
      icon: '/_assets/icons/fluent-account.svg'
    },
    pages: {
      name: t('admin.storage.contentTypePages'),
      color: '#3f51b5',
      icon: '/_assets/icons/fluent-document-in-folder.svg'
    },
    pages_wiki: { name: 'Wiki.js', icon: '/_assets/logo-wikijs.svg', color: '#161b22' }
  }
  const edges = {
    user_pages: { source: 'user', target: 'pages' },
    pages_in: { source: 'pages', target: 'pages_wiki' },
    pages_out: { source: 'pages_wiki', target: 'pages' }
  }
  const layouts = {
    nodes: {
      user: { x: -30, y: 30 },
      pages: { x: 0, y: 0 },
      pages_wiki: { x: 60, y: 0 }
    }
  }
  const paths = []

  // -> Create Asset Nodes

  for (const [i, tp] of types.entries()) {
    nodes[tp.key] = {
      name: tp.label,
      color: '#3f51b5',
      icon: tp.icon
    }
    edges[`user_${tp.key}`] = { source: 'user', target: tp.key }
    layouts.nodes[tp.key] = { x: 0, y: (i + 1) * 15 }

    // -> Find target with direct access
    const dt = targets.find((tgt) => {
      return (
        tgt.module !== 'db' &&
        tgt.contentTypes.activeTypes.includes(tp.key) &&
        tgt.isEnabled &&
        tgt.assetDelivery.isDirectAccessSupported &&
        tgt.assetDelivery.directAccess
      )
    })

    if (dt) {
      nodes[`${tp.key}_${dt.module}`] = { name: dt.title, icon: dt.icon }
      nodes[`${tp.key}_wiki`] = {
        name: 'Wiki.js',
        icon: '/_assets/logo-wikijs.svg',
        color: '#161b22'
      }
      layouts.nodes[`${tp.key}_${dt.module}`] = { x: 60, y: (i + 1) * 15 }
      layouts.nodes[`${tp.key}_wiki`] = { x: 120, y: (i + 1) * 15 }
      edges[`${tp.key}_${dt.module}_in`] = {
        source: tp.key,
        target: `${tp.key}_${dt.module}`
      }
      edges[`${tp.key}_${dt.module}_out`] = {
        source: `${tp.key}_${dt.module}`,
        target: tp.key
      }
      edges[`${tp.key}_${dt.module}_wiki`] = {
        source: `${tp.key}_wiki`,
        target: `${tp.key}_${dt.module}`,
        color: '#02c39a',
        animationSpeed: 25
      }
      continue
    }

    // -> Find target with streaming

    const st = targets.find((tgt) => {
      return (
        tgt.module !== 'db' &&
        tgt.contentTypes.activeTypes.includes(tp.key) &&
        tgt.isEnabled &&
        tgt.assetDelivery.isStreamingSupported &&
        tgt.assetDelivery.streaming
      )
    })

    if (st) {
      nodes[`${tp.key}_${st.module}`] = { name: st.title, icon: st.icon }
      nodes[`${tp.key}_wiki`] = {
        name: 'Wiki.js',
        icon: '/_assets/logo-wikijs.svg',
        color: '#161b22'
      }
      layouts.nodes[`${tp.key}_${st.module}`] = { x: 120, y: (i + 1) * 15 }
      layouts.nodes[`${tp.key}_wiki`] = { x: 60, y: (i + 1) * 15 }
      edges[`${tp.key}_wiki_in`] = { source: tp.key, target: `${tp.key}_wiki` }
      edges[`${tp.key}_wiki_out`] = { source: `${tp.key}_wiki`, target: tp.key }
      edges[`${tp.key}_${st.module}_out`] = {
        source: `${tp.key}_${st.module}`,
        target: `${tp.key}_wiki`
      }
      edges[`${tp.key}_${st.module}_in`] = {
        source: `${tp.key}_wiki`,
        target: `${tp.key}_${st.module}`
      }
      edges[`${tp.key}_${st.module}_wiki`] = {
        source: `${tp.key}_wiki`,
        target: `${tp.key}_${st.module}`,
        color: '#02c39a',
        animationSpeed: 25
      }
      continue
    }

    // -> Check DB fallback

    const dbt = targets.find((tgt) => tgt.module === 'db')
    if (dbt?.contentTypes?.activeTypes?.includes(tp.key)) {
      nodes[`${tp.key}_wiki`] = {
        name: 'Wiki.js',
        icon: '/_assets/logo-wikijs.svg',
        color: '#161b22'
      }
      layouts.nodes[`${tp.key}_wiki`] = { x: 60, y: (i + 1) * 15 }
      edges[`${tp.key}_db_in`] = { source: tp.key, target: `${tp.key}_wiki` }
      edges[`${tp.key}_db_out`] = { source: `${tp.key}_wiki`, target: tp.key }
    } else {
      nodes[`${tp.key}_wiki`] = {
        name: t('admin.storage.missingOrigin'),
        color: '#f03a47',
        icon: '/_assets/icons/fluent-unavailable.svg'
      }
      layouts.nodes[`${tp.key}_wiki`] = { x: 60, y: (i + 1) * 15 }
      edges[`${tp.key}_db_in`] = {
        source: tp.key,
        target: `${tp.key}_wiki`,
        color: '#f03a47',
        animate: false
      }
      paths.push({ edges: [`${tp.key}_db_in`], color: '#f03a4755' })
    }
  }

  return { nodes, edges, layouts, paths }
}
