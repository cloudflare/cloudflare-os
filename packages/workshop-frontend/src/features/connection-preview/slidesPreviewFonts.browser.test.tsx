// The Google Slides preview draws a deck in its own fonts, which its session hands it as bytes: the
// gadget UI frame has no network. This holds the frame to taking them: under the frame's own
// content policy, which names no font source, in its own sandbox.

import { afterEach, expect, it } from 'vitest'
import FONT_URL from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'
import { SANDBOX_HEAD } from '../../sandboxDocument'

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

// Run inside the frame: registers the bytes it is sent, and measures a word with and without them.
const PROBE = `
  addEventListener('message', async ({ data }) => {
    const report = result => parent.postMessage({ fontProbe: result }, '*')
    try {
      const face = new FontFace('Probe', data.bytes, { weight: '700' })
      document.fonts.add(face)
      await face.load()
      const context = document.createElement('canvas').getContext('2d')
      const width = font => (context.font = font, context.measureText('Wide and narrow').width)
      report({ status: face.status, with: width('700 40px Probe, monospace'), without: width('700 40px monospace') })
    } catch (error) {
      report({ error: String(error) })
    }
  })
  parent.postMessage({ fontProbe: 'ready' }, '*')
`

it('lets the sandboxed frame register a font from bytes, with no font source in its policy', async () => {
  const bytes = await (await fetch(FONT_URL)).arrayBuffer()
  const answers: unknown[] = []
  const hear = (event: MessageEvent) => {
    if (event.source === frame?.contentWindow && event.data?.fontProbe) answers.push(event.data.fontProbe)
  }
  addEventListener('message', hear)
  try {
    frame = document.createElement('iframe')
    // As GadgetUI frames a gadget's UI: an opaque origin, and the policy in SANDBOX_HEAD.
    frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox')
    frame.srcdoc = `<!doctype html><html><head>${SANDBOX_HEAD}</head><body><script>${PROBE}</script></body></html>`
    document.body.append(frame)
    await expect.poll(() => answers[0]).toBe('ready')
    expect(SANDBOX_HEAD).not.toContain('font-src')
    frame.contentWindow!.postMessage({ bytes }, '*')
    await expect.poll(() => answers[1]).toBeDefined()

    const result = answers[1] as { status?: string, with?: number, without?: number, error?: string }
    expect(result.error).toBeUndefined()
    expect(result.status).toBe('loaded')
    expect(result.with).not.toBe(result.without)
  } finally {
    removeEventListener('message', hear)
  }
})
