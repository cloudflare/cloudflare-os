// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_FRAME_WAIT_MS, CAPTURE_START_WAIT_MS, canCaptureTab, captureTab } from './captureTab'

// The second animation frame's timestamp in every test: when the hidden dialog has been painted.
const PAINTED_AT = 1016

type FrameMetadata = { captureTime?: number; presentationTime: number }
type FrameCallback = (now: number, metadata: FrameMetadata) => void

// Lets everything that is ready to run do so, without moving the clock.
const settle = () => vi.advanceTimersByTimeAsync(0)

/**
 * A capture whose every clock the test turns by hand: the browser's prompt, the page's animation
 * frames, the frames the capture delivers to the video, and timers. `log` records, in order,
 * what the capture did to the dialog, the tracks and the picture.
 */
const fakeCapture = (options: { frameCallbacks?: boolean } = {}) => {
  const log: string[] = []
  let endTrack: (() => void) | undefined
  const track = {
    stop: vi.fn<() => void>(() => { log.push('stop') }),
    addEventListener: vi.fn<(type: string, listener: () => void) => void>((_type, listener) => { endTrack = listener }),
  }
  const stream = { getTracks: () => [track] }
  let answerPrompt!: (stream: unknown) => void
  let declinePrompt!: (reason: unknown) => void
  const getDisplayMedia = vi.fn<(options: unknown) => Promise<unknown>>(() => new Promise((resolve, reject) => {
    answerPrompt = resolve
    declinePrompt = reject
  }))
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } })

  const videoFrames = new Map<number, FrameCallback>()
  let handles = 0
  const video = {
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    videoWidth: 640,
    videoHeight: 360,
    play: vi.fn<() => Promise<void>>(async () => {}),
    ...(options.frameCallbacks === false ? {} : {
      requestVideoFrameCallback: vi.fn<(callback: FrameCallback) => number>((callback) => {
        videoFrames.set(++handles, callback)
        return handles
      }),
      cancelVideoFrameCallback: vi.fn<(handle: number) => void>((handle) => {
        if (videoFrames.delete(handle)) log.push('cancel-frame')
      }),
    }),
  }
  const drawImage = vi.fn<(...args: unknown[]) => void>(() => { log.push('draw') })
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: (done: (blob: Blob) => void, type: string) => done(new Blob(['picture'], { type })),
  }
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => (
    tag === 'video' ? video : tag === 'canvas' ? canvas : createElement(tag)
  ) as HTMLElement)

  const animationFrames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => animationFrames.push(callback))

  const restore = vi.fn<() => void>(() => { log.push('restore') })
  const hide = vi.fn<() => () => void>(() => {
    log.push('hide')
    return restore
  })
  const press = new AbortController()

  return {
    log,
    hide,
    restore,
    drawImage,
    getDisplayMedia,
    video,
    stream,
    videoFrames,
    start: () => captureTab({ hide, signal: press.signal }),
    /** Withdraws the press, as a later press or the dialog closing does. */
    withdraw: () => press.abort(),
    answerPrompt: async () => {
      answerPrompt(stream)
      await settle()
    },
    declinePrompt: async (reason: unknown) => {
      declinePrompt(reason)
      await settle()
    },
    animationFrame: async (timestamp: number) => {
      animationFrames.shift()!(timestamp)
      await settle()
    },
    /** Hides the dialog and paints it hidden: the prompt answered, then two animation frames. */
    paintHidden: async function () {
      await this.answerPrompt()
      await this.animationFrame(1000)
      await this.animationFrame(PAINTED_AT)
    },
    /** Delivers a frame of the capture to the one callback that waits for it. */
    videoFrame: async (metadata: FrameMetadata) => {
      const [[handle, callback]] = videoFrames
      videoFrames.delete(handle)
      callback(metadata.presentationTime, metadata)
      await settle()
    },
    endTrack: async () => {
      endTrack!()
      await settle()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

describe('captureTab', () => {
  it('asks the browser for this tab, once, with a prompt that prefers it', async () => {
    const capture = fakeCapture()
    void capture.start()
    expect(capture.getDisplayMedia).toHaveBeenCalledExactlyOnceWith({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    })
    await capture.declinePrompt(new DOMException('Permission denied', 'NotAllowedError'))
  })

  it('hides the dialog only once the prompt has resolved', async () => {
    const capture = fakeCapture()
    const picture = capture.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture.hide).not.toHaveBeenCalled()

    await capture.answerPrompt()
    expect(capture.hide).toHaveBeenCalledOnce()
    expect(capture.video.srcObject).toBe(capture.stream)

    await capture.animationFrame(1000)
    await capture.animationFrame(PAINTED_AT)
    await capture.videoFrame({ captureTime: PAINTED_AT, presentationTime: PAINTED_AT + 4 })
    await expect(picture).resolves.toBeInstanceOf(Blob)
  })

  it('draws nothing after one animation frame, nor after two', async () => {
    const capture = fakeCapture()
    void capture.start()
    await capture.answerPrompt()
    await capture.animationFrame(1000)
    expect(capture.drawImage).not.toHaveBeenCalled()
    expect(capture.videoFrames.size).toBe(0)

    await capture.animationFrame(PAINTED_AT)
    expect(capture.drawImage).not.toHaveBeenCalled()
    // Only now does it wait for a frame of the capture.
    expect(capture.videoFrames.size).toBe(1)
  })

  it('passes over a frame captured before the dialog was hidden, and draws the first one after', async () => {
    const capture = fakeCapture()
    const picture = capture.start()
    await capture.paintHidden()

    // Captured before the hidden dialog was painted, delivered after.
    await capture.videoFrame({ captureTime: PAINTED_AT - 1, presentationTime: PAINTED_AT + 20 })
    expect(capture.drawImage).not.toHaveBeenCalled()
    expect(capture.videoFrames.size).toBe(1)

    await capture.videoFrame({ captureTime: PAINTED_AT, presentationTime: PAINTED_AT + 30 })
    expect(capture.drawImage).toHaveBeenCalledExactlyOnceWith(capture.video, 0, 0)
    const blob = await picture
    expect(blob?.type).toBe('image/png')
    expect(capture.videoFrames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads a frame’s presentation time where it has no capture time', async () => {
    const capture = fakeCapture()
    void capture.start()
    await capture.paintHidden()

    await capture.videoFrame({ presentationTime: PAINTED_AT - 1 })
    expect(capture.drawImage).not.toHaveBeenCalled()
    await capture.videoFrame({ presentationTime: PAINTED_AT })
    expect(capture.drawImage).toHaveBeenCalledOnce()
  })

  it('draws the video’s current frame when the wait ends with no later frame', async () => {
    const capture = fakeCapture()
    const picture = capture.start()
    await capture.paintHidden()

    await vi.advanceTimersByTimeAsync(CAPTURE_FRAME_WAIT_MS - 1)
    expect(capture.drawImage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(capture.drawImage).toHaveBeenCalledOnce()
    await expect(picture).resolves.toBeInstanceOf(Blob)

    // The callback that was waiting is cancelled, so a frame that arrives later draws nothing.
    expect(capture.videoFrames.size).toBe(0)
    expect(capture.drawImage).toHaveBeenCalledOnce()
  })

  it('waits out the bound on a video that reports no frames', async () => {
    const capture = fakeCapture({ frameCallbacks: false })
    const picture = capture.start()
    await capture.paintHidden()

    await vi.advanceTimersByTimeAsync(CAPTURE_FRAME_WAIT_MS - 1)
    expect(capture.drawImage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(capture.drawImage).toHaveBeenCalledOnce()
    await expect(picture).resolves.toBeInstanceOf(Blob)
  })

  describe('puts everything back, in order', () => {
    it('after a picture was taken', async () => {
      const capture = fakeCapture()
      const picture = capture.start()
      await capture.paintHidden()
      await capture.videoFrame({ captureTime: PAINTED_AT + 5, presentationTime: PAINTED_AT + 9 })
      await picture

      expect(capture.log).toEqual(['hide', 'draw', 'stop', 'restore'])
      expect(capture.restore).toHaveBeenCalledOnce()
      expect(capture.video.srcObject).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('when drawing fails', async () => {
      const capture = fakeCapture()
      capture.drawImage.mockImplementation(() => { throw new Error('The canvas is tainted.') })
      const picture = capture.start()
      picture.catch(() => {})
      await capture.paintHidden()
      await vi.advanceTimersByTimeAsync(CAPTURE_FRAME_WAIT_MS)

      await expect(picture).rejects.toThrow('The canvas is tainted.')
      expect(capture.log).toEqual(['hide', 'cancel-frame', 'stop', 'restore'])
      expect(capture.restore).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('when the page is given no animation frame, as one in the background is', async () => {
      const capture = fakeCapture()
      const picture = capture.start()
      picture.catch(() => {})
      await capture.answerPrompt()
      await vi.advanceTimersByTimeAsync(CAPTURE_START_WAIT_MS - 1)
      expect(capture.log).toEqual(['hide'])

      await vi.advanceTimersByTimeAsync(1)
      await expect(picture).rejects.toThrow('The capture took too long to start.')
      expect(capture.log).toEqual(['hide', 'stop', 'restore'])
      expect(capture.video.srcObject).toBeNull()
      expect(capture.drawImage).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('when the capture never plays', async () => {
      const capture = fakeCapture()
      capture.video.play.mockReturnValue(new Promise(() => {}))
      const picture = capture.start()
      picture.catch(() => {})
      await capture.paintHidden()
      await vi.advanceTimersByTimeAsync(CAPTURE_START_WAIT_MS)

      await expect(picture).rejects.toThrow('The capture took too long to start.')
      expect(capture.log).toEqual(['hide', 'stop', 'restore'])
      expect(capture.drawImage).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('when the capture ends before a frame came', async () => {
      const capture = fakeCapture()
      const picture = capture.start()
      picture.catch(() => {})
      await capture.paintHidden()
      await capture.endTrack()

      await expect(picture).rejects.toThrow('The capture ended before a picture was taken.')
      // The callback and the timer that waited for a frame are cancelled before the dialog is back.
      expect(capture.log).toEqual(['hide', 'stop', 'cancel-frame', 'restore'])
      expect(capture.restore).toHaveBeenCalledOnce()
      expect(capture.drawImage).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('resolves with nothing, and never hides the dialog, when the user declines the prompt', async () => {
    const capture = fakeCapture()
    const picture = capture.start()
    await capture.declinePrompt(new DOMException('Permission denied', 'NotAllowedError'))

    await expect(picture).resolves.toBeNull()
    expect(capture.hide).not.toHaveBeenCalled()
    expect(capture.log).toEqual([])
  })

  it('stops the capture at once, hides nothing and draws nothing, when the press was withdrawn before the prompt was answered', async () => {
    const capture = fakeCapture()
    const picture = capture.start()
    capture.withdraw()
    await capture.answerPrompt()

    await expect(picture).resolves.toBeNull()
    expect(capture.log).toEqual(['stop'])
    expect(capture.hide).not.toHaveBeenCalled()
    expect(capture.video.srcObject).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs a capture that has hidden the dialog to its end, whatever is withdrawn then', async () => {
    const capture = fakeCapture()
    const picture = capture.start()
    await capture.paintHidden()
    capture.withdraw()
    await capture.videoFrame({ captureTime: PAINTED_AT, presentationTime: PAINTED_AT + 4 })

    await expect(picture).resolves.toBeInstanceOf(Blob)
    expect(capture.log).toEqual(['hide', 'draw', 'stop', 'restore'])
  })

  it('rejects, without hiding the dialog, when the browser cannot capture', async () => {
    const capture = fakeCapture()
    const picture = capture.start()
    picture.catch(() => {})
    await capture.declinePrompt(new DOMException('No source', 'NotFoundError'))

    await expect(picture).rejects.toThrow('No source')
    expect(capture.hide).not.toHaveBeenCalled()
  })
})

describe('canCaptureTab', () => {
  it('is false in a browser without screen capture', () => {
    expect(canCaptureTab()).toBe(false)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} })
    expect(canCaptureTab()).toBe(false)
  })

  it('is true where getDisplayMedia exists', () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: () => Promise.reject(new Error('unused')) },
    })
    expect(canCaptureTab()).toBe(true)
  })
})
