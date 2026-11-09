import type { CSSProperties, ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Image as ImageIcon } from '@phosphor-icons/react'
import type { DocumentPreview } from '@gadgets/workshop-shared/gatekeeper'
import { safeExternalUrl } from '../../utils/safeExternalUrl'
import { changeAttributes, changeLabel, changeState, focusRing, inlineChangeProps, isAttributed, isFocused, type ChangeMarks } from './changeMarks'
import { placeEdits, rehypeChangeMarks, type UnplacedEdit } from './documentMarking'
import { colors, fonts } from './googleTheme'
import { OVERLAY_CLEARANCE, PreviewOverlay } from './PreviewOverlay'
import { useElementSize } from './useElementSize'
import { useRovingTabs, useSelectionFollowingFocus } from './useRovingTabs'

// US Letter at 96dpi with Docs' default one-inch margins.
const PAGE_WIDTH = 816
const PAGE_HEIGHT = 1056
const PAGE_MARGIN = 96
const GUTTER = 16
const PAGELESS_BELOW = 0.7

const pt = (points: number) => `${points}pt`

// Docs' default paragraph styles: Normal text is Arial 11pt at 1.15 line spacing.
const HEADING: Record<1 | 2 | 3 | 4 | 5 | 6, CSSProperties> = {
  1: { fontSize: pt(20), margin: `${pt(20)} 0 ${pt(6)}`, fontWeight: 400 },
  2: { fontSize: pt(16), margin: `${pt(18)} 0 ${pt(6)}`, fontWeight: 400 },
  3: { fontSize: pt(14), margin: `${pt(16)} 0 ${pt(4)}`, fontWeight: 400, color: colors.heading3 },
  4: { fontSize: pt(12), margin: `${pt(14)} 0 ${pt(4)}`, fontWeight: 400, color: colors.heading4 },
  5: { fontSize: pt(11), margin: `${pt(12)} 0 ${pt(4)}`, fontWeight: 400, color: colors.heading4 },
  6: { fontSize: pt(11), margin: `${pt(12)} 0 ${pt(4)}`, fontWeight: 400, color: colors.heading4, fontStyle: 'italic' },
}

const cell: CSSProperties = { border: `1px solid ${colors.documentInk}`, padding: `${pt(5)} ${pt(5)}`, verticalAlign: 'top', textAlign: 'left' }

const markStyle = (tag: 'ins' | 'del', state: ReturnType<typeof changeState>): CSSProperties => {
  // Each line of a wrapped mark draws its own edges, so a highlight is even on every line rather
  // than open where the line breaks.
  const base: CSSProperties = {
    cursor: 'pointer', textDecorationThickness: 1, textUnderlineOffset: 2,
    boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone',
  }
  if (state === 'pending') {
    // New text is told by its colour and tint alone: an underline would read as the edit's own
    // formatting, which may be to underline something.
    return tag === 'ins'
      ? { ...base, color: colors.suggestion, textDecorationLine: 'none', background: colors.suggestionTint }
      : { ...base, color: colors.suggestion, textDecorationLine: 'line-through' }
  }
  if (state === 'approved') {
    return tag === 'ins'
      ? { ...base, color: 'inherit', textDecorationLine: 'none' }
      : { ...base, color: colors.inkFaint, textDecorationLine: 'line-through' }
  }
  // Rejected: the old text returns as the page's own, and the new text is struck and faded.
  return tag === 'ins'
    ? { ...base, color: colors.inkFaint, textDecorationLine: 'line-through', opacity: 0.55 }
    : { ...base, color: 'inherit', textDecorationLine: 'none' }
}

const components = (marks: ChangeMarks): Components => {
  const changeMark = (tag: 'ins' | 'del') => ({ children, node: _node, ...rest }: { children?: ReactNode; node?: unknown }) => {
    const attributes = rest as Record<string, unknown>
    const changeId = Number(attributes['data-change-id'])
    // Strikethrough from the document's own Markdown (`~~text~~`) is a plain <del>.
    if (!Number.isInteger(changeId)) return tag === 'ins' ? <ins>{children}</ins> : <del>{children}</del>
    const label = typeof attributes['data-change-label'] === 'string' ? attributes['data-change-label'] : null
    const state = changeState(marks, changeId)
    // Approved, removed text is gone, unless it is all the change shows and so its only handle.
    if (tag === 'del' && state === 'approved' && label === null) return null
    const Tag = tag
    return (
      <Tag
        {...inlineChangeProps(marks, changeId, label)}
        style={{
          ...markStyle(tag, state),
          ...(tag === 'del' ? { marginRight: '0.25em' } : {}),
          // An edit's pieces are separate inline boxes, so the focused one is highlighted as Docs
          // highlights a selected suggestion, a ring per piece reading as several changes.
          ...(isFocused(marks, changeId) ? { background: colors.selectedTab, boxShadow: `0 0 0 2px ${colors.selectedTab}`, borderRadius: 1 } : {}),
        }}
      >
        {children}
      </Tag>
    )
  }
  return {
    h1: ({ children }) => <h1 style={HEADING[1]}>{children}</h1>,
    h2: ({ children }) => <h2 style={HEADING[2]}>{children}</h2>,
    h3: ({ children }) => <h3 style={HEADING[3]}>{children}</h3>,
    h4: ({ children }) => <h4 style={HEADING[4]}>{children}</h4>,
    h5: ({ children }) => <h5 style={HEADING[5]}>{children}</h5>,
    h6: ({ children }) => <h6 style={HEADING[6]}>{children}</h6>,
    p: ({ children }) => <p style={{ margin: `0 0 ${pt(10)}` }}>{children}</p>,
    ul: ({ children }) => <ul style={{ margin: `0 0 ${pt(10)}`, paddingLeft: pt(36), listStyleType: 'disc' }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: `0 0 ${pt(10)}`, paddingLeft: pt(36), listStyleType: 'decimal' }}>{children}</ol>,
    li: ({ children }) => <li style={{ margin: 0, paddingLeft: pt(4) }}>{children}</li>,
    blockquote: ({ children }) => <blockquote style={{ margin: `0 0 ${pt(10)}`, paddingLeft: pt(36) }}>{children}</blockquote>,
    table: ({ children }) => <table style={{ borderCollapse: 'collapse', width: '100%', margin: `0 0 ${pt(10)}` }}>{children}</table>,
    th: ({ children }) => <th style={{ ...cell, fontWeight: 700 }}>{children}</th>,
    td: ({ children }) => <td style={cell}>{children}</td>,
    hr: () => <hr style={{ border: 0, borderTop: `1px solid ${colors.chromeBorder}`, margin: `${pt(10)} 0` }} />,
    pre: ({ children }) => (
      <pre style={{ fontFamily: '"Roboto Mono", "Courier New", monospace', fontSize: pt(10), background: colors.headerFill, padding: pt(8), margin: `0 0 ${pt(10)}`, whiteSpace: 'pre-wrap' }}>
        {children}
      </pre>
    ),
    code: ({ children }) => <code style={{ fontFamily: '"Roboto Mono", "Courier New", monospace' }}>{children}</code>,
    // Links are drawn as Docs draws them, but not followed: this is a preview of the file, not it.
    a: ({ children, href }) => (
      <span style={{ color: colors.link, textDecoration: 'underline' }} title={safeExternalUrl(href)}>{children}</span>
    ),
    // Never loaded: an image the file names could be anywhere, and fetching it would leak the view.
    img: ({ alt }) => (
      <span
        role="img"
        aria-label={alt || 'Image'}
        className="inline-flex items-center gap-1 align-middle"
        style={{ background: colors.imagePlaceholder, color: colors.imagePlaceholderInk, padding: '2px 6px', fontSize: pt(9) }}
      >
        <ImageIcon size={12} aria-hidden="true" />{alt || 'Image'}
      </span>
    ),
    ins: changeMark('ins'),
    del: changeMark('del'),
  }
}

const REASON: Record<UnplacedEdit['reason'], string> = {
  'not-found': 'Can’t show where this lands: a later change rewrote it.',
  ambiguous: 'Can’t show where this lands: the text appears more than once.',
  deletion: 'Removes text.',
  overlap: 'Can’t show where this lands: a later change overlaps it.',
  'no-text': 'Changes layout or formatting only.',
}

const UnplacedNote = ({ edit, marks }: { edit: UnplacedEdit; marks: ChangeMarks }) => {
  const state = changeState(marks, edit.changeId)
  const text = edit.after || edit.before
  const Tag = isAttributed(edit.changeId) ? 'button' : 'div'
  return (
    <Tag
      {...(Tag === 'button' ? { type: 'button', 'aria-label': changeLabel(text, edit.after ? undefined : 'remove') } : {})}
      {...changeAttributes(marks, edit.changeId)}
      className="block w-full rounded-md border border-kumo-line bg-kumo-tint px-3 py-1.5 text-left text-xs text-kumo-subtle"
      style={{ fontFamily: fonts.ui, ...focusRing(isFocused(marks, edit.changeId)), ...(state === 'rejected' ? { opacity: 0.6 } : {}) }}
    >
      <span className="block">{REASON[edit.reason]}</span>
      <span
        className={`mt-0.5 block truncate text-kumo-default ${edit.after ? '' : 'line-through'} ${state === 'rejected' ? 'line-through' : ''}`}
      >
        {text}
      </span>
    </Tag>
  )
}

// Where a page's first lines will be: a title, then paragraphs, at Normal text's line height.
const LoadingLines = () => (
  <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
    <div style={{ height: pt(20), width: '55%', marginBottom: pt(14), borderRadius: 4, background: colors.loadingLine }} />
    {[100, 96, 100, 88, 62, 0, 100, 93, 97, 70].map((width, index) => (
      <div key={index} style={{ height: pt(8), width: `${width}%`, margin: `${pt(3.5)} 0 ${pt(4.5)}`, borderRadius: 3, background: colors.loadingLine }} />
    ))}
  </div>
)

/** A Google Doc as it will be: the active tab on a Letter page, each placed edit as a suggestion. */
export const DocumentPreviewView = ({ title, content, actions, marks, overlay, loading = false }: {
  title: string
  /** Floated over the bottom of the main area: the file's review controls. */
  overlay?: ReactNode
  /** Draw the page with placeholder lines: the document is still loading. */
  loading?: boolean
  content: DocumentPreview
  actions: readonly number[]
  marks: ChangeMarks
}) => {
  const tabs = content.tabs
  const [selected, setSelected] = useSelectionFollowingFocus(0, marks.focusedChangeId, changeId => {
    const index = tabs.findIndex(tab => tab.edits.some(edit => actions[edit.change] === changeId))
    return index === -1 ? undefined : index
  })
  const tabProps = useRovingTabs({ count: tabs.length, selected, onSelect: setSelected })
  const [scrollRef, size] = useElementSize<HTMLDivElement>()
  const tab = tabs[Math.min(selected, tabs.length - 1)]
  const fit = !size?.width ? 1 : (size.width - 2 * GUTTER) / PAGE_WIDTH
  // Shrunk much further, a page's text is too small to read; Docs' own answer is pageless format.
  const pageless = fit < PAGELESS_BELOW
  const zoom = Math.min(1, fit)

  const { placed, unplaced } = tab ? placeEdits(tab.markdown, tab.edits, actions) : { placed: [], unplaced: [] }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: colors.canvas }}>
      {tabs.length > 1 && (
        <div className="flex shrink-0 px-4 py-2" style={{ borderBottom: `1px solid ${colors.chromeDivider}` }}>
          <div role="tablist" aria-label="Document tabs" className="flex flex-wrap gap-1.5">
            {tabs.map((t, index) => (
              <button
                key={t.id}
                type="button"
                {...tabProps(index)}
                className="rounded-full px-3 py-0.5 text-[13px] leading-5 focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{
                  fontFamily: fonts.ui,
                  background: index === selected ? colors.selectedTab : 'transparent',
                  color: index === selected ? colors.selectedTabInk : colors.inkMuted,
                  border: `1px solid ${index === selected ? colors.selectedTab : colors.chromeBorder}`,
                  outlineColor: colors.focus,
                }}
              >
                {t.title}
                {t.edits.length > 0 && <span aria-label=", changed" className="ml-1.5 inline-block size-1.5 rounded-full align-middle" style={{ background: colors.suggestion }} />}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} data-preview-scroll role={tabs.length > 1 ? 'tabpanel' : undefined} className="min-h-0 flex-1 overflow-auto" style={{ padding: `${pageless ? 0 : GUTTER}px 0 ${overlay ? OVERLAY_CLEARANCE : GUTTER}px`, background: pageless ? colors.page : undefined }}>
        {tab && (
          <article
            aria-label={`${title}${tabs.length > 1 ? `, ${tab.title}` : ''}`}
            className="mx-auto"
            style={{
              ...(pageless
                ? { width: '100%', padding: `${GUTTER}px ${2 * GUTTER}px` }
                : { zoom, width: PAGE_WIDTH, minHeight: PAGE_HEIGHT, padding: PAGE_MARGIN, boxShadow: colors.pageShadow }),
              background: colors.page,
              fontFamily: fonts.document,
              fontSize: pt(11),
              lineHeight: 1.15,
              color: colors.documentInk,
              overflowWrap: 'break-word',
            }}
          >
            {loading && <LoadingLines />}
            {unplaced.length > 0 && (
              <div className="mb-4 space-y-1.5">
                {unplaced.map((edit, i) => <UnplacedNote key={`${edit.changeId}-${i}`} edit={edit} marks={marks} />)}
              </div>
            )}
            <ReactMarkdown
              skipHtml
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeChangeMarks(tab.markdown, placed)]}
              components={components(marks)}
            >
              {tab.markdown}
            </ReactMarkdown>
          </article>
        )}
      </div>
      {overlay && <PreviewOverlay>{overlay}</PreviewOverlay>}
      </div>
    </div>
  )
}
