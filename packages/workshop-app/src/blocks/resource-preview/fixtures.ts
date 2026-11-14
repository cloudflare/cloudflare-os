import type { ResourcePreview, SpreadsheetCellFormat } from '@gadgets/workshop-shared/gatekeeper'

// Realistic previews for tests and visual checks: what the Google gatekeeper draws for a few
// queued actions, numbered as Overseer.previewResource() numbers them (ActionLogEntry ids).

const launchPlan = `# Aurora Launch Plan

Owner: [Maya Chen](https://example.com/people/maya) · Last updated October 14

## Summary

Aurora is the new onboarding flow for small teams. This plan covers the beta, the public launch, and the first month after it.

## Milestones

1. Private beta opens to 40 design partners
2. Public launch on **November 18**
3. First retrospective two weeks after launch

## Owners

| Area | Owner | Status |
| --- | --- | --- |
| Product | Maya Chen | On track |
| Marketing | Priya Natarajan | Approved |
| Support | Daniel Ortiz | Not started |

## Risks

- Support staffing over the holiday period
- Pricing page copy still needs legal review
- Localization for German and Japanese

Questions go to the #aurora-launch channel.
`

export const documentFixture: ResourcePreview = {
  title: 'Aurora Launch Plan',
  url: 'https://docs.google.com/document/d/1AuroraLaunchPlan/edit',
  actions: [101, 102, 103],
  content: {
    type: 'document',
    tabs: [
      {
        id: 't.0',
        title: 'Plan',
        markdown: launchPlan,
        edits: [
          { change: 0, before: 'Public launch on **October 28**', after: 'Public launch on **November 18**' },
          { change: 1, before: '| Marketing | Priya Natarajan | In review |', after: '| Marketing | Priya Natarajan | Approved |' },
          { change: 2, before: '- Pricing page copy still needs legal review', after: '- Pricing page copy still needs legal review\n- Localization for German and Japanese' },
        ],
      },
      { id: 't.1', title: 'Launch notes', markdown: '# Launch notes\n\nNothing here yet.\n', edits: [] },
    ],
  },
}

const header = {
  bold: true,
  backgroundColor: '#f3f3f3',
  borders: { bottom: { style: 'medium', color: '#000000' } },
} satisfies SpreadsheetCellFormat
const total = { bold: true, borders: { top: { style: 'solid', color: '#000000' }, bottom: { style: 'double', color: '#000000' } } } satisfies SpreadsheetCellFormat
// Literal amounts, which Sheets right-aligns.
const money = (text: string) => ({ text, format: { horizontalAlignment: 'right' as const } })

export const spreadsheetFixture: ResourcePreview = {
  title: 'FY26 Team Budget',
  url: 'https://docs.google.com/spreadsheets/d/1TeamBudget/edit',
  actions: [201, 202, 203, 204, 205],
  content: {
    type: 'spreadsheet',
    sheets: [
      { id: 0, title: 'Budget', frozenRows: 1, frozenColumns: 1 },
      { id: 1288, title: 'Headcount' },
      { id: 90210, title: 'Q3 Forecast', status: 'added' },
      { id: 55, title: 'Old drafts', status: 'removed' },
    ],
    areas: [
      {
        sheetId: 0,
        row: 0,
        column: 0,
        columnWidths: [160, 110, 110, 110, 100],
        rowHeights: [28, 21, 21, 21, 21, 21],
        cells: [
          [
            { text: 'Category', format: { ...header, verticalAlignment: 'middle' } },
            { text: 'Q1', format: { ...header, verticalAlignment: 'middle', horizontalAlignment: 'right' } },
            { text: 'Q2', format: { ...header, verticalAlignment: 'middle', horizontalAlignment: 'right' } },
            { text: 'Q3', format: { ...header, verticalAlignment: 'middle', horizontalAlignment: 'right' } },
            { text: 'Notes', format: { ...header, verticalAlignment: 'middle' } },
          ],
          [{ text: 'Salaries' }, money('$182,000'), money('$182,000'), { ...money('$194,500'), change: 0, previous: '$188,000' }, null],
          [{ text: 'Contractors' }, money('$24,000'), money('$18,000'), money('$12,000'), { text: 'Ends Aug 31', change: 1, format: { italic: true, textColor: '#5f6368' } }],
          [{ text: 'Software' }, money('$9,400'), money('$9,400'), money('$10,250'), null],
          [{ text: 'Travel' }, money('$6,000'), money('$4,500'), { ...money('$7,800'), change: 1, previous: '$3,000' }, { text: 'Offsite in Lisbon', change: 1 }],
          [{ text: 'Training' }, money('$2,000'), money('$2,000'), money('$2,000'), null],
        ],
        insertedRows: [],
      },
      {
        sheetId: 0,
        row: 18,
        column: 0,
        columnWidths: [160, 110, 110, 110, 100],
        cells: [
          [{ text: 'Total', format: total }, { text: '$223,400', format: { ...total, horizontalAlignment: 'right' } }, { text: '$215,900', format: { ...total, horizontalAlignment: 'right' } }, { formula: '=SUM(D2:D7)', change: 2, previous: '$218,850', format: total }, { format: total }],
          [{ text: 'Budget cap' }, { text: '$230,000' }, { text: '$230,000' }, { text: '$230,000' }, null],
          [{ text: 'Over cap?', format: { textColor: '#cc0000' } }, { text: 'FALSE' }, { text: 'FALSE' }, { formula: '=D19>D20', change: 3 }, { text: 'Flag for review', change: 3 }],
        ],
        insertedRows: [2],
      },
      {
        sheetId: 90210,
        row: 0,
        column: 0,
        columnWidths: [160, 120, 120],
        cells: [
          [{ text: 'Line item', change: 4, format: { bold: true } }, { text: 'Forecast', change: 4, format: { bold: true } }, { text: 'Confidence', change: 4, format: { bold: true } }],
          [{ text: 'Salaries', change: 4 }, { text: '$194,500', change: 4 }, { text: 'High', change: 4 }],
          [{ text: 'Travel', change: 4 }, { text: '$7,800', change: 4 }, { text: 'Medium', change: 4 }],
        ],
      },
      {
        sheetId: 1288,
        row: 2,
        column: 1,
        columnWidths: [120, 80],
        merges: [{ row: 0, column: 0, rows: 1, columns: 2 }],
        hiddenRows: [2],
        cells: [
          [{ text: 'Team size', format: { bold: true, horizontalAlignment: 'center', backgroundColor: '#d9ead3' } }, null],
          [{ text: 'Engineering' }, { text: '12', format: { horizontalAlignment: 'right' } }],
          [{ text: 'Interns' }, { text: '2', format: { horizontalAlignment: 'right' } }],
          [{ text: 'Design' }, { text: '3', format: { horizontalAlignment: 'right' } }],
        ],
      },
    ],
  },
}

const W = 720
const H = 405

// A deck in a themed look like one of Slides' own: a navy title slide, then white slides with
// Montserrat titles and Open Sans body text, each as the gatekeeper resolves it from the layout.
const NAVY = '#0b2545'
const ACCENT = '#1a73e8'
const BODY = '#3c4043'

const title = (id: string, text: string, change?: number) => ({
  id, kind: 'shape' as const, x: 36, y: 22, width: W - 72, height: 58, change, verticalAlign: 'bottom' as const,
  text: [{ runs: [{ text, fontSize: 28, bold: true, fontFamily: 'Montserrat', color: NAVY }] }],
})

const bullets = (id: string, lines: string[], width = 400) => ({
  id, kind: 'shape' as const, x: 36, y: 96, width, height: 270,
  text: lines.map(line => {
    const nested = line.startsWith('  ')
    return {
      bullet: { glyph: nested ? '○' : '●', fontSize: 16, fontFamily: 'Open Sans', color: nested ? BODY : ACCENT },
      indentStart: nested ? 54 : 27, indentFirstLine: nested ? 36 : 9, lineSpacing: 115, spaceBelow: 6,
      runs: [{ text: line.trim(), fontSize: nested ? 14 : 16, fontFamily: 'Open Sans', color: BODY }],
    }
  }),
})

const accentBar = (id: string) => ({ id, kind: 'shape' as const, x: 36, y: 84, width: 48, height: 4, fill: ACCENT })

const photo = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ec5fc"/><stop offset="1" stop-color="#e0c3fc"/></linearGradient></defs><rect width="480" height="320" fill="url(#s)"/><circle cx="360" cy="80" r="34" fill="#fff4c2"/><path d="M0 250 L90 160 L160 210 L250 120 L340 200 L420 150 L480 190 L480 320 L0 320Z" fill="#3f6e8c"/><path d="M0 280 L110 220 L200 260 L300 200 L400 250 L480 230 L480 320 L0 320Z" fill="#24485e"/><rect x="200" y="236" width="60" height="44" fill="#f4f1ea"/><path d="M194 238 L230 212 L266 238Z" fill="#b5523b"/></svg>',
)

const cell = (text: string, style: { bold?: boolean; color?: string } = {}) => ({
  text: [{ runs: [{ text, fontSize: 12, fontFamily: 'Open Sans', color: BODY, ...style }] }],
})
const headerCell = (text: string) => ({ ...cell(text, { bold: true, color: '#ffffff' }), fill: NAVY, verticalAlign: 'middle' as const })
const rule = { color: '#c4c7c5', weight: 1 }

export const presentationFixture: ResourcePreview = {
  title: 'Aurora Launch Review',
  url: 'https://docs.google.com/presentation/d/1AuroraDeck/edit',
  actions: [301, 302, 303],
  content: {
    type: 'presentation',
    width: W,
    height: H,
    slides: [
      {
        id: 'p1',
        changes: [0],
        background: NAVY,
        elements: [
          { id: 'p1-band', kind: 'shape', geometry: 'RIGHT_TRIANGLE', x: W - 260, y: H - 150, width: 260, height: 150, fill: '#13315c', flipped: true, rotation: 180 },
          { id: 'p1-dot', kind: 'shape', geometry: 'ELLIPSE', x: W - 112, y: 40, width: 64, height: 64, fill: '#1a73e899' },
          {
            id: 'p1-title', kind: 'shape', x: 54, y: 120, width: 520, height: 100, change: 0, verticalAlign: 'bottom',
            text: [{ runs: [{ text: 'Aurora launches November 18', fontSize: 40, bold: true, fontFamily: 'Montserrat', color: '#ffffff' }], lineSpacing: 90 }],
          },
          { id: 'p1-rule', kind: 'line', x: 61, y: 236, width: 96, height: 0, outline: { color: '#8ab4f8', weight: 3 } },
          {
            id: 'p1-sub', kind: 'shape', x: 54, y: 248, width: 520, height: 40,
            text: [{ runs: [{ text: 'Launch review · Product, Marketing and Support', fontSize: 16, fontFamily: 'Open Sans', color: '#c6dafc' }] }],
          },
        ],
      },
      {
        id: 'p2',
        changes: [],
        background: '#ffffff',
        elements: [
          title('p2-title', 'Where we are'),
          accentBar('p2-bar'),
          bullets('p2-body', ['40 design partners in private beta', '  Weekly feedback sessions', 'Activation up 18% over the old flow', 'Support docs drafted'], 380),
          {
            id: 'p2-img', kind: 'image', x: 440, y: 100, width: 244, height: 160, image: photo,
            crop: { left: 0.08, top: 0.12, right: 0.06, bottom: 0.04 }, outline: { color: '#ffffff', weight: 4 },
            shadow: { color: '#0000004d', x: 0, y: 2, blur: 6 },
          },
          {
            id: 'p2-callout', kind: 'shape', geometry: 'WEDGE_ROUND_RECTANGLE_CALLOUT', x: 456, y: 286, width: 212, height: 64,
            fill: '#e8f0fe', outline: { color: ACCENT, weight: 1 }, verticalAlign: 'middle',
            text: [{ align: 'center', runs: [{ text: '“Setup took ', fontSize: 13, fontFamily: 'Open Sans', italic: true, color: NAVY }, { text: 'four minutes', fontSize: 13, fontFamily: 'Open Sans', italic: true, bold: true, color: NAVY }, { text: '”', fontSize: 13, fontFamily: 'Open Sans', italic: true, color: NAVY }] }],
          },
        ],
      },
      {
        id: 'p3',
        changes: [],
        background: '#ffffff',
        elements: [
          title('p3-title', 'Owners'),
          accentBar('p3-bar'),
          {
            id: 'p3-table', kind: 'table', x: 36, y: 112, width: 648, height: 160,
            table: {
              columns: [180, 228, 240],
              rows: [36, 31, 31, 31, 31],
              cells: [
                [headerCell('Area'), headerCell('Owner'), headerCell('Status')],
                [cell('Product'), cell('Maya Chen'), { ...cell('On track', { color: '#188038', bold: true }), fill: '#e6f4ea' }],
                [cell('Marketing'), cell('Priya Natarajan'), { ...cell('Approved', { color: '#188038', bold: true }), fill: '#e6f4ea' }],
                [cell('Support'), cell('Daniel Ortiz'), { ...cell('Not started', { color: '#c5221f', bold: true }), fill: '#fce8e6' }],
                [{ ...cell('Legal review of pricing copy is shared by all three teams'), columnSpan: 3 }, null, null],
              ],
              horizontalBorders: [[null, null, null], [rule, rule, rule], [rule, rule, rule], [rule, rule, rule], [rule, rule, rule], [{ color: NAVY, weight: 2 }, { color: NAVY, weight: 2 }, { color: NAVY, weight: 2 }]],
              verticalBorders: Array.from({ length: 5 }, () => [null, null, null, null]),
            },
          },
        ],
      },
      {
        id: 'p-new',
        changes: [1],
        status: 'added',
        background: '#ffffff',
        elements: [
          { ...title('pn-title', 'Launch-day checklist'), change: 1 },
          accentBar('pn-bar'),
          { ...bullets('pn-body', ['Flip the feature flag at 9:00 PT', 'Publish the blog post and changelog', 'Staff the support queue until 18:00', '  Escalations go to Daniel']), change: 1 },
          { id: 'pn-arrow', kind: 'line', x: 452, y: 190, width: 52, height: 0, outline: { color: ACCENT, weight: 2, dash: 'dash' }, endArrow: 'fillArrow', change: 1 },
          {
            id: 'pn-badge', kind: 'shape', geometry: 'ROUND_RECTANGLE', x: 512, y: 140, width: 172, height: 100, fill: '#e6f4ea', outline: { color: '#188038', weight: 1.5 },
            verticalAlign: 'middle', change: 1,
            text: [
              { align: 'center', runs: [{ text: 'Go / no-go', fontSize: 20, bold: true, fontFamily: 'Montserrat', color: '#137333' }] },
              { align: 'center', spaceAbove: 4, runs: [{ text: 'Nov 17, 16:00', fontSize: 13, fontFamily: 'Open Sans', color: '#137333' }] },
            ],
          },
        ],
      },
      {
        id: 'p5',
        changes: [],
        background: '#ffffff',
        elements: [
          title('p5-title', 'Risks'),
          accentBar('p5-bar'),
          bullets('p5-body', ['Support staffing over the holidays', 'Pricing copy needs legal review', 'Localization for German and Japanese'], 380),
          { id: 'p5-img', kind: 'image', x: 456, y: 110, width: 228, height: 160 },
        ],
      },
      {
        id: 'p6',
        changes: [2],
        status: 'removed',
        background: '#ffffff',
        elements: [
          title('p6-title', 'Appendix: old timeline'),
          accentBar('p6-bar'),
          bullets('p6-body', ['Beta in September', 'Launch October 28']),
        ],
      },
    ],
  },
}
