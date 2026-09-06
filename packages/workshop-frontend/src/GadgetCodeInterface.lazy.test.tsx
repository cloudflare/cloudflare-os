// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeSubscriber, CodeUpdate } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  } else {
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

const lazyLoads = vi.hoisted(() => ({
  code: 0,
  diff: 0,
  lastCodeFilename: null as string | null,
  lastDiffFilename: null as string | null,
  diffText: '',
}))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<() => void>() }),
}))

vi.mock('./FileSidebar', () => ({
  default: () => null,
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: () => null,
  WorkshopIconButton: () => null,
}))

vi.mock('./CodeEditor', () => {
  lazyLoads.code += 1
  return {
    default: ({ filename }: { filename: string | null }) => {
      lazyLoads.lastCodeFilename = filename
      return null
    },
  }
})

vi.mock('./CodeDiffEditor', () => {
  lazyLoads.diff += 1
  return {
    default: ({ filename, modifiedYText }: { filename: string | null; modifiedYText: Y.Text | null }) => {
      lazyLoads.lastDiffFilename = filename
      lazyLoads.diffText = modifiedYText?.toString() ?? ''
      return null
    },
  }
})

import GadgetCodeInterface from './GadgetCodeInterface'

class FakeSubscription {
  disposed = false;

  [Symbol.dispose]() {
    this.disposed = true
  }
}

class FakeOverseer {
  subscribers: CodeSubscriber[] = []
  subscriptions: FakeSubscription[] = []
  subscribeCalls: number[] = []

  constructor(private initialUpdate: CodeUpdate) {}

  async subscribeToCode(subscriber: CodeSubscriber, version: number) {
    this.subscribeCalls.push(version)
    this.subscribers.push(subscriber)
    subscriber.update(this.initialUpdate)
    subscriber.ready()
    const subscription = new FakeSubscription()
    this.subscriptions.push(subscription)
    return subscription
  }

  async updateCode() {}
}

function updateWithFile(filesRoot: string, filename: string, contents: string): CodeUpdate {
  const ydoc = new Y.Doc()
  const files = ydoc.getMap<Y.Text>(filesRoot)
  const text = new Y.Text(contents)
  files.set(filename, text)
  const update = { version: 1, timestamp: new Date(), update: Y.encodeStateAsUpdateV2(ydoc) }
  ydoc.destroy()
  return update
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('GadgetCodeInterface lazy visibility behavior', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    lazyLoads.code = 0
    lazyLoads.diff = 0
    lazyLoads.lastCodeFilename = null
    lazyLoads.lastDiffFilename = null
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
      }),
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('syncs authoritative code presence without importing Monaco-backed editors while hidden', async () => {
    const overseer = new FakeOverseer(updateWithFile('files', 'client.js', 'console.log(1)'))
    const onHasCodeChange = vi.fn<(value: boolean) => void>()

    await act(async () => {
      root.render(
        <GadgetCodeInterface
          overseer={overseer as never}
          filesRoot="files"
          isAgentActive={false}
          isVisible={false}
          onHasCodeChange={onHasCodeChange}
        />
      )
    })

    expect(overseer.subscribeCalls).toEqual([0])
    expect(onHasCodeChange).toHaveBeenLastCalledWith(true)
    expect(lazyLoads.code).toBe(0)
    expect(lazyLoads.diff).toBe(0)
  })

  it('loads the editor when shown without restarting or disposing the lightweight subscription', async () => {
    const overseer = new FakeOverseer(updateWithFile('files', 'client.js', 'console.log(1)'))
    const hasCode: boolean[] = []

    await act(async () => {
      root.render(
        <GadgetCodeInterface
          overseer={overseer as never}
          filesRoot="files"
          isAgentActive={false}
          isVisible={false}
          onHasCodeChange={value => hasCode.push(value)}
        />
      )
    })

    await act(async () => {
      root.render(
        <GadgetCodeInterface
          overseer={overseer as never}
          filesRoot="files"
          isAgentActive={false}
          isVisible
          onHasCodeChange={value => hasCode.push(value)}
        />
      )
    })
    await flush()

    expect(overseer.subscribeCalls).toEqual([0])
    expect(hasCode).toContain(true)
    expect(lazyLoads.code).toBe(1)

    await act(async () => {
      root.render(
        <GadgetCodeInterface
          overseer={overseer as never}
          filesRoot="files"
          isAgentActive={false}
          isVisible={false}
          onHasCodeChange={value => hasCode.push(value)}
        />
      )
    })

    expect(overseer.subscriptions[0].disposed).toBe(false)
  })

  it('keeps hidden streaming diffs in local Yjs state without loading the diff editor early', async () => {
    const overseer = new FakeOverseer(updateWithFile('files', 'client.js', 'old'))
    const streamDoc = new Y.Doc()
    const streamText = new Y.Text('new')
    streamDoc.getMap<Y.Text>('files').set('server.js', streamText)
    const updates = [Y.encodeStateAsUpdateV2(streamDoc)]

    await act(async () => {
      root.render(
        <GadgetCodeInterface
          overseer={overseer as never}
          filesRoot="files"
          selectedChatId={7}
          streamingProposedChanges={{ count: 1, updates }}
          streamingActiveFile="server.js"
          isAgentActive
          isVisible={false}
        />
      )
    })

    expect(overseer.subscribeCalls).toEqual([0])
    expect(lazyLoads.diff).toBe(0)

    streamDoc.on('updateV2', update => updates.push(update))
    streamText.insert(3, ' while hidden')
    await act(async () => {
      root.render(<GadgetCodeInterface overseer={overseer as never} filesRoot="files"
        selectedChatId={7} streamingProposedChanges={{ count: 2, updates }}
        streamingActiveFile="server.js" isAgentActive isVisible={false} />)
    })
    expect(overseer.subscribeCalls).toEqual([0])
    expect(lazyLoads.diff).toBe(0)

    await act(async () => {
      root.render(
        <GadgetCodeInterface
          overseer={overseer as never}
          filesRoot="files"
          selectedChatId={7}
          streamingProposedChanges={{ count: 2, updates }}
          streamingActiveFile="server.js"
          isAgentActive
          isVisible
        />
      )
    })
    await flush()

    expect(overseer.subscribeCalls).toEqual([0])
    expect(lazyLoads.diff).toBe(1)
    expect(lazyLoads.lastDiffFilename).toBe('server.js')
    expect(lazyLoads.diffText).toBe('new while hidden')
    streamDoc.destroy()
  })

  it('disposes a late subscription and ignores callbacks after unmounting', async () => {
    let subscriber: CodeSubscriber | undefined
    let resolve!: (subscription: FakeSubscription) => void
    const subscribeToCode = vi.fn<(next: CodeSubscriber) => Promise<FakeSubscription>>((next) => {
      subscriber = next
      return new Promise<FakeSubscription>(done => { resolve = done })
    })
    const overseer = { subscribeToCode, updateCode: vi.fn<() => Promise<void>>() }
    const onHasCodeChange = vi.fn<(value: boolean) => void>()
    const render = (isVisible: boolean) => act(async () => {
      root.render(<GadgetCodeInterface overseer={overseer as never} filesRoot="files"
        isAgentActive={false} isVisible={isVisible} onHasCodeChange={onHasCodeChange} />)
    })
    await render(true)
    await act(async () => root.render(null))
    const subscription = new FakeSubscription()
    await act(async () => {
      subscriber!.update(updateWithFile('files', 'late.js', 'ignored'))
      subscriber!.ready()
      resolve(subscription)
    })
    expect(subscription.disposed).toBe(true)
    expect(onHasCodeChange).not.toHaveBeenCalled()
  })

  it('retains its subscription across visibility changes and disposes on unmount', async () => {
    const overseer = new FakeOverseer(updateWithFile('files', 'client.js', 'old'))
    const render = (isVisible: boolean) => act(async () => {
      root.render(<GadgetCodeInterface overseer={overseer as never} filesRoot="files"
        isAgentActive={false} isVisible={isVisible} />)
    })
    await render(true)
    await render(false)
    await render(true)
    expect(overseer.subscribeCalls).toEqual([0])
    expect(overseer.subscriptions[0].disposed).toBe(false)
    await act(async () => root.render(null))
    expect(overseer.subscriptions[0].disposed).toBe(true)
  })

  it('reports code presence for the newly selected root without another subscription', async () => {
    const overseer = new FakeOverseer(updateWithFile('files', 'client.js', 'old'))
    const onHasCodeChange = vi.fn<(value: boolean) => void>()
    const render = (filesRoot: string) => act(async () => {
      root.render(<GadgetCodeInterface overseer={overseer as never} filesRoot={filesRoot}
        isAgentActive={false} isVisible={false} onHasCodeChange={onHasCodeChange} />)
    })
    await render('files')
    expect(onHasCodeChange).toHaveBeenLastCalledWith(true)
    await render('empty')
    expect(onHasCodeChange).toHaveBeenLastCalledWith(false)
    await render('files')
    expect(onHasCodeChange).toHaveBeenLastCalledWith(true)
    expect(overseer.subscribeCalls).toEqual([0])
  })
})
