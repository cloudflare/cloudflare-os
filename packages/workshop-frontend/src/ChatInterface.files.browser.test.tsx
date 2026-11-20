import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { AgentAnswer, MarkdownMessage } from './ChatInterface'
import type { FileSnapshots } from './features/chat/inlineFiles'

let host: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  window.scrollTo(0, 0)
  vi.restoreAllMocks()
})

const show = async (message: string, files?: FileSnapshots) => {
  if (!host) {
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
  }
  await act(async () => root!.render(React.createElement(MarkdownMessage, { message, files })))
}
const image = (alt: string) => host?.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(bytes); controller.close() },
})
const png = (color: string): Uint8Array => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2
  const context = canvas.getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 2, 2)
  return Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0))
}
const pixel = (picture: HTMLImageElement | null | undefined) => {
  if (!picture?.naturalWidth) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')!
  context.drawImage(picture, 0, 0)
  return [...context.getImageData(0, 0, 1, 1).data]
}

const captureDownloads = () => {
  const downloads: { name: string; response: Promise<Response> }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, response: fetch(this.href) })
  })
  return downloads
}

it.each([
  ['results.csv', new TextEncoder().encode('name,value\nexample,42\n')],
  ['archive.zip', Uint8Array.of(80, 75, 3, 4, 0, 255, 128)],
  ['empty.bin', new Uint8Array()],
  ['report.html', new TextEncoder().encode('<script>throw new Error("must download, never execute")</script>')],
])('downloads a pinned %s only when the viewer clicks its link', async (name, bytes) => {
  const source = `worktree://OUTPUTS/${name}`, oid = 'a'.repeat(40)
  const readBlob = vi.fn<Overseer['readBlob']>(async () => stream(bytes))
  const downloads = captureDownloads()
  await show(`[Download](${source})`, { oids: { [source]: oid }, readBlob })
  expect(readBlob).not.toHaveBeenCalled()
  const link = host!.querySelector<HTMLElement>('[role="link"]')
  expect(link).not.toBeNull()
  await act(async () => link!.click())
  await expect.poll(() => downloads.length).toBe(1)
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
  expect(downloads[0]!.name).toBe(name)
  const response = await downloads[0]!.response
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
})

it('downloads the saved version of normalized reference links after later edits, deletion and reopening', async () => {
  const source = 'worktree://REPO/output/%C3%BC%20report.csv', a = 'a'.repeat(40), b = 'b'.repeat(40)
  const bytes = new Map([[a, Uint8Array.of(0, 255, 1)], [b, Uint8Array.of(0, 255, 2)]])
  const readBlob = vi.fn<Overseer['readBlob']>(async oid => stream(bytes.get(oid)!))
  const downloads = captureDownloads()
  const markdown = '[Download][result]\n\n[result]: <worktree://REPO/output/ü report.csv>\n'
  const original = { oids: { [source]: a }, readBlob }
  for (const files of [original, { oids: { [source]: b }, readBlob }, original]) {
    await show(markdown, files)
    await act(async () => host!.querySelector<HTMLElement>('[role="link"]')!.click())
    await expect.poll(() => downloads.length).toBe(readBlob.mock.calls.length)
    await show('File has since changed or been deleted.')
  }
  expect(readBlob.mock.calls.map(([oid]) => oid)).toEqual([a, b, a])
  expect(downloads.map(download => download.name)).toEqual(['ü report.csv', 'ü report.csv', 'ü report.csv'])
  expect(await Promise.all(downloads.map(async download =>
    [...new Uint8Array(await (await download.response).arrayBuffer())]))).toEqual([[0, 255, 1], [0, 255, 2], [0, 255, 1]])
})

it('downloads a pinned file link from a GFM footnote', async () => {
  const source = 'worktree://OUTPUTS/report.csv', oid = 'a'.repeat(40)
  const readBlob = vi.fn<Overseer['readBlob']>(async () => stream(new TextEncoder().encode('report')))
  const downloads = captureDownloads()
  await show(`See the report.[^report]\n\n[^report]: [Download](${source})`, { oids: { [source]: oid }, readBlob })
  expect(readBlob).not.toHaveBeenCalled()
  await act(async () => host!.querySelector<HTMLElement>('[role="link"]')!.click())
  await expect.poll(() => downloads.length).toBe(1)
  expect(await (await downloads[0]!.response).text()).toBe('report')
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
})

it('cancels an unfinished file download when its message leaves', async () => {
  const source = 'worktree://REPO/large.zip', cancel = vi.fn<() => void>()
  const readBlob = vi.fn<Overseer['readBlob']>(async () => new ReadableStream({
    start(controller) { controller.enqueue(Uint8Array.of(80, 75)) }, cancel,
  }))
  const downloads = captureDownloads()
  await show(`[Archive](${source})`, { oids: { [source]: 'a'.repeat(40) }, readBlob })
  await act(async () => host!.querySelector<HTMLElement>('[role="link"]')!.click())
  await expect.poll(() => readBlob.mock.calls.length).toBe(1)
  await show('Another message.')
  await expect.poll(() => cancel.mock.calls.length).toBe(1)
  expect(downloads).toEqual([])
})

it('reports a failed download and retries the same pinned blob only on another click', async () => {
  const source = 'worktree://REPO/archive.zip', oid = 'a'.repeat(40)
  const readBlob = vi.fn<Overseer['readBlob']>()
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockImplementation(async () => stream(Uint8Array.of(0, 255)))
  const downloads = captureDownloads()
  await show(`[Archive](${source})`, { oids: { [source]: oid }, readBlob })
  await act(async () => host!.querySelector<HTMLElement>('[role="link"]')!.click())
  await expect.poll(() => host!.querySelector('[role="alert"]')?.textContent).toContain('Connection lost')
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
  expect(downloads).toEqual([])
  await act(async () => host!.querySelector<HTMLElement>('[role="link"]')!.click())
  await expect.poll(() => downloads.length).toBe(1)
  expect(readBlob.mock.calls.map(([value]) => value)).toEqual([oid, oid])
  expect(host!.querySelector('[role="alert"]')).toBeNull()
})

it('embeds a snapshotted path without a frame and preserves its bytes when reopened', async () => {
  const source = 'worktree://REPO/pictures/result.png', a = 'a'.repeat(40), b = 'b'.repeat(40)
  const bytes = new Map([[a, png('red')], [b, png('cyan')]])
  const readBlob = vi.fn<Overseer['readBlob']>(async oid => stream(bytes.get(oid)!))
  const oldReply = { oids: { [source]: a }, readBlob }
  const markdown = `Here is the result:\n\n![Result](${source})`
  await show('Here is the result:\n\n![Result](worktree://REPO/pictures/', oldReply)
  expect(readBlob).not.toHaveBeenCalled()
  await show(markdown, oldReply)
  await expect.poll(() => pixel(image('Result'))).toEqual([255, 0, 0, 255])
  expect(image('Result')!.dataset.blobOid).toBe(a)
  expect(host!.querySelector('iframe')).toBeNull()
  expect(readBlob.mock.calls.map(([oid]) => oid)).toEqual([a])
  await show(markdown + '\nMore text.', { ...oldReply })
  expect(readBlob).toHaveBeenCalledTimes(1)
  // A later reply to the same path carries a new host snapshot. The old reply still has A.
  await show(markdown, { oids: { [source]: b }, readBlob })
  await expect.poll(() => pixel(image('Result'))).toEqual([0, 255, 255, 255])
  await show('Another message.')
  await show(markdown, oldReply)
  await expect.poll(() => pixel(image('Result'))).toEqual([255, 0, 0, 255])
})

it('loads a large pinned image through a Blob with only a bounded JavaScript header read', async () => {
  const source = 'worktree://OUTPUTS/large.png', oid = 'a'.repeat(40)
  vi.spyOn(Response.prototype, 'arrayBuffer').mockRejectedValue(new Error('Whole-image arrays are forbidden'))
  const sizes: number[] = [], arrayBuffer = Blob.prototype.arrayBuffer
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function (this: Blob) {
    sizes.push(this.size)
    return arrayBuffer.call(this)
  })
  const readBlob = vi.fn<Overseer['readBlob']>(async () => new ReadableStream({
    start(controller) {
      controller.enqueue(png('cyan'))
      const padding = new Uint8Array(1024 * 1024)
      for (let i = 0; i < 16; i++) controller.enqueue(padding)
      controller.close()
    },
  }))
  await show(`![Large](${source})`, { oids: { [source]: oid }, readBlob })
  await expect.poll(() => pixel(image('Large'))).toEqual([0, 255, 255, 255])
  expect(sizes.length).toBeGreaterThan(0)
  expect(Math.max(...sizes)).toBeLessThanOrEqual(1024)
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
})

it('cancels an in-progress byte download when its snapshot leaves and releases the final object URL', async () => {
  const source = 'worktree://REPO/result.png', a = 'a'.repeat(40), b = 'b'.repeat(40)
  const cancel = vi.fn<() => void>()
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  const readBlob = vi.fn<Overseer['readBlob']>(async oid => oid === a
    ? new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(137, 80)) }, cancel })
    : stream(png('cyan')))
  const markdown = `![Result](${source})`
  await show(markdown, { oids: { [source]: a }, readBlob })
  await expect.poll(() => readBlob.mock.calls.length).toBe(1)
  await show(markdown, { oids: { [source]: b }, readBlob })
  await expect.poll(() => cancel.mock.calls.length).toBe(1)
  await expect.poll(() => pixel(image('Result'))).toEqual([0, 255, 255, 255])
  const url = image('Result')!.src
  await show('Done.')
  await expect.poll(() => revoke.mock.calls.some(([value]) => value === url)).toBe(true)
})

it.each(['failed', 'interrupted'])('retries after a %s image read on reconnect without refetching a loaded image', async status => {
  const source = 'worktree://REPO/result.png', oid = 'a'.repeat(40)
  const cancel = vi.fn<() => void>()
  const readBlob = vi.fn<Overseer['readBlob']>(async () => {
    if (status === 'failed') throw new Error('Connection lost')
    return new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(137, 80)) }, cancel })
  })
  const markdown = `![Result](${source})`, oids = { [source]: oid }
  await show(markdown, { oids, readBlob })
  await expect.poll(() => readBlob.mock.calls.length).toBe(1)
  await expect.poll(() => host!.textContent!.includes('Image unavailable')).toBe(status === 'failed')
  const reconnected = vi.fn<Overseer['readBlob']>(async () => stream(png('cyan')))
  await show(markdown, { oids, readBlob: reconnected })
  await expect.poll(() => pixel(image('Result'))).toEqual([0, 255, 255, 255])
  expect(reconnected).toHaveBeenCalledExactlyOnceWith(oid)
  expect(cancel).toHaveBeenCalledTimes(status === 'interrupted' ? 1 : 0)
  const nextReader = vi.fn<Overseer['readBlob']>()
  await show(markdown + '\nMore text.', { oids, readBlob: nextReader })
  expect(nextReader).not.toHaveBeenCalled()
  expect(pixel(image('Result'))).toEqual([0, 255, 255, 255])
})

it.each([
  ['![Result](worktree://REPO/ü.png)', 'worktree://REPO/%C3%BC.png'],
  ['![Result](<worktree://REPO/my image.png>)', 'worktree://REPO/my%20image.png'],
  ['![Result][picture]\n\n[picture]: <worktree://REPO/ü image.png>\n', 'worktree://REPO/%C3%BC%20image.png'],
])('loads the host snapshot for a normalized Markdown image: %s', async (markdown, source) => {
  const oid = 'a'.repeat(40)
  const readBlob = vi.fn<Overseer['readBlob']>(async () => stream(png('red')))
  await show(markdown, { oids: { [source]: oid }, readBlob })
  await expect.poll(() => pixel(image('Result'))).toEqual([255, 0, 0, 255])
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
})

it.each(['', '<?xml-stylesheet type="text/css" href="style.css"?>', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'])(
  'shows a snapshotted SVG with prolog %s without creating an origin-bearing SVG blob URL', async doctype => {
  const source = 'worktree://REPO/vector.svg'
  const bytes = new TextEncoder().encode('<?xml version="1.0"?>' + '<!-- comment -->'.repeat(10) + doctype +
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="19"/>')
  const readBlob = vi.fn<Overseer['readBlob']>(async () => stream(bytes))
  await show(`![Vector](${source})`, { oids: { [source]: 'a'.repeat(40) }, readBlob })
  await expect.poll(() => image('Vector')?.naturalWidth).toBe(17)
  expect(image('Vector')!.naturalHeight).toBe(19)
  expect(image('Vector')!.src).toMatch(/^data:image\/svg\+xml/)
})

it('never looks up an unavailable path and keeps raw HTML, other schemes and unsafe links disabled', async () => {
  const readBlob = vi.fn<Overseer['readBlob']>()
  await show('![Unavailable](worktree://REPO/missing.png)\n\n![Unsafe](javascript:alert%281%29)\n\n' +
    '![Old scheme](worktree:REPO/image.png) ![Hash](git-blob:' + 'a'.repeat(40) + ')\n\n' +
    '[Local link](worktree://REPO/result.png)\n\n<img src="file:///secret">', {
    oids: { 'worktree://REPO/missing.png': null }, readBlob,
  })
  expect(host!.textContent).toContain('Image unavailable: Unavailable')
  expect(readBlob).not.toHaveBeenCalled()
  expect(host!.querySelector('img[src], a[href]')).toBeNull()
  await show('![No capability](worktree://REPO/result.png)')
  expect(host!.textContent).toBe('No capability')
  expect(host!.querySelector('img')).toBeNull()
})


it('waits to read historical images until the viewer nears them', async () => {
  const source = 'worktree://REPO/old.png', oid = 'a'.repeat(40)
  const readBlob = vi.fn<Overseer['readBlob']>(async () => stream(png('cyan')))
  await show('Setting up history.')
  host!.style.marginTop = '10000px'
  await show(`![Historical](${source})`, { oids: { [source]: oid }, readBlob })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(readBlob).not.toHaveBeenCalled()
  host!.scrollIntoView()
  await expect.poll(() => image('Historical')?.naturalWidth).toBe(2)
  expect(readBlob).toHaveBeenCalledExactlyOnceWith(oid)
})


it('keeps a reader following the latest reply at the bottom after delayed image layout', async () => {
  await show('Preparing result.')
  host!.style.cssText = 'height:180px;overflow:auto'
  const source = 'worktree://OUTPUTS/tall.svg', oid = 'a'.repeat(40)
  const ready = Promise.withResolvers<void>(), reading = Promise.withResolvers<void>()
  const readBlob = vi.fn<Overseer['readBlob']>(async () => {
    reading.resolve()
    await ready.promise
    return stream(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="500"/>'))
  })
  const keepAtBottom = vi.fn<() => void>(() => { host!.scrollTop = host!.scrollHeight })
  await act(async () => root!.render(<>
    <div style={{ height: 800 }}>Earlier replies</div>
    <AgentAnswer message={`![Result](${source})`} streaming={false} blocks={{
      scrollRoot: { current: host! }, onHeightChange: keepAtBottom,
      onSendMessage: async () => {}, files: { oids: { [source]: oid }, readBlob },
    }} />
  </>))
  host!.scrollTop = host!.scrollHeight
  await reading.promise
  ready.resolve()
  await expect.poll(() => image('Result')?.naturalHeight).toBe(500)
  await expect.poll(() => host!.scrollHeight - host!.clientHeight - host!.scrollTop).toBeLessThan(2)
  expect(keepAtBottom).toHaveBeenCalled()
})

it.each(['utf-16le', 'utf-16be', 'namespace'])('decodes a valid %s SVG header with originless image URLs', async encoding => {
  const svg = '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="17" height="19"/>'
  let bytes = new TextEncoder().encode(svg)
  if (encoding !== 'namespace') {
    bytes = new Uint8Array(2 + svg.length * 2)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 0xfeff, encoding === 'utf-16le')
    for (let i = 0; i < svg.length; i++) view.setUint16(2 + i * 2, svg.charCodeAt(i), encoding === 'utf-16le')
  }
  const source = 'worktree://OUTPUTS/vector.svg'
  await show(`![Vector](${source})`, { oids: { [source]: 'a'.repeat(40) }, readBlob: async () => stream(bytes) })
  await expect.poll(() => image('Vector')?.naturalWidth).toBe(17)
  expect(image('Vector')!.naturalHeight).toBe(19)
  expect(image('Vector')!.src).toMatch(/^data:image\/svg\+xml/)
})


it('retains keyboard focus during a delayed download and permits retry after failure', async () => {
  const source = 'worktree://OUTPUTS/report.csv', oid = 'a'.repeat(40)
  const pending = Promise.withResolvers<ReadableStream<Uint8Array>>()
  const readBlob = vi.fn<Overseer['readBlob']>().mockReturnValueOnce(pending.promise)
    .mockImplementation(async () => stream(new TextEncoder().encode('report')))
  const downloads = captureDownloads()
  await show(`[Download](${source})`, { oids: { [source]: oid }, readBlob })
  const link = host!.querySelector<HTMLButtonElement>('[role="link"]')!
  link.focus()
  await act(async () => userEvent.keyboard('{Enter}'))
  await expect.poll(() => readBlob.mock.calls.length).toBe(1)
  expect(document.activeElement).toBe(link)
  await act(async () => userEvent.keyboard('{Enter}'))
  expect(readBlob).toHaveBeenCalledTimes(1)
  pending.reject(new Error('Connection lost'))
  await expect.poll(() => host!.querySelector('[role="alert"]')?.textContent).toContain('Connection lost')
  expect(document.activeElement).toBe(link)
  await act(async () => userEvent.keyboard('{Enter}'))
  await expect.poll(() => downloads.length).toBe(1)
  expect(document.activeElement).toBe(link)
  expect(readBlob).toHaveBeenCalledTimes(2)
})
