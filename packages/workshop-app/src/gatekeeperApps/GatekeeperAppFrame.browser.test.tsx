/* eslint-disable react/react-in-jsx-scope */
// A gatekeeper app's frame, in Chromium: the app in it connects over a port it hands the page once,
// which jsdom cannot run.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
// The library itself, as the page has no origin to load it from. Its package exports only its entry.
import capnwebSource from '../../node_modules/capnweb/dist/index.js?raw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { ApiContext, type ApiSession } from '@/rpc/ApiContext'
import { GatekeeperAppFrame } from './GatekeeperAppFrame'

// The deployment's accent colour, which would be read over a connection the test does not have.
vi.mock('@/rpc/serverConfig', () => ({ useServerConfig: () => undefined }))

class TestUi extends RpcTarget {
  constructor(private readonly name: string) {
    super()
  }

  whoami() {
    return this.name
  }
}

// An app doing what every one does once it loads (see `gatekeeper-context/app/main.tsx`): hands the
// page a port in its one handshake, then asks its gatekeeper's API over it, and says what came back.
const appHtml = `<!doctype html><script type="module">
${capnwebSource.replace(/^export \{[^}]*\};?\s*$/m, '')}
const { port1, port2 } = new MessageChannel()
window.parent.postMessage({ type: 'handshake' }, '*', [port2])
const host = newMessagePortRpcSession(port1)
host.ui.whoami().then(
  (name) => window.parent.postMessage({ type: 'test-answer', name }, '*'),
  (error) => window.parent.postMessage({ type: 'test-answer', name: 'failed: ' + error }, '*'),
)
</script>`

const session = { reconnecting: false } as unknown as ApiSession

let container: HTMLDivElement
let root: Root
let answers: string[]
const onMessage = (event: MessageEvent) => {
  const data = event.data as { type?: unknown; name?: unknown } | null
  if (data?.type === 'test-answer') answers.push(String(data.name))
}

beforeEach(() => {
  answers = []
  window.addEventListener('message', onMessage)
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.removeEventListener('message', onMessage)
})

const render = (frame: GatekeeperUiFrame) =>
  act(async () =>
    root.render(
      <ApiContext value={session}>
        <GatekeeperAppFrame frame={frame} gatekeeperId="test" title="Test" onOpenWorkspace={() => {}} onOpenPrompt={() => {}} />
      </ApiContext>,
    ),
  )

it('connects the app again to a new frame with the same page', async () => {
  await render({ iframeHtml: appHtml, ui: new RpcStub(new TestUi('first')) })
  await expect.poll(() => answers).toEqual(['first'])

  // A reconnect: the same page, with the new connection's API for it.
  await render({ iframeHtml: appHtml, ui: new RpcStub(new TestUi('second')) })
  await expect.poll(() => answers).toEqual(['first', 'second'])
})
