import { describe, expect, it } from 'vitest'

import { MarkdownRenderer } from './markdown'

/**
 * The block-vs-fence handoff: `block-diagram`, `block-kroki` and `block-plantuml` all read their
 * source out of a `<pre>` left behind by markdown's own fence handling — never rendered or escaped
 * away, since each block draws it client-side (Mermaid) or hands it to an image server (Kroki,
 * PlantUML). This is the one seam that is genuinely worth a unit test: it is exactly what a headless
 * re-render depends on producing byte-for-byte, and a regression here would silently blank every
 * diagram on the site without ever touching the block components themselves.
 */
describe('MarkdownRenderer fenced diagram handoff', () => {
  it.each(['mermaid', 'kroki', 'plantuml'])(
    'leaves a ```%s fence as an escaped <pre> for the block to read, not a rendered diagram',
    (lang) => {
      const md = new MarkdownRenderer({})
      const html = md.render(`\`\`\`${lang}\nA --> B\n\`\`\``)

      expect(html).toContain(`<pre class="codeblock-${lang}">`)
      expect(html).toContain('A --&gt; B')
      expect(html).not.toContain('A --> B')
    }
  )

  it.each(['mermaid', 'kroki', 'plantuml'])(
    'escapes markup written inside a ```%s fence rather than interpolating it raw',
    (lang) => {
      const md = new MarkdownRenderer({})
      const html = md.render(`\`\`\`${lang}\n<script>alert(1)</script>\n\`\`\``)

      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    }
  )

  /*
   * `lang === 'diagram'` used to be special-cased in `highlight()`: it base64-decoded the fence body
   * and interpolated the result into `<pre class="diagram">` completely unescaped. Nothing in the app
   * ever produces a ```diagram fence — the block picker's templates and every producer of a diagram
   * fence write ```mermaid / ```kroki / ```plantuml, handled above — so the branch was dead code, and
   * dead code that skips escaping is worth actively guarding against reappearing. A ```diagram fence,
   * if one is ever typed by hand, must fall through to the same escaped, generic-code treatment as any
   * other unrecognised language.
   */
  it('treats a ```diagram fence as ordinary, escaped code rather than unescaped raw HTML', () => {
    const md = new MarkdownRenderer({})
    // -> Valid base64 for "<script>alert(1)</script>": what the old branch would have decoded and
    //    interpolated unescaped had it survived
    const html = md.render('```diagram\nPHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\n```')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('class="diagram"')
    expect(html).toContain('language-diagram')
  })
})
