import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveAppShellLocale,
  templateAppShell,
  insertIntoAppShell,
  mergeShellFragments,
  getTemplatedAppShell,
  resetAppShellCache
} from './appShell.ts'

describe('templateAppShell', () => {
  test('sets lang and dir="ltr" for a non-RTL locale', () => {
    const html = '<!DOCTYPE html>\n<html lang="en">\n<head></head>\n<body></body>\n</html>'
    const result = templateAppShell(html, { lang: 'fr', isRTL: false })
    assert.match(result, /<html lang="fr" dir="ltr">/)
  })

  test('sets dir="rtl" for an RTL locale', () => {
    const html = '<html lang="en">\n<head></head>\n</html>'
    const result = templateAppShell(html, { lang: 'ar', isRTL: true })
    assert.match(result, /<html lang="ar" dir="rtl">/)
  })

  test('replaces whatever attributes the existing tag carries, not just lang="en"', () => {
    const html = '<html lang="en" data-theme="light" class="foo">'
    const result = templateAppShell(html, { lang: 'he', isRTL: true })
    assert.equal(result, '<html lang="he" dir="rtl">')
  })

  test('only rewrites the opening <html> tag, leaving the rest of the document untouched', () => {
    const html =
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Cardinal.js</title></head>\n<body class="wiki-root"><div id="app"></div></body>\n</html>'
    const result = templateAppShell(html, { lang: 'de', isRTL: false })
    assert.match(result, /<title>Cardinal\.js<\/title>/)
    assert.match(result, /<body class="wiki-root"><div id="app"><\/div><\/body>/)
  })

  test('returns the document unchanged if no <html> tag is present', () => {
    const html = '<!DOCTYPE html>\nnot actually html'
    const result = templateAppShell(html, { lang: 'en', isRTL: false })
    assert.equal(result, html)
  })
})

describe('resolveAppShellLocale', () => {
  const cfg = { primary: 'en', active: ['en', 'ar'], forcePrefix: false }

  test('a locale-prefixed page path resolves to its own locale', () => {
    assert.equal(resolveAppShellLocale('/ar/guides/x', undefined, cfg), 'ar')
  })

  test('an app route reads ?locale=', () => {
    assert.equal(resolveAppShellLocale('/_edit/guides/x', 'locale=ar', cfg), 'ar')
  })

  test('an invalid query locale falls back to the primary', () => {
    assert.equal(resolveAppShellLocale('/_edit/guides/x', 'locale=zz', cfg), 'en')
  })

  test('a bare path is the primary', () => {
    assert.equal(resolveAppShellLocale('/guides/x', undefined, cfg), 'en')
  })

  describe('with a locale alias', () => {
    const aliased = { primary: 'en', active: ['en', 'zh-CN'], aliases: { 'zh-CN': 'zh' } }

    test('an aliased page path resolves to the canonical code', () => {
      assert.equal(resolveAppShellLocale('/zh/page', undefined, aliased), 'zh-CN')
    })

    test('the alias matches case-insensitively', () => {
      assert.equal(resolveAppShellLocale('/ZH/page', undefined, aliased), 'zh-CN')
    })

    test('the canonical code still resolves, so the redirect to the alias can happen', () => {
      assert.equal(resolveAppShellLocale('/zh-CN/page', undefined, aliased), 'zh-CN')
    })

    test('a bare aliased prefix resolves too', () => {
      assert.equal(resolveAppShellLocale('/zh', undefined, aliased), 'zh-CN')
    })

    test('an alias for an inactive locale is not a locale prefix', () => {
      const inactive = { primary: 'en', active: ['en'], aliases: { 'zh-CN': 'zh' } }
      assert.equal(resolveAppShellLocale('/zh/page', undefined, inactive), 'en')
    })

    test('an app route reads the canonical code from ?locale=', () => {
      assert.equal(resolveAppShellLocale('/_edit/page', 'locale=zh-CN', aliased), 'zh-CN')
    })

    test('without aliases the alias segment is an ordinary path segment', () => {
      const plain = { primary: 'en', active: ['en', 'zh-CN'] }
      assert.equal(resolveAppShellLocale('/zh/page', undefined, plain), 'en')
    })
  })
})

describe('getTemplatedAppShell', () => {
  beforeEach(() => {
    resetAppShellCache()
  })

  function makeReader(initialHtml: string, initialMtimeMs: number) {
    let html = initialHtml
    let mtimeMs = initialMtimeMs
    const readFile = { calls: 0 }
    const stat = { calls: 0 }
    return {
      set: (nextHtml: string, nextMtimeMs: number) => {
        html = nextHtml
        mtimeMs = nextMtimeMs
      },
      readFile: {
        calls: readFile,
        fn: async (_path: string) => {
          readFile.calls++
          return html
        }
      },
      stat: {
        calls: stat,
        fn: async (_path: string) => {
          stat.calls++
          return { mtimeMs }
        }
      }
    }
  }

  test('a repeated (lang, isRTL) pair returns byte-identical output without re-reading the file', async () => {
    const reader = makeReader('<html lang="en">', 1000)
    let resolveCalls = 0
    const resolveIsRTL = () => {
      resolveCalls++
      return false
    }
    const first = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    const second = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(first, second)
    assert.equal(first, '<html lang="fr" dir="ltr">')
    assert.equal(reader.readFile.calls.calls, 1)
    assert.equal(resolveCalls, 1)
    // stat still runs on every call, to detect a rebuilt shell.
    assert.equal(reader.stat.calls.calls, 2)
  })

  test('a different lang gets its own cache entry', async () => {
    const reader = makeReader('<html lang="en">', 1000)
    const first = await getTemplatedAppShell('/shell.html', 'fr', () => false, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    const second = await getTemplatedAppShell('/shell.html', 'ar', () => true, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(first, '<html lang="fr" dir="ltr">')
    assert.equal(second, '<html lang="ar" dir="rtl">')
    assert.equal(reader.readFile.calls.calls, 2)
  })

  test('touching the shell file mtimeMs forces a re-template', async () => {
    const reader = makeReader('<html lang="en">', 1000)
    let resolveCalls = 0
    const resolveIsRTL = () => {
      resolveCalls++
      return false
    }
    const first = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(first, '<html lang="fr" dir="ltr">')

    reader.set('<html lang="en" data-build="2">', 2000)
    const second = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(second, '<html lang="fr" dir="ltr">')
    assert.equal(reader.readFile.calls.calls, 2)
    assert.equal(resolveCalls, 2)
  })
})

describe('insertIntoAppShell', () => {
  const shell =
    '<!DOCTYPE html>\n<html lang="en">\n<head><title>Cardinal.js</title></head>\n<body><div id="app"></div></body>\n</html>'

  test('inserts the head fragment before </head> and the body fragment before </body>', () => {
    const result = insertIntoAppShell(shell, {
      head: '<meta name="x" content="y">',
      bodyEnd: '<i>z</i>'
    })
    assert.equal(
      result,
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Cardinal.js</title><meta name="x" content="y"></head>\n<body><div id="app"></div><i>z</i></body>\n</html>'
    )
  })

  test('with nothing to insert the output is the very same string', () => {
    assert.equal(insertIntoAppShell(shell, {}), shell)
    assert.equal(insertIntoAppShell(shell, { head: '', bodyEnd: '' }), shell)
    assert.equal(insertIntoAppShell(shell, { head: undefined, bodyEnd: undefined }), shell)
  })

  test('inserts each fragment independently', () => {
    assert.equal(
      insertIntoAppShell(shell, { head: '<b></b>' }),
      shell.replace('</head>', '<b></b></head>')
    )
    assert.equal(
      insertIntoAppShell(shell, { bodyEnd: '<b></b>' }),
      shell.replace('</body>', '<b></b></body>')
    )
  })

  test('inserts fragments verbatim, including String.replace $-patterns', () => {
    const fragment = '<meta content="$& $1 $` $\' $$ $<x>">'
    const result = insertIntoAppShell(shell, { head: fragment, bodyEnd: fragment })
    assert.equal(result.split(fragment).length, 3)
    assert.equal(
      result,
      shell
        .replace('</head>', () => fragment + '</head>')
        .replace('</body>', () => fragment + '</body>')
    )
  })

  test('a closing tag inside one fragment does not redirect the other', () => {
    const head = '<script>var s = "</body>"</script>'
    const bodyEnd = '<script>var s = "</head>"</script>'
    assert.equal(
      insertIntoAppShell(shell, { head, bodyEnd }),
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Cardinal.js</title><script>var s = "</body>"</script></head>\n<body><div id="app"></div><script>var s = "</head>"</script></body>\n</html>'
    )
  })

  test('matches closing tags case-insensitively and with trailing whitespace', () => {
    const result = insertIntoAppShell('<HEAD></HEAD >\n<BODY></BODY\n></html>', {
      head: 'H',
      bodyEnd: 'B'
    })
    assert.equal(result, '<HEAD>H</HEAD >\n<BODY>B</BODY\n></html>')
  })

  test('the body fragment goes before the last </body>', () => {
    const html = '<head></head><body><script>"</body>"</script></body>'
    assert.equal(
      insertIntoAppShell(html, { bodyEnd: 'B' }),
      '<head></head><body><script>"</body>"</script>B</body>'
    )
  })

  test('a fragment whose closing tag is missing is dropped, the other still lands', () => {
    assert.equal(
      insertIntoAppShell('<html><body></body></html>', { head: 'H', bodyEnd: 'B' }),
      '<html><body>B</body></html>'
    )
    assert.equal(
      insertIntoAppShell('<html><head></head></html>', { head: 'H', bodyEnd: 'B' }),
      '<html><head>H</head></html>'
    )
  })

  test('does not touch the memoised base: repeated calls with different fragments are independent', async () => {
    resetAppShellCache()
    const deps = { readFile: async () => shell, stat: async () => ({ mtimeMs: 1 }) }
    const base = await getTemplatedAppShell('/shell.html', 'en', () => false, deps)
    const withHead = insertIntoAppShell(base, { head: '<meta name="a">' })
    const again = await getTemplatedAppShell('/shell.html', 'en', () => false, deps)
    assert.notEqual(withHead, base)
    assert.equal(again, base)
    assert.equal(insertIntoAppShell(again, {}), base)
    assert.equal(base.includes('<meta name="a">'), false)
  })
})

describe('mergeShellFragments', () => {
  test('concatenates head and bodyEnd in argument order', () => {
    assert.deepEqual(
      mergeShellFragments({ head: '<a>', bodyEnd: '1' }, { head: '<b>', bodyEnd: '2' }),
      { head: '<a><b>', bodyEnd: '12' }
    )
  })

  test('skips empty and missing parts, and returns {} when nothing is left', () => {
    assert.deepEqual(mergeShellFragments({}, { head: '' }, { bodyEnd: 'x' }), { bodyEnd: 'x' })
    assert.deepEqual(mergeShellFragments(), {})
  })

  test('one merged insertion never finds </body> inside an earlier fragment', () => {
    const merged = mergeShellFragments({ head: '<i></body></i>' }, { bodyEnd: '<b></b>' })
    const out = insertIntoAppShell('<head></head><body></body>', merged)
    assert.equal(out, '<head><i></body></i></head><body><b></b></body>')
  })
})
