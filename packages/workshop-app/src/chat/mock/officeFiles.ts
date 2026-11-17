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
