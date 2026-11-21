/* eslint-disable react/react-in-jsx-scope */

// The Report issue dialog in Chromium, for what jsdom does not model: a capture of the tab with
// the dialog out of the picture, where focus is across it, the three ways an image gets in, and
// focus going back to the menu that opened the dialog. What the dialog offers and what it sends
// are tested in its jsdom suite.

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Toasty } from '@cloudflare/kumo'
import '../../styles.css'

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {},
    logout: () => {},
    currentUser: { id: 'rita', name: 'Rita Reporter' },
    isAdmin: false,
  }),
}))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => ({ adminContentGrants: true }),
}))
vi.mock('../../useAvatar', () => ({ useAvatar: () => null }))

import UserMenu from '../../components/UserMenu'
import { ReportIssueDialog } from './ReportIssueDialog'
import { ReportIssueProvider } from './ReportIssueHost'

let host: HTMLDivElement | undefined
let root: Root | undefined

const render = async (ui: ReactNode) => {
  const base = createRootRoute({ component: () => <Toasty>{ui}</Toasty> })
  const router = createRouter({ routeTree: base, history: createMemoryHistory({ initialEntries: ['/'] }) })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => {
    await router.load()
    root!.render(<RouterProvider router={router} />)
  })
}

// The dialog as its host holds it: mounted until it says it has closed.
const Held = () => {
  const [open, setOpen] = useState(true)
  return open ? <ReportIssueDialog context={{}} onClosed={() => setOpen(false)} /> : null
}

const popup = () => {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  if (element === null) throw new Error('no dialog')
  return element
}
// Whatever Kumo puts beside the popup to cover the page.
const backdrops = () =>
  [...popup().parentElement!.querySelectorAll<HTMLElement>(':scope > [role="presentation"]')]
const visibilities = () => [popup(), ...backdrops()].map((element) => getComputedStyle(element).visibility)
const previews = () => [...popup().querySelectorAll<HTMLImageElement>('li img')]
const captureButton = () => page.getByRole('button', { name: 'Capture this tab' })
const addButton = () => page.getByRole('button', { name: 'Add images' })
const fileInput = () => popup().querySelector<HTMLInputElement>('input[type="file"]')!
const problems = () => [...popup().querySelectorAll('[role="alert"] li')].map((item) => item.textContent)

const pngFile = async (name: string): Promise<File> => {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  canvas.getContext('2d')!.fillRect(0, 0, 8, 8)
  const blob = await new Promise<Blob>((resolve) => { canvas.toBlob((made) => resolve(made!), 'image/png') })
  return new File([blob], name, { type: 'image/png' })
}

const transferOf = (...files: File[]) => {
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  return transfer
}
const paste = (...files: File[]) => act(async () => {
  popup().querySelector('textarea')!.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transferOf(...files), bubbles: true, cancelable: true }),
  )
})
const dropOnDialog = (...files: File[]) => act(async () => {
  const dataTransfer = transferOf(...files)
  const under = popup().querySelector('form')!
  for (const type of ['dragenter', 'dragover', 'drop']) {
    under.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }))
  }
})
const attachImages = async (count: number) => {
  const files = await Promise.all(Array.from({ length: count }, (_, index) => pngFile(`image-${index + 1}.png`)))
  await userEvent.upload(fileInput(), files)
  await expect.poll(() => previews().length).toBe(count)
}

const pressEscape = () => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

/**
 * A screen to capture, in place of the browser's prompt: a canvas that keeps changing, as a
 * moving page does, and a stream of it for each prompt. A prompt is answered at once, declined at
 * once, or left unanswered until `answer()`. `seen` records what the capture drew a frame of:
 * whether the dialog and its backdrop were in sight, whether the dialog was inert, and whether
 * focus was in it; `whileHidden` runs at that moment. `stopped` spies on every track handed out.
 */
const fakeScreen = (options: {
  prompt?: 'answered' | 'declined' | 'unanswered'
  drawing?: 'works' | 'fails'
  whileHidden?: () => void
} = {}) => {
  const source = document.createElement('canvas')
  source.width = 64
  source.height = 48
  const pen = source.getContext('2d')!
  let ticks = 0
  const paint = () => {
    pen.fillStyle = ticks++ % 2 === 0 ? 'black' : 'white'
    pen.fillRect(0, 0, source.width, source.height)
  }
  paint()
  const painting = setInterval(paint, 10)
  const stopped: ReturnType<typeof vi.spyOn>[] = []
  const unanswered: (() => void)[] = []

  const getDisplayMedia = vi.fn<(options?: DisplayMediaStreamOptions) => Promise<MediaStream>>(async () => {
    if (options.prompt === 'declined') throw new DOMException('Permission denied', 'NotAllowedError')
    if (options.prompt === 'unanswered') await new Promise<void>((resolve) => { unanswered.push(resolve) })
    const stream = source.captureStream(60)
    stopped.push(...stream.getTracks().map((track) => vi.spyOn(track, 'stop')))
    return stream
  })
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: getDisplayMedia })

  const seen: { visibility: string[]; inert: boolean; focusInside: boolean }[] = []
  const drawImage = CanvasRenderingContext2D.prototype.drawImage
  vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(
    function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (args[0] instanceof HTMLVideoElement) {
        // A frame can be drawn with no dialog left, which is a picture nobody asked for.
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
        seen.push({
          visibility: dialog === null ? [] : visibilities(),
          inert: dialog?.inert === true,
          focusInside: dialog?.contains(document.activeElement) === true,
        })
        options.whileHidden?.()
        if (options.drawing === 'fails') throw new Error('The frame could not be drawn.')
      }
      return Reflect.apply(drawImage, this, args)
    },
  )
  return {
    getDisplayMedia,
    stopped,
    seen,
    /** Answers every prompt that waits, the oldest first. */
    answer: () => { for (const resolve of unanswered.splice(0)) resolve() },
    stop: () => clearInterval(painting),
  }
}

let screen: ReturnType<typeof fakeScreen> | undefined

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  screen?.stop()
  screen = undefined
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator.mediaDevices, 'getDisplayMedia')
})

describe('capturing this tab', () => {
  it('adds one picture of the page, with the dialog out of it, and gives the button focus back', async () => {
    screen = fakeScreen()
    await render(<Held />)
    await userEvent.fill(page.getByLabelText('What went wrong?'), 'The export button does nothing')

    captureButton().element().focus()
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => previews().length).toBe(1)

    expect(screen.getDisplayMedia).toHaveBeenCalledOnce()
    expect(screen.getDisplayMedia.mock.calls[0][0]).toMatchObject({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
    })
    for (const stop of screen.stopped) expect(stop).toHaveBeenCalledOnce()

    // What the one frame was drawn of: neither the dialog nor its backdrop, and a dialog no key
    // press could reach.
    expect(screen.seen).toHaveLength(1)
    expect(screen.seen[0].visibility.length).toBeGreaterThanOrEqual(2)
    expect(new Set(screen.seen[0].visibility)).toEqual(new Set(['hidden']))
    expect(screen.seen[0].inert).toBe(true)
    expect(screen.seen[0].focusInside).toBe(false)

    // The backdrop's own transition reads as its starting value for one frame.
    await expect.poll(() => new Set(visibilities())).toEqual(new Set(['visible']))
    expect(popup().inert).toBe(false)
    expect(document.activeElement).toBe(captureButton().element())
    await expect.element(page.getByLabelText('What went wrong?')).toHaveValue('The export button does nothing')
    expect(problems()).toEqual([])
  })

  it('puts the dialog and focus back when the frame cannot be drawn', async () => {
    screen = fakeScreen({ drawing: 'fails' })
    await render(<Held />)

    captureButton().element().focus()
    await userEvent.keyboard('{Enter}')
    await expect.poll(problems).toEqual(['Couldn’t capture this tab.'])

    expect(screen.seen).toHaveLength(1)
    expect(new Set(screen.seen[0].visibility)).toEqual(new Set(['hidden']))
    expect(previews()).toHaveLength(0)
    for (const stop of screen.stopped) expect(stop).toHaveBeenCalledOnce()
    await expect.poll(() => new Set(visibilities())).toEqual(new Set(['visible']))
    expect(popup().inert).toBe(false)
    expect(document.activeElement).toBe(captureButton().element())
  })

  it('adds nothing, says nothing and never hides the dialog when the prompt is declined', async () => {
    screen = fakeScreen({ prompt: 'declined' })
    await render(<Held />)

    await userEvent.click(captureButton())
    await expect.poll(() => screen!.getDisplayMedia.mock.calls.length).toBe(1)
    // Time enough for a capture that had started to hide the dialog and draw.
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(previews()).toHaveLength(0)
    expect(problems()).toEqual([])
    expect(screen.seen).toEqual([])
    expect(new Set(visibilities())).toEqual(new Set(['visible']))
    expect(popup().inert).toBe(false)
  })

  it('leaves focus on the new preview’s Remove button when the capture fills the last slot', async () => {
    screen = fakeScreen()
    await render(<Held />)
    await attachImages(4)

    captureButton().element().focus()
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => previews().length).toBe(5)

    await expect.element(captureButton()).toBeDisabled()
    await expect.poll(() => document.activeElement?.getAttribute('aria-label')).toBe('Remove Tab capture 1')
  })

  it('ignores Escape while it is out of sight for the capture', async () => {
    screen = fakeScreen({ whileHidden: pressEscape })
    await render(<Held />)

    await userEvent.click(captureButton())
    await expect.poll(() => previews().length).toBe(1)
    expect(screen.seen).toHaveLength(1)
    expect(new Set(screen.seen[0].visibility)).toEqual(new Set(['hidden']))
    await expect.poll(() => new Set(visibilities())).toEqual(new Set(['visible']))

    // The same key press closes the dialog once it is back.
    await act(async () => { pressEscape() })
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes under a prompt that is never answered, and takes no picture if it is answered later', async () => {
    screen = fakeScreen({ prompt: 'unanswered' })
    await render(<Held />)

    await userEvent.click(captureButton())
    await expect.poll(() => screen!.getDisplayMedia.mock.calls.length).toBe(1)
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }))
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull()

    screen.answer()
    // The capture is stopped before a frame of it could be drawn.
    await expect.poll(() => screen!.stopped.length).toBe(1)
    await expect.poll(() => screen!.stopped[0].mock.calls.length).toBe(1)
    expect(screen.seen).toEqual([])
  })

  it('asks again at a second press, and only the latest press takes a picture', async () => {
    screen = fakeScreen({ prompt: 'unanswered' })
    await render(<Held />)

    await userEvent.click(captureButton())
    await userEvent.click(captureButton())
    await expect.poll(() => screen!.getDisplayMedia.mock.calls.length).toBe(2)

    screen.answer()
    await expect.poll(() => previews().map((image) => image.alt)).toEqual(['Tab capture 1'])
    expect(screen.seen).toHaveLength(1)
    expect(screen.stopped.length).toBeGreaterThanOrEqual(2)
    for (const stop of screen.stopped) expect(stop).toHaveBeenCalledOnce()
    expect(problems()).toEqual([])
  })

  it('is not offered by a browser that cannot capture', async () => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: undefined })
    await render(<Held />)

    await expect.element(addButton()).toBeVisible()
    expect(captureButton().query()).toBeNull()
  })
})

describe('opening', () => {
  it('starts with focus in "What went wrong?"', async () => {
    await render(<Held />)
    const field = page.getByLabelText('What went wrong?')
    await expect.element(field).toBeVisible()
    // Time enough for the dialog's own focus handling, which would pick the Close button.
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(document.activeElement).toBe(field.element())
  })
})

describe('the three ways an image gets in', () => {
  it('takes a picked, a pasted and a dropped image, each as one preview', async () => {
    await render(<Held />)
    expect(fileInput().accept).toBe('image/png,image/jpeg,image/webp')

    await userEvent.upload(page.getByLabelText('Images to attach'), await pngFile('picked.png'))
    await expect.poll(() => previews().map((image) => image.alt)).toEqual(['picked.png'])

    await paste(await pngFile('pasted.png'))
    await expect.poll(() => previews().map((image) => image.alt)).toEqual(['picked.png', 'pasted.png'])

    await dropOnDialog(await pngFile('dropped.png'))
    await expect.poll(() => previews().map((image) => image.alt))
      .toEqual(['picked.png', 'pasted.png', 'dropped.png'])
    expect(problems()).toEqual([])
  })

  it('refuses a file that is not an image a report takes, and says why', async () => {
    await render(<Held />)
    await userEvent.upload(
      page.getByLabelText('Images to attach'),
      new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' }),
    )

    await expect.poll(problems).toEqual(['notes.pdf: Only PNG, JPEG and WebP images can be attached.'])
    expect(previews()).toHaveLength(0)
  })
})

describe('five images', () => {
  it('takes no sixth, and takes one more once a preview is removed', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    screen = fakeScreen()
    await render(<Held />)
    await attachImages(5)

    expect(fileInput().disabled).toBe(true)
    await expect.element(addButton()).toBeDisabled()
    await expect.element(captureButton()).toBeDisabled()

    await paste(await pngFile('pasted-sixth.png'))
    await expect.poll(problems).toEqual(['A report takes at most 5 images.'])
    await dropOnDialog(await pngFile('dropped-sixth.png'))
    await expect.poll(problems).toEqual(['A report takes at most 5 images.'])
    expect(previews()).toHaveLength(5)

    const urls = previews().map((image) => image.src)
    expect(revoke).not.toHaveBeenCalled()
    await userEvent.click(page.getByRole('button', { name: 'Remove image-2.png' }))

    await expect.poll(() => previews().map((image) => image.alt))
      .toEqual(['image-1.png', 'image-3.png', 'image-4.png', 'image-5.png'])
    expect(revoke.mock.calls).toEqual([[urls[1]]])
    expect(fileInput().disabled).toBe(false)
    await expect.element(addButton()).toBeEnabled()
    await expect.element(captureButton()).toBeEnabled()
    // The Remove button went with its preview: focus stays in the dialog.
    expect(document.activeElement).toBe(addButton().element())

    await paste(await pngFile('one-more.png'))
    await expect.poll(() => previews().length).toBe(5)
    const kept = previews().map((image) => image.src)

    await userEvent.click(page.getByRole('button', { name: 'Close' }))
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull()
    expect(revoke.mock.calls.map(([url]) => url).toSorted()).toEqual([urls[1], ...kept].toSorted())
  })
})

describe('opened from the user menu', () => {
  it('gives focus back to the menu’s trigger once it has closed', async () => {
    await render(<ReportIssueProvider><UserMenu /></ReportIssueProvider>)
    const trigger = page.getByRole('button', { name: 'Open profile menu' })

    await userEvent.click(trigger)
    await userEvent.click(page.getByRole('menuitem', { name: 'Report issue' }))
    await expect.element(page.getByRole('dialog', { name: 'Report issue' })).toBeVisible()
    // The item that opened the dialog went with its menu.
    expect(page.getByRole('menuitem', { name: 'Report issue' }).query()).toBeNull()

    await userEvent.keyboard('{Escape}')
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull()
    await expect.poll(() => document.activeElement).toBe(trigger.element())
  })
})
