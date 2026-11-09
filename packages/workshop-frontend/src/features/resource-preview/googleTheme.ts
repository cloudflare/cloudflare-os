// Deliberate exception to the Kumo-tokens-only rule: these previews imitate Google's own Docs,
// Sheets and Slides UI on purpose, at the user's request, so the person deciding a change sees the
// file as they know it. Every Google product color and font lives here and nowhere else; the
// Workshop chrome around a preview (notes, empty states) still uses Kumo tokens.

/** Google's UI and document fonts, never downloaded: each falls back to what the system has. */
export const fonts = {
  ui: '"Google Sans", Roboto, Arial, sans-serif',
  text: 'Roboto, Arial, sans-serif',
  document: 'Arial, Helvetica, sans-serif',
  /** What a slide's serif or monospace font falls back to when it is not installed. */
  serif: 'Georgia, "Times New Roman", Times, serif',
  monospace: '"Courier New", Courier, monospace',
} as const

export const colors = {
  /** The app background behind the page, grid or slide. */
  canvas: '#f9fbfd',
  /** Docs' and Slides' gray work surface around a page or slide. */
  workspace: '#f0f2f5',
  page: '#ffffff',
  pageShadow: '0 1px 3px 1px rgba(60, 64, 67, 0.15), 0 1px 2px rgba(60, 64, 67, 0.3)',
  chromeBorder: '#c7c7c7',
  chromeDivider: '#e3e3e3',
  /** Placeholder lines on a page still loading. */
  loadingLine: '#f1f3f4',
  ink: '#1f1f1f',
  inkMuted: '#444746',
  inkFaint: '#747775',
  link: '#1155cc',

  /** Docs' default text color, and its table borders. */
  documentInk: '#000000',

  /** Docs' heading colors for levels 3 and below. */
  heading3: '#434343',
  heading4: '#666666',

  /** Docs' suggestion green: inserted text underlined, removed text struck. */
  suggestion: '#137333',
  suggestionTint: 'rgba(19, 115, 51, 0.08)',

  /** The focused change, in Google's selection blue. */
  focus: '#0b57d0',
  selectedTab: '#d3e3fd',
  selectedTabInk: '#0b57d0',
  badge: '#0b57d0',
  badgeInk: '#ffffff',

  /** Sheets. */
  /** The selected sheet tab, which hangs from the top of the tab bar. */
  sheetTab: '#e1e9f7',
  sheetTabInk: '#0b57d0',
  scrollbarThumb: '#dadce0',
  scrollbarTrack: '#f9fbfd',
  /** The bar below frozen rows and right of frozen columns. */
  frozenDivider: '#c4c7c5',
  gridline: '#e1e1e1',
  headerFill: '#f8f9fa',
  headerInk: '#444746',
  headerBorder: '#c4c7c5',
  changedCell: '#e8f0fe',
  changedHeader: '#d3e3fd',
  cellMarker: '#1a73e8',
  insertedTint: '#e6f4ea',
  insertedHeader: '#ceead6',
  /** Lines a change deletes, in Google's error red, as Sheets' version history marks them. */
  deletedTint: '#fce8e6',
  deletedHeader: '#fad2cf',
  deletedInk: '#a50e0e',
  formulaPending: '#80868b',

  /** Slides. */
  /**
   * The editor's surface around the filmstrip and slide, the 1px line around the slide, and the
   * ring around an unselected thumbnail, measured from a screenshot of the current editor.
   */
  slidesWorkspace: '#f8fafd',
  slideBorder: '#dadce0',
  thumbnailBorder: '#c4c7c5',
  /** Text a slide does not color, as Slides' default black. */
  slideInk: '#000000',
  imagePlaceholder: '#e8eaed',
  imagePlaceholderInk: '#9aa0a6',
  tableBorder: '#9e9e9e',
  changedElement: 'rgba(11, 87, 208, 0.55)',
} as const
