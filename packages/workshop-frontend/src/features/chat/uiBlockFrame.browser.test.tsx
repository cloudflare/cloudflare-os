// An `<inline-html>` block's frame, in Chromium.

import { RpcSession } from 'capnweb'
import { afterEach, expect, it } from 'vitest'
import {
  createUiBlockDocumentStart, createUiBlockShell, UiBlockHostImpl, type UiBlockFrame, type UiBlockHostOptions,
  type UiBlockTheme,
} from './uiBlockFrame'

const THEME: UiBlockTheme = { scheme: 'light', tokens: {} }

const resources: Disposable[] = []

afterEach(() => {
  for (const resource of resources.splice(0).toReversed()) resource[Symbol.dispose]()
})

/**
 * The host's end of a frame's port, as newMessagePortRpcSession builds it, but as a session, which
 * reports its stats.
 */
function hostSession(port: MessagePort, host: UiBlockHostImpl): RpcSession<UiBlockFrame> {
  const inbox: unknown[] = []
  let waiting: ((message: unknown) => void) | undefined
  port.addEventListener('message', event => {
    if (waiting === undefined) inbox.push(event.data)
    else { waiting(event.data); waiting = undefined }
  })
  port.start()
  return new RpcSession<UiBlockFrame>({
    encodingLevel: 'structuredClonable',
    send: message => port.postMessage(message),
    receive: () => inbox.length > 0
      ? Promise.resolve(inbox.shift())
      : new Promise(resolve => { waiting = resolve }),
  }, host)
}

/** Runs `body` as a block in a frame, as the card does, and returns the host's session. */
function openBlock(body: string, options: UiBlockHostOptions): Promise<RpcSession<UiBlockFrame>> {
  const { promise, resolve, reject } = Promise.withResolvers<RpcSession<UiBlockFrame>>()
  const iframe = document.body.appendChild(document.createElement('iframe'))
  iframe.sandbox.add('allow-scripts')
  resources.push({ [Symbol.dispose]: () => iframe.remove() })
  window.addEventListener('message', function handshake(event) {
    const port = event.ports[0]
    if (event.source !== iframe.contentWindow || port === undefined) return
    window.removeEventListener('message', handshake)
    const session = hostSession(port, new UiBlockHostImpl(options))
    const frame = session.getRemoteMain()
    resources.push(frame)
    frame.write(createUiBlockDocumentStart(THEME) + body).catch(reject)
    frame.close().catch(reject)
    resolve(session)
  })
  iframe.srcdoc = createUiBlockShell(THEME)
  return promise
}

it('releases what a view asks to send, though its code ignores the result', async () => {
  const sent: string[] = []
  const session = await openBlock(`
    <script type="module">
      for (let i = 0; i < 8; i++) agent.send("Show me week " + i + ".");
    </script>`, { onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {} })

  await expect.poll(() => sent.length).toBe(8)
  // Left is the host the frame was given: the eight requests' results are all released.
  await expect.poll(() => session.getStats().exports).toBe(1)
})
