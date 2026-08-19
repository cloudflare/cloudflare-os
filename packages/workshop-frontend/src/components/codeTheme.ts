/**
 * Shared CodeMirror theme + monospace font stack used by the code view's editors (CodeEditor
 * and CodeDiffEditor). Ported from the Workshop's former Monaco theme -- the palette is the
 * same one gatekeeper-context's Monaco-matched CodeMirror theme uses, so gadget code looks
 * identical across surfaces. The diff layer's own styling lives in CodeDiffEditor.css.
 */

import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import type { ResolvedThemeMode } from '../theme'

export const monoFont =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const highlightLight = HighlightStyle.define([
  { tag: t.comment, color: '#a39990', fontStyle: 'italic' },
  {
    tag: [
      t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword,
      t.modifier, t.self,
    ],
    color: '#8e3aa6',
  },
  { tag: t.operator, color: '#6b6157' },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: '#4d8a44' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b56a1f' },
  { tag: [t.typeName, t.className, t.namespace], color: '#b56a1f' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#3a72c9' },
  { tag: [t.variableName, t.propertyName], color: '#1f1d1a' },
  { tag: t.constant(t.variableName), color: '#b56a1f' },
  { tag: t.standard(t.variableName), color: '#3a72c9' },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace], color: '#6b6157' },
  { tag: t.tagName, color: '#c14438' },
  { tag: t.attributeName, color: '#b56a1f' },
  { tag: t.attributeValue, color: '#4d8a44' },
  { tag: t.heading, color: '#8e3aa6' },
  { tag: t.url, color: '#4d8a44' },
])

const highlightDark = HighlightStyle.define([
  { tag: t.comment, color: '#858396', fontStyle: 'italic' },
  {
    tag: [
      t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword,
      t.modifier, t.self,
    ],
    color: '#d8b4fe',
  },
  { tag: t.operator, color: '#b9b5c8' },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: '#86efac' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#fbbf24' },
  { tag: [t.typeName, t.className, t.namespace], color: '#fbbf24' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#93c5fd' },
  { tag: [t.variableName, t.propertyName], color: '#e8e6f0' },
  { tag: t.constant(t.variableName), color: '#fbbf24' },
  { tag: t.standard(t.variableName), color: '#93c5fd' },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace], color: '#b9b5c8' },
  { tag: t.tagName, color: '#fca5a5' },
  { tag: t.attributeName, color: '#fbbf24' },
  { tag: t.attributeValue, color: '#86efac' },
  { tag: t.heading, color: '#d8b4fe' },
  { tag: t.url, color: '#86efac' },
])

// Shared structural rules (fonts, sizing, gutters), parameterized by palette.
function editorChrome(colors: {
  bg: string; fg: string; gutter: string; gutterActive: string; selection: string
  inactiveSelection: string; matchHighlight: string; panelBg: string; line: string
}, dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        color: colors.fg,
        backgroundColor: colors.bg,
        height: '100%',
        fontSize: '13px',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: monoFont,
        lineHeight: '20px',
        overflow: 'auto',
      },
      '.cm-content': { padding: '12px 0', caretColor: colors.fg },
      '.cm-line': { padding: '0 16px 0 12px' },
      '.cm-gutters': {
        backgroundColor: colors.bg,
        border: 'none',
        color: colors.gutter,
        fontSize: '12px',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px', minWidth: '36px' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: colors.gutterActive },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: colors.fg },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: colors.selection },
      '.cm-selectionBackground': { backgroundColor: colors.inactiveSelection },
      '.cm-selectionMatch': { backgroundColor: colors.matchHighlight },
      '.cm-searchMatch': { backgroundColor: colors.matchHighlight },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: colors.selection },
      '.cm-panels': { backgroundColor: colors.panelBg, color: colors.fg },
      '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${colors.line}` },
      '.cm-panel.cm-search [name=close]': { color: colors.fg },
      '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'transparent',
        border: 'none',
        color: colors.gutterActive,
      },
    },
    { dark },
  )
}

const chromeLight = editorChrome({
  bg: '#fffdfb',
  fg: '#1f1d1a',
  gutter: '#cabfb2',
  gutterActive: '#796c63',
  selection: '#b3d4ff',
  inactiveSelection: '#dbe6f5',
  matchHighlight: '#cee0fa',
  panelBg: '#faf6f1',
  line: '#efe4d6',
}, false)

const chromeDark = editorChrome({
  bg: '#16151f',
  fg: '#e8e6f0',
  gutter: '#6d6880',
  gutterActive: '#b9b5c8',
  selection: '#4b3d66',
  inactiveSelection: '#352f4a',
  matchHighlight: '#352f4a',
  panelBg: '#1d1c29',
  line: '#2a263b',
}, true)

/** The editor theme (chrome + syntax highlighting) for the given resolved UI theme mode. */
export function codeEditorTheme(mode: ResolvedThemeMode): Extension {
  return mode === 'dark'
    ? [chromeDark, syntaxHighlighting(highlightDark)]
    : [chromeLight, syntaxHighlighting(highlightLight)]
}
