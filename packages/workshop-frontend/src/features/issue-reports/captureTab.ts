/**
 * How long a capture waits for a frame taken after the dialog was hidden. A capture of a tab
 * delivers a frame when the tab's picture changes, so on a page that is not moving the frame
 * the hiding itself caused is the last one: no later frame comes, and that one is the video's
 * current frame when the wait ends. The bound is why a capture of a still page takes a third of
 * a second.
 */
export const CAPTURE_FRAME_WAIT_MS = 300

/**
 * How long a capture may take, from the answer to the prompt, to play and for the page to paint
 * the dialog hidden. Both take a few frames. A page in the background is given no animation
 * frame, and a stream can deliver nothing: past the bound the capture is stopped with no picture
 * instead of sharing on until the page is looked at again.
 */
export const CAPTURE_START_WAIT_MS = 3000

// Options the DOM types do not list yet: both ask the browser to offer this tab first.
type TabCaptureOptions = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean
  selfBrowserSurface?: 'include' | 'exclude'
}

/** Whether this browser can capture a tab at all. */
export const canCaptureTab = (): boolean =>
  typeof navigator.mediaDevices?.getDisplayMedia === 'function'

// What getDisplayMedia() rejects with when the user dismisses the browser's prompt or picks
// nothing: a choice, not a failure.
const declined = (err: unknown): boolean =>
  err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')

const animationFrame = (): Promise<DOMHighResTimeStamp> =>
  new Promise((resolve) => { requestAnimationFrame(resolve) })

/**
 * Waits until the video holds a frame of the capture taken at or after `paintedAt`, for
 * CAPTURE_FRAME_WAIT_MS at most. The page's animation frames say nothing about the capture,
 * which delivers frames on its own clock and some milliseconds late: the video can still hold a
 * frame from before the dialog was hidden. Without requestVideoFrameCallback the bounded wait
 * alone stands in. Returns what settles the wait and what abandons it.
 */
const frameAfter = (video: HTMLVideoElement, paintedAt: DOMHighResTimeStamp) => {
  let callback: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    if (callback !== undefined) video.cancelVideoFrameCallback(callback)
    callback = undefined
  }
  const arrived = new Promise<void>((resolve) => {
    const settle = () => {
      cancel()
      resolve()
    }
    timer = setTimeout(settle, CAPTURE_FRAME_WAIT_MS)
    if (typeof video.requestVideoFrameCallback !== 'function') return
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      callback = undefined
      if ((metadata.captureTime ?? metadata.presentationTime) >= paintedAt) settle()
      else callback = video.requestVideoFrameCallback(onFrame)
    }
    callback = video.requestVideoFrameCallback(onFrame)
  })
  return { arrived, cancel }
}

const toPng = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('The capture could not be made into an image.'))
      else resolve(blob)
    }, 'image/png')
  })

/**
 * Captures ONE frame of this tab as a PNG, through the browser's own screen-capture prompt, and
 * stops the capture at once. Resolves null when the user declines the prompt. Call it from the
 * press of a button: nothing is captured without that press and the browser's prompt.
 *
 * The press comes from a modal dialog, which would be in the picture. Once the prompt has
 * resolved (the dialog stays visible under it), `hide()` takes the dialog out of sight without
 * unmounting it, and returns what puts it back and gives focus back. The frame is drawn only
 * after two animation frames of the page (the hidden state has been painted) and then a frame
 * of the capture taken after those (see CAPTURE_FRAME_WAIT_MS). A capture that has not come that
 * far CAPTURE_START_WAIT_MS after the prompt was answered is stopped and rejects. The dialog is
 * put back on every path that hid it.
 *
 * Aborting `signal` withdraws a press whose prompt is still unanswered: the browser offers no way
 * to take its prompt back, so a prompt answered after that has its capture stopped at once, hides
 * nothing and resolves null. A capture that has hidden the dialog runs to its end.
 */
export const captureTab = async ({ hide, signal }: {
  hide: () => () => void
  signal: AbortSignal
}): Promise<Blob | null> => {
  const options: TabCaptureOptions = {
    video: { displaySurface: 'browser' },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options)
  } catch (err) {
    if (declined(err)) return null
    throw err
  }
  if (signal.aborted) {
    for (const track of stream.getTracks()) track.stop()
    return null
  }

  let restore: (() => void) | undefined
  let frameWait: ReturnType<typeof frameAfter> | undefined
  let startTimer: ReturnType<typeof setTimeout> | undefined
  const video = document.createElement('video')
  try {
    const overdue = new Promise<never>((_resolve, reject) => {
      startTimer = setTimeout(
        () => reject(new Error('The capture took too long to start.')),
        CAPTURE_START_WAIT_MS,
      )
    })
    // The user can stop sharing from the browser's own bar while the frame is awaited.
    const ended = new Promise<never>((_resolve, reject) => {
      for (const track of stream.getTracks()) {
        track.addEventListener(
          'ended',
          () => reject(new Error('The capture ended before a picture was taken.')),
          { once: true },
        )
      }
    })
    restore = hide()
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    const painted = animationFrame().then(animationFrame)
    const [paintedAt] = await Promise.race([Promise.all([painted, video.play()]), ended, overdue])
    clearTimeout(startTimer)
    frameWait = frameAfter(video, paintedAt)
    await Promise.race([frameWait.arrived, ended])

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (context === null || canvas.width === 0 || canvas.height === 0) {
      throw new Error('The capture held no picture.')
    }
    context.drawImage(video, 0, 0)
    return await toPng(canvas)
  } finally {
    for (const track of stream.getTracks()) track.stop()
    clearTimeout(startTimer)
    frameWait?.cancel()
    video.srcObject = null
    restore?.()
  }
}
