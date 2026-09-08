import { describe, expect, it, vi } from 'vitest'
import { WorkshopWebSocketTransport } from './workshopWebSocketRpc'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  binaryType: BinaryType = 'blob'
  readyState = FakeWebSocket.CONNECTING
  readonly sent: string[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(message: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('native send should only see an open socket')
    }
    this.sent.push(message)
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSING
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  fail() {
    this.dispatchEvent(new Event('error'))
  }

  closeFromPeer(code = 1006, reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

const delay = () => new Promise(resolve => setTimeout(resolve, 0))

describe('WorkshopWebSocketTransport', () => {
  it('inherits connecting queue and open flush behavior', () => {
    const socket = new FakeWebSocket()
    const transport = new WorkshopWebSocketTransport(socket as unknown as WebSocket)

    transport.send('one')
    transport.send('two')
    expect(socket.sent).toEqual([])

    socket.open()
    expect(socket.sent).toEqual(['one', 'two'])
  })

  it('inherits pending receive rejection on close', async () => {
    const socket = new FakeWebSocket()
    const transport = new WorkshopWebSocketTransport(socket as unknown as WebSocket)
    const pending = transport.receive()

    socket.closeFromPeer(1001, 'going away')

    await expect(pending).rejects.toThrow('Peer closed WebSocket: 1001 going away')
  })

  it('inherits pending receive rejection on error', async () => {
    const socket = new FakeWebSocket()
    const transport = new WorkshopWebSocketTransport(socket as unknown as WebSocket)
    const pending = transport.receive()

    socket.fail()

    await expect(pending).rejects.toThrow('WebSocket connection failed.')
  })

  it('preserves capnweb abort semantics while guarding closed-state send', async () => {
    const socket = new FakeWebSocket()
    const transport = new WorkshopWebSocketTransport(socket as unknown as WebSocket)
    const pending = transport.receive()

    transport.abort(new Error('session aborted'))

    await delay()
    await expect(Promise.race([pending, Promise.resolve('still pending')])).resolves.toBe('still pending')
    expect(socket.closes).toEqual([{ code: 3000, reason: 'session aborted' }])

    transport.send('abort frame after close started')
    expect(socket.sent).toEqual([])
  })

  it('guards native send in both closing and closed states only', () => {
    const socket = new FakeWebSocket()
    const transport = new WorkshopWebSocketTransport(socket as unknown as WebSocket)
    const send = vi.spyOn(socket, 'send')

    socket.readyState = FakeWebSocket.CLOSING
    transport.send('closing')
    socket.readyState = FakeWebSocket.CLOSED
    transport.send('closed')

    expect(send).not.toHaveBeenCalled()
  })
})
