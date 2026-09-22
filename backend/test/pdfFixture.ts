export function buildTextPdf(pages: string[], options: { encrypted?: boolean } = {}): Buffer {
  const objects: string[] = []
  const pageCount = pages.length
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  const fontId = 3 + pageCount * 2

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`
  pages.forEach((text, i) => {
    const pageId = 3 + i * 2
    const contentId = pageId + 1
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const encryptId = fontId + 1
  if (options.encrypted) {
    const zeros = '0'.repeat(64)
    objects[encryptId] = `<< /Filter /Standard /V 1 /R 2 /O <${zeros}> /U <${zeros}> /P -4 >>`
  }

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefAt = body.length
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R${options.encrypted ? ` /Encrypt ${encryptId} 0 R /ID [<00> <00>]` : ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
