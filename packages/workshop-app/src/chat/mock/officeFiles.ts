import { buildDeck, buildDocx, buildXlsx, drawnShape, escapeXml, paragraph, run, transform } from '@gadgets/office-content/test-fixtures'

/** Made once, when first fetched: building a package compresses it, which is asynchronous. */
const once = (build: () => Promise<Uint8Array>) => {
  let built: Promise<Uint8Array> | undefined
  return () => (built ??= build())
}

const cell = (ref: string, value: string | number) =>
  typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`
const row = (index: number, values: Array<string | number>) =>
  `<row r="${index}">${values.map((value, column) => cell(`${String.fromCharCode(65 + column)}${index}`, value)).join('')}</row>`

/** A short Word document: a title, a paragraph and a list's worth of points. */
export const Q3_PLAN_DOCX = once(() => buildDocx({
  body: [
    paragraph(run('Q3 platform plan', '<w:b/><w:sz w:val="40"/>')),
    paragraph(run('Three things to land before the end of the quarter, in order of how much they unblock.')),
    paragraph(run('1. Twelve weeks of tickets on the dashboard.')),
    paragraph(run('2. Error rates beside deploys.')),
    paragraph(run('3. A weekly digest for the platform channel.')),
  ].join(''),
}))

// 16:9, in EMU, and a text box placed on it: the deck's shapes say where they go.
const WIDE = { cx: 12192000, cy: 6858000 }
/** A line of slide text, `size` in hundredths of a point, in `color` (hex) when given. */
const line = (text: string, size: number, { bold = false, color }: { bold?: boolean; color?: string } = {}) =>
  `<a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''}>${color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : ''}</a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`
const box = (y: number, height: number, body: string) => drawnShape({
  properties: transform(838200, y, 10515600, height),
  body,
})

/** A two-slide deck: a title slide on a dark band, then the plan's points. */
export const ROADMAP_PPTX = once(() => buildDeck({
  size: WIDE,
  slides: [
    {
      background: '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F2A44"/></a:solidFill></p:bgPr></p:bg>',
      shapes: box(2400000, 1200000, line('Platform roadmap', 5400, { bold: true, color: 'FFFFFF' })) + box(3700000, 700000, line('Q3 review', 2800, { color: 'F6821F' })),
    },
    {
      shapes: box(500000, 1000000, line('This quarter', 4000, { bold: true }))
        + box(1800000, 3500000, ['Twelve weeks of tickets on the dashboard', 'Error rates beside deploys', 'A weekly digest'].map((point) => line(`•  ${point}`, 2400)).join('')),
    },
  ],
}))

/** A workbook of two sheets: the budget by month, and the people on it. */
export const BUDGET_XLSX = once(() => buildXlsx({
  sheets: [
    { name: 'Budget', rows: [row(1, ['Month', 'Planned', 'Spent']), row(2, ['July', 12000, 11400]), row(3, ['August', 12000, 12950]), row(4, ['September', 14000, 9800])].join('') },
    { name: 'Team', rows: [row(1, ['Name', 'Role']), row(2, ['Ada', 'Lead']), row(3, ['Lin', 'Platform'])].join('') },
  ],
}))

// Text as a PDF string: its brackets and backslashes escaped.
const pdfString = (text: string) => `(${text.replace(/[\\()]/g, (character) => `\\${character}`)})`

/**
 * A PDF of US Letter pages, each a heading and lines of Helvetica, and a link to the web under the
 * first page's text where one is given, with the offsets a reader looks its parts up by.
 */
const buildPdf = (pages: ReadonlyArray<{ heading: string; lines: readonly string[] }>, link?: { text: string; url: string }) => {
  // The catalog, the page tree and the font first; then each page, its contents and its link.
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids: number[] = []
  pages.forEach(({ heading, lines }, index) => {
    const pageId = objects.length + 1
    kids.push(pageId)
    const linkY = 680 - lines.length * 20 - 20
    const linked = index === 0 && link
    const text = [
      `BT /F1 22 Tf 72 720 Td ${pdfString(heading)} Tj ET`,
      ...lines.map((said, at) => `BT /F1 12 Tf 72 ${680 - at * 20} Td ${pdfString(said)} Tj ET`),
      ...(linked ? [`0 0.3 0.8 rg BT /F1 12 Tf 72 ${linkY} Td ${pdfString(link.text)} Tj ET`] : []),
    ].join('\n')
    const annots = linked ? ` /Annots [${pageId + 2} 0 R]` : ''
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >>${annots} >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
    if (linked) {
      objects.push(`<< /Type /Annot /Subtype /Link /Rect [70 ${linkY - 4} ${76 + link.text.length * 5.6} ${linkY + 12}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(link.url)} >> >>`)
    }
  })
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = body.length
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

/** A three-page review: what happened, what is next, and who to ask, with a link to its dashboard. */
export const Q2_REVIEW_PDF = buildPdf([
  { heading: 'Q2 platform review', lines: ['Ticket volume fell 12% on the quarter before.', 'Median time to close: 3.2 days, down from 4.1.', 'Two incidents, both resolved inside an hour.'] },
  { heading: 'Next quarter', lines: ['Move the on-call rota to the new scheduler.', 'Retire the legacy export job by August.', 'Keep the dashboard on the weekly agenda.'] },
  { heading: 'Who to ask', lines: ['Platform: #platform-help', 'Billing: #billing-oncall', 'Anything else: the team lead.'] },
], { text: 'Open the platform dashboard', url: 'https://dash.cloudflare.com/' })
