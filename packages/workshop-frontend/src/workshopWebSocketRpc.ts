import {
  RpcSession,
  WebSocketTransport,
  type RpcSessionOptions,
  type RpcStub,
} from 'capnweb'

const WS_CLOSING = 2
const WS_CLOSED = 3

/** Cap'n Web WebSocket transport with only the browser closed-send warning guarded. */
export class WorkshopWebSocketTransport extends WebSocketTransport<string> {
  readonly #webSocket: WebSocket

  constructor(webSocket: WebSocket) {
    super(webSocket)
    this.#webSocket = webSocket
  }

  send(message: string): void {
    if (this.#webSocket.readyState === WS_CLOSING || this.#webSocket.readyState === WS_CLOSED) {
      return
    }
    super.send(message)
  }
}

export function newWorkshopWebSocketRpcSession<T>(
  webSocket: WebSocket | string,
  localMain?: unknown,
  options?: RpcSessionOptions,
): RpcStub<T> {
  const socket = typeof webSocket === 'string' ? new WebSocket(webSocket) : webSocket
  return new RpcSession<T>(new WorkshopWebSocketTransport(socket), localMain, options).getRemoteMain()
}
