// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FileOp } from '@gadgets/workshop-shared/code-op'
import CodeDiffEditor from './CodeDiffEditor'
import type { EditSession } from './CodeEditor'
import { ThemeProvider } from './ThemeContext'

// Mounts the diff editor with a fake EditSession to cover the component wiring: the
// rAF-coalesced diff recompute, the -N +N pill, the deletion zones, and remote ops flowing
// into both the document and the diff layer.

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
  readonly applied: FileOp[] = []
  private listeners = new Set<(op: FileOp) => void>()
  constructor(private text: string | undefined) {}
  getText() {
    return this.text
  }
  applyLocal(op: FileOp, docText: string) {
    this.applied.push(op)
    this.text = docText
  }
  subscribeRemote(cb: (op: FileOp) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  emitRemote(op: FileOp) {
    if ('set' in op) this.text = op.set
    if ('remove' in op) this.text = undefined
    for (const listener of this.listeners) listener(op)
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
        <ThemeProvider>
          <CodeDiffEditor
            filename="notes.txt"
            original={original}
            session={session}
          />
        </ThemeProvider>,
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

  it('folds remote ops into the document and re-diffs', async () => {
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
