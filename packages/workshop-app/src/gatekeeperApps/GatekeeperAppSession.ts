import { newMessagePortRpcSession } from 'capnweb'
import type { GatekeeperAppTheme } from '@gadgets/workshop-shared/theme'
import { forwardFrameError } from '@/rpc/errorReporting'
import type { GatekeeperAppHost } from './GatekeeperAppHost'

/** A message to the page, as much of it as is read. */
export type FrameMessage = Pick<MessageEvent, 'source' | 'origin' | 'data' | 'ports'>

/**
 * One app frame's connection. Only its own frame is listened to (`receive`, with a frame that has
 * no origin), and only its first handshake, which is given the host (`connect`): a second means the
 * page in it is not the one that was given, so it is cut off for good. What went wrong in the
 * frame that it posts is reported as the app's (`forwardFrameError`).
 */
export class GatekeeperAppSession {
  #host: GatekeeperAppHost | undefined
  #session: Disposable | undefined
  #connected = false
  #invalid = false

  constructor(
    private readonly frame: () => Window | null | undefined,
    /** The gatekeeper whose app it is, which its reports name. */
    private readonly gatekeeperId: string,
    private readonly connect: () => GatekeeperAppHost,
  ) {}

  /** A message to the page, which is the frame's handshake or a report if it is from the frame. */
  receive = (event: FrameMessage) => {
    const frame = this.frame()
    if (!frame || event.source !== frame || event.origin !== 'null' || this.#invalid) return
    if (forwardFrameError(event, frame, { surface: 'gatekeeper-app', gatekeeperVendorId: this.gatekeeperId })) return
    const port = (event.data as { type?: unknown } | null)?.type === 'handshake' ? event.ports[0] : undefined
    if (!port) return
    if (this.#connected) {
      port.close()
      this.#invalid = true
      this.dispose()
      return
    }
    const host = this.connect()
    this.#host = host
    this.#session = newMessagePortRpcSession(port, host)
    this.#connected = true
  }

  /** The Workshop's theme changed. */
  updateTheme(theme: GatekeeperAppTheme) {
    this.#host?.updateTheme(theme)
  }

  /** Lets go of the frame, and of what the app held. */
  dispose() {
    this.#session?.[Symbol.dispose]()
    this.#session = undefined
    this.#host?.dispose()
    this.#host = undefined
  }
}
