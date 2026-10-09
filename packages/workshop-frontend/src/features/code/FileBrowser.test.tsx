// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@gadgets/workshop-shared/api'
import FileBrowser, { type ExpandedDirs } from './FileBrowser'
import { buildBrowserTree, type ChangedFile } from './workpieceTree'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

const BASE: TreeNode[] = [
  { name: 'README.md', kind: 'file' },
  { name: 'bin', kind: 'dir', children: [{ name: 'run', kind: 'executable' }] },
  { name: 'src', kind: 'dir', children: [
    { name: 'deep', kind: 'dir', children: [{ name: 'inner.ts', kind: 'file' }] },
    { name: 'a.ts', kind: 'file' },
    { name: 'link', kind: 'symlink' },
  ] },
]

describe('FileBrowser', () => {
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
  })

  async function render(options: {
    activeFile?: string | null
    changes?: ChangedFile[]
    isDiffMode?: boolean
    leafCount?: number
    onFileSelect?: (path: string) => void
    initialExpanded?: ExpandedDirs
    onExpandedChange?: (expanded: ExpandedDirs) => void
  } = {}) {
    // Pad the base with enough leaves to cross the large-tree threshold when asked.
    const padded: TreeNode[] = options.leafCount !== undefined
      ? [...BASE, { name: 'pad', kind: 'dir', children: Array.from(
        { length: options.leafCount }, (_, i) => ({ name: `f${i}`, kind: 'file' as const })) }]
      : BASE
    const tree = buildBrowserTree(padded, [], new Set())
    // Attached, so focus() moves document.activeElement as it would in a browser.
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    const onFileSelect = options.onFileSelect ?? vi.fn<(path: string) => void>()
    const rerender = async (activeFile: string | null) => {
      await act(async () => root!.render(
        <FileBrowser
          tree={tree}
          changes={options.changes ?? []}
          activeFile={activeFile}
          isDiffMode={options.isDiffMode ?? true}
          editLocked={false}
          workpieceNoun="gadget"
          initialExpanded={options.initialExpanded}
          onExpandedChange={options.onExpandedChange}
          onFileSelect={onFileSelect}
          onFileCreate={vi.fn<(path: string) => void>()}
          onFileDelete={vi.fn<(path: string) => void>()}
          onFileRename={vi.fn<(oldPath: string, newPath: string) => void>()}
          onFileDownload={vi.fn<(path: string) => void>()}
        />,
      ))
    }
    await rerender(options.activeFile ?? null)
    return { container, rerender }
  }

  function rowLabels(container: HTMLElement): string[] {
    return [...container.querySelectorAll('button')]
      .map(button => button.textContent ?? '')
      .filter(text => text !== '' && !text.startsWith('Actions'))
  }

  it('renders a small tree fully expanded, directories first', async () => {
    const { container } = await render()
    expect(rowLabels(container)).toEqual([
      'bin', 'run', 'src', 'deep', 'inner.ts', 'a.ts', 'README.md',
    ])
    // The symlink is listed (as text, not a button) and named for what it is.
    expect(container.textContent).toContain('link')
    expect(container.querySelector('[title="Symbolic link (not viewable)"]')).not.toBeNull()
  })

  it('does not select a symlink when its row is clicked', async () => {
    const onFileSelect = vi.fn<(path: string) => void>()
    const { container } = await render({ onFileSelect })
    const row = container.querySelector<HTMLElement>('[title="Symbolic link (not viewable)"]')!
    await act(async () => row.click())
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('withholds Rename from an executable but keeps Delete and Download', async () => {
    const { container } = await render()
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for bin/run"]')!
    await act(async () => trigger.click())
    const menuText = document.body.textContent ?? ''
    expect(menuText).toContain('Download')
    expect(menuText).toContain('Delete')
    expect(menuText).not.toContain('Rename')
  })

  it('collapses a large tree to its first level and reveals the active file', async () => {
    const { container, rerender } = await render({ leafCount: 250 })
    expect(rowLabels(container)).toEqual(['bin', 'pad', 'src', 'README.md'])
    await rerender('src/deep/inner.ts')
    expect(rowLabels(container)).toEqual([
      'bin', 'pad', 'src', 'deep', 'inner.ts', 'a.ts', 'README.md',
    ])
  })

  it('reports expansion toggles and resumes from them on a fresh mount', async () => {
    let remembered: ExpandedDirs | undefined
    const { container } = await render({ onExpandedChange: expanded => { remembered = expanded } })
    const srcToggle = [...container.querySelectorAll('button')].find(b => b.textContent === 'src')!
    await act(async () => srcToggle.click())
    expect(rowLabels(container)).toEqual(['bin', 'run', 'src', 'README.md'])
    expect(remembered?.get('src')).toBe(false)
    await act(async () => root?.unmount())
    document.body.replaceChildren()

    const resumed = await render({ initialExpanded: remembered })
    expect(rowLabels(resumed.container)).toEqual(['bin', 'run', 'src', 'README.md'])
  })

  it('remembers directories the active-file reveal opened', async () => {
    let remembered: ExpandedDirs | undefined
    const { rerender } = await render({
      leafCount: 250, onExpandedChange: expanded => { remembered = expanded },
    })
    await rerender('src/deep/inner.ts')
    expect(remembered?.get('src')).toBe(true)
    expect(remembered?.get('src/deep')).toBe(true)
  })

  it('lists changed files above the tree, with a deleted file the tree no longer holds', async () => {
    const { container } = await render({
      changes: [{ path: 'gone/old.ts', status: 'deleted' }, { path: 'src/a.ts', status: 'modified' }],
    })
    expect(container.textContent).toContain('Changes (2)')
    const labels = rowLabels(container)
    expect(labels.slice(0, 2)).toEqual(['gone/old.ts', 'src/a.ts'])
  })

  it('opens one rename input for a file listed under both Changes and Files', async () => {
    vi.useFakeTimers()
    try {
      const { container } = await render({ changes: [{ path: 'src/a.ts', status: 'modified' }] })
      const triggers = container.querySelectorAll<HTMLButtonElement>('[aria-label="Actions for src/a.ts"]')
      expect(triggers).toHaveLength(2)
      await act(async () => triggers[1].click())  // the tree's row
      const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(item => item.textContent === 'Rename')!
      await act(async () => rename.click())
      const inputs = () => container.querySelectorAll<HTMLInputElement>('input[aria-label="Rename src/a.ts"]')
      expect(inputs()).toHaveLength(1)
      // Each input focuses itself on a timer; with two mounted, the second's focus would blur
      // the first, whose unchanged value cancels the rename. One input rides it out.
      await act(async () => { vi.runAllTimers() })
      expect(inputs()).toHaveLength(1)
      expect(document.activeElement).toBe(inputs()[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists an unresolved removal as a selectable pending row without file actions', async () => {
    const onFileSelect = vi.fn<(path: string) => void>()
    const { container } = await render({
      onFileSelect, changes: [{ path: 'gone/old.ts', status: 'pending' }],
    })
    expect(container.querySelector('[aria-label="Actions for gone/old.ts"]')).toBeNull()
    const row = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'gone/old.ts')!
    await act(async () => row.click())
    expect(onFileSelect).toHaveBeenCalledWith('gone/old.ts')
  })

  it('omits the Changes section outside diff mode', async () => {
    const { container } = await render({
      isDiffMode: false, changes: [{ path: 'src/a.ts', status: 'modified' }],
    })
    expect(container.textContent).not.toContain('Changes')
  })
})
