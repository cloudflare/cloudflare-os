// An `<inline-html>` block's frame, in Chromium.

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ThemeProvider } from '../../ThemeContext'
import { UiBlockCard } from './UiBlockCard'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { RpcSession } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { readSnapshotFile } from './inlineFiles'
import {
  createUiBlockDocumentStart, createUiBlockShell, UiBlockHostImpl, type UiBlockFrame, type UiBlockHostOptions,
  type UiBlockTheme,
} from './uiBlockFrame'

const THEME: UiBlockTheme = { scheme: 'light', tokens: {} }

const resources: Disposable[] = []
const roots: Root[] = []

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
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

const png = (color: string): Uint8Array => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2
  const context = canvas.getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 2, 2)
  return Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0))
}
const byteStream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(bytes); controller.close() },
})
const observedImage = (id: string, source: string) =>
  `<img id="${id}" src="${source}" onload="agent.send(this.id + ':' + this.naturalWidth + ':' + this.src)">`

it('renders only the message snapshot bytes through its narrow RPC reader', async () => {
  const oid = 'a'.repeat(40), source = 'worktree://REPO/image.png'
  const readBlob = vi.fn<(oid: string) => Promise<ReadableStream<Uint8Array>>>(async () => byteStream(png('red')))
  const sent: string[] = []
  await openBlock(observedImage('first', source) + observedImage('second', source), {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {},
    readImage: url => readSnapshotFile({ oids: { [source]: oid }, readBlob }, url),
  })
  await expect.poll(() => sent.filter(message => /^(first|second):2:blob:/.test(message)).length).toBe(2)
  expect(readBlob.mock.calls.map(([value]) => value)).toEqual([oid, oid])
})

it.each([
  ['a&amp;b.png', 'a&b.png'],
  ['a&#38;b.png', 'a&b.png'],
  ['a&#x26;b.png', 'a&b.png'],
  ['a&amp;amp;b.png', 'a&amp;b.png'],
  ['a&notit;.png', 'a&notit;.png'],
  ['a&quot;b.png', 'a"b.png'],
  ['a&#x1f600;.png', 'a😀.png'],
])('reads the pinned DOM-decoded inline image URL for %s', async (attribute, path) => {
  const source = `worktree://REPO/${path}`, oid = 'a'.repeat(40)
  const readBlob = vi.fn<(oid: string) => Promise<ReadableStream<Uint8Array>>>(async () => byteStream(png('red')))
  const readImage = vi.fn<NonNullable<UiBlockHostOptions['readImage']>>(url =>
    readSnapshotFile({ oids: { [source]: oid }, readBlob }, url))
  const sent: string[] = []
  await openBlock(observedImage('picture', `worktree://REPO/${attribute}`), {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {}, readImage,
  })
  await expect.poll(() => sent.some(message => message.startsWith('picture:2:blob:'))).toBe(true)
  expect(readImage).toHaveBeenCalledExactlyOnceWith(source)
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
})

it.each(['remove', 'replace', 'clear'])('cancels an in-progress image download when the view chooses to %s it', async action => {
  const source = 'worktree://REPO/pending.png', trigger = 'worktree://REPO/trigger.png'
  const replacement = 'worktree://REPO/replacement.png'
  const first = 'a'.repeat(40), second = 'b'.repeat(40), third = 'c'.repeat(40)
  const reading = Promise.withResolvers<void>()
  const cancel = vi.fn<() => void>()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let chunks = 0
  const pending = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    pull(value) {
      if (chunks++ === 0) value.enqueue(Uint8Array.of(137, 80))
      else reading.resolve()
    },
    cancel,
  }, { highWaterMark: 0 })
  resources.push({ [Symbol.dispose]: () => controller.error(new Error('Test ended')) })
  const readBlob = vi.fn<(oid: string) => Promise<ReadableStream<Uint8Array>>>(async oid => {
    if (oid === first) return pending
    // The trigger cannot load and mutate the view until the first download is consuming bytes.
    if (oid === second) await reading.promise
    return byteStream(png('cyan'))
  })
  const sent: string[] = [], errors: string[] = []
  const mutation = action === 'remove' ? 'target.remove()'
    : action === 'clear' ? "target.removeAttribute('src')" : `target.src = '${replacement}'`
  await openBlock(observedImage('target', source) +
    `<img src="${trigger}" onload="const target = document.getElementById('target'); ${mutation}; agent.send('evicted')">`, {
    onMessageRequest: message => {
      sent.push(message)
      // Cap'n Web's sender observes remote cancellation when its next write is acknowledged.
      if (message === 'evicted' && cancel.mock.calls.length === 0) controller.enqueue(Uint8Array.of(1))
    },
    onResize: () => {}, onError: message => errors.push(message),
    readImage: url => readSnapshotFile({ oids: { [source]: first, [trigger]: second, [replacement]: third }, readBlob }, url),
  })
  await expect.poll(() => sent.includes('evicted')).toBe(true)
  await expect.poll(() => cancel.mock.calls.length).toBe(1)
  await expect.poll(() => readBlob.mock.calls.map(([oid]) => oid))
    .toEqual(action === 'replace' ? [first, second, third] : [first, second])
  await expect.poll(() => sent.some(message => message.startsWith('target:2:blob:'))).toBe(action === 'replace')
  expect(errors).toEqual([])
})

it.each([false, true])('restores a detached image while respecting an explicit source change: %s', async changed => {
  const source = 'worktree://OUTPUTS/image.png', sent: string[] = []
  const replacement = changed ? 'worktree://OUTPUTS/replacement.png' : source
  const readImage = vi.fn<NonNullable<UiBlockHostOptions['readImage']>>(async () =>
    ({oid: 'a'.repeat(40), stream: byteStream(png('cyan'))}))
  await openBlock(`<img width="1600" src="${source}" onerror="agent.send('error')" onload="
    if (!this.dataset.detached) {
      this.dataset.detached = '1';
      this.dataset.width = this.getBoundingClientRect().width;
      this.remove();
      requestAnimationFrame(() => { ${changed ? `this.src = '${replacement}';` : ''} document.body.append(this); });
    } else agent.send(this.dataset.width + ':' + this.getBoundingClientRect().width);
  ">`, {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {}, readImage,
  })
  await expect.poll(() => readImage.mock.calls.length).toBe(2)
  await expect.poll(() => sent.some(message => /^([0-9.]+):\1$/.test(message))).toBe(true)
  expect(sent).not.toContain('error')
  expect(readImage.mock.calls.map(([url]) => url)).toEqual([source, replacement])
})

it.each(['pending', 'loaded'])('preserves a %s image when the view resets its pinned source', async phase => {
  const source = 'worktree://OUTPUTS/image.png', trigger = 'worktree://OUTPUTS/trigger.png'
  const reading = Promise.withResolvers<void>(), loaded = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<void>()
  const sent: string[] = []
  const readImage = vi.fn<NonNullable<UiBlockHostOptions['readImage']>>(async url => {
    if (url === source) {
      reading.resolve()
      if (phase === 'pending') await pending.promise
    } else await (phase === 'pending' ? reading.promise : loaded.promise)
    return { oid: 'a'.repeat(40), stream: byteStream(png('cyan')) }
  })
  await openBlock(`<img id="target" src="${source}" onerror="agent.send('fallback')"
      onload="agent.send('target:' + this.naturalWidth + ':' + this.src)">
    <img src="${trigger}" onload="document.getElementById('target').src = '${source}'; agent.send('reset'); this.remove()">`, {
    onMessageRequest: message => {
      sent.push(message)
      if (message.startsWith('target:')) loaded.resolve()
    },
    onResize: () => {}, onError: () => {}, readImage,
  })
  await expect.poll(() => sent.includes('reset')).toBe(true)
  pending.resolve()
  await expect.poll(() => sent.filter(message => message.startsWith('target:2:blob:')).length)
    .toBe(phase === 'pending' ? 1 : 2)
  expect(sent).not.toContain('fallback')
  expect(readImage.mock.calls.filter(([url]) => url === source)).toHaveLength(1)
})

it('removes worktree sizing when the view switches an image to a data preview', async () => {
  const preview = 'data:image/png;base64,' + btoa(String.fromCharCode(...png('red')))
  const sent: string[] = []
  await openBlock(`<img src="worktree://OUTPUTS/image.png" width="440" height="20" onload="
    if (!this.dataset.preview) { this.dataset.preview = 'true'; this.src = '${preview}'; }
    else { const r = this.getBoundingClientRect(); agent.send(r.width + 'x' + r.height + ':' + this.hasAttribute('data-blob-oid')); }">`, {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {},
    readImage: async () => ({ oid: 'a'.repeat(40), stream: byteStream(png('cyan')) }),
  })
  await expect.poll(() => sent).toEqual(['440x20:false'])
})

it.each(['', '<?xml-stylesheet type="text/css" href="style.css"?>', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'])(
  'decodes SVG with prolog %s and keeps external HTTP images blocked by the sandbox', async doctype => {
  const source = 'worktree://REPO/image.svg'
  const readBlob = vi.fn<(oid: string) => Promise<ReadableStream<Uint8Array>>>(async () => byteStream(
    new TextEncoder().encode('<?xml version="1.0"?>' + '<!-- comment -->'.repeat(10) + doctype +
      '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="19"/>')))
  const sent: string[] = []
  await openBlock(observedImage('vector', source) +
    '<img src="https://example.com/blocked.png" onerror="agent.send(\'blocked\')">', {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {},
    readImage: url => readSnapshotFile({ oids: { [source]: 'a'.repeat(40) }, readBlob }, url),
  })
  await expect.poll(() => sent.some(message => message.startsWith('vector:17:blob:'))).toBe(true)
  await expect.poll(() => sent.includes('blocked')).toBe(true)
  expect(readBlob).toHaveBeenCalledTimes(1)
})


it('does not invoke the image fallback while pinned bytes are still being read', async () => {
  const pending = Promise.withResolvers<void>(), reading = Promise.withResolvers<void>()
  const sent: string[] = []
  await openBlock('<img src="worktree://REPO/image.png" onerror="agent.send(\'fallback\'); this.remove()" ' +
    'onload="agent.send(\'loaded\')">', {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {},
    readImage: async () => {
      reading.resolve()
      await pending.promise
      return { oid: 'a'.repeat(40), stream: byteStream(png('cyan')) }
    },
  })
  await reading.promise
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(sent).toEqual([])
  pending.resolve()
  await expect.poll(() => sent).toEqual(['loaded'])
})


it.each(['', 'svg', 'math'])('renders nested template images alongside foreign %s markup in an actual card', async namespace => {
  const host = document.body.appendChild(document.createElement('div'))
  resources.push({ [Symbol.dispose]: () => host.remove() })
  const root = createRoot(host)
  roots.push(root)
  const source = 'worktree://OUTPUTS/template.png', oid = 'a'.repeat(40)
  const readBlob = vi.fn<Overseer['readBlob']>(async () => byteStream(png('cyan')))
  const foreign = namespace ? `<${namespace}><template id="foreign"></template></${namespace}>` : ''
  const html = foreign + `<template id="outer"><template id="inner">${observedImage('picture', source)}</template></template>
    <script>
      document.body.append(document.getElementById('outer').content.cloneNode(true));
      document.body.append(document.getElementById('inner').content.cloneNode(true));
    </script>`
  await act(async () => root.render(React.createElement(ThemeProvider, null,
    <UiBlockCard block={{kind: 'block', html}} files={{oids: {[source]: oid}, readBlob}}
      onSendMessage={async () => {}} onHeightChange={() => {}} scrollRoot={{current: null}} />
  )))
  await expect.poll(() => host.textContent).toContain('picture:2:blob:')
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
  expect(host.textContent).not.toContain('File unavailable')
})

it.each(['failed', 'interrupted'])('retries %s frame image reads on reconnect while preserving the live view and loaded images', async status => {
  const host = document.body.appendChild(document.createElement('div'))
  resources.push({ [Symbol.dispose]: () => host.remove() })
  const root = createRoot(host)
  roots.push(root)
  const source = 'worktree://OUTPUTS/image.png', loaded = 'worktree://OUTPUTS/loaded.png'
  const a = 'a'.repeat(40), b = 'b'.repeat(40), oids = { [source]: a, [loaded]: b }
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const cancel = vi.fn<() => void>()
  const readBlob = vi.fn<Overseer['readBlob']>(async oid => {
    if (oid === b) return byteStream(png('red'))
    if (status === 'failed') throw new Error('Connection lost')
    return new ReadableStream({ start(value) { controller = value; value.enqueue(Uint8Array.of(137, 80)) }, cancel })
  })
  const show = async (readBlob: Overseer['readBlob']) => act(async () => root.render(React.createElement(ThemeProvider, null,
    <UiBlockCard block={{kind: 'block', html: `<img src="${source}" onload="agent.send('recovered')"><img src="${loaded}" onload="agent.send('ready')">`}}
      files={{ oids, readBlob }} onSendMessage={async () => {}} onHeightChange={() => {}} scrollRoot={{ current: null }} />
  )))
  await show(readBlob)
  await expect.poll(() => readBlob.mock.calls.length).toBe(2)
  await expect.poll(() => host.textContent!.includes('Connection lost')).toBe(status === 'failed')
  await expect.poll(() => host.textContent).toContain('ready')
  const iframe = host.querySelector('iframe')
  const reconnected = vi.fn<Overseer['readBlob']>(async () => byteStream(png('cyan')))
  await show(reconnected)
  await expect.poll(() => host.textContent).toContain('recovered')
  expect(reconnected).toHaveBeenCalledExactlyOnceWith(a)
  expect(host.querySelector('iframe')).toBe(iframe)
  expect(host.textContent).not.toContain('Connection lost')
  if (controller) {
    controller.enqueue(Uint8Array.of(1))
  }
  await expect.poll(() => cancel.mock.calls.length).toBe(status === 'interrupted' ? 1 : 0)
  await show(vi.fn<Overseer['readBlob']>())
  expect(host.querySelector('iframe')).toBe(iframe)
  expect(host.textContent).toContain('recovered')
})


it.each(['utf-16le', 'utf-16be', 'namespace'])('decodes a valid %s SVG in an inline view', async encoding => {
  const svg = '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="17" height="19"/>'
  let bytes = new TextEncoder().encode(svg)
  if (encoding !== 'namespace') {
    bytes = new Uint8Array(2 + svg.length * 2)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 0xfeff, encoding === 'utf-16le')
    for (let i = 0; i < svg.length; i++) view.setUint16(2 + i * 2, svg.charCodeAt(i), encoding === 'utf-16le')
  }
  const sent: string[] = []
  await openBlock(observedImage('vector', 'worktree://OUTPUTS/vector.svg'), {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {},
    readImage: async () => ({oid: 'a'.repeat(40), stream: byteStream(bytes)}),
  })
  await expect.poll(() => sent.some(message => message.startsWith('vector:17:blob:'))).toBe(true)
})


it.each(['data', 'worktree'])('preserves dimensions authored on %s images in existing views', async kind => {
  const bytes = png('cyan')
  const source = kind === 'data'
    ? 'data:image/png;base64,' + btoa(String.fromCharCode(...bytes)) : 'worktree://OUTPUTS/image.png'
  const sent: string[] = []
  await openBlock(`<img src="${source}" width="60" height="20" onload="const r = this.getBoundingClientRect(); agent.send(r.width + 'x' + r.height)">`, {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {},
    readImage: async () => ({oid: 'a'.repeat(40), stream: byteStream(bytes)}),
  })
  await expect.poll(() => sent).toEqual(['60x20'])
})


it('lets a view override responsive image defaults with its own stylesheet', async () => {
  const sent: string[] = []
  await openBlock('<style>.thumb { width: 60px; height: 20px; max-width: 40px; }</style>' +
    '<img class="thumb" src="worktree://OUTPUTS/image.png" onload="const r = this.getBoundingClientRect(); agent.send(r.width + \'x\' + r.height)">', {
    onMessageRequest: message => sent.push(message), onResize: () => {}, onError: () => {},
    readImage: async () => ({oid: 'a'.repeat(40), stream: byteStream(png('cyan'))}),
  })
  await expect.poll(() => sent).toEqual(['40x20'])
})
