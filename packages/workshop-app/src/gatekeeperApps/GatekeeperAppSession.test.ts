import { afterEach, expect, it, vi } from 'vitest'
import { FRONTEND_ERROR_MESSAGE_TYPE } from '@gadgets/error-reporting'
import { GatekeeperAppHost } from './GatekeeperAppHost'
import { GatekeeperAppSession, type FrameMessage } from './GatekeeperAppSession'

const frame = {} as Window
const channels: MessageChannel[] = []
afterEach(() => {
  for (const { port1, port2 } of channels.splice(0)) {
    port1.close()
    port2.close()
  }
})

const handshake = (overrides: Partial<FrameMessage> = {}): FrameMessage => {
  const channel = new MessageChannel()
  channels.push(channel)
  return { source: frame, origin: 'null', data: { type: 'handshake' }, ports: [channel.port2], ...overrides }
}

const sessionOf = () => {
  const hosts: GatekeeperAppHost[] = []
  const page = {
    present: () => ({ rect: null, willResize: false }),
    openWorkspace: () => {},
    openPrompt: () => {},
    resolveWorkspaceTitles: async () => [],
    openUserPicker: async () => {},
    cancelUserPicker: () => {},
  }
  const session = new GatekeeperAppSession(() => frame, 'example', () => {
    const host = new GatekeeperAppHost({}, page, { mode: 'light', accentColor: null })
    vi.spyOn(host, 'dispose')
    hosts.push(host)
    return host
  })
  return { session, hosts }
}

it('connects only its own frame, at its opaque origin', () => {
  const { session, hosts } = sessionOf()
  session.receive(handshake({ source: {} as Window }))
  session.receive(handshake({ origin: 'https://evil.example' }))
  session.receive(handshake({ data: { type: 'something else' } }))
  expect(hosts).toHaveLength(0)
  session.receive(handshake())
  expect(hosts).toHaveLength(1)
  session.dispose()
  expect(hosts[0]!.dispose).toHaveBeenCalled()
})

it('cuts the frame off for good at a second handshake, as its page is no longer the one given', () => {
  const { session, hosts } = sessionOf()
  session.receive(handshake())
  session.receive(handshake())
  expect(hosts).toHaveLength(1)
  expect(hosts[0]!.dispose).toHaveBeenCalled()
  session.receive(handshake())
  expect(hosts).toHaveLength(1)
})

it('takes a report from the frame for a report, not a handshake', () => {
  const { session, hosts } = sessionOf()
  session.receive({
    source: frame,
    origin: 'null',
    data: { type: FRONTEND_ERROR_MESSAGE_TYPE, report: { failureSite: 'frame.render', severity: 'error', handled: false, captureMechanism: 'react' } },
    ports: [],
  })
  expect(hosts).toHaveLength(0)
})
