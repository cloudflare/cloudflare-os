// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { FileChange } from '@gadgets/workshop-shared/code-change'
import CodeDiffEditor from './CodeDiffEditor'
import type { EditSession } from './CodeEditor'
import { ThemeProvider } from './ThemeContext'

// Mounts the diff editor with a fake EditSession to cover the component wiring: the
// rAF-coalesced diff recompute, the -N +N pill, the deletion zones, and remote changes flowing
// into both the document and the diff layer. Mounted under StrictMode like the real app
// (main.tsx): its simulated unmount+remount runs effect cleanups against a component instance
// that lives on, which is exactly what once wedged the recompute scheduler.

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
  ResizeObserver?: typeof ResizeObserver
}
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
const previousResizeObserver = testGlobal.ResizeObserver
testGlobal.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
// jsdom implements neither matchMedia (ThemeProvider) nor ResizeObserver (width gating).
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as typeof window.matchMedia
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  } else {
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
  if (previousResizeObserver === undefined) {
    Reflect.deleteProperty(testGlobal, 'ResizeObserver')
  } else {
    testGlobal.ResizeObserver = previousResizeObserver
  }
})

class FakeSession implements EditSession {
  readonly key = 'chat:1:file'
  readonly applied: FileChange[] = []
  private listeners = new Set<(change: FileChange) => void>()
  constructor(private text: string | undefined) {}
  getText() {
    return this.text
  }
  applyLocal(change: FileChange, docText: string) {
    this.applied.push(change)
    this.text = docText
  }
  subscribeRemote(cb: (change: FileChange) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  emitRemote(change: FileChange) {
    if ('set' in change) this.text = change.set
    if ('remove' in change) this.text = undefined
    for (const listener of this.listeners) listener(change)
  }
}

async function flushFrames() {
  // jsdom delivers requestAnimationFrame on a timer; two rounds cover recompute-after-remote.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40))
  })
}

describe('CodeDiffEditor', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function mount(session: FakeSession, original: string | null) {
    await act(async () => {
      root.render(
        <StrictMode>
          <ThemeProvider>
            <CodeDiffEditor
              filename="notes.txt"
              original={original}
              session={session}
            />
          </ThemeProvider>
        </StrictMode>,
      )
    })
    await flushFrames()
  }

  it('shows the document, the pill, and a deletion zone for a replacement', async () => {
    const session = new FakeSession('hello\nthere')
    await mount(session, 'hello\nworld')
    expect(container.querySelector('.cm-content')?.textContent).toContain('there')
    expect(container.querySelector('.gadgets-deleted-code-zone')?.textContent).toBe('world')
    expect(container.textContent).toContain('-1')
    expect(container.textContent).toContain('+1')
  })

  it('re-diffs after locally-authored edits (StrictMode remount must not wedge the rAF)', async () => {
    const session = new FakeSession('hello\nworld')
    await mount(session, 'hello\nworld')
    expect(container.textContent).toContain('Unchanged')

    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)
    expect(view).not.toBeNull()
    // A user edit: a plain transaction with no remote annotation, replacing line 2.
    await act(async () => {
      view!.dispatch({ changes: { from: 6, to: 11, insert: 'there' } })
    })
    await flushFrames()
    expect(session.getText()).toBe('hello\nthere')
    expect(container.textContent).toContain('-1')
    expect(container.textContent).toContain('+1')
    expect(container.querySelector('.gadgets-deleted-code-zone')?.textContent).toBe('world')
    expect(container.querySelector('.gadgets-diff-line-add')).not.toBeNull()

    // And again: the scheduler must keep working across repeated frames.
    await act(async () => {
      view!.dispatch({ changes: { from: view!.state.doc.length, insert: '\nmore' } })
    })
    await flushFrames()
    expect(container.textContent).toContain('+2')
  })

  it('folds remote changes into the document and re-diffs', async () => {
    const session = new FakeSession('hello\nthere')
    await mount(session, 'hello\nworld')
    await act(async () => {
      session.emitRemote({ set: 'hello\nworld' })
    })
    await flushFrames()
    expect(container.querySelector('.cm-content')?.textContent).toContain('world')
    expect(container.querySelector('.gadgets-deleted-code-zone')).toBeNull()
    expect(container.textContent).toContain('Unchanged')
  })

  it('reports an added file with no deletion zones', async () => {
    const session = new FakeSession('brand\nnew')
    await mount(session, null)
    expect(container.textContent).toContain('Added')
    expect(container.textContent).toContain('+2')
    expect(container.querySelector('.gadgets-deleted-code-zone')).toBeNull()
  })

  it('shows a whole-file deletion zone after a remote remove', async () => {
    const session = new FakeSession('hello\nworld')
    await mount(session, 'hello\nworld')
    await act(async () => {
      session.emitRemote({ remove: true })
    })
    await flushFrames()
    expect(container.textContent).toContain('Deleted')
    expect(container.querySelector('.gadgets-deleted-code-zone')?.textContent)
      .toBe('helloworld')
  })

  it('renders the select-a-file placeholder without a filename', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider>
          <CodeDiffEditor filename={null} original={null} />
        </ThemeProvider>,
      )
    })
    expect(container.textContent).toContain('Select a file to view changes')
  })
})
